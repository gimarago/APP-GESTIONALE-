import {randomUUID} from 'node:crypto';
import {validateApplication, SimulatorXmlValidator} from './fatture/xml-validator.js';
import {SimulatorXmlGenerator} from './fatture/xml-generator.js';
import {SimulatorSdiClient} from './sdi/sdi-client.js';
import {assertSimulation} from './config.js';
import {paymentStates} from './sdi/sdi-status.js';
export class InvoiceService {
  constructor(store, client = new SimulatorSdiClient()) { assertSimulation(); this.store=store; this.db=store.db; this.client=client; }
  async createDraft(sourceKey, draft) {
    assertSimulation(); validateApplication(draft);
    if (typeof sourceKey !== 'string' || !sourceKey.trim() || sourceKey.length > 200) throw new Error('INVALID_SOURCE_KEY');
    const body=JSON.stringify(draft);
    return this.store.transaction(() => {
      const old=this.db.prepare('SELECT * FROM invoices WHERE source_key=?').get(sourceKey);
      if (old) { if(old.draft!==body) throw new Error('IDEMPOTENCY_CONFLICT'); return old.id; }
      const id=randomUUID();
      this.db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?)').run(id,sourceKey,body,'BOZZA','DA_SALDARE',null);
      this.store.event('DRAFT_CREATED',id); return id;
    });
  }
  async get(id) { return this.db.prepare('SELECT * FROM invoices WHERE id=?').get(id); }
  async enqueue(id) {
    assertSimulation();
    const invoice=await this.get(id); if(!invoice) throw new Error('NOT_FOUND');
    const draft=JSON.parse(invoice.draft); validateApplication(draft);
    const xml=await new SimulatorXmlGenerator().generate(draft);
    await new SimulatorXmlValidator().validate(xml);
    return this.store.transaction(() => {
      const current=this.db.prepare('SELECT status FROM invoices WHERE id=?').get(id);
      if(current.status!=='BOZZA') return false;
      this.db.prepare("UPDATE invoices SET xml=?,status='DA_INVIARE' WHERE id=?").run(xml,id);
      this.db.prepare("INSERT INTO queue VALUES(?,'READY')").run(id);
      this.store.event('QUEUED_SIMULATION',id); return true;
    });
  }
  async runOne() {
    assertSimulation();
    const job=this.store.transaction(() => {
      const item=this.db.prepare("SELECT i.* FROM queue q JOIN invoices i ON i.id=q.invoice_id WHERE q.state='READY' ORDER BY q.rowid LIMIT 1").get();
      if(!item) return null;
      const attemptId=randomUUID();
      this.db.prepare("INSERT INTO attempts VALUES(?,?,'IN_CORSO',NULL)").run(attemptId,item.id);
      this.db.prepare("UPDATE queue SET state='IN_FLIGHT' WHERE invoice_id=?").run(item.id);
      this.store.event('ATTEMPT_STARTED',attemptId); return {...item,attemptId};
    });
    if(!job) return null;
    let ack;
    try {
      ack=await this.client.send({attemptId:job.attemptId,xml:job.xml});
      if(ack?.simulation!==true || ack.correlation!==`SIM-${job.attemptId}`) throw new Error('INVALID_ACK');
    } catch {
      this.markUncertain(job.attemptId); return job.attemptId;
    }
    this.store.transaction(() => {
      const result=this.db.prepare("UPDATE attempts SET state='ACK_SIMULATO',correlation=? WHERE id=? AND state='IN_CORSO'").run(ack.correlation,job.attemptId);
      if(!result.changes) return;
      this.db.prepare("UPDATE invoices SET status='INVIATA' WHERE id=?").run(job.id);
      this.db.prepare("UPDATE queue SET state='DONE' WHERE invoice_id=?").run(job.id);
      this.store.event('ACK_SIMULATED',job.attemptId);
    });
    return job.attemptId;
  }
  markUncertain(attemptId) {
    this.store.transaction(() => {
      const a=this.db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId);
      if(!a || a.state!=='IN_CORSO') return;
      this.db.prepare("UPDATE attempts SET state='ESITO_INCERTO' WHERE id=?").run(attemptId);
      this.db.prepare("UPDATE queue SET state='RECONCILE' WHERE invoice_id=?").run(a.invoice_id);
      this.store.event('OUTCOME_UNKNOWN',attemptId);
    });
  }
  // Solo dopo arresto di tutti i worker: nessuna scadenza che autorizzi un reinvio.
  async recoverInterrupted() {
    assertSimulation();
    for(const a of this.db.prepare("SELECT id FROM attempts WHERE state='IN_CORSO'").all()) this.markUncertain(a.id);
  }
  async reconcileSimulatedAck(attemptId, evidence) {
    assertSimulation();
    if(typeof evidence!=='string' || !evidence.trim() || evidence.length>200) throw new Error('EVIDENCE_REQUIRED');
    this.store.transaction(() => {
      const a=this.db.prepare('SELECT * FROM attempts WHERE id=?').get(attemptId);
      if(!a || a.state!=='ESITO_INCERTO') throw new Error('NOT_UNCERTAIN');
      this.db.prepare("UPDATE attempts SET state='ACK_SIMULATO',correlation=? WHERE id=?").run(`SIM-${attemptId}`,attemptId);
      this.db.prepare("UPDATE invoices SET status='INVIATA' WHERE id=?").run(a.invoice_id);
      this.db.prepare("UPDATE queue SET state='DONE' WHERE invoice_id=?").run(a.invoice_id);
      this.store.event('MANUAL_SIMULATION_RECONCILIATION',attemptId,{evidence});
    });
  }
  async setPayment(id, state) {
    assertSimulation(); if(!paymentStates.includes(state)) throw new Error('INVALID_PAYMENT_STATE');
    this.store.transaction(() => {
      if(!this.db.prepare('UPDATE invoices SET payment=? WHERE id=?').run(state,id).changes) throw new Error('NOT_FOUND');
      this.store.event('PAYMENT_CHANGED',id,{state});
    });
  }
}
