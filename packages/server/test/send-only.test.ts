import {test,expect} from 'bun:test';
import {MsgzleSendOnly} from '@photon-ai/imessage-kit';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
test('send-only constructor is lazy and never creates a Messages database reader',()=>{
 const adapter=new MsgzleSendOnly();
 expect(Object.prototype.hasOwnProperty.call(adapter,'database')).toBe(false);
 expect((adapter as any).sender).toBeNull();
 const require=createRequire(import.meta.url);const source=readFileSync(require.resolve('@photon-ai/imessage-kit').replace(/index\.cjs$/,'index.js'),'utf8');
 const body=source.split('/* Msgzle send-only adapter v2 */')[1];
 expect(body).toBeDefined();expect(body).not.toContain('MessagesDatabaseReader');expect(body).not.toContain('chat.db');expect(body).not.toContain('TempFileManager');
 adapter.close();
});
