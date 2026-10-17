import {createHash} from 'node:crypto';
import {CentralStore,type AuthProvider,type CommandState,type OidcProfile} from './store';
import {isEncryptedEnvelope,isEncryptionPublicKey} from '../../sdk/src/central-crypto';
export interface OidcProviderOptions {clientId:string;clientSecret?:string;redirectUri:string;authorizationEndpoint?:string;tokenEndpoint?:string;jwksUri?:string;}
export interface AppleProviderOptions extends OidcProviderOptions {teamId?:string;keyId?:string;privateKey?:string;}
export interface CentralOptions {dbPath:string;host?:string;port?:string|number;origin?:string;allowLocalSignup?:boolean;google?:OidcProviderOptions;apple?:AppleProviderOptions;}
const text=(s:unknown,max=80)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
const result=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function bearer(req:Request):string|null{const got=req.headers.get('authorization');return got?.startsWith('Bearer ')?got.slice(7):null;}
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const b64url=(value:string|Buffer|Uint8Array)=>Buffer.isBuffer(value)||value instanceof Uint8Array?Buffer.from(value).toString('base64url'):Buffer.from(value).toString('base64url');
const defaults:Record<AuthProvider,{issuer:string[];scope:string;authorizationEndpoint:string;tokenEndpoint:string;jwksUri:string;formPost:boolean}>={
 google:{issuer:['https://accounts.google.com','accounts.google.com'],scope:'openid email profile',authorizationEndpoint:'https://accounts.google.com/o/oauth2/v2/auth',tokenEndpoint:'https://oauth2.googleapis.com/token',jwksUri:'https://www.googleapis.com/oauth2/v3/certs',formPost:false},
 apple:{issuer:['https://appleid.apple.com'],scope:'name email',authorizationEndpoint:'https://appleid.apple.com/auth/authorize',tokenEndpoint:'https://appleid.apple.com/auth/token',jwksUri:'https://appleid.apple.com/auth/keys',formPost:true}
};
function envProviders(opts:CentralOptions){return {
 google:opts.google??(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.GOOGLE_REDIRECT_URI?{clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET,redirectUri:process.env.GOOGLE_REDIRECT_URI}:undefined),
 apple:opts.apple??(process.env.APPLE_CLIENT_ID&&process.env.APPLE_REDIRECT_URI&&(process.env.APPLE_CLIENT_SECRET||(process.env.APPLE_TEAM_ID&&process.env.APPLE_KEY_ID&&process.env.APPLE_PRIVATE_KEY))?{clientId:process.env.APPLE_CLIENT_ID,clientSecret:process.env.APPLE_CLIENT_SECRET,teamId:process.env.APPLE_TEAM_ID,keyId:process.env.APPLE_KEY_ID,privateKey:process.env.APPLE_PRIVATE_KEY,redirectUri:process.env.APPLE_REDIRECT_URI}:undefined)
};}
export async function createAppleClientSecret(opts:AppleProviderOptions):Promise<string>{
 if(opts.clientSecret)return opts.clientSecret;if(!opts.teamId||!opts.keyId||!opts.privateKey)throw Error('Apple client secret or signing key required');
 const header={alg:'ES256',kid:opts.keyId,typ:'JWT'},now=Math.floor(Date.now()/1000),payload={iss:opts.teamId,iat:now,exp:now+300,aud:'https://appleid.apple.com',sub:opts.clientId},unsigned=b64url(JSON.stringify(header))+'.'+b64url(JSON.stringify(payload));
 const pem=opts.privateKey.replace(/\\n/g,'\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,''),key=await crypto.subtle.importKey('pkcs8',Buffer.from(pem,'base64'),{name:'ECDSA',namedCurve:'P-256'},false,['sign']),signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(unsigned));
 return unsigned+'.'+b64url(new Uint8Array(signature));
}
async function verifyIdToken(provider:AuthProvider,idToken:string,opts:OidcProviderOptions,pending:{nonceHash:string;codeVerifier:string}):Promise<OidcProfile>{
 const parts=idToken.split('.');if(parts.length!==3)throw Error('Invalid identity token');const header=JSON.parse(Buffer.from(parts[0],'base64url').toString()) as any,payload=JSON.parse(Buffer.from(parts[1],'base64url').toString()) as any;if(typeof header.kid!=='string'||typeof payload.sub!=='string')throw Error('Invalid identity token');
 const jwks=await (await fetch(opts.jwksUri??defaults[provider].jwksUri,{signal:AbortSignal.timeout(10000)})).json() as {keys?:Array<JsonWebKey&{kid?:string}>},jwk=jwks.keys?.find(k=>k.kid===header.kid);if(!jwk)throw Error('Identity key not found');
 const data=Buffer.from(parts[0]+'.'+parts[1]),signature=Buffer.from(parts[2],'base64url');let key:CryptoKey,algorithm:AlgorithmIdentifier|RsaHashedImportParams|EcdsaParams;
 if(header.alg==='RS256'){algorithm={name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'};key=await crypto.subtle.importKey('jwk',jwk,algorithm,false,['verify']);}
 else if(header.alg==='ES256'){algorithm={name:'ECDSA',hash:'SHA-256'};key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);}
 else throw Error('Unsupported identity token algorithm');
 if(!await crypto.subtle.verify(algorithm,key,signature,data))throw Error('Invalid identity token signature');
 const audience=Array.isArray(payload.aud)?payload.aud:[payload.aud];if(!defaults[provider].issuer.includes(payload.iss)||!audience.includes(opts.clientId)||typeof payload.exp!=='number'||payload.exp*1000<=Date.now()||typeof payload.nonce!=='string'||sha256(payload.nonce)!==pending.nonceHash)throw Error('Identity token validation failed');
 if(provider==='google'&&payload.email_verified!==true)throw Error('Google email is not verified');
 return {sub:payload.sub,email:typeof payload.email==='string'?payload.email:undefined,name:typeof payload.name==='string'?payload.name:undefined};
}
export function createCentral(opts:CentralOptions){
 const store=new CentralStore(opts.dbPath),origin=opts.origin,providers=envProviders(opts);
 const server=Bun.serve({hostname:opts.host??'127.0.0.1',port:Number(opts.port??0),maxRequestBodySize:65536,async fetch(req){
  const url=new URL(req.url),expectedOrigin=origin??url.origin,path=url.pathname,externalOidcCallback=/^\/v1\/auth\/(google|apple)\/callback$/.test(path)&&req.method==='POST';
  if(req.headers.get('host')!==new URL(expectedOrigin).host)return result({error:'Host rejected'},403);
  if(req.headers.has('origin')&&req.headers.get('origin')!==expectedOrigin&&!externalOidcCallback)return result({error:'Origin rejected'},403);
  try{
   if(path==='/v1/health'&&req.method==='GET')return result({version:'0.0.0',role:'central',receive:false,auth:{google:Boolean(providers.google),apple:Boolean(providers.apple)}});
   if(path==='/v1/users'&&req.method==='POST'){if(opts.allowLocalSignup!==true)return result({error:'Signup provider required'},403);const b=await req.json();if(!text(b.label))return result({error:'Invalid label'},400);const made=store.createUser(b.label.trim());return result({user:made.user,user_token:made.userToken},201);}
   const authMatch=path.match(/^\/v1\/auth\/(google|apple)\/(start|callback|status)$/);
   if(authMatch){
    const provider=authMatch[1] as AuthProvider,action=authMatch[2],config=providers[provider];if(!config)return result({error:`${provider==='google'?'Google':'Apple'} sign-in is not configured`},503);
    if(action==='start'&&req.method==='POST'){const key=provider+':'+(req.headers.get('cf-connecting-ip')||'local');if(!store.authAllowed(key))return result({error:'Too many sign-in attempts'},429);const login=store.startOidcLogin(provider),authUrl=new URL(config.authorizationEndpoint??defaults[provider].authorizationEndpoint);authUrl.searchParams.set('client_id',config.clientId);authUrl.searchParams.set('redirect_uri',config.redirectUri);authUrl.searchParams.set('response_type','code');authUrl.searchParams.set('scope',defaults[provider].scope);authUrl.searchParams.set('state',login.state);authUrl.searchParams.set('nonce',login.nonce);authUrl.searchParams.set('code_challenge',createHash('sha256').update(login.codeVerifier).digest('base64url'));authUrl.searchParams.set('code_challenge_method','S256');if(defaults[provider].formPost)authUrl.searchParams.set('response_mode','form_post');return result({provider,state:login.state,auth_url:authUrl.toString()},201);}
    if(action==='callback'&&(req.method==='GET'||req.method==='POST')){
     const form=req.method==='POST'?await req.formData():undefined,get=(name:string)=>String(form?.get(name)??url.searchParams.get(name)??''),state=get('state'),code=get('code');
     try{
      if(!state||!code)throw Error('Missing sign-in response');const pending=store.pendingOidcLogin(provider,state);if(!pending)throw Error('Sign-in expired');const secret=provider==='apple'?await createAppleClientSecret(config as AppleProviderOptions):config.clientSecret;if(!secret)throw Error('OAuth client secret required');
      const tokenResponse=await fetch(config.tokenEndpoint??defaults[provider].tokenEndpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,client_secret:secret,code,redirect_uri:config.redirectUri,code_verifier:pending.codeVerifier}),signal:AbortSignal.timeout(10000)}),tokens=await tokenResponse.json().catch(()=>({})) as any;if(!tokenResponse.ok||typeof tokens.id_token!=='string')throw Error('Identity token exchange failed');
      const profile=await verifyIdToken(provider,tokens.id_token,config,pending),userField=get('user');if(userField){try{const details=JSON.parse(userField) as any,name=[details?.name?.firstName,details?.name?.lastName].filter(Boolean).join(' ');if(name)profile.name=name;if(!profile.email&&typeof details?.email==='string')profile.email=details.email;}catch{}}
      const user=store.completeOidcLogin(provider,state,profile);if(!user)throw Error('Sign-in expired');
      return new Response(`<!doctype html><title>Msgzle sign-in</title><p>Signed in with ${provider==='google'?'Google':'Apple'}. You can return to Msgzle.</p>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
     }catch(error){if(state)store.failOidcLogin(state,error instanceof Error?error.message:'Sign-in failed');return new Response('Sign-in failed. Return to Msgzle and try again.',{status:400,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});}
    }
    if(action==='status'&&req.method==='POST'){const b=await req.json();if(!text(b.state,128))return result({error:'Invalid sign-in state'},400);const made=store.consumeOidcLogin(provider,b.state);return made?result({status:'complete',user:made.user,user_token:made.userToken}):result({status:'pending'},202);}
   }
   if(path==='/v1/pairing/start'&&req.method==='POST'){const b=await req.json();if(!text(b.label)||!isEncryptionPublicKey(b.public_key))return result({error:'Invalid device'},400);const made=store.startPairing(b.label.trim(),b.public_key);return result({device_id:made.device.id,pair_code:made.pairCode,device_token:made.deviceToken},201);}
   if(path==='/v1/pairing/approve'&&req.method==='POST'){const user=store.userByToken(bearer(req)??'');if(!user)return result({error:'Unauthorized'},401);const b=await req.json();if(!text(b.pair_code,16))return result({error:'Invalid pair code'},400);const device=store.approvePairing(user.id,b.pair_code);return device?result({device}):result({error:'Pairing not found'},404);}
   if(path==='/v1/apps'&&req.method==='POST'){const user=store.userByToken(bearer(req)??'');if(!user)return result({error:'Unauthorized'},401);const b=await req.json();if(!text(b.name)||!isEncryptionPublicKey(b.public_key))return result({error:'Invalid app'},400);const made=store.createApp(user.id,b.name.trim(),b.public_key);return result({app:made.app,app_token:made.appToken},201);}
   if(path==='/v1/grants'&&req.method==='POST'){const user=store.userByToken(bearer(req)??'');if(!user)return result({error:'Unauthorized'},401);const b=await req.json();if(!text(b.device_id,80)||!text(b.app_id,80)||!Array.isArray(b.scopes)||b.scopes.length!==1||b.scopes[0]!=='messages.send')return result({error:'Invalid grant'},400);const grant=store.createGrant(user.id,b.device_id,b.app_id,b.scopes);return grant?result({grant},201):result({error:'Device or app not available'},404);}
   if(path==='/v1/send'&&req.method==='POST'){const app=store.appByToken(bearer(req)??'');if(!app)return result({error:'Unauthorized'},401);const b=await req.json();if(!text(b.grant_id,80)||typeof b.id!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(b.id)||!isEncryptedEnvelope(b.envelope))return result({error:'Invalid encrypted command'},400);const made=store.sendCommand(app.id,b.grant_id,b.id,b.envelope);return made.command?result({command:made.command},made.status):result({error:made.error},made.status);}
   const commandMatch=path.match(/^\/v1\/commands\/([A-Za-z0-9_-]{8,80})$/);if(commandMatch&&req.method==='GET'){const app=store.appByToken(bearer(req)??'');if(!app)return result({error:'Unauthorized'},401);const command=store.commandForApp(app.id,commandMatch[1]);return command?result({command}):result({error:'Not found'},404);}
   if(path==='/v1/connector/next'&&req.method==='POST'){const device=store.deviceByToken(bearer(req)??'');if(!device)return result({error:'Unauthorized'},401);const command=store.nextCommand(device.id);return result({command:command??null});}
   if(path==='/v1/connector/result'&&req.method==='POST'){const device=store.deviceByToken(bearer(req)??'');if(!device)return result({error:'Unauthorized'},401);const b=await req.json();if(!text(b.id,80)||!['dispatch-accepted','uncertain','cancelled','policy-rejected'].includes(b.state))return result({error:'Invalid result'},400);const command=store.finishCommand(device.id,b.id,b.state as CommandState);return command?result({command}):result({error:'Not attempting'},409);}
   return result({error:'Not found'},404);
  }catch{return result({error:'Request could not be processed'},400);}
 }});
 return {server,store,close(){server.stop(true);store.close();}};
}
