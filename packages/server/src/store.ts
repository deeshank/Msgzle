import { Database } from 'bun:sqlite';
import type { Command, SendCommand } from '../../sdk/src/index';
export class Store {
 readonly db: Database;
 constructor(path: string) {
  this.db=new Database(path,{create:true});
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, toAddress TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, createdAt INTEGER NOT NULL)');
  this.db.exec("UPDATE commands SET state='uncertain' WHERE state='attempting'");
 }
 get(id:string):Command|undefined { const r=this.db.query('SELECT * FROM commands WHERE id=?').get(id) as any; return r ? {id:r.id,to:r.toAddress,text:r.text,state:r.state,createdAt:r.createdAt}:undefined; }
 add(c:SendCommand):Command {
  const old=this.get(c.id);
  if(old) {if(old.to!==c.to||old.text!==c.text)throw new Error('Command ID already has different content');return old;}
  this.db.query('INSERT INTO commands VALUES (?, ?, ?, ?, ?)').run(c.id,c.to,c.text,'queued',Date.now());return this.get(c.id)!;
 }
 transition(id:string,from:string,to:string):boolean {return this.db.query('UPDATE commands SET state=? WHERE id=? AND state=?').run(to,id,from).changes===1;}
 next():Command|undefined {const row=this.db.query("SELECT id FROM commands WHERE state='queued' ORDER BY createdAt LIMIT 1").get() as any;return row?this.get(row.id):undefined;}
 close(){this.db.close();}
}
