import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {xmlEngine} from '../xml/engine.js';
import {exportSource} from './export-source.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
export class InvoiceSync {
  static async open(path,company) {await mkdir(dirname(path),{recursive:true});return new this(path,company);}
  constructor(path,company) {
    if(!company || typeof company.vat!=='string' || !/^\d{11}$/.test(company.vat) || /^0+$/.test(company.vat) || (company.cf!==undefined && !/^(?:[A-Z0-9]{16}|\d{11})$/.test(company.cf))) throw Error('INVALID_COMPANY_ID');
    this.company=Object.freeze({vat:company.vat,...(company.cf?{cf:company.cf}:{})});
    this.db=new DatabaseSync(path);
    const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if(tables.length && !tables.some(t=>t.name==='sync_company')) {this.db.close();throw Error('SEPARATE_SYNC_DATABASE_REQUIRED');}
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sync_company(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_runs(id TEXT PRIMARY KEY,state TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,summary TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS sync_one_running ON sync_runs((1)) WHERE state='RUNNING';
      CREATE TABLE IF NOT EXISTS received_files(digest TEXT PRIMARY KEY,original BLOB NOT NULL,origin TEXT NOT NULL,imported_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS received_invoices(id TEXT PRIMARY KEY,fiscal_key TEXT UNIQUE NOT NULL,file_digest TEXT NOT NULL REFERENCES received_files(digest),body_index INTEGER NOT NULL,metadata TEXT NOT NULL,UNIQUE(file_digest,body_index));
      CREATE TABLE IF NOT EXISTS sync_events(seq INTEGER PRIMARY KEY,run_id TEXT NOT NULL REFERENCES sync_runs(id),source_name TEXT NOT NULL,outcome TEXT NOT NULL,detail TEXT NOT NULL);`);
    try {
      this.transaction(()=>{
        const identity=JSON.stringify(this.company);const old=this.db.prepare('SELECT identity FROM sync_company WHERE id=1').get();
        if(old && old.identity!==identity)throw Error('COMPANY_ARCHIVE_MISMATCH');
        this.db.prepare('INSERT OR IGNORE INTO sync_company VALUES(1,?)').run(identity);
      });
    } catch(e){this.db.close();throw e;}
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  event(runId,name,outcome,detail={}){this.db.prepare('INSERT INTO sync_events(run_id,source_name,outcome,detail) VALUES(?,?,?,?)').run(runId,name,outcome,JSON.stringify(detail));}
  async importFile(runId,{sourceName,bytes,error}) {
    if(error) {this.event(runId,sourceName,'ISSUE',{code:error});return {outcome:'issues',documents:0};}
    const digest=hash(bytes);
    if(this.db.prepare('SELECT digest FROM received_files WHERE digest=?').get(digest)) {
      this.event(runId,sourceName,'DUPLICATE',{digest});return {outcome:'duplicates',documents:0};
    }
    let parsed;
    try {
      const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(/<\?xml[^?]*encoding\s*=\s*["'](?!utf-8["'])/i.test(xml)) throw Error('UNSUPPORTED_ENCODING');
      parsed=await xmlEngine({mode:'inspect-invoice',xml});
    } catch {
      this.event(runId,sourceName,'ISSUE',{code:'XML_INVALID_OR_UNSUPPORTED',digest});return {outcome:'issues',documents:0};
    }
    const b=parsed.buyer;
    const belongs=b.vat?(b.country==='IT' && b.vat===this.company.vat):Boolean(this.company.cf && b.cf===this.company.cf);
    if(!belongs) {this.event(runId,sourceName,'ISSUE',{code:'COMPANY_MISMATCH',digest});return {outcome:'issues',documents:0};}
    const seller=parsed.seller;
    if(!seller.vat && !seller.cf) {this.event(runId,sourceName,'ISSUE',{code:'MISSING_SELLER_ID',digest});return {outcome:'issues',documents:0};}
    const keyed=parsed.documents.map(d=>({...d,key:JSON.stringify([seller.country,seller.vat||seller.cf,d.date.slice(0,4),d.type,d.number])}));
    return this.transaction(()=>{
      // Il file multi-fattura si importa integralmente, oppure viene segnalato come conflitto.
      const keys=new Set();
      for(const d of keyed){
        if(keys.has(d.key)||this.db.prepare('SELECT id FROM received_invoices WHERE fiscal_key=?').get(d.key)){
          this.event(runId,sourceName,'CONFLICT',{digest});return {outcome:'conflicts',documents:0};
        }keys.add(d.key);
      }
      this.db.prepare('INSERT INTO received_files VALUES(?,?,?,?)').run(digest,bytes,'LOCAL_EXPORT',new Date().toISOString());
      for(const d of keyed){
        const metadata={...d,seller,buyer:b,signatureVerification:parsed.signatureVerification,sdiIdentifier:null,paymentStatus:'UNKNOWN',deliveryStatus:'NOT_INFERRED'};delete metadata.key;
        this.db.prepare('INSERT INTO received_invoices VALUES(?,?,?,?,?)').run(randomUUID(),d.key,digest,d.bodyIndex,JSON.stringify(metadata));
      }
      this.event(runId,sourceName,'IMPORTED',{digest,documents:keyed.length});return {outcome:'imported',documents:keyed.length};
    });
  }
  async syncLocal(inputPath) {
    const id=randomUUID();
    this.transaction(()=>this.db.prepare("INSERT INTO sync_runs VALUES(?,'RUNNING',?,NULL,NULL)").run(id,new Date().toISOString()));
    const summary={id,imported:0,duplicates:0,issues:0,conflicts:0,documents:0,source:'LOCAL_EXPORT',portalConnected:false};
    try {
      for await(const item of exportSource(inputPath)){const result=await this.importFile(id,item);summary[result.outcome]++;summary.documents+=result.documents;}
      summary.state=summary.issues||summary.conflicts?'COMPLETED_WITH_ISSUES':'COMPLETED';
    } catch {
      summary.state='FAILED';summary.issues++;this.event(id,'','ISSUE',{code:'SYNC_INTERRUPTED_OR_SOURCE_UNAVAILABLE'});
    }
    this.db.prepare('UPDATE sync_runs SET state=?,finished_at=?,summary=? WHERE id=?').run(summary.state,new Date().toISOString(),JSON.stringify(summary),id);
    return summary;
  }
  list(){return this.db.prepare('SELECT id,file_digest,body_index,metadata FROM received_invoices ORDER BY rowid').all().map(r=>({...r,metadata:JSON.parse(r.metadata)}));}
  original(digest){return this.db.prepare('SELECT original FROM received_files WHERE digest=?').get(digest)?.original;}
  issues(runId){return this.db.prepare("SELECT source_name,outcome,detail FROM sync_events WHERE run_id=? AND outcome IN ('ISSUE','CONFLICT') ORDER BY seq").all(runId);}
  recoverInterrupted(){this.db.prepare("UPDATE sync_runs SET state='INTERRUPTED',finished_at=? WHERE state='RUNNING'").run(new Date().toISOString());}
  close(){this.db.close();}
}
