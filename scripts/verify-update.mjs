import {readFileSync} from 'node:fs';
import {createPublicKey,verify} from 'node:crypto';
const arch=process.argv[2];if(!['arm64','x64'].includes(arch))throw Error('Invalid arch');
const pub=Buffer.from(process.env.SPARKLE_PUBLIC_KEY??'', 'base64');if(pub.length!==32)throw Error('Missing public key');
const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pub]),format:'der',type:'spki'});
const signature=readFileSync('build/signature.txt','utf8').match(/sparkle:edSignature="([A-Za-z0-9+/=]+)"/);
if(!signature||!verify(null,readFileSync(`build/Msgzle-${arch}.zip`),key,Buffer.from(signature[1],'base64')))throw Error('Update signature did not verify');
console.log('Sparkle archive signature verified against embedded public key');
