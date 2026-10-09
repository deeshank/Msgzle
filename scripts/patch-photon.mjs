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
