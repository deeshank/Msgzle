// Upstream 3.0.0 has a hard-coded three-attempt AppleScript policy.
// Never silently patch another version or a changed source shape.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const root = dirname(require.resolve('@photon-ai/imessage-kit'));
const pkg = JSON.parse(readFileSync(join(root,'../package.json'),'utf8'));
if (pkg.version !== '3.0.0') throw new Error('Photon patch requires audited 3.0.0');
for (const file of ['index.js','index.cjs']) {
 const path=join(root,file); let text=readFileSync(path,'utf8');
 const before='retryAttempts = RETRY_ATTEMPTS,'; const after='retryAttempts = 1, /* Msgzle: no ambiguous resend */';
 if (text.includes(after)) continue;
 if (text.split(before).length !== 2) throw new Error(`Unexpected Photon send source: ${file}`);
 writeFileSync(path,text.replace(before,after));
}
console.log('Photon 3.0.0 single-attempt patch verified');
// Text-only send adapter: no MessagesDatabaseReader, watcher or temp-file manager.
// Keep this narrow adapter coupled to the audited 3.0.0 source; do not export internals broadly.
const adapter = `\n/* Msgzle send-only adapter v2 */
class MsgzleSendOnly {
 constructor() { this.abort = new AbortController(); this.sender = null; }
 async preflight() { requireMacOS(); const probe = new MessagesAppProbe(); if (!await probe.isRunning()) throw ConfigError('Messages is not running'); }
 async send(request) {
  requireMacOS();
  if (typeof request.to !== 'string' || typeof request.text !== 'string' || !request.text.trim() || 'attachments' in request) throw ConfigError('Msgzle supports text sends only');
  this.sender ??= new MessageSender({retryAttempts:1,semaphore:new Semaphore(1),signal:this.abort.signal});
  await this.sender.send({to:request.to,text:request.text});
 }
 close() { this.abort.abort(); }
}
`;
for (const file of ['index.js','index.cjs']) {
 const path=join(root,file);let text=readFileSync(path,'utf8');
 if(text.includes('/* Msgzle send-only adapter v2 */'))continue;
 if(text.includes('/* Msgzle send-only adapter v1 */'))text=text.split('/* Msgzle send-only adapter v1 */')[0];
 if(text.split('var MessageSender = class {').length!==2||text.split('var Semaphore = class {').length!==2)throw new Error(`Unexpected Photon adapter source: ${file}`);
 text+=adapter+(file.endsWith('.cjs')?'\nexports.MsgzleSendOnly = MsgzleSendOnly;\n':'\nexport { MsgzleSendOnly };\n');writeFileSync(path,text);
}
const types=join(root,'index.d.ts');let declaration=readFileSync(types,'utf8');
declaration=declaration.replace(/\nexport declare class MsgzleSendOnly[^\n]+/g,'');writeFileSync(types,declaration+'\nexport declare class MsgzleSendOnly { preflight():Promise<void>; send(request:{to:string;text:string}):Promise<void>; close():void; }\n');
console.log('Photon text-only, no-history adapter verified');
