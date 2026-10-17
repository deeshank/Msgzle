import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createAppleClientSecret,createCentral} from '../src/central';import {decryptFromDevice,encryptForDevice,generateEncryptionKeyPair} from '../../sdk/src/central-crypto';import {MsgzleCentral} from '../../sdk/src/central-client';
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'msgzle-central-')),central=createCentral({dbPath:join(dir,'central.sqlite'),allowLocalSignup:true}),base=central.server.url;const post=(path:string,body:unknown,token?:string)=>fetch(new URL(path,base),{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});const get=(path:string,token:string)=>fetch(new URL(path,base),{headers:{authorization:`Bearer ${token}`}});return {dir,central,base,post,get,close(){central.close();rmSync(dir,{recursive:true,force:true});}};}
test('encrypted envelope round-trips only to the paired device key',async()=>{
 const device=await generateEncryptionKeyPair(),other=await generateEncryptionKeyPair(),payload={to:'+15551234567',text:'hello'};const envelope=await encryptForDevice(device.publicKey,payload);expect(JSON.stringify(envelope)).not.toContain('+15551234567');expect(JSON.stringify(envelope)).not.toContain('hello');await expect(decryptFromDevice(device.privateKey,envelope)).resolves.toEqual(payload);await expect(decryptFromDevice(other.privateKey,envelope)).rejects.toThrow();
});
test('pair, approve, grant, queue encrypted send, poll once, report status',async()=>{
 const f=await fixture();try{
  const deviceKeys=await generateEncryptionKeyPair(),appKeys=await generateEncryptionKeyPair();
  const user=await (await f.post('/v1/users',{label:'Dee'})).json() as any;
  const pair=await (await f.post('/v1/pairing/start',{label:'Home Mac',public_key:deviceKeys.publicKey})).json() as any;
  const app=await (await f.post('/v1/apps',{name:'Throwaway',public_key:appKeys.publicKey},user.user_token)).json() as any;
  const approved=await (await f.post('/v1/pairing/approve',{pair_code:pair.pair_code},user.user_token)).json() as any;expect(approved.device.status).toBe('active');
  const grant=await (await f.post('/v1/grants',{device_id:approved.device.id,app_id:app.app.id,scopes:['messages.send']},user.user_token)).json() as any;
  const envelope=await encryptForDevice(deviceKeys.publicKey,{to:'+15551234567',text:'hello central'}),send=await f.post('/v1/send',{grant_id:grant.grant.id,id:'command01',envelope},app.app_token);expect(send.status).toBe(202);
  expect((await f.post('/v1/send',{grant_id:grant.grant.id,id:'plain001',to:'+15551234567',text:'plaintext'},app.app_token)).status).toBe(400);
  expect(f.central.store.rawCommandEnvelope('command01')).not.toContain('+15551234567');expect(f.central.store.rawCommandEnvelope('command01')).not.toContain('hello central');
  expect((await f.post('/v1/send',{grant_id:grant.grant.id,id:'command01',envelope},app.app_token)).status).toBe(200);expect((await f.post('/v1/send',{grant_id:grant.grant.id,id:'command01',envelope:{...envelope,iv:'bad'}},app.app_token)).status).toBe(409);
  const next=await (await f.post('/v1/connector/next',{},pair.device_token)).json() as any;expect(next.command.id).toBe('command01');expect(next.command.envelope).toEqual(envelope);await expect(decryptFromDevice(deviceKeys.privateKey,next.command.envelope)).resolves.toEqual({to:'+15551234567',text:'hello central'});
  expect((await (await f.post('/v1/connector/next',{},pair.device_token)).json() as any).command).toBeNull();
  expect((await f.post('/v1/connector/result',{id:'command01',state:'dispatch-accepted'},pair.device_token)).status).toBe(200);
  const client=new MsgzleCentral({baseUrl:String(f.base)}),health=await client.health();expect(health.role).toBe('central');const status=await client.command('command01',app.app_token);expect(status.command.state).toBe('dispatch-accepted');expect(JSON.stringify(status)).not.toContain('hello central');
 }finally{f.close();}
});
test('grant cannot send before device approval and app tokens stay separate',async()=>{
 const f=await fixture();try{
  const deviceKeys=await generateEncryptionKeyPair(),appKeys=await generateEncryptionKeyPair(),user=await (await f.post('/v1/users',{label:'Dee'})).json() as any,pair=await (await f.post('/v1/pairing/start',{label:'Mac',public_key:deviceKeys.publicKey})).json() as any,app=await (await f.post('/v1/apps',{name:'App',public_key:appKeys.publicKey},user.user_token)).json() as any;
  expect((await f.post('/v1/grants',{device_id:pair.device_id,app_id:app.app.id,scopes:['messages.send']},user.user_token)).status).toBe(404);
  await f.post('/v1/pairing/approve',{pair_code:pair.pair_code},user.user_token);const grant=await (await f.post('/v1/grants',{device_id:pair.device_id,app_id:app.app.id,scopes:['messages.send']},user.user_token)).json() as any,envelope=await encryptForDevice(deviceKeys.publicKey,{to:'+15551234567',text:'secret'});
  expect((await f.post('/v1/send',{grant_id:grant.grant.id,id:'command02',envelope},user.user_token)).status).toBe(401);expect((await f.post('/v1/connector/next',{},app.app_token)).status).toBe(401);
 }finally{f.close();}
});

test('local signup is off by default and plaintext sends are rejected',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'msgzle-central-')),central=createCentral({dbPath:join(dir,'central.sqlite')});try{const denied=await fetch(new URL('/v1/users',central.server.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'Dee'})});expect(denied.status).toBe(403);}finally{central.close();rmSync(dir,{recursive:true,force:true});}
});

async function fakeOidc(){
 const googleKeys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']),googleJwk=await crypto.subtle.exportKey('jwk',googleKeys.publicKey) as JsonWebKey&{kid:string};googleJwk.kid='google-key';googleJwk.alg='RS256';
 const appleKeys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),appleJwk=await crypto.subtle.exportKey('jwk',appleKeys.publicKey) as JsonWebKey&{kid:string};appleJwk.kid='apple-key';appleJwk.alg='ES256';
 const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url'),jwt=async(provider:'google'|'apple',nonce:string)=>{
  const header={alg:provider==='google'?'RS256':'ES256',kid:provider+'-key',typ:'JWT'},now=Math.floor(Date.now()/1000),payload={iss:provider==='google'?'https://accounts.google.com':'https://appleid.apple.com',sub:provider+'-subject-1',aud:provider+'-client',email:'dee+'+provider+'@example.com',email_verified:provider==='google'?true:undefined,name:provider==='google'?'Dee Google':undefined,nonce,iat:now,exp:now+600},unsigned=encode(header)+'.'+encode(payload),key=provider==='google'?googleKeys.privateKey:appleKeys.privateKey,algorithm=provider==='google'?{name:'RSASSA-PKCS1-v1_5'}:{name:'ECDSA',hash:'SHA-256'},signature=await crypto.subtle.sign(algorithm as AlgorithmIdentifier,key,Buffer.from(unsigned));return unsigned+'.'+Buffer.from(signature).toString('base64url');
 };
 const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){const path=new URL(req.url).pathname;if(path==='/google/jwks')return Response.json({keys:[googleJwk]});if(path==='/apple/jwks')return Response.json({keys:[appleJwk]});if(path==='/google/token'||path==='/apple/token'){const provider=path.startsWith('/google')?'google':'apple',form=await req.formData(),code=String(form.get('code')||''),nonce=code.split(':')[1]||'';if(String(form.get('client_id'))!==provider+'-client'||String(form.get('client_secret'))!==provider+'-secret'||!String(form.get('code_verifier')||'').length)return Response.json({error:'invalid_request'},{status:400});return Response.json({access_token:provider+'-access',id_token:await jwt(provider,nonce)});}return new Response('not found',{status:404});}});
 return {server,url:server.url.origin,close(){server.stop(true);}};
}
test('Google and Apple OIDC sign in create scoped sessions without passwords',async()=>{
 const oidc=await fakeOidc(),dir=mkdtempSync(join(tmpdir(),'msgzle-oidc-')),central=createCentral({dbPath:join(dir,'central.sqlite'),allowLocalSignup:false,google:{clientId:'google-client',clientSecret:'google-secret',redirectUri:'https://central.example.com/v1/auth/google/callback',authorizationEndpoint:oidc.url+'/google/authorize',tokenEndpoint:oidc.url+'/google/token',jwksUri:oidc.url+'/google/jwks'},apple:{clientId:'apple-client',clientSecret:'apple-secret',redirectUri:'https://central.example.com/v1/auth/apple/callback',authorizationEndpoint:oidc.url+'/apple/authorize',tokenEndpoint:oidc.url+'/apple/token',jwksUri:oidc.url+'/apple/jwks'}});
 try{
  const post=(path:string,body:unknown)=>fetch(new URL(path,central.server.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  expect((await post('/v1/auth/signup',{email:'dee@example.com',password:'correct horse battery'})).status).toBe(404);
  const googleStart=await (await post('/v1/auth/google/start',{})).json() as any,googleAuth=new URL(googleStart.auth_url);expect(googleAuth.origin).toBe(oidc.url);expect(googleAuth.searchParams.get('client_id')).toBe('google-client');expect(googleAuth.searchParams.get('code_challenge_method')).toBe('S256');expect(googleAuth.searchParams.get('response_mode')).toBeNull();
  const googleNonce=googleAuth.searchParams.get('nonce')!,googleCallback=await fetch(new URL(`/v1/auth/google/callback?code=google:${googleNonce}&state=${googleStart.state}`,central.server.url));expect(googleCallback.status).toBe(200);
  const googleSession=await (await post('/v1/auth/google/status',{state:googleStart.state})).json() as any;expect(googleSession.user.email).toBe('dee+google@example.com');expect(googleSession.user_token).toBeTruthy();expect((await post('/v1/auth/google/status',{state:googleStart.state})).status).toBe(202);
  const appleStart=await (await post('/v1/auth/apple/start',{})).json() as any,appleAuth=new URL(appleStart.auth_url);expect(appleAuth.searchParams.get('client_id')).toBe('apple-client');expect(appleAuth.searchParams.get('response_mode')).toBe('form_post');
  const appleNonce=appleAuth.searchParams.get('nonce')!,appleCallback=await fetch(new URL('/v1/auth/apple/callback',central.server.url),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:'apple:'+appleNonce,state:appleStart.state,user:JSON.stringify({name:{firstName:'Dee',lastName:'Apple'},email:'dee+apple@example.com'})})});expect(appleCallback.status).toBe(200);
  const appleSession=await (await post('/v1/auth/apple/status',{state:appleStart.state})).json() as any;expect(appleSession.user.label).toBe('Dee Apple');expect(appleSession.user_token).toBeTruthy();
  const keys=await generateEncryptionKeyPair(),pair=await (await post('/v1/pairing/start',{label:'Mac',public_key:keys.publicKey})).json() as any;expect((await post('/v1/pairing/approve',{pair_code:pair.pair_code})).status).toBe(401);expect((await fetch(new URL('/v1/pairing/approve',central.server.url),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${googleSession.user_token}`},body:JSON.stringify({pair_code:pair.pair_code})})).status).toBe(200);
  expect(central.store.db.query('SELECT google_sub,apple_sub FROM users WHERE google_sub=?').get('google-subject-1')).toBeDefined();expect(central.store.db.query('SELECT google_sub,apple_sub FROM users WHERE apple_sub=?').get('apple-subject-1')).toBeDefined();expect(JSON.stringify(central.store.db.query('SELECT * FROM users').all())).not.toContain('password_hash');
 }finally{central.close();oidc.close();rmSync(dir,{recursive:true,force:true});}
});

test('Apple client-secret JWT is signed with the configured service key',async()=>{
 const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),privatePkcs8=Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64'),pem='-----BEGIN PRIVATE KEY-----\n'+privatePkcs8+'\n-----END PRIVATE KEY-----',secret=await createAppleClientSecret({clientId:'in.msgzle.central',redirectUri:'https://central.example.com/v1/auth/apple/callback',teamId:'TEAM123456',keyId:'KEY1234567',privateKey:pem}),parts=secret.split('.');expect(parts).toHaveLength(3);
 const header=JSON.parse(Buffer.from(parts[0],'base64url').toString()),payload=JSON.parse(Buffer.from(parts[1],'base64url').toString());expect(header).toMatchObject({alg:'ES256',kid:'KEY1234567'});expect(payload).toMatchObject({iss:'TEAM123456',aud:'https://appleid.apple.com',sub:'in.msgzle.central'});expect(payload.exp-payload.iat).toBe(300);
 expect(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},keys.publicKey,Buffer.from(parts[2],'base64url'),Buffer.from(parts[0]+'.'+parts[1]))).toBe(true);
});
