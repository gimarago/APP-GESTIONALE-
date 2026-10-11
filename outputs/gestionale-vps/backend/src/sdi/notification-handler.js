import {assertSimulation} from '../config.js';
import {simulatedOutcomes} from './sdi-status.js';
export class NotificationHandler {
  constructor(store) { this.store=store; this.db=store.db; }
  async handle(n) {
    assertSimulation();
    if(!n || n.simulation!==true || !simulatedOutcomes.includes(n.outcome) ||
       ![n.id,n.correlation].every(v=>typeof v==='string' && v.length>0 && v.length<=200)) throw new Error('INVALID_SIMULATION_NOTIFICATION');
    const body=JSON.stringify({simulation:true,id:n.id,correlation:n.correlation,outcome:n.outcome});
    return this.store.transaction(() => {
      const old=this.db.prepare('SELECT * FROM notifications WHERE id=?').get(n.id);
      if(old && old.body!==body) throw new Error('NOTIFICATION_ID_CONFLICT');
      if(old && old.state!=='UNMATCHED') return old.state;
      if(!old) this.db.prepare("INSERT INTO notifications VALUES(?,?,'UNMATCHED')").run(n.id,body);
      const a=this.db.prepare("SELECT * FROM attempts WHERE correlation=? AND state='ACK_SIMULATO'").get(n.correlation);
      let state='UNMATCHED';
      if(a) {
        const invoice=this.db.prepare('SELECT * FROM invoices WHERE id=?').get(a.invoice_id);
        if(invoice.status===n.outcome) state='DUPLICATE_OUTCOME';
        else if(invoice.status==='INVIATA' || (invoice.status==='MANCATA_CONSEGNA' && n.outcome==='CONSEGNATA')) {
          this.db.prepare('UPDATE invoices SET status=? WHERE id=?').run(n.outcome,a.invoice_id); state='APPLIED';
        } else state='CONFLICT'; // Nessuna regressione o scelta arbitraria tra esiti incompatibili.
      }
      this.db.prepare('UPDATE notifications SET state=? WHERE id=?').run(state,n.id);
      this.store.event('SIMULATION_NOTIFICATION',n.id,{state}); return state;
    });
  }
  async reconcileUnmatched() {
    const results=[];
    for(const row of this.db.prepare("SELECT body FROM notifications WHERE state='UNMATCHED' ORDER BY rowid").all()) results.push(await this.handle(JSON.parse(row.body)));
    return results;
  }
}
