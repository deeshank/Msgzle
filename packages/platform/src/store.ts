import {Database} from 'bun:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {isEncryptedEnvelope,type EncryptedEnvelope} from '../../sdk/src/central-crypto';
export type CommandState='queued'|'attempting'|'dispatch-accepted'|'uncertain'|'cancelled'|'policy-rejected';
export type AuthProvider='google'|'apple';
export interface User {id:string;label:string;email?:string;googleSub?:string;appleSub?:string;createdAt:number;}
export interface Device {id:string;userId:string|null;label:string;publicKey:JsonWebKey;status:'pending'|'active';createdAt:number;}
export interface App {id:string;ownerUserId:string;name:string;publicKey:JsonWebKey;createdAt:number;}
export interface Grant {id:string;userId:string;deviceId:string;appId:string;scopes:string[];status:'active'|'revoked';createdAt:number;}
export interface CentralCommand {id:string;grantId:string;state:CommandState;createdAt:number;updatedAt:number;envelope?:EncryptedEnvelope;}
export interface OidcProfile {sub:string;email?:string;name?:string;}
export interface OidcLogin {state:string;nonce:string;codeVerifier:string;}
const now=()=>Date.now(),id=(prefix:string)=>prefix+'_'+randomBytes(12).toString('hex'),token=()=>randomBytes(32).toString('hex'),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function rowUser(r:any):User{return {id:r.id,label:r.label,email:r.email||undefined,googleSub:r.google_sub||undefined,appleSub:r.apple_sub||undefined,createdAt:r.created_at};}
function rowDevice(r:any):Device{return {id:r.id,userId:r.user_id,label:r.label,publicKey:JSON.parse(r.public_key),status:r.status,createdAt:r.created_at};}
function rowApp(r:any):App{return {id:r.id,ownerUserId:r.owner_user_id,name:r.name,publicKey:JSON.parse(r.public_key),createdAt:r.created_at};}
function rowGrant(r:any):Grant{return {id:r.id,userId:r.user_id,deviceId:r.device_id,appId:r.app_id,scopes:JSON.parse(r.scopes),status:r.status,createdAt:r.created_at};}
function rowCommand(r:any,envelope=false):CentralCommand{return {id:r.id,grantId:r.grant_id,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at,...(envelope?{envelope:JSON.parse(r.envelope)}:{})};}
export class CentralStore {
 readonly db:Database;
 constructor(path:string){
  this.db=new Database(path,{create:true});
  this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,label TEXT NOT NULL,email TEXT,google_sub TEXT UNIQUE,apple_sub TEXT UNIQUE,token_hash TEXT UNIQUE,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS auth_attempts(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS oidc_logins(provider TEXT NOT NULL,state_hash TEXT PRIMARY KEY,nonce_hash TEXT NOT NULL,code_verifier TEXT NOT NULL,user_id TEXT REFERENCES users(id),session_token_hash TEXT,error TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),label TEXT NOT NULL,public_key TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,pair_code TEXT,status TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,owner_user_id TEXT REFERENCES users(id),name TEXT NOT NULL,public_key TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),device_id TEXT NOT NULL REFERENCES devices(id),app_id TEXT NOT NULL REFERENCES apps(id),scopes TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(device_id,app_id));
   CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES grants(id),app_id TEXT NOT NULL,device_id TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  this.db.query("UPDATE commands SET state='uncertain',updated_at=? WHERE state='attempting'").run(now());
  this.db.query('DELETE FROM oidc_logins WHERE expires_at<?').run(now());
 }
 close(){this.db.close();}
 createUser(label:string):{user:User;userToken:string}{const user={id:id('usr'),label,createdAt:now()},userToken=token();this.db.query('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(user.id,label,null,null,null,hash(userToken),user.createdAt);return {user,userToken};}
 createSession(userId:string):string{const session=token(),created=now();this.db.query('INSERT INTO auth_sessions VALUES (?,?,?,?)').run(hash(session),userId,created,created+30*24*3600*1000);return session;}
 authAllowed(key:string):boolean{const window=Math.floor(now()/600000),r=this.db.query('SELECT * FROM auth_attempts WHERE key=?').get(key) as any;if(!r||r.window!==window){this.db.query('INSERT OR REPLACE INTO auth_attempts VALUES (?,?,?)').run(key,window,1);return true;}if(r.count>=20)return false;this.db.query('UPDATE auth_attempts SET count=count+1 WHERE key=?').run(key);return true;}
 startOidcLogin(provider:AuthProvider):OidcLogin{const state=randomBytes(24).toString('base64url'),nonce=randomBytes(24).toString('base64url'),codeVerifier=randomBytes(48).toString('base64url'),created=now();this.db.query('INSERT INTO oidc_logins VALUES (?,?,?,?,?,?,?,?,?)').run(provider,hash(state),hash(nonce),codeVerifier,null,null,null,created,created+600000);return {state,nonce,codeVerifier};}
 pendingOidcLogin(provider:AuthProvider,state:string):{nonceHash:string;codeVerifier:string}|undefined{const r=this.db.query('SELECT nonce_hash,code_verifier FROM oidc_logins WHERE provider=? AND state_hash=? AND expires_at>? AND session_token_hash IS NULL AND error IS NULL').get(provider,hash(state),now()) as any;return r?{nonceHash:r.nonce_hash,codeVerifier:r.code_verifier}:undefined;}
 completeOidcLogin(provider:AuthProvider,state:string,profile:OidcProfile):User|undefined{const pending=this.pendingOidcLogin(provider,state);if(!pending)return undefined;const column=provider==='google'?'google_sub':'apple_sub';let r=this.db.query(`SELECT * FROM users WHERE ${column}=?`).get(profile.sub) as any;if(!r){const user={id:id('usr'),label:profile.name||profile.email||`${provider} user`,email:profile.email||null,googleSub:provider==='google'?profile.sub:null,appleSub:provider==='apple'?profile.sub:null,createdAt:now()};this.db.query('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(user.id,user.label,user.email,user.googleSub,user.appleSub,null,user.createdAt);r=this.db.query('SELECT * FROM users WHERE id=?').get(user.id) as any;}const user=rowUser(r);this.db.query("UPDATE oidc_logins SET user_id=?,session_token_hash='ready' WHERE state_hash=?").run(user.id,hash(state));return user;}
 failOidcLogin(state:string,error:string){this.db.query('UPDATE oidc_logins SET error=? WHERE state_hash=?').run(error.slice(0,120),hash(state));}
 consumeOidcLogin(provider:AuthProvider,state:string):{user:User;userToken:string}|undefined{const r=this.db.query("SELECT u.* FROM oidc_logins l JOIN users u ON u.id=l.user_id WHERE l.provider=? AND l.state_hash=? AND l.session_token_hash='ready'").get(provider,hash(state)) as any;if(!r)return undefined;this.db.query('DELETE FROM oidc_logins WHERE state_hash=?').run(hash(state));const user=rowUser(r),userToken=this.createSession(user.id);return {user,userToken};}
 userByToken(userToken:string):User|undefined{const tokenHash=hash(userToken);let r=this.db.query('SELECT id,label,email,google_sub,apple_sub,created_at FROM users WHERE token_hash=?').get(tokenHash) as any;if(r)return rowUser(r);r=this.db.query('SELECT u.id,u.label,u.email,u.google_sub,u.apple_sub,u.created_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash,now()) as any;return r?rowUser(r):undefined;}
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
  const changed=this.db.query("UPDATE commands SET state='attempting',updated_at=? WHERE id=? AND state='queued'").run(now(),row.id).changes===1;return changed?rowCommand({...row,state:'attempting',updatedAt:now()},true):undefined;
 }
 finishCommand(deviceId:string,commandId:string,state:CommandState):CentralCommand|undefined{const changed=this.db.query("UPDATE commands SET state=?,updated_at=? WHERE id=? AND device_id=? AND state='attempting'").run(state,now(),commandId,deviceId).changes===1;if(!changed)return undefined;const r=this.db.query('SELECT * FROM commands WHERE id=?').get(commandId) as any;return r?rowCommand(r):undefined;}
 commandForApp(appId:string,commandId:string,envelope=false):CentralCommand|undefined{const r=this.db.query('SELECT * FROM commands WHERE id=? AND app_id=?').get(commandId,appId) as any;return r?rowCommand(r,envelope):undefined;}
 rawCommandEnvelope(commandId:string):string|undefined{const r=this.db.query('SELECT envelope FROM commands WHERE id=?').get(commandId) as any;return r?.envelope;}
}
