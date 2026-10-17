import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createCentral} from '../src/central';import {decryptFromDevice,encryptForDevice,generateEncryptionKeyPair} from '../../sdk/src/central-crypto';import {MsgzleCentral} from '../../sdk/src/central-client';
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
test('real password signup and sign-in issue scoped sessions without storing plaintext',async()=>{
 const f=await fixture();try{
  const email='dee@example.com',password='correct horse battery';
  const signed=await f.post('/v1/auth/signup',{email,password,label:'Dee'});expect(signed.status).toBe(201);expect(f.central.store.db.query('SELECT password_hash FROM users WHERE email=?').get(email) as any).toBeDefined();expect(JSON.stringify(f.central.store.db.query('SELECT * FROM users WHERE email=?').get(email))).not.toContain(password);
  expect((await f.post('/v1/auth/signup',{email,password})).status).toBe(409);expect((await f.post('/v1/auth/sign-in',{email,password:'wrong password'})).status).toBe(401);
  const session=await (await f.post('/v1/auth/sign-in',{email,password})).json() as any,keys=await generateEncryptionKeyPair(),pair=await (await f.post('/v1/pairing/start',{label:'Mac',public_key:keys.publicKey})).json() as any;expect((await f.post('/v1/pairing/approve',{pair_code:pair.pair_code},session.user_token)).status).toBe(200);
 }finally{f.close();}
});
