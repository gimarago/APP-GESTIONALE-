const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Journal,reconcile,days}=require('./cashbook-core.js');
function memory(){let value=null;return {getItem:()=>value,setItem:(k,v)=>{value=v;}};}
function entry(overrides={}) {return {key:'agenda:2026-09-01:sample',source:'agenda',date:'2026-09-01',time:'09:00',customer:'Cliente Test',vehicle:'TEST123',work:'Tagliando',amount:100,lines:[{description:'Tagliando',amount:100}],...overrides};}
function seed(journal,e=entry(),outside=100) {journal.resolve(e);journal.sync(e,{outside,inCash:e.amount-outside,profit:25,lastEdited:'outside'});journal.persist();return e;}
test('Rientro: credito azzerato, cassa originale invariata, importo e profitto non duplicati',()=>{
  const journal=new Journal(memory()),e=seed(journal);
  const p=journal.settle(e.cashId,'2026-09-05','2026-09-13','15:30');
  const state=reconcile(100,journal.account(e.cashId).state,journal.received(e.cashId));
  assert.equal(state.outside,0);assert.equal(state.inCash,0);assert.equal(state.profit,25);
  assert.equal(journal.account(e.cashId).meta.amount,100);assert.equal(p.cents,10000);assert.equal(p.days,4);
  assert.equal(state.inCash+p.cents/100,100);
  assert.throws(()=>journal.settle(e.cashId,'2026-09-05','2026-09-13','15:31'),/già saldato/);
});
test('Incasso iniziale parziale: si registra soltanto il residuo',()=>{
  const journal=new Journal(memory()),e=seed(journal,entry({amount:100.15}),40.05);
  journal.settle(e.cashId,'2026-09-01','2026-09-13','09:10');
  const state=reconcile(100.15,journal.account(e.cashId).state,journal.received(e.cashId));
  assert.equal(state.inCash,60.1);assert.equal(state.outside,0);assert.equal(journal.received(e.cashId),40.05);assert.equal(journal.data.payments[0].days,0);
});
test('Date reali, ordine cronologico e cambio ora legale',()=>{
  assert.equal(days('2026-03-28','2026-03-30'),2);
  const journal=new Journal(memory()),e=seed(journal);
  for(const date of ['2026-08-31','2026-09-14','2026-02-30','']) assert.throws(()=>journal.settle(e.cashId,date,'2026-09-13','12:00'));
  assert.equal(journal.data.payments.length,0);
});
test('Riapertura: riferimenti stabili e storico del saldo conservato',()=>{
  const storage=memory(),first=new Journal(storage),e=seed(first);
  first.settle(e.cashId,'2026-09-04','2026-09-13','11:00');
  const restored=new Journal(storage),same=entry({key:'agenda:2026-09-01:changed-runtime-key'});
  restored.resolve(same);assert.equal(same.cashId,e.cashId);assert.equal(restored.received(same.cashId),100);assert.equal(restored.account(same.cashId).state.outside,0);
});
test('Errore di salvataggio: nessun saldo perso e nessun rientro fantasma',()=>{
  const storage=memory(),journal=new Journal(storage),e=seed(journal);
  storage.setItem=()=>{throw Error('full');};
  assert.throws(()=>journal.settle(e.cashId,'2026-09-05','2026-09-13','10:00'),/Impossibile salvare/);
  assert.equal(journal.account(e.cashId).state.outside,100);assert.equal(journal.data.payments.length,0);
});
test('Due schede: una copia obsoleta non sovrascrive il registro',()=>{
  const storage=memory(),first=new Journal(storage),e=seed(first),second=new Journal(storage);
  first.settle(e.cashId,'2026-09-05','2026-09-13','10:00');
  assert.throws(()=>second.settle(e.cashId,'2026-09-06','2026-09-13','10:00'),/altra scheda/);
  assert.equal(new Journal(storage).data.payments.length,1);
});
test('Lavori identici distinti e veicoli in parcheggio',()=>{
  const journal=new Journal(memory()),a=entry(),b=entry(),p=entry({source:'parking'});
  journal.resolve(a,0);journal.resolve(b,1);journal.resolve(p,0);
  assert.equal(new Set([a.cashId,b.cashId,p.cashId]).size,3);
});

test('Riga condivisa senza archivio derivato: identità conservata senza scritture',()=>{
  const storage={getItem:()=>null,setItem:()=>{throw Error('must not write');}},journal=new Journal(storage);
  const id='cash-12345678-1234-1234-1234-123456789abc',row={dataset:{cashAccountId:id}};
  const e=entry({sourceRow:row});journal.resolve(e);journal.resolve(e);
  assert.equal(e.cashId,id);assert.equal(row.dataset.cashAccountId,id);assert.equal(journal.data.accounts.length,1);
  const other=entry({sourceRow:{dataset:{cashAccountId:'cash-12345678-1234-1234-1234-123456789def'}}});
  journal.resolve(other);assert.notEqual(other.cashId,id);assert.equal(journal.data.accounts.length,2);
});

test('Identità condivise numeriche non collidono con i successivi conti locali',()=>{
  const journal=new Journal(memory()),shared=entry({sourceRow:{dataset:{cashAccountId:'cash-7'}}});
  journal.resolve(shared);assert.equal(shared.cashId,'cash-7');
  const local=entry({work:'Altro lavoro'});journal.resolve(local);assert.equal(local.cashId,'cash-8');
  const invalid=entry({sourceRow:{dataset:{cashAccountId:'invalid'}},work:'Terzo lavoro'});journal.resolve(invalid);
  assert.equal(invalid.cashId,'cash-9');
});

test('Conto derivato remoto: un altro lavoro non lo registra; un acconto lo attiva',()=>{
  const storage=memory(),journal=new Journal(storage),e=entry({sourceRow:{dataset:{cashAccountId:'cash-7'}}});
  journal.resolve(e,0,{cacheOnly:true});journal.sync(e,{outside:100,inCash:0,profit:20,lastEdited:'outside'});journal.account(e.cashId).status='IN LAVORAZIONE';
  journal.persist();assert.deepEqual(JSON.parse(storage.getItem()).accounts,[]);assert.equal(JSON.parse(storage.getItem()).nextId,1);
  journal.recordDeposit(e.cashId,'30','2026-09-02','2026-09-13','10:00','cache-action-001');
  const saved=JSON.parse(storage.getItem());assert.equal(saved.accounts.length,1);assert.equal(saved.accounts[0].id,'cash-7');assert.equal(saved.payments[0].cents,3000);
  journal.persist();assert.equal(JSON.parse(storage.getItem()).accounts.length,1);
});
test('Archivio corrotto: nessuna sovrascrittura silenziosa',()=>{
  const storage={getItem:()=>'{invalid',setItem:()=>{throw Error('must not write');}},journal=new Journal(storage);
  assert.ok(journal.loadError);assert.throws(()=>journal.persist(),/non leggibile/);
});

test('Correzione importo dopo saldo: rientro aggiornato senza duplicati',()=>{
 const journal=new Journal(memory()),e=seed(journal);
 journal.settle(e.cashId,'2026-09-05','2026-09-13','12:00');
 e.amount=50;e.lines=[{description:'Tagliando',amount:50}];journal.adjustReturn(e);
 assert.equal(journal.received(e.cashId),50);assert.equal(journal.data.payments.length,1);
 assert.equal(journal.data.payments[0].corrections[0].cents,10000);
 e.amount=150;journal.adjustReturn(e);assert.equal(journal.received(e.cashId),150);
 e.amount=0;journal.adjustReturn(e);assert.equal(journal.received(e.cashId),0);
});
test('Stato riaperto persistente e rientro conservato',()=>{
 const storage=memory(),journal=new Journal(storage),e=seed(journal);
 journal.settle(e.cashId,'2026-09-05','2026-09-13','12:00');journal.setStatus(e.cashId,'IN LAVORAZIONE');
 const reopened=new Journal(storage);assert.equal(reopened.account(e.cashId).status,'IN LAVORAZIONE');assert.equal(reopened.received(e.cashId),100);
});
test('Correzione fallita non altera il rientro salvato',()=>{
 const storage=memory(),journal=new Journal(storage),e=seed(journal);
 journal.settle(e.cashId,'2026-09-05','2026-09-13','12:00');storage.setItem=()=>{throw Error('full');};e.amount=50;
 assert.throws(()=>journal.adjustReturn(e));assert.equal(journal.received(e.cashId),100);
});

test('Rientri esclusi da righe e totali quando il lavoro è riaperto',()=>{
 const storage=memory(),journal=new Journal(storage),e=seed(journal);
 journal.settle(e.cashId,'2026-09-05','2026-09-13','12:00');assert.equal(journal.activePayments().length,1);
 journal.setStatus(e.cashId,'IN LAVORAZIONE');assert.equal(journal.activePayments().length,0);
 const loaded=new Journal(storage);assert.equal(loaded.activePayments().length,0);
 loaded.setStatus(e.cashId,'COMPLETATO');assert.equal(loaded.activePayments().length,1);assert.equal(loaded.data.payments.length,1);
});

test('Medie per cliente: almeno due rientri, veicoli raggruppati',()=>{
 const {customerAverages}=require('./cashbook-core.js');const groups=customerAverages([{days:2,meta:{customer:'Mario Rossi',vehicle:'A'}},{days:6,meta:{customer:'MARIO ROSSI',vehicle:'B'}},{days:1,meta:{customer:'Anna'}}]);assert.equal(groups.length,1);assert.equal(groups[0].average,4);assert.equal(groups[0].count,2);
});
test('Attesa media: i debiti aperti invecchiano ogni giorno e i saldi restano fermi',()=>{
 const {customerAgingAverages}=require('./cashbook-core.js');
 const entries=[{customer:'Mario Rossi',date:'2026-10-01',state:{outside:50}},{customer:'MARIO ROSSI',date:'2026-10-05',state:{outside:25}},{customer:'Altro',date:'2026-10-01',state:{outside:0}}];
 const payments=[{days:4,kind:'return',meta:{customer:'Mario Rossi'}},{days:0,kind:'deposit',meta:{customer:'Mario Rossi'}}];
 const first=customerAgingAverages(entries,payments,'2026-10-11').find(group=>group.key==='mariorossi');
 const next=customerAgingAverages(entries,payments,'2026-10-12').find(group=>group.key==='mariorossi');
 assert.equal(first.openCount,2);assert.equal(first.settledCount,1);assert.equal(first.count,3);assert.equal(first.average,20/3);
 assert.equal(next.average,22/3);assert.equal(payments[0].days,4,'the recorded settlement duration is unchanged');
});
test('Saldo fattura: un rientro solo, residuo azzerato e riapertura',()=>{
 const j=new Journal(memory()),e=seed(j);let saves=0;j.invoicePayment(e.cashId,'inv-1',true,'2026-09-05','2026-09-14',()=>saves++);assert.equal(j.account(e.cashId).state.outside,0);assert.equal(j.received(e.cashId),100);j.invoicePayment(e.cashId,'inv-1',true,'2026-09-05','2026-09-14',()=>saves++);assert.equal(j.data.payments.length,1);assert.equal(saves,2);j.invoicePayment(e.cashId,'inv-1',false,'2026-09-05','2026-09-14',()=>{});assert.equal(j.account(e.cashId).state.outside,100);assert.equal(j.data.payments.length,0);
});
test('Errore nel salvataggio fattura ripristina il fuori cassa',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j);assert.throws(()=>j.invoicePayment(e.cashId,'inv-2',true,'2026-09-05','2026-09-14',()=>{throw Error('failed');}));assert.equal(j.account(e.cashId).state.outside,100);assert.equal(new Journal(storage).data.payments.length,0);
});

test('Cambio data saldo fattura: aggiorna rientro e giorni senza duplicare incasso',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j,entry(),40);
 j.invoicePayment(e.cashId,'inv-date',true,'2026-09-05','2026-09-14',()=>{});
 const accountBefore=structuredClone(j.account(e.cashId)),paymentId=j.data.payments[0].id;
 let commits=0;j.invoicePayment(e.cashId,'inv-date',true,'2026-09-09','2026-09-14',()=>commits++);
 assert.equal(commits,1);assert.equal(j.data.payments.length,1);assert.equal(j.data.payments[0].id,paymentId);
 assert.equal(j.data.payments[0].date,'2026-09-09');assert.equal(j.data.payments[0].days,8);
 assert.equal(j.received(e.cashId),40);assert.deepEqual(j.account(e.cashId),accountBefore);
 const restored=new Journal(storage);assert.equal(restored.data.payments[0].date,'2026-09-09');assert.equal(restored.data.payments[0].days,8);
 j.invoicePayment(e.cashId,'inv-date',false,'2026-09-09','2026-09-14',()=>{});
 assert.equal(j.account(e.cashId).state.outside,40);assert.equal(j.account(e.cashId).state.inCash,60);assert.equal(j.data.payments.length,0);
});

test('Cambio data saldo fattura: date non valide e lavoro riaperto non alterano dati',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j);
 j.invoicePayment(e.cashId,'inv-date',true,'2026-09-05','2026-09-14',()=>{});
 const before=storage.getItem();let commits=0;
 for(const date of ['2026-08-31','2026-09-15','2026-02-30',''])assert.throws(()=>j.invoicePayment(e.cashId,'inv-date',true,date,'2026-09-14',()=>commits++));
 assert.equal(commits,0);assert.equal(storage.getItem(),before);assert.equal(j.data.payments[0].date,'2026-09-05');
 j.setStatus(e.cashId,'IN LAVORAZIONE');const reopened=storage.getItem();
 assert.throws(()=>j.invoicePayment(e.cashId,'inv-date',true,'2026-09-09','2026-09-14',()=>commits++),/Completa il lavoro/);
 assert.equal(commits,0);assert.equal(storage.getItem(),reopened);assert.equal(j.data.payments[0].date,'2026-09-05');
});

test('Cambio data saldo fattura: errore commit ripristina data in memoria e archivio',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j);
 j.invoicePayment(e.cashId,'inv-date',true,'2026-09-05','2026-09-14',()=>{});
 const before=storage.getItem(),memoryBefore=structuredClone(j.data);
 assert.throws(()=>j.invoicePayment(e.cashId,'inv-date',true,'2026-09-09','2026-09-14',()=>{throw Error('commit-failed');}),/commit-failed/);
 assert.equal(storage.getItem(),before);assert.deepEqual(j.data,memoryBefore);assert.deepEqual(new Journal(storage).data,memoryBefore);
 j.invoicePayment(e.cashId,'inv-date',true,'2026-09-10','2026-09-14',()=>{});
 assert.equal(j.data.payments[0].date,'2026-09-10');assert.equal(j.data.payments.length,1);
});

test('Cambio data saldo fattura: errore storage non esegue commit né modifica il rientro',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j);
 j.invoicePayment(e.cashId,'inv-date',true,'2026-09-05','2026-09-14',()=>{});
 const before=storage.getItem();storage.setItem=()=>{throw Error('quota');};let commits=0;
 assert.throws(()=>j.invoicePayment(e.cashId,'inv-date',true,'2026-09-09','2026-09-14',()=>commits++),/Impossibile salvare/);
 assert.equal(commits,0);assert.equal(storage.getItem(),before);assert.equal(j.data.payments[0].date,'2026-09-05');assert.equal(j.received(e.cashId),100);
});

test('Acconto immediato: centesimi rigorosi, idempotenza e residuo fuori cassa',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j,entry({amount:100.15}),100.15);j.setStatus(e.cashId,'IN LAVORAZIONE');
 const p=j.recordDeposit(e.cashId,'30,05','2026-09-02','2026-09-13','10:00','request-0001');
 assert.equal(p.kind,'deposit');assert.equal(j.activePayments().length,1);assert.equal(j.deposits(e.cashId),30.05);
 assert.equal(j.recordDeposit(e.cashId,'30,05','2026-09-02','2026-09-13','10:00','request-0001').id,p.id);assert.equal(j.data.payments.length,1);
 assert.throws(()=>j.recordDeposit(e.cashId,'1','2026-09-02','2026-09-13','10:00','request-0001'),/già stata/);
 for(const value of ['-1','1.0011','2,001','NaN','0','70,11'])assert.throws(()=>j.recordDeposit(e.cashId,value,'2026-09-02','2026-09-13','10:00','request-0002'));
 j.setStatus(e.cashId,'COMPLETATO');const state=reconcile(e.amount,j.account(e.cashId).state,j.received(e.cashId));j.sync(e,state);j.persist();
 assert.equal(state.outside,70.1);assert.equal(state.inCash,0);assert.equal(Math.round((state.outside+j.received(e.cashId))*100),10015);
 j.settle(e.cashId,'2026-09-05','2026-09-13','12:00');assert.equal(j.received(e.cashId),100.15);
 e.amount=40;e.work='Corretto';assert.equal(j.adjustReturn(e),false);assert.equal(j.data.payments[0].cents,3005);assert.equal(j.data.payments[1].cents,7010);
 const reload=new Journal(storage);assert.equal(reload.deposits(e.cashId),30.05);assert.equal(reload.received(e.cashId),100.15);
});
test('Acconto completato con incasso iniziale: riduce solo il credito residuo',()=>{
 const j=new Journal(memory()),e=seed(j,entry(),40);j.setStatus(e.cashId,'COMPLETATO');
 j.recordDeposit(e.cashId,'20','2026-09-02','2026-09-13','12:00','request-0003');
 assert.equal(j.account(e.cashId).state.outside,20);assert.equal(j.account(e.cashId).state.inCash,60);
 const state=reconcile(100,j.account(e.cashId).state,j.received(e.cashId));assert.equal(state.outside,20);assert.equal(state.inCash,60);
 assert.throws(()=>j.recordDeposit(e.cashId,'20,01','2026-09-02','2026-09-13','12:00','request-0004'),/residuo/);
});
test('Acconto e saldo fattura indipendenti: annullare il saldo non cancella l’acconto',()=>{
 const j=new Journal(memory()),e=seed(j);j.setStatus(e.cashId,'IN LAVORAZIONE');
 j.recordDeposit(e.cashId,'30','2026-09-02','2026-09-13','12:00','request-0005');j.setStatus(e.cashId,'COMPLETATO');
 j.invoicePayment(e.cashId,'invoice-deposit',true,'2026-09-05','2026-09-13',()=>{});assert.equal(j.received(e.cashId),100);
 j.invoicePayment(e.cashId,'invoice-deposit',false,'2026-09-05','2026-09-13',()=>{});assert.equal(j.received(e.cashId),30);assert.equal(j.account(e.cashId).state.outside,70);assert.equal(j.deposits(e.cashId),30);
 j.setStatus(e.cashId,'IN LAVORAZIONE');assert.equal(j.activePayments().length,1);
});
test('Acconto non salvato non produce incasso e non altera il conto',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j),before=structuredClone(j.data);j.setStatus(e.cashId,'IN LAVORAZIONE');const status=structuredClone(j.data);
 storage.setItem=()=>{throw Error('full');};assert.throws(()=>j.recordDeposit(e.cashId,'30','2026-09-02','2026-09-13','12:00','request-0006'),/Impossibile salvare/);assert.deepEqual(j.data,status);
});
test('Lavoro gemello non riutilizza un conto collegato a un’altra riga',()=>{
 const j=new Journal(memory()),a=entry({key:'agenda:2026-09-01:row-a',sourceRow:{dataset:{}}});j.resolve(a);j.sync(a,{outside:100,inCash:0});
 const b=entry({key:'agenda:2026-09-01:row-b',sourceRow:{dataset:{}}});j.resolve(b);assert.notEqual(a.cashId,b.cashId);
});
test('Acconti esclusi dalle statistiche di attesa dei saldi',()=>{
 const {customerAverages}=require('./cashbook-core.js');assert.deepEqual(customerAverages([{kind:'deposit',days:0,meta:{customer:'A'}},{kind:'deposit',days:0,meta:{customer:'A'}}]),[]);
});

test('Eliminazione acconto: solo il pagamento selezionato viene rimosso, con idempotenza e residuo aggiornato',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j,entry({amount:100.15}),100.15);j.setStatus(e.cashId,'IN LAVORAZIONE');
 const first=j.recordDeposit(e.cashId,'30,05','2026-09-02','2026-09-13','12:00','remove-deposit-0001');
 const second=j.recordDeposit(e.cashId,'10,10','2026-09-03','2026-09-13','12:00','remove-deposit-0002');
 assert.equal(j.deleteDeposit(first.id).id,first.id);assert.equal(j.deposits(e.cashId),10.1);assert.equal(j.account(e.cashId).state.outside,90.05);
 assert.deepEqual(j.data.payments,[second]);assert.equal(j.account(e.cashId).state.profit,25);assert.equal(j.account(e.cashId).meta.amount,100.15);
 const saved=storage.getItem();assert.equal(j.deleteDeposit(first.id),null);assert.equal(storage.getItem(),saved);
 const reloaded=new Journal(storage);assert.equal(reloaded.deposits(e.cashId),10.1);assert.equal(reloaded.account(e.cashId).state.outside,90.05);
});
test('Eliminazione acconto completato: ripristina il credito e conserva incasso iniziale e profitto',()=>{
 const j=new Journal(memory()),e=seed(j,entry(),40);j.setStatus(e.cashId,'COMPLETATO');
 const payment=j.recordDeposit(e.cashId,'20','2026-09-02','2026-09-13','12:00','remove-deposit-0003');
 j.deleteDeposit(payment.id);assert.equal(j.account(e.cashId).state.outside,40);assert.equal(j.account(e.cashId).state.inCash,60);assert.equal(j.account(e.cashId).state.profit,25);
 assert.deepEqual(reconcile(100,j.account(e.cashId).state,j.received(e.cashId)),j.account(e.cashId).state);
});
test('Eliminazione acconto dopo saldo: non modifica il saldo successivo e consente un nuovo rientro distinto',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j);j.setStatus(e.cashId,'IN LAVORAZIONE');
 const payment=j.recordDeposit(e.cashId,'30','2026-09-02','2026-09-13','12:00','remove-deposit-0004');j.setStatus(e.cashId,'COMPLETATO');
 const settlement=structuredClone(j.settle(e.cashId,'2026-09-05','2026-09-13','12:00'));
 j.deleteDeposit(payment.id);assert.equal(j.account(e.cashId).state.outside,30);assert.equal(j.account(e.cashId).state.inCash,0);
 assert.deepEqual(j.data.payments,[settlement]);assert.equal(j.adjustReturn(e),false);assert.deepEqual(j.data.payments,[settlement]);
 const reloaded=new Journal(storage);assert.equal(reloaded.adjustReturn(e),false);assert.equal(reloaded.account(e.cashId).state.outside,30);
 const newSettlement=reloaded.settle(e.cashId,'2026-09-06','2026-09-13','12:00');assert.notEqual(newSettlement.id,settlement.id);
 assert.equal(newSettlement.cents,3000);assert.equal(reloaded.received(e.cashId),100);assert.deepEqual(reloaded.data.payments[0],settlement);
});
test('Eliminazione acconto: gli errori di salvataggio e le copie obsolete non alterano i pagamenti',()=>{
 const storage=memory(),j=new Journal(storage),e=seed(j);j.setStatus(e.cashId,'IN LAVORAZIONE');
 const payment=j.recordDeposit(e.cashId,'30','2026-09-02','2026-09-13','12:00','remove-deposit-0005');
 const old=new Journal(storage),before=structuredClone(j.data);storage.setItem=()=>{throw Error('quota');};
 assert.throws(()=>j.deleteDeposit(payment.id),/Impossibile salvare/);assert.deepEqual(j.data,before);
 const concurrent=memory(),first=new Journal(concurrent),entry1=seed(first);first.setStatus(entry1.cashId,'IN LAVORAZIONE');
 const deposit=first.recordDeposit(entry1.cashId,'30','2026-09-02','2026-09-13','12:00','remove-deposit-0006'),second=new Journal(concurrent);
 first.recordDeposit(entry1.cashId,'10','2026-09-02','2026-09-13','12:00','remove-deposit-0007');
 assert.throws(()=>second.deleteDeposit(deposit.id),/altra scheda/);assert.equal(new Journal(concurrent).data.payments.length,2);assert.equal(old.data.payments.length,1);
});
test('Eliminazione acconto rifiuta un saldo fattura e mantiene il suo collegamento',()=>{
 const j=new Journal(memory()),e=seed(j);j.setStatus(e.cashId,'IN LAVORAZIONE');
 const payment=j.recordDeposit(e.cashId,'30','2026-09-02','2026-09-13','12:00','remove-deposit-0008');j.setStatus(e.cashId,'COMPLETATO');
 j.invoicePayment(e.cashId,'invoice-after-deposit',true,'2026-09-05','2026-09-13',()=>{});
 const invoice=structuredClone(j.data.payments[1]);assert.throws(()=>j.deleteDeposit(invoice.id),/soltanto un acconto/);
 j.deleteDeposit(payment.id);assert.deepEqual(j.data.payments,[invoice]);assert.equal(j.account(e.cashId).state.outside,30);assert.equal(j.adjustReturn(e),false);
});
