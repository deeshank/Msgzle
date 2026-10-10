import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { Store } from './store';
import { ui, setupJs } from './ui';
export interface Config { token:string; connectorToken:string; sendEnabled:boolean; recipients:string[]; allowEveryone?:boolean; rateLimit?:number; retryCap?:number; debug?:boolean; relayUrl?:string; relayToken?:string; }
export function loadConfig(dir:string):Config {
 mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);const p=join(dir,'config.json');
 if(!existsSync(p))writeFileSync(p,JSON.stringify({token:randomBytes(32).toString('hex'),connectorToken:randomBytes(32).toString('hex'),sendEnabled:false,recipients:[]},null,2),{mode:0o600});
 chmodSync(p,0o600);const c=JSON.parse(readFileSync(p,'utf8'));if(!c.token||c.token.length<32||!c.connectorToken||c.connectorToken.length<32||typeof c.sendEnabled!=='boolean'||!Array.isArray(c.recipients))throw Error('Invalid local config');if(c.allowEveryone!==undefined&&typeof c.allowEveryone!=='boolean'||c.rateLimit!==undefined&&(!Number.isInteger(c.rateLimit)||c.rateLimit<1||c.rateLimit>120)||c.retryCap!==undefined&&(!Number.isInteger(c.retryCap)||c.retryCap<0||c.retryCap>3)||c.debug!==undefined&&typeof c.debug!=='boolean')throw Error('Invalid policy config');return c;
}
export function createApp(opts:{dir:string;role:'mac'|'relay';port?:number;host?:string;origin?:string;preflight?:()=>Promise<void>;send?:(to:string,text:string)=>Promise<void>}) {
 let config=loadConfig(opts.dir);const store=new Store(join(opts.dir,'commands.sqlite'));chmodSync(join(opts.dir,'commands.sqlite'),0o600);let connectedAt=0;let lastAttempt=0;
 const valid=(got:string|null,key:string)=>{const value=got??'';const x=Buffer.from(value);const y=Buffer.from(`Bearer ${key}`);return x.length===y.length&&timingSafeEqual(x,y);};
 const allowed=(to:unknown)=>typeof to==='string'&&to.length<200&&/^([+]\d{7,15}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(to)&&(config.allowEveryone===true||config.recipients.includes(to));
 const diagnostic=(event:string)=>{if(config.debug)console.log('Diagnostic: '+event);};
 const save=()=>writeFileSync(join(opts.dir,'config.json'),JSON.stringify(config,null,2),{mode:0o600});
 const result=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
 const server=Bun.serve({hostname:opts.host??'127.0.0.1',port:opts.port??19791,maxRequestBodySize:16384,async fetch(req){
  const url=new URL(req.url);const origin=opts.origin??url.origin;
  if(req.headers.get('host')!==new URL(origin).host)return result({error:'Host rejected'},403);
  if(req.headers.has('origin')&&req.headers.get('origin')!==origin)return result({error:'Origin rejected'},403);
  const path=url.pathname;
  if(path==='/'&&req.method==='GET'&&opts.role==='mac')return new Response('Open Settings from the Msgzle menu-bar icon.',{headers:{'content-type':'text/plain','cache-control':'no-store'}});
  if(path==='/'&&req.method==='GET')return new Response(ui,{headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",'cache-control':'no-store'}});
  if(path==='/setup.js'&&req.method==='GET')return new Response(setupJs,{headers:{'content-type':'text/javascript'}});
  const isConnector=path.startsWith('/connector/');
  if(!valid(req.headers.get('authorization'),isConnector?config.connectorToken:config.token))return result({error:'Unauthorized'},401);
  try {
   if(path==='/v1/health'&&req.method==='GET')return result({version:'0.0.2',instance:process.env.MSGZLE_INSTANCE,role:opts.role,connected:opts.role==='mac'||Date.now()-connectedAt<15000,sendEnabled:config.sendEnabled,allowlistCount:config.recipients.length,allowEveryone:config.allowEveryone===true,lastSend:store.latest(),receive:false});
   if(path==='/admin/config'&&req.method==='GET')return result({sendEnabled:config.sendEnabled,recipients:config.recipients,allowEveryone:config.allowEveryone===true,rateLimit:config.rateLimit??6,retryCap:config.retryCap??0,debug:config.debug===true,relayUrl:config.relayUrl});
   if(path==='/admin/config'&&req.method==='POST') {const b=await req.json();if(typeof b.sendEnabled!=='boolean'||!Array.isArray(b.recipients)||b.recipients.length>50||!b.recipients.every((s:any)=>typeof s==='string'&&s.length<200&&/^([+]\d{7,15}|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(s)))return result({error:'Invalid settings'},400);if(b.allowEveryone!==undefined&&typeof b.allowEveryone!=='boolean'||b.rateLimit!==undefined&&(!Number.isInteger(b.rateLimit)||b.rateLimit<1||b.rateLimit>120)||b.retryCap!==undefined&&(!Number.isInteger(b.retryCap)||b.retryCap<0||b.retryCap>3)||b.debug!==undefined&&typeof b.debug!=='boolean')return result({error:'Invalid policy'},400);config={...config,sendEnabled:b.sendEnabled,recipients:b.recipients,allowEveryone:b.allowEveryone??false,rateLimit:b.rateLimit??6,retryCap:b.retryCap??0,debug:b.debug??false};save();return result({sendEnabled:config.sendEnabled,recipients:config.recipients});}
   if(path==='/admin/relay'&&req.method==='POST') {if(opts.role!=='mac')return result({error:'Mac only'},400);const b=await req.json();const u=new URL(b.url);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||typeof b.token!=='string'||b.token.length<32) return result({error:'HTTPS URL and connector token required'},400);config.relayUrl=u.origin;config.relayToken=b.token;save();return result({saved:true});}
   if(path==='/v1/commands'&&req.method==='POST') {const b=await req.json();if(!config.sendEnabled||!allowed(b.to))return result({error:'Sending disabled or recipient not allowed'},403);if(typeof b.id!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(b.id)||typeof b.text!=='string'||!b.text.trim()||b.text.length>4000)return result({error:'Invalid command'},400);return result(store.add({id:b.id,to:b.to,text:b.text}),202);}
   const match=path.match(/^\/v1\/commands\/([A-Za-z0-9_-]+)(\/cancel)?$/);
   if(match){const c=store.get(match[1]);if(!c)return result({error:'Not found'},404);if(match[2]&&req.method==='POST'){store.transition(c.id,'queued','cancelled');return result(store.get(c.id));}if(!match[2]&&req.method==='GET')return result(c);}
   if(path==='/connector/next'&&req.method==='POST'&&opts.role==='relay') {connectedAt=Date.now();const c=store.next();if(!c)return result({command:null});if(!store.transition(c.id,'queued','attempting'))return result({command:null});return result({command:store.get(c.id)});}
   if(path==='/connector/result'&&req.method==='POST'&&opts.role==='relay') {const b=await req.json();if(!['dispatch-accepted','uncertain'].includes(b.state)||typeof b.id!=='string')return result({error:'Invalid result'},400);store.transition(b.id,'attempting',b.state);return result({saved:true});}
   return result({error:'Not found'},404);
  }catch{return result({error:'Request could not be processed'},400);}
 }});
 let busy=false;
 const poll=setInterval(async()=>{
  if(busy||opts.role!=='mac'||!config.sendEnabled||!opts.send||Date.now()-lastAttempt<60000/(config.rateLimit??6))return;busy=true;
  try{
   if(opts.preflight){for(let attempt=0;;attempt++){try{await opts.preflight();break;}catch(error){if(attempt>=(config.retryCap??0))throw error;await Bun.sleep(500*(attempt+1));}}}
   if(config.relayUrl&&config.relayToken){const call=async(path:string,body:unknown)=>{const r=await fetch(new URL(path,config.relayUrl),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{authorization:`Bearer ${config.relayToken}`,'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Relay request failed');return r.json();};
    const {command}=await call('/connector/next',{});if(command){let c=store.get(command.id);if(!c){c=store.add(command);store.transition(c.id,'queued','attempting');if(allowed(c.to)){try{lastAttempt=Date.now();diagnostic('dispatch started');await opts.send(c.to,c.text);store.transition(c.id,'attempting','dispatch-accepted');}catch{diagnostic('dispatch uncertain');store.transition(c.id,'attempting','uncertain');}}else store.transition(c.id,'attempting','uncertain');}
     await call('/connector/result',{id:command.id,state:store.get(command.id)?.state==='dispatch-accepted'?'dispatch-accepted':'uncertain'});
    }
   }else{const c=store.next();if(c&&store.transition(c.id,'queued','attempting')){if(allowed(c.to)){try{lastAttempt=Date.now();diagnostic('dispatch started');await opts.send(c.to,c.text);store.transition(c.id,'attempting','dispatch-accepted');}catch{diagnostic('dispatch uncertain');store.transition(c.id,'attempting','uncertain');}}else store.transition(c.id,'attempting','uncertain');}}
  }catch{/* Redacted failure: do not retry an uncertain dispatch. */}finally{busy=false;}
 },2000);
 return {server,store,close(){clearInterval(poll);server.stop(true);store.close();}};
}
if(import.meta.main){try {const role=process.env.MSGZLE_ROLE==='relay'?'relay':'mac';const dir=process.env.MSGZLE_DATA_DIR??join(homedir(),'Library','Application Support','Msgzle');let preflight:(()=>Promise<void>)|undefined;let send:((to:string,text:string)=>Promise<void>)|undefined;
 if(role==='mac'){if(process.platform!=='darwin')throw Error('Mac role requires macOS. Use MSGZLE_ROLE=relay for a cloud server.');const {MsgzleSendOnly}=await import('@photon-ai/imessage-kit');const sdk=new MsgzleSendOnly();preflight=()=>sdk.preflight();send=(to,text)=>sdk.send({to,text});}
 const app=createApp({dir,role,send,preflight,host:process.env.MSGZLE_HOST??'127.0.0.1',port:Number(process.env.MSGZLE_PORT??19791),origin:process.env.MSGZLE_ORIGIN});console.log(`Msgzle ${role}: ${app.server.url.origin}`);
 process.on('SIGTERM',()=>{app.close();process.exit(0);});
 } catch(error) { const code=(error as {code?:string})?.code; console.error(code==='EADDRINUSE'?'Startup failed: port is already in use.':code==='EACCES'?'Startup failed: file or port access denied.':'Startup failed: service initialization failed.'); process.exit(1); }
                    }
