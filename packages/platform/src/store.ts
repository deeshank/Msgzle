import {Database} from 'bun:sqlite';
import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {isEncryptedEnvelope,type EncryptedEnvelope} from '../../sdk/src/central-crypto';
export type CommandState='queued'|'attempting'|'dispatch-accepted'|'uncertain'|'cancelled'|'policy-rejected';
export interface User {id:string;label:string;email?:string;createdAt:number;}
export interface Device {id:string;userId:string|null;label:string;publicKey:JsonWebKey;status:'pending'|'active';createdAt:number;}
export interface App {id:string;ownerUserId:string;name:string;publicKey:JsonWebKey;createdAt:number;}
export interface Grant {id:string;userId:string;deviceId:string;appId:string;scopes:string[];status:'active'|'revoked';createdAt:number;}
export interface CentralCommand {id:string;grantId:string;state:CommandState;createdAt:number;updatedAt:number;envelope?:EncryptedEnvelope;}
const now=()=>Date.now(),id=(prefix:string)=>prefix+'_'+randomBytes(12).toString('hex'),token=()=>randomBytes(32).toString('hex'),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function rowUser(r:any):User{return {id:r.id,label:r.label,email:r.email||undefined,createdAt:r.created_at};}
function rowDevice(r:any):Device{return {id:r.id,userId:r.user_id,label:r.label,publicKey:JSON.parse(r.public_key),status:r.status,createdAt:r.created_at};}
function rowApp(r:any):App{return {id:r.id,ownerUserId:r.owner_user_id,name:r.name,publicKey:JSON.parse(r.public_key),createdAt:r.created_at};}
function rowGrant(r:any):Grant{return {id:r.id,userId:r.user_id,deviceId:r.device_id,appId:r.app_id,scopes:JSON.parse(r.scopes),status:r.status,createdAt:r.created_at};}
function rowCommand(r:any,envelope=false):CentralCommand{return {id:r.id,grantId:r.grant_id,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at,...(envelope?{envelope:JSON.parse(r.envelope)}:{})};}
export class CentralStore {
 readonly db:Database;
 constructor(path:string){
  this.db=new Database(path,{create:true});
  this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,label TEXT NOT NULL,email TEXT UNIQUE,password_hash TEXT,token_hash TEXT UNIQUE,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_attempts(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),label TEXT NOT NULL,public_key TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,pair_code TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,owner_user_id TEXT REFERENCES users(id),name TEXT NOT NULL,public_key TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),device_id TEXT NOT NULL REFERENCES devices(id),app_id TEXT NOT NULL REFERENCES apps(id),scopes TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(device_id,app_id));
   CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES grants(id),app_id TEXT NOT NULL,device_id TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  this.db.query("UPDATE commands SET state='uncertain',updated_at=? WHERE state='attempting'").run(now());
 }
 close(){this.db.close();}
 createUser(label:string):{user:User;userToken:string}{const user={id:id('usr'),label,createdAt:now()},userToken=token();this.db.query('INSERT INTO users VALUES (?,?,?,?,?,?)').run(user.id,label,null,null,hash(userToken),user.createdAt);return {user,userToken};}
 createAccount(email:string,password:string,label?:string):{user:User;userToken:string}|undefined{
  const existing=this.db.query('SELECT id FROM users WHERE email=?').get(email);if(existing)return undefined;const user={id:id('usr'),label:label||email,email,createdAt:now()},salt=randomBytes(16).toString('hex'),passwordHash='scrypt:'+salt+':'+scryptSync(password,salt,64).toString('hex');
  this.db.query('INSERT INTO users VALUES (?,?,?,?,?,?)').run(user.id,user.label,email,passwordHash,null,user.createdAt);const userToken=this.createSession(user.id);return {user,userToken};
 }
 signIn(email:string,password:string):{user:User;userToken:string}|undefined{const r=this.db.query('SELECT * FROM users WHERE email=?').get(email) as any;if(!r||typeof r.password_hash!=='string')return undefined;const parts=r.password_hash.split(':');if(parts.length!==3||parts[0]!=='scrypt')return undefined;const got=scryptSync(password,parts[1],64),want=Buffer.from(parts[2],'hex');if(got.length!==want.length||!timingSafeEqual(got,want))return undefined;const user=rowUser(r),userToken=this.createSession(user.id);return {user,userToken};}
 createSession(userId:string):string{const session=token(),created=now();this.db.query('INSERT INTO auth_sessions VALUES (?,?,?,?)').run(hash(session),userId,created,created+30*24*3600*1000);return session;}
 authAllowed(key:string):boolean{const window=Math.floor(now()/600000),r=this.db.query('SELECT * FROM auth_attempts WHERE key=?').get(key) as any;if(!r||r.window!==window){this.db.query('INSERT OR REPLACE INTO auth_attempts VALUES (?,?,?)').run(key,window,1);return true;}if(r.count>=10)return false;this.db.query('UPDATE auth_attempts SET count=count+1 WHERE key=?').run(key);return true;}
 clearAuthAttempts(key:string){this.db.query('DELETE FROM auth_attempts WHERE key=?').run(key);}
 userByToken(userToken:string):User|undefined{const tokenHash=hash(userToken);let r=this.db.query('SELECT id,label,email,created_at FROM users WHERE token_hash=?').get(tokenHash) as any;if(r)return rowUser(r);r=this.db.query('SELECT u.id,u.label,u.email,u.created_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash,now()) as any;return r?rowUser(r):undefined;}
 startPairing(label:string,publicKey:JsonWebKey):{device:Device;pairCode:string;deviceToken:string}{const deviceToken=token(),alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=randomBytes(8),raw=Array.from(bytes,b=>alphabet[b%alphabet.length]).join(''),pairCode=raw.slice(0,4)+'-'+raw.slice(4),userId=null,createdAt=now(),deviceId=id('dev');this.db.query('INSERT INTO devices VALUES (?,?,?,?,?,?,?,?)').run(deviceId,userId,label,JSON.stringify(publicKey),hash(deviceToken),pairCode,'pending',createdAt);return {device:{id:deviceId,userId,label,publicKey,status:'pending',createdAt},pairCode,deviceToken};}
 approvePairing(userId:string,pairCode:string):Device|undefined{const r=this.db.query("SELECT * FROM devices WHERE pair_code=? AND status='pending'").get(pairCode) as any;if(!r)return undefined;this.db.query("UPDATE devices SET user_id=?,pair_code=NULL,status='active' WHERE id=? AND status='pending'").run(userId,r.id);return this.device(r.id);}
 device(id:string):Device|undefined{const r=this.db.query('SELECT * FROM devices WHERE id=?').get(id) as any;return r?rowDevice(r):undefined;}
 deviceByToken(deviceToken:string):Device|undefined{const r=this.db.query("SELECT * FROM devices WHERE token_hash=? AND status='active'").get(hash(deviceToken)) as any;return r?rowDevice(r):undefined;}
 createApp(ownerUserId:string,name:string,publicKey:JsonWebKey):{app:App;appToken:string}{const app={id:id('app'),ownerUserId,name,publicKey,createdAt:now()},appToken=token();this.db.query('INSERT INTO apps VALUES (?,?,?,?,?,?)').run(app.id,ownerUserId,name,JSON.stringify(publicKey),hash(appToken),app.createdAt);return {app,appToken};}
 app(id:string):App|undefined{const r=this.db.query('SELECT * FROM apps WHERE id=?').get(id) as any;return r?rowApp(r):undefined;}
 appByToken(appToken:string):App|undefined{const r=this.db.query('SELECT * FROM apps WHERE token_hash=?').get(hash(appToken)) as any;return r?rowApp(r):undefined;}
 createGrant(userId:string,deviceId:string,appId:string,scopes:string[]):Grant|undefined{
  const device=this.device(deviceId),app=this.app(appId);if(!device||!app||device.userId!==userId||device.status!=='active')return undefined;
  const existing=this.db.query('SELECT * FROM grants WHERE device_id=? AND app_id=?').get(deviceId,appId) as any;if(existing)return rowGrant(existing);
  const grant={id:id('grt'),userId,deviceId,appId,scopes,status:'active' as const,createdAt:now()};this.db.query('INSERT INTO grants VALUES (?,?,?,?,?,?,?)').run(grant.id,userId,deviceId,appId,JSON.stringify(scopes),grant.status,grant.createdAt);return grant;
 }
 grant(id:string):Grant|undefined{const r=this.db.query('SELECT * FROM grants WHERE id=?').get(id) as any;return r?rowGrant(r):undefined;}
 sendCommand(appId:string,grantId:string,commandId:string,envelope:EncryptedEnvelope):{command?:CentralCommand;error?:string;status:number}{
  const grant=this.grant(grantId);if(!grant||grant.appId!==appId||grant.status!=='active'||!grant.scopes.includes('messages.send'))return {error:'Grant not available',status:403};
  const old=this.db.query('SELECT * FROM commands WHERE id=?').get(commandId) as any;if(old){if(old.grant_id!==grantId||old.app_id!==appId||old.envelope!==JSON.stringify(envelope))return {error:'Command ID already has different content',status:409};return {command:rowCommand(old),status:200};}
  const ts=now();this.db.query('INSERT INTO commands VALUES (?,?,?,?,?,?,?,?)').run(commandId,grantId,appId,grant.deviceId,JSON.stringify(envelope),'queued',ts,ts);return {command:this.commandForApp(appId,commandId,true),status:202};
 }
 nextCommand(deviceId:string):CentralCommand|undefined{
  const row=this.db.query("SELECT c.* FROM commands c JOIN grants g ON g.id=c.grant_id WHERE c.device_id=? AND c.state='queued' AND g.status='active' ORDER BY c.created_at LIMIT 1").get(deviceId) as any;if(!row)return undefined;
  const changed=this.db.query("UPDATE commands SET state='attempting',updated_at=? WHERE id=? AND state='queued'").run(now(),row.id).changes===1;return changed?rowCommand({...row,state:'attempting',updated_at:now()},true):undefined;
 }
 finishCommand(deviceId:string,commandId:string,state:CommandState):CentralCommand|undefined{const changed=this.db.query("UPDATE commands SET state=?,updated_at=? WHERE id=? AND device_id=? AND state='attempting'").run(state,now(),commandId,deviceId).changes===1;if(!changed)return undefined;const r=this.db.query('SELECT * FROM commands WHERE id=?').get(commandId) as any;return r?rowCommand(r):undefined;}
 commandForApp(appId:string,commandId:string,envelope=false):CentralCommand|undefined{const r=this.db.query('SELECT * FROM commands WHERE id=? AND app_id=?').get(commandId,appId) as any;return r?rowCommand(r,envelope):undefined;}
 rawCommandEnvelope(commandId:string):string|undefined{const r=this.db.query('SELECT envelope FROM commands WHERE id=?').get(commandId) as any;return r?.envelope;}
}
