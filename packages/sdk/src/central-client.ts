import type {EncryptedEnvelope} from './central-crypto';
export type CentralCommandState='queued'|'attempting'|'dispatch-accepted'|'uncertain'|'cancelled'|'policy-rejected';
export interface CentralUser {id:string;label:string;email?:string;createdAt:number;}
export interface CentralDevice {id:string;userId:string|null;label:string;publicKey:JsonWebKey;status:'pending'|'active';createdAt:number;}
export interface CentralApp {id:string;ownerUserId:string;name:string;publicKey:JsonWebKey;createdAt:number;}
export interface CentralGrant {id:string;userId:string;deviceId:string;appId:string;scopes:string[];status:'active'|'revoked';createdAt:number;}
export interface CentralCommand {id:string;grantId:string;state:CentralCommandState;createdAt:number;updatedAt:number;envelope?:EncryptedEnvelope;}
export class MsgzleCentral {
 private readonly base:URL;
 constructor(options:{baseUrl:string;fetch?:typeof fetch}) {this.base=new URL(options.baseUrl);if(this.base.protocol!=='https:'&&!( ['localhost','127.0.0.1','[::1]'].includes(this.base.hostname)&&this.base.protocol==='http:'))throw new Error('Use HTTPS, except for loopback development.');if(this.base.username||this.base.password||this.base.search||this.base.hash)throw new Error('Base URL cannot contain credentials, query or fragment.');this.fetch=options.fetch??fetch;}
 private readonly fetch:typeof fetch;
 private async request<T>(path:string,body?:unknown,token?:string):Promise<T> {const response=await this.fetch(new URL(path,this.base),{method:body===undefined?'GET':'POST',redirect:'error',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok)throw new Error(`Msgzle Central HTTP ${response.status}: ${await response.text()}`);return response.json() as Promise<T>;}
 health():Promise<{version:string;role:'central';receive:false}> {return this.request('/v1/health');}
 signUp(email:string,password:string,label?:string):Promise<{user:CentralUser;user_token:string}> {return this.request('/v1/auth/signup',{email,password,label});}
 signIn(email:string,password:string):Promise<{user:CentralUser;user_token:string}> {return this.request('/v1/auth/sign-in',{email,password});}
 startPairing(label:string,publicKey:JsonWebKey):Promise<{device_id:string;pair_code:string;device_token:string}> {return this.request('/v1/pairing/start',{label,public_key:publicKey});}
 approvePairing(pairCode:string,userToken:string):Promise<{device:CentralDevice}> {return this.request('/v1/pairing/approve',{pair_code:pairCode},userToken);}
 registerApp(name:string,publicKey:JsonWebKey,userToken:string):Promise<{app:CentralApp;app_token:string}> {return this.request('/v1/apps',{name,public_key:publicKey},userToken);}
 createGrant(deviceId:string,appId:string,scopes:['messages.send'],userToken:string):Promise<{grant:CentralGrant}> {return this.request('/v1/grants',{device_id:deviceId,app_id:appId,scopes},userToken);}
 sendEncrypted(grantId:string,id:string,envelope:EncryptedEnvelope,appToken:string):Promise<{command:CentralCommand}> {return this.request('/v1/send',{grant_id:grantId,id,envelope},appToken);}
 command(id:string,appToken:string):Promise<{command:CentralCommand}> {return this.request(`/v1/commands/${encodeURIComponent(id)}`,undefined,appToken);}
 connectorNext(deviceToken:string):Promise<{command:CentralCommand|null}> {return this.request('/v1/connector/next',{},deviceToken);}
 connectorResult(id:string,state:CentralCommandState,deviceToken:string):Promise<{command:CentralCommand}> {return this.request('/v1/connector/result',{id,state},deviceToken);}
}
