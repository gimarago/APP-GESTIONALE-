import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { recordStore } from './records.mjs';
import { makeStateValidator } from './validation.mjs';
import { guardWorkReports } from './work-reports.mjs';

const require = createRequire(import.meta.url), R = require('../cloud-records.js'), schema = require('../cloud-schema.js');
const archiveKey = 'officina.invoices.v1', cashKey = 'ma-gomme-cashbook-v1';
const ids = ['account-agenda','account-parking','account-archived'];
const td = value => ({t:'td',a:{},c:[value]});
const account = (id, source) => ({id,status:'COMPLETATO',meta:{source,date:'2026-10-04',time:'09:00',customer:'Cliente Test',vehicle:'AB123CD',work:'Tagliando',amount:50},state:{outside:0,inCash:50,profit:10,lastEdited:'inCash'}});
const row = (id,cashId,parking=false) => ({t:parking?'div':'tr',a:{'data-cloud-id':id,'data-cash-account-id':cashId,'data-date':'2026-10-04',...(parking?{class:'parking-row'}:{})},c:parking?[{t:'b',a:{},c:['Cliente Test']},{t:'select',a:{class:'parking-status'},c:[{t:'option',a:{value:'COMPLETATO',selected:''},c:['COMPLETATO']}]}]:[td('09:00'),td('Cliente Test'),td('AB123CD'),td('Tagliando'),td('€ 50,00'),td({t:'select',a:{class:'status-select'},c:[{t:'option',a:{value:'COMPLETATO',selected:''},c:['COMPLETATO']}]})]});
const archive = state => JSON.parse(state.storage[archiveKey]);
const write = (state,value) => {state.storage[archiveKey]=JSON.stringify(value);};
const cash = state => JSON.parse(state.storage[cashKey]);
const writeCash = (state,value) => {state.storage[cashKey]=JSON.stringify(value);};
function report(workIds=ids) {
  const sources = ['agenda','parking','archive'],selectors=['#agendaRows','#agenda .parking-section .card',''],rowIds=['row-agenda','row-parking',''];
  return {id:randomUUID(),date:'2026-10-05',customer:'Cliente Test',customerKey:'clientetest',period:{start:'2026-10-01',end:'2026-10-04'},works:workIds.map(cashId=>{
    const index=ids.indexOf(cashId);
    return {id:cashId,cashId,source:sources[index],sourceSelector:selectors[index],rowId:rowIds[index],date:'2026-10-04',plate:'AB123CD',vehicle:'Fiat Panda',km:'15000',notes:'Note conservate',amount:50,lines:[{description:'Tagliando',amount:49.99},{description:'Materiale',amount:0.01}]};
  }),total:workIds.length*50};
}
const invoice = (r,extra={}) => ({id:randomUUID(),type:'TD01',status:'Bozza',date:'2026-10-05',customer:{name:r.customer},lines:[{description:'Tagliando',quantity:1,price:50/1.22,vat:22}],sourceWorkReportId:r.id,sourceWorkIds:r.works.map(work=>work.cashId),...extra});
const td24 = (r,extra={}) => {const month=r.works[0].date.slice(0,7),date=r.works.map(work=>work.date).sort().at(-1),reportNumber=`RI-${r.id.replace(/-/g,'').slice(0,17).toUpperCase()}`;return invoice(r,{type:'TD24',date,deferredServiceMonth:month,sourceWorkReportNumber:reportNumber,sourceWorkReportDate:r.date,notes:`Rif. rapporto ${reportNumber} del ${r.date}`,cashLink:'',...extra});};
const fails = (action,status,code) => assert.throws(action,error=>error.status===status&&error.code===code);
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'officina-work-reports-test-')),db=openDatabase(directory);
  const store=recordStore(db,makeStateValidator(schema),Date.now,guardWorkReports);
  const auth={role:'operator',username:'Reports Test',sessionId:randomUUID()},clientId=randomUUID();
  t.after(()=>{db.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('officina-work-reports-test-'));rmSync(absolute,{recursive:true,force:true});});
  const operation=(base,update)=>{const next=structuredClone(base.state||R.empty());update(next);return {protocol:2,clientId,mutationId:randomUUID(),versions:base.versions,changes:R.diff(base.state,next,base.versions)};};
  const save=(update,base=store.read())=>store.commit(auth,operation(base,update));
  save(state=>{
    state.dom['#agendaRows']=[row('row-agenda',ids[0])];
    state.dom['#agenda .parking-section .card']=[row('row-parking',ids[1],true)];
    state.dom['#stockRows']=[{t:'tr',a:{'data-cloud-id':'stock-one','data-quantity':'8'},c:[td('Prodotto'),td('Categoria'),td('8')]}];
    writeCash(state,{version:1,nextId:1,accounts:ids.map((id,index)=>account(id,['agenda','parking','archive'][index])),payments:[]});
    write(state,{version:1,seller:{name:'Officina'},documents:[]});
  });
  const addReport=(state,r)=>{const data=archive(state);data.workReports=[...(data.workReports||[]),structuredClone(r)];write(state,data);};
  const addInvoice=(state,doc)=>{const data=archive(state);data.documents.push(structuredClone(doc));write(state,data);};
  return {db,store,auth,operation,save,addReport,addInvoice};
}

test('report snapshots and TD01 conversion change only invoice archive; creation and conversion replay idempotently',t=>{
  const f=fixture(t),base=f.store.read(),r=report();
  const operation=f.operation(base,state=>f.addReport(state,r));
  f.store.commit(f.auth,operation);const saved=f.store.read();
  assert.deepEqual(saved.state.dom,base.state.dom);
  assert.equal(saved.state.storage[cashKey],base.state.storage[cashKey]);
  assert.equal(saved.versions['domain:inventory'],base.versions['domain:inventory']);
  assert.equal(f.store.commit(f.auth,operation).replayed,true);assert.deepEqual(f.store.read(),saved);
  const conversion=f.operation(saved,state=>f.addInvoice(state,invoice(r)));
  f.store.commit(f.auth,conversion);const converted=f.store.read();
  assert.deepEqual(converted.state.dom,base.state.dom);assert.equal(converted.state.storage[cashKey],base.state.storage[cashKey]);
  assert.equal(archive(converted.state).documents.length,1);
  assert.equal(f.store.commit(f.auth,conversion).replayed,true);assert.deepEqual(f.store.read(),converted);
});

test('new report fences an independently edited source account and source row without partial archive mutation',t=>{
  for(const edit of [state=>{const book=cash(state);book.accounts[0].state.profit=11;writeCash(state,book);},state=>{state.dom['#agendaRows'][0].c[3]=td('Descrizione corretta');}]){
    const f=fixture(t),base=f.store.read(),operation=f.operation(base,state=>f.addReport(state,report([ids[0]])));
    f.save(edit,base);const newer=f.store.read();
    fails(()=>f.store.commit(f.auth,operation),409,'DEPENDENCY_CONFLICT');
    assert.deepEqual(f.store.read(),newer);assert.equal(archive(newer.state).workReports,undefined);
  }
});

test('saved report fences a source edit made from an earlier account or row revision',t=>{
  for(const edit of [state=>{const book=cash(state);book.accounts[1].state.profit=11;writeCash(state,book);},state=>{state.dom['#agenda .parking-section .card'][0].a['data-vehicle']='Veicolo corretto';}]){
    const f=fixture(t),base=f.store.read(),operation=f.operation(base,edit);
    f.save(state=>f.addReport(state,report([ids[1]])),base);const saved=f.store.read();
    fails(()=>f.store.commit(f.auth,operation),409,'RECORD_CONFLICT');assert.deepEqual(f.store.read(),saved);
  }
});

test('conversion detects source row changes or transfers since the selected snapshot, including current source lookup by cash identity',t=>{
  const f=fixture(t),r=report([ids[0]]);f.save(state=>f.addReport(state,r));
  const base=f.store.read(),conversion=f.operation(base,state=>f.addInvoice(state,invoice(r)));
  f.save(state=>{
    const moved=structuredClone(state.dom['#agendaRows'][0]);moved.t='div';moved.a['data-cloud-id']='moved-row';moved.a.class='parking-row';
    state.dom['#agendaRows']=[];state.dom['#agenda .parking-section .card'].push(moved);
  },base);
  const newer=f.store.read();fails(()=>f.store.commit(f.auth,conversion),409,'DEPENDENCY_CONFLICT');assert.deepEqual(f.store.read(),newer);
  const latestConversion=f.operation(newer,state=>f.addInvoice(state,invoice(r)));
  const deps=R.dependencies(latestConversion.changes,R.flatten(newer.state));
  assert.ok(deps.includes(R.key('row','#agenda .parking-section .card','moved-row')),'conversion fences current row even if report retains original source');
  f.store.commit(f.auth,latestConversion);assert.equal(archive(f.store.read().state).documents.length,1);
});

test('overlapping reports are allowed, concurrent double invoices conflict and fresh duplicate source conversion is rejected',t=>{
  const f=fixture(t),first=report([ids[0]]),second=report([ids[0]]);
  f.save(state=>{f.addReport(state,first);f.addReport(state,second);});
  const base=f.store.read(),a=f.operation(base,state=>f.addInvoice(state,invoice(first))),b=f.operation(base,state=>f.addInvoice(state,invoice(second)));
  f.store.commit(f.auth,a);const saved=f.store.read();
  fails(()=>f.store.commit(f.auth,b),409,'RECORD_CONFLICT');assert.deepEqual(f.store.read(),saved);
  fails(()=>f.save(state=>f.addInvoice(state,invoice(second))),409,'WORK_ALREADY_INVOICED');assert.deepEqual(f.store.read(),saved);
});

test('removing the linked invoice unlocks source works; a referenced report cannot be deleted',t=>{
  const f=fixture(t),first=report([ids[0]]),second=report([ids[0]]);
  f.save(state=>{f.addReport(state,first);f.addReport(state,second);f.addInvoice(state,invoice(first));});
  fails(()=>f.save(state=>{const data=archive(state);data.workReports=data.workReports.filter(r=>r.id!==first.id);write(state,data);}),400,'WORK_REPORT_LINK');
  f.save(state=>{const data=archive(state);data.documents=[];write(state,data);});
  f.save(state=>f.addInvoice(state,invoice(second)));
  assert.equal(archive(f.store.read().state).documents[0].sourceWorkReportId,second.id);
});

test('historic report snapshots remain valid after source rework, while ordinary invoice payment edits do not depend on current source rows',t=>{
  const f=fixture(t),r=report([ids[0]]);f.save(state=>{f.addReport(state,r);f.addInvoice(state,invoice(r));});
  const base=f.store.read(),payment=f.operation(base,state=>{const data=archive(state);data.documents[0].payments=[{id:'invoice-payment',amount:5}];write(state,data);});
  assert.deepEqual(R.dependencies(payment.changes,R.flatten(base.state)),[],'unchanged source markers add no work fences');
  f.save(state=>{state.dom['#agendaRows'][0].c[3]=td('Lavoro aggiornato dopo rapporto');});
  f.store.commit(f.auth,payment);
  assert.deepEqual(archive(f.store.read().state).workReports,[r]);
  f.save(state=>{state.fields.shopPhone='Numero aggiornato';});
});

test('TD04 credit notes and legacy documents without report metadata retain their existing behavior',t=>{
  const f=fixture(t),r=report([ids[0]]);
  f.save(state=>{f.addReport(state,r);f.addInvoice(state,invoice(r));f.addInvoice(state,invoice(r,{type:'TD04'}));f.addInvoice(state,{id:'legacy-minimal',type:'TD01',anything:'legacy'});});
  assert.equal(archive(f.store.read().state).documents.length,3);
  const legacy=R.empty();write(legacy,{documents:[{id:'legacy',type:'TD01',customer:'Cliente vecchio'}]});assert.doesNotThrow(()=>guardWorkReports(legacy));
});

test('report conversion cannot rebill a work already linked to a single-work TD01; unrelated legacy duplicates stay compatible',t=>{
  const f=fixture(t),r=report([ids[0]]);
  f.save(state=>{f.addReport(state,r);f.addInvoice(state,{id:'legacy-invoice',type:'TD01',cashLink:ids[0]});});
  const before=f.store.read();
  fails(()=>f.save(state=>f.addInvoice(state,invoice(r))),409,'WORK_ALREADY_INVOICED');assert.deepEqual(f.store.read(),before);
  f.save(state=>{const data=archive(state);data.documents=[{id:'credit-old',type:'TD04',cashLink:ids[0]}];write(state,data);});
  f.save(state=>f.addInvoice(state,invoice(r)));
  assert.equal(archive(f.store.read().state).documents.length,2,'credit note does not occupy work identity');
  const legacy=R.empty();write(legacy,{documents:[{id:'legacy-one',type:'TD01',cashLink:ids[0]},{id:'legacy-two',type:'TD01',cashLink:ids[0]}]});
  assert.doesNotThrow(()=>guardWorkReports(legacy),'pre-existing duplicate legacy links are not newly validated');
});

test('report invoices cannot also settle a single-work cash account through cashLink',t=>{
  const f=fixture(t),r=report();f.save(state=>f.addReport(state,r));const before=f.store.read();
  fails(()=>f.save(state=>f.addInvoice(state,invoice(r,{cashLink:ids[0]}))),400,'WORK_REPORT_LINK');
  assert.deepEqual(f.store.read(),before,'invalid mixed links leave cash and work records unchanged');
  f.save(state=>f.addInvoice(state,invoice(r,{cashLink:''})));
  assert.equal(archive(f.store.read().state).documents.length,1,'empty cash link is the canonical frontend value');
});

test('TD24 report invoices require one service month, matching dated report reference and source identities',t=>{
  const f=fixture(t),r=report([ids[0]]);f.save(state=>f.addReport(state,r));
  f.save(state=>f.addInvoice(state,td24(r)));assert.equal(archive(f.store.read().state).documents[0].type,'TD24');
  const invalid=td24(r,{id:randomUUID(),deferredServiceMonth:'2026-09'}),before=f.store.read();fails(()=>f.save(state=>f.addInvoice(state,invalid)),400,'WORK_REPORT_LINK');assert.deepEqual(f.store.read(),before);
  const missingRef=td24(r,{id:randomUUID(),notes:'Fattura differita'});fails(()=>f.save(state=>f.addInvoice(state,missingRef)),400,'WORK_REPORT_LINK');assert.deepEqual(f.store.read(),before);
});

test('report shape, dates, customer keys, identities and exact cent totals are validated',()=>{
  const valid=report(),state=()=>{const value=R.empty();write(value,{workReports:[structuredClone(valid)],documents:[]});return value;};
  const invalidChanges=[r=>{r.id='invalid';},r=>{r.customerKey='wrong';},r=>{r.date='2026-02-30';},r=>{r.period.end='2026-09-01';},r=>{r.works[0].date='2026-09-01';},r=>{r.works[1].cashId=r.works[0].cashId;r.works[1].id=r.works[0].id;},r=>{r.works[0].id='different';},r=>{r.works[0].sourceSelector='#customerRows';},r=>{r.works[0].rowId='';},r=>{r.works[2].rowId='non-empty-archive';},r=>{r.works[0].km=-1;},r=>{r.works[0].lines=[];},r=>{r.works[0].lines[0].amount=49.999;},r=>{r.works[0].lines[0].amount=-1;},r=>{r.works[0].amount=51;},r=>{r.total=149.99;}];
  for(const change of invalidChanges){const value=state(),data=archive(value);change(data.workReports[0]);write(value,data);fails(()=>guardWorkReports(value),400,'WORK_REPORT_INVALID');}
  assert.doesNotThrow(()=>guardWorkReports(state()));
});

test('invoice source markers must reference one saved report and exactly its unique work identities',()=>{
  const r=report([ids[0],ids[1]]),changes=[d=>{d.sourceWorkReportId=randomUUID();},d=>{delete d.sourceWorkReportId;},d=>{delete d.sourceWorkIds;},d=>{d.sourceWorkIds=[ids[0]];},d=>{d.sourceWorkIds=[ids[0],ids[0]];},d=>{d.sourceWorkIds=[ids[0],ids[2]];}];
  for(const change of changes){const state=R.empty(),doc=invoice(r);change(doc);write(state,{workReports:[r],documents:[doc]});fails(()=>guardWorkReports(state),400,'WORK_REPORT_LINK');}
  const duplicateId=R.empty(),doc=invoice(r);write(duplicateId,{workReports:[r],documents:[doc,{id:doc.id,type:'TD01',cashLink:ids[0]}]});fails(()=>guardWorkReports(duplicateId),400,'WORK_REPORT_LINK');
  const noArray=R.empty();write(noArray,{workReports:null,documents:[]});fails(()=>guardWorkReports(noArray),400,'WORK_REPORT_INVALID');
});
