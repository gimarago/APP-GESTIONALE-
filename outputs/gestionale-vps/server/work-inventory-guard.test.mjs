import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { recordStore } from './records.mjs';
import { makeStateValidator } from './validation.mjs';

const require=createRequire(import.meta.url),R=require('../cloud-records.js'),schema=require('../cloud-schema.js');
const agenda='#agendaRows',parking='#agenda .parking-section .card';
const td=value=>({t:'td',a:{},c:[value]});
const statusSelect=(status,source=agenda)=>({t:'select',a:{class:source===agenda?'status-select':'parking-status'},c:['PROGRAMMATO','IN LAVORAZIONE','COMPLETATO','RITIRATO'].map(value=>({t:'option',a:{value,...(value===status?{selected:''}:{})},c:[value]}))});
const job=(status='PROGRAMMATO',source=agenda)=>({t:source===agenda?'tr':'div',a:{'data-cloud-id':'work','data-agenda-tyre-deductions':'[]','data-date':'2026-10-08'},c:[td('09:00'),td('Cliente'),td('AB123CD'),td({t:'input',a:{class:'work-input',value:'2 pneumatici 205/55/16'},c:[]}),td('€ 100,00'),td(statusSelect(status,source))]});
const stock=()=>({t:'tr',a:{'data-cloud-id':'tyre','data-quantity':'12'},c:[td('Pneumatico'),td('Pneumatici'),td('12')]});
function fixture(t,status='PROGRAMMATO'){
  const directory=mkdtempSync(join(tmpdir(),'officina-guard-test-')),db=openDatabase(directory),store=recordStore(db,makeStateValidator(schema),Date.now);
  const auth={role:'operator',username:'Test',sessionId:randomUUID()},clientId=randomUUID();
  t.after(()=>{db.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('officina-guard-test-'));rmSync(absolute,{recursive:true,force:true});});
  const operation=(base,update)=>{const state=structuredClone(base.state||R.empty());update(state);return {protocol:2,clientId,mutationId:randomUUID(),versions:base.versions,changes:R.diff(base.state,state,base.versions)};};
  const save=(update,base=store.read())=>store.commit(auth,operation(base,update));
  save(state=>{state.dom[agenda]=[job(status)];state.dom['#stockRows']=[stock()];});
  const changeStock=()=>save(state=>{state.dom['#stockRows'][0].a['data-quantity']='14';state.dom['#stockRows'][0].c[2]=td('14');});
  return {store,auth,operation,save,changeStock};
}
const rejected=action=>assert.throws(action,error=>error.status===409&&error.code==='DEPENDENCY_CONFLICT');
const setStatus=(row,status)=>{for(const option of row.c[5].c[0].c){delete option.a.selected;if(option.a.value===status)option.a.selected='';}};

for(const status of ['PROGRAMMATO','COMPLETATO'])test(`${status} presentation, notes and amounts do not conflict with an unrelated inventory update`,t=>{
  const f=fixture(t,status),base=f.store.read();
  const pending=f.operation(base,state=>{const row=state.dom[agenda][0];row.a.class='selected-row';row.a['data-work-notes']='Controllare il rumore';row.a['data-km']='120000';row.c[4]=td('€ 100,75');});
  assert.equal(R.needsInventoryGuard(pending.changes,R.flatten(base.state)),false);
  f.changeStock();f.store.commit(f.auth,pending);
  const end=f.store.read();assert.equal(end.state.dom['#stockRows'][0].a['data-quantity'],'14');assert.equal(end.state.dom[agenda][0].a['data-work-notes'],'Controllare il rumore');assert.equal(end.state.dom[agenda][0].c[4].c[0],'€ 100,75');
});

test('unselected completion options and completion text in a planned work are not stock dependencies',t=>{
  const f=fixture(t),base=f.store.read();
  const pending=f.operation(base,state=>{state.dom[agenda][0].c[3].c[0].a.value='Controllo da segnare COMPLETATO al ritiro';});
  assert.equal(R.needsInventoryGuard(pending.changes,R.flatten(base.state)),false);
  f.changeStock();f.store.commit(f.auth,pending);assert.equal(f.store.read().state.dom['#stockRows'][0].a['data-quantity'],'14');
});

test('receipt signature upgrades and structured amount changes preserve the inventory version fence only for real stock changes',t=>{
  const f=fixture(t,'COMPLETATO');
  f.save(state=>{const row=state.dom[agenda][0];row.a['data-agenda-tyre-deductions']=JSON.stringify([{stockId:'tyre',quantity:2,requested:2,unitProfit:5}]);row.a['data-acceptance-lines']=JSON.stringify([{description:'2 pneumatici 205/55/16',amount:100}]);});
  const base=f.store.read(),pending=f.operation(base,state=>{const row=state.dom[agenda][0];row.a['data-agenda-tyre-deductions']=JSON.stringify([{stockId:'tyre',quantity:2,requested:2,unitProfit:5,requestSignature:'recorded'}]);row.a['data-acceptance-lines']=JSON.stringify([{description:'2 pneumatici 205/55/16',amount:100.75,profit:10}]);});
  assert.equal(R.needsInventoryGuard(pending.changes,R.flatten(base.state)),false);
  f.changeStock();f.store.commit(f.auth,pending);assert.equal(f.store.read().state.dom['#stockRows'][0].a['data-quantity'],'14');
});

test('adding structured lines with the same completed description does not invent a stock operation',t=>{
  const f=fixture(t,'COMPLETATO'),base=f.store.read(),pending=f.operation(base,state=>{state.dom[agenda][0].a['data-acceptance-lines']=JSON.stringify([{description:'2 pneumatici 205/55/16',amount:100}]);});
  assert.equal(R.needsInventoryGuard(pending.changes,R.flatten(base.state)),false);
  f.changeStock();f.store.commit(f.auth,pending);assert.equal(f.store.read().state.dom['#stockRows'][0].a['data-quantity'],'14');
});

test('status option values remain authoritative when a legacy menu has a different class',()=>{
  const prior=job('PROGRAMMATO');prior.c[5].c[0].a.class='legacy-status';
  const row=structuredClone(prior);setStatus(row,'COMPLETATO');
  const key=R.key('row',agenda,'work');assert.equal(R.needsInventoryGuard([{key,value:row}],new Map([[key,prior]])),true);
});

for(const transition of [['PROGRAMMATO','COMPLETATO'],['COMPLETATO','PROGRAMMATO']])test(`a ${transition.join(' → ')} transition still rejects unseen stock changes`,t=>{
  const f=fixture(t,transition[0]),base=f.store.read(),pending=f.operation(base,state=>setStatus(state.dom[agenda][0],transition[1]));
  f.changeStock();const fresh=f.store.read();rejected(()=>f.store.commit(f.auth,pending));assert.deepEqual(f.store.read(),fresh);
});

for(const structured of [false,true])test(`changing ${structured?'structured':'inline'} descriptions on completed work still checks the stock`,t=>{
  const f=fixture(t,'COMPLETATO');if(structured)f.save(state=>{state.dom[agenda][0].a['data-acceptance-lines']=JSON.stringify([{description:'2 pneumatici 205/55/16',amount:100}]);});
  const base=f.store.read(),pending=f.operation(base,state=>{if(structured)state.dom[agenda][0].a['data-acceptance-lines']=JSON.stringify([{description:'4 pneumatici 205/55/16',amount:100}]);else state.dom[agenda][0].c[3].c[0].a.value='4 pneumatici 205/55/16';});
  f.changeStock();const fresh=f.store.read();rejected(()=>f.store.commit(f.auth,pending));assert.deepEqual(f.store.read(),fresh);
});

test('changing stock deductions still rejects an unseen inventory change',t=>{
  const f=fixture(t,'COMPLETATO'),base=f.store.read(),pending=f.operation(base,state=>{state.dom[agenda][0].a['data-agenda-consumable-deductions']=JSON.stringify([{stockId:'oil',quantity:4,requested:4}]);});
  f.changeStock();const fresh=f.store.read();rejected(()=>f.store.commit(f.auth,pending));assert.deepEqual(f.store.read(),fresh);
});

test('transferring completed work between agenda and parking still fences the inventory',t=>{
  const f=fixture(t,'COMPLETATO'),base=f.store.read(),pending=f.operation(base,state=>{state.dom[agenda]=[];state.dom[parking]=[job('COMPLETATO',parking)];});
  f.changeStock();const fresh=f.store.read();rejected(()=>f.store.commit(f.auth,pending));assert.deepEqual(f.store.read(),fresh);
});

test('equal proposed stock quantities cannot merge two distinct stock deductions',t=>{
  const f=fixture(t),base=f.store.read();
  const operation=id=>f.operation(base,state=>{state.dom['#stockRows'][0].a['data-quantity']='10';state.dom['#stockRows'][0].c[2]=td('10');const row=job('COMPLETATO');row.a['data-cloud-id']=id;state.dom[agenda].push(row);});
  const first=operation('first-work'),second=operation('second-work');f.store.commit(f.auth,first);const fresh=f.store.read();
  assert.throws(()=>f.store.commit(f.auth,second),error=>error.status===409&&error.code==='RECORD_CONFLICT');assert.deepEqual(f.store.read(),fresh);assert.equal(fresh.state.dom['#stockRows'][0].a['data-quantity'],'10');assert.equal(fresh.state.dom[agenda].length,2);
});
