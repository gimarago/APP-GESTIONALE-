import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {XmlGenerator} from '../fatture/xml-generator.js';
import {SdiClient} from './sdi-client.js';
// Archivio separato da bozze e simulatore. Nessuna assegnazione di numeri fiscali.
export class FiscalTransmissionService {
  static async open(path,config) {await mkdir(dirname(path),{recursive:true});return new this(path,config);}
  constructor(path,config) {
    if(!['local-contract-test','sdi-test'].includes(config?.environment) || process.env.APP_ENV==='production') throw Error('PRODUCTION_DISABLED');
    this.client=new SdiClient(config);this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channel(environment TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,source_key TEXT UNIQUE NOT NULL,fiscal_key TEXT UNIQUE NOT NULL,filename TEXT UNIQUE NOT NULL,digest TEXT UNIQUE NOT NULL,xml TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transmission_events(seq INTEGER PRIMARY KEY,submission_id TEXT NOT NULL,type TEXT NOT NULL,at TEXT NOT NULL);`);
    const channel=this.db.prepare('SELECT environment FROM channel').get();
    if(channel && channel.environment!==config.environment){this.db.close();throw Error('ARCHIVE_ENVIRONMENT_MISMATCH');}
    this.db.prepare('INSERT OR IGNORE INTO channel VALUES(?)').run(config.environment);
  }
  transaction(fn) {this.db.exec('BEGIN IMMEDIATE');try {const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  event(id,type){this.db.prepare('INSERT INTO transmission_events(submission_id,type,at) VALUES(?,?,?)').run(id,type,new Date().toISOString());}
  async submit({sourceKey,filename,invoice}) {
    invoice=structuredClone(invoice);
    if(typeof sourceKey!=='string'||!sourceKey.trim()||sourceKey.length>200) throw Error('INVALID_SOURCE_KEY');
    if(typeof filename!=='string') throw Error('INVALID_FILENAME');
    const xml=await new XmlGenerator().generate(invoice);
    if(!filename.startsWith(`${invoice.transmission.country}${invoice.transmission.id}_`)) throw Error('FILENAME_TRANSMITTER_MISMATCH');
    const fiscalKey=JSON.stringify([invoice.seller.vat,invoice.date.slice(0,4),invoice.type,invoice.number]);
    const digest=createHash('sha256').update(xml).digest('hex');
    const prepared=await this.client.prepare({filename,xml});
    const job=this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM submissions WHERE source_key=?').get(sourceKey);
      if(old){if(old.digest!==digest||old.filename!==filename)throw Error('IDEMPOTENCY_CONFLICT');return {id:old.id,existing:true};}
      const id=randomUUID();
      this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,NULL,?)').run(id,sourceKey,fiscalKey,filename,digest,xml,'IN_FLIGHT',new Date().toISOString());
      this.event(id,'PREPARED_AND_CLAIMED');return {id,existing:false};
    });
    if(job.existing) return this.get(job.id);
    const result=await this.client.sendPrepared(prepared);
    this.transaction(()=>{
      // Un recupero concorrente o una risposta tardiva non autorizzano una nuova trasmissione.
      const state=this.db.prepare('SELECT state FROM submissions WHERE id=?').get(job.id).state;
      if(state!=='IN_FLIGHT'){this.event(job.id,'LATE_RESPONSE_REQUIRES_RECONCILIATION');return;}
      this.db.prepare('UPDATE submissions SET state=?,result=? WHERE id=?').run(result.kind,JSON.stringify(result),job.id);
      this.event(job.id,result.kind);
    });
    return this.get(job.id);
  }
  get(id){return this.db.prepare('SELECT id,source_key,filename,digest,state,result,created_at FROM submissions WHERE id=?').get(id);}
  async recoverInterrupted(){this.transaction(()=>{for(const r of this.db.prepare("SELECT id FROM submissions WHERE state='IN_FLIGHT'").all()){this.db.prepare("UPDATE submissions SET state='UNKNOWN' WHERE id=?").run(r.id);this.event(r.id,'RECOVERED_AS_UNKNOWN');}});}
  close(){this.db.close();}
}
