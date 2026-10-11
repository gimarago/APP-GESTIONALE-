'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const dio=require('./inventory-dio-core.js');

const day=dio.DAY_MS;

test('DIO follows average inventory value divided by cost of goods sold times days',()=>{
  const start=Date.UTC(2026,0,1),ledger=dio.createLedger(start,30,10);
  for(const [offset,quantity,id] of [[1,10,'sale-1'],[7,10,'sale-2'],[30,10,'sale-3']]){
    ledger.events.push({id,at:start+offset*day,kind:'sale',quantity,unitCost:10});
  }
  const result=dio.summarize(ledger,start+31*day);
  assert.equal(result.costOfGoodsSold,300);
  assert.equal(result.dioDays,12.666666666666666);
  assert.equal(result.averageInventoryValue,3800/31);
});

test('the DIO calculation weighs each group by its actual stock quantity',()=>{
  const start=Date.UTC(2026,0,1),ledger=dio.createLedger(start,35,10);
  for(const [offset,quantity,id] of [[1,10,'sale-1'],[7,20,'sale-2'],[30,5,'sale-3']])ledger.events.push({id,at:start+offset*day,kind:'sale',quantity,unitCost:10});
  const result=dio.summarize(ledger,start+31*day);
  assert.equal(result.costOfGoodsSold,350);
  assert.ok(Math.abs(result.dioDays-(10*1+20*7+5*30)/35)<1e-10);
});

test('new receipts update weighted cost while adjustments do not count as COGS',()=>{
  const start=Date.UTC(2026,0,1);let ledger=dio.createLedger(start,10,10);
  ledger=dio.upsert(ledger,{id:'receipt-1',at:start+5*day,kind:'receipt',quantity:5,unitCost:20});
  ledger=dio.upsert(ledger,{id:'count-correction',at:start+7*day,kind:'adjustment',delta:-1});
  ledger=dio.upsert(ledger,{id:'sale',at:start+10*day,kind:'sale',quantity:3,unitCost:40/3});
  const result=dio.summarize(ledger,start+15*day);
  assert.equal(result.costOfGoodsSold,40);
  assert.equal(result.reason,'');
  assert.ok(result.dioDays>0);
});

test('DIO remains unavailable when an open balance or sale has no known unit cost',()=>{
  const start=Date.UTC(2026,0,1),ledger=dio.createLedger(start,4,null);
  ledger.events.push({id:'sale',at:start+day,kind:'sale',quantity:1,unitCost:null});
  const result=dio.summarize(ledger,start+2*day);
  assert.equal(result.dioDays,null);
  assert.equal(result.reason,'costo non disponibile');
});

test('replacing and removing a sale event updates cost of goods sold',()=>{
  const start=Date.UTC(2026,0,1),initial=dio.createLedger(start,10,5);
  const changed=dio.upsert(initial,{id:'work-1',at:start+day,kind:'sale',quantity:3,unitCost:5});
  const replaced=dio.upsert(changed,{id:'work-1',at:start+day,kind:'sale',quantity:2,unitCost:5});
  assert.equal(replaced.events.length,1);
  assert.equal(dio.summarize(replaced,start+2*day).costOfGoodsSold,10);
  const removed=dio.remove(replaced,'work-1');
  assert.equal(removed.events.length,0);
  assert.equal(dio.summarize(removed,start+2*day).reason,'nessun consumo valorizzato');
});
