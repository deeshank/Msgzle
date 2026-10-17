import {CentralStore,type CommandState} from './store';
import {isEncryptedEnvelope,isEncryptionPublicKey} from '../../sdk/src/central-crypto';
export interface CentralOptions {dbPath:string;host?:string;port?:string|number;origin?:string;allowLocalSignup?:boolean;}
const text=(s:unknown,max=80)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
const result=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function bearer(req:Request):string|null{const got=req.headers.get('authorization');return got?.startsWith('Bearer ')?got.slice(7):null;}
export function createCentral(opts:CentralOptions){
 const store=new CentralStore(opts.dbPath),origin=opts.origin;
 const server=Bun.serve({hostname:opts.host??'127.0.0.1',port:Number(opts.port??0),maxRequestBodySize:65536,async fetch(req){
  const url=new URL(req.url),expectedOrigin=origin??url.origin;
  if(req.headers.get('host')!==new URL(expectedOrigin).host)return result({error:'Host rejected'},403);
  if(req.headers.has('origin')&&req.headers.get('origin')!==expectedOrigin)return result({error:'Origin rejected'},403);
  try{
   const path=url.pathname;
   if(path==='/v1/health'&&req.method==='GET')return result({version:'0.0.0',role:'central',receive:false});
   if(path==='/v1/users'&&req.method==='POST'){if(opts.allowLocalSignup!==true)return result({error:'Signup provider required'},403);const b=await req.json();if(!text(b.label))return result({error:'Invalid label'},400);const made=store.createUser(b.label.trim());return result({user:made.user,user_token:made.userToken},201);}
   if(path==='/v1/auth/signup'&&req.method==='POST'){const b=await req.json();if(!text(b.email,254)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)||typeof b.password!=='string'||b.password.length<12||b.password.length>256)return result({error:'Valid email and 12+ character password required'},400);const made=store.createAccount(b.email.toLowerCase(),b.password,text(b.label,80)?b.label.trim():undefined);return made?result({user:made.user,user_token:made.userToken},201):result({error:'Account already exists'},409);}
   if(path==='/v1/auth/sign-in'&&req.method==='POST'){const b=await req.json();if(!text(b.email,254)||typeof b.password!=='string')return result({error:'Email and password required'},400);const email=b.email.toLowerCase(),key=email+':'+(req.headers.get('cf-connecting-ip')||'local');if(!store.authAllowed(key))return result({error:'Too many sign-in attempts'},429);const made=store.signIn(email,b.password);if(!made)return result({error:'Invalid email or password'},401);store.clearAuthAttempts(key);return result({user:made.user,user_token:made.userToken});}
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
