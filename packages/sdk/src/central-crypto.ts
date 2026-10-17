const ALG='ECDH-P256-HKDF-SHA256-A256GCM';
const INFO=new TextEncoder().encode('msgzle-central-v1');
export interface EncryptedEnvelope {v:1;alg:typeof ALG;epk:string;salt:string;iv:string;ciphertext:string;}
const te=new TextEncoder(),td=new TextDecoder();
function b64u(bytes:Uint8Array):string {let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function unb64u(value:string):Uint8Array<ArrayBuffer> {const normalized=value.replaceAll('-','+').replaceAll('_','/'),padded=normalized+'='.repeat((4-normalized.length%4)%4),s=atob(padded);const out=new Uint8Array(new ArrayBuffer(s.length));for(let i=0;i<s.length;i++)out[i]=s.charCodeAt(i);return out;}
function assertPublicJwk(jwk:JsonWebKey):void {if(jwk.kty!=='EC'||jwk.crv!=='P-256'||typeof jwk.x!=='string'||typeof jwk.y!=='string')throw new Error('P-256 public key required');}
function assertPrivateJwk(jwk:JsonWebKey):void {assertPublicJwk(jwk);if(typeof jwk.d!=='string')throw new Error('P-256 private key required');}
function publicJwk(jwk:JsonWebKey):JsonWebKey {assertPublicJwk(jwk);return {kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y,ext:true};}
async function importPublic(jwk:JsonWebKey):Promise<CryptoKey> {return crypto.subtle.importKey('jwk',publicJwk(jwk),{name:'ECDH',namedCurve:'P-256'},false,[]);}
async function importPrivate(jwk:JsonWebKey):Promise<CryptoKey> {assertPrivateJwk(jwk);return crypto.subtle.importKey('jwk',{...publicJwk(jwk),d:jwk.d},{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);}
async function contentKey(privateKey:CryptoKey,publicKey:CryptoKey,salt:Uint8Array<ArrayBuffer>):Promise<CryptoKey> {
 const bits=await crypto.subtle.deriveBits({name:'ECDH',public:publicKey},privateKey,256),hkdf=await crypto.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt,info:INFO},hkdf,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function generateEncryptionKeyPair():Promise<{publicKey:JsonWebKey;privateKey:JsonWebKey}> {
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']),privateKey=await crypto.subtle.exportKey('jwk',pair.privateKey),exportedPublic=await crypto.subtle.exportKey('jwk',pair.publicKey);
 return {publicKey:publicJwk(exportedPublic),privateKey:{...publicJwk(exportedPublic),d:privateKey.d}};
}
export async function encryptForDevice(devicePublicKey:JsonWebKey,payload:unknown):Promise<EncryptedEnvelope> {
 const ephemeral=await generateEncryptionKeyPair(),salt=crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16))),iv=crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12))),key=await contentKey(await importPrivate(ephemeral.privateKey),await importPublic(devicePublicKey),salt),plaintext=te.encode(JSON.stringify(payload)),ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plaintext);
 return {v:1,alg:ALG,epk:b64u(packPublic(ephemeral.publicKey)),salt:b64u(salt),iv:b64u(iv),ciphertext:b64u(new Uint8Array(ciphertext))};
}
export function isEncryptedEnvelope(value:unknown):value is EncryptedEnvelope {
 if(!value||typeof value!=='object')return false;const e=value as Record<string,unknown>;return e.v===1&&e.alg===ALG&&['epk','salt','iv','ciphertext'].every(k=>typeof e[k]==='string'&&(e[k] as string).length>0)&&Object.keys(e).sort().join(',')==='alg,ciphertext,epk,iv,salt,v';
}
export async function decryptFromDevice(devicePrivateKey:JsonWebKey,envelope:EncryptedEnvelope):Promise<unknown> {
 if(!isEncryptedEnvelope(envelope))throw new Error('Invalid encrypted envelope');
 const epkRaw=unb64u(envelope.epk);if(epkRaw.length!==65&&epkRaw.length!==64)throw new Error('Invalid ephemeral key');
 // WebCrypto imports JWK rather than raw P-256 points. epk is the ephemeral public x||y coordinate bytes.
 const xLength=Math.floor(epkRaw.length/2),x=b64u(epkRaw.slice(0,xLength)),y=b64u(epkRaw.slice(xLength)),key=await contentKey(await importPrivate(devicePrivateKey),await importPublic({kty:'EC',crv:'P-256',x,y}),unb64u(envelope.salt));
 const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64u(envelope.iv)},key,unb64u(envelope.ciphertext));return JSON.parse(td.decode(plaintext));
}
function packPublic(jwk:JsonWebKey):Uint8Array<ArrayBuffer> {assertPublicJwk(jwk);const x=unb64u(jwk.x!),y=unb64u(jwk.y!),out=new Uint8Array(new ArrayBuffer(x.length+y.length));out.set(x);out.set(y,x.length);return out;}
export function isEncryptionPublicKey(value:unknown):value is JsonWebKey {
 if(!value||typeof value!=='object')return false;const jwk=value as JsonWebKey;return jwk.kty==='EC'&&jwk.crv==='P-256'&&typeof jwk.x==='string'&&typeof jwk.y==='string';
}
