/* Inventory DIO calculations shared by the browser UI and unit tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkshopInventoryDioCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const finite = value => Number.isFinite(Number(value));
  const validCost = value => value !== null && value !== undefined && value !== '' && finite(value) && Number(value) >= 0;
  const validQuantity = value => finite(value) && Number(value) >= 0;

  function createLedger(startedAt, quantity, unitCost) {
    if (!finite(startedAt) || !validQuantity(quantity)) throw new TypeError('Dati iniziali DIO non validi.');
    return {version:1, startedAt:Number(startedAt), opening:{quantity:Number(quantity), unitCost:validCost(unitCost)?Number(unitCost):null}, events:[]};
  }

  function parseLedger(value) {
    let ledger;
    try { ledger = typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return null; }
    if (!ledger || ledger.version !== 1 || !finite(ledger.startedAt) || !ledger.opening || !validQuantity(ledger.opening.quantity) || !(ledger.opening.unitCost === null || validCost(ledger.opening.unitCost)) || !Array.isArray(ledger.events)) return null;
    if (!ledger.events.every(event => event && typeof event.id === 'string' && event.id.length > 0 && finite(event.at) && ['receipt','sale','adjustment','revalue'].includes(event.kind) && (event.kind === 'receipt' ? validQuantity(event.quantity) && validCost(event.unitCost) : event.kind === 'sale' ? validQuantity(event.quantity) && (event.unitCost === null || validCost(event.unitCost)) : event.kind === 'adjustment' ? finite(event.delta) : validCost(event.unitCost)))) return null;
    return {version:1,startedAt:Number(ledger.startedAt),opening:{quantity:Number(ledger.opening.quantity),unitCost:validCost(ledger.opening.unitCost)?Number(ledger.opening.unitCost):null},events:ledger.events.map(event=>({...event,at:Number(event.at),quantity:event.quantity===undefined?undefined:Number(event.quantity),unitCost:event.unitCost===null?null:event.unitCost===undefined?undefined:Number(event.unitCost)}))};
  }

  function sortedEvents(ledger) {
    return ledger.events.map((event,index)=>({event,index})).sort((a,b)=>a.event.at-b.event.at||a.index-b.index).map(item=>item.event);
  }

  function apply(state, event) {
    if (event.kind === 'receipt') {
      const quantity = state.quantity, incoming = Number(event.quantity), cost = Number(event.unitCost);
      state.unitCost = quantity <= 0 ? cost : state.unitCost === null ? null : (quantity*state.unitCost+incoming*cost)/(quantity+incoming);
      state.quantity += incoming;
    } else if (event.kind === 'sale') {
      state.quantity = Math.max(0,state.quantity-Number(event.quantity));
      if (state.quantity <= 1e-9) state.quantity = 0;
    } else if (event.kind === 'adjustment') {
      state.quantity = Math.max(0,state.quantity+Number(event.delta));
      if (state.quantity <= 1e-9) state.quantity = 0;
    } else if (event.kind === 'revalue') state.unitCost = Number(event.unitCost);
  }

  function stateAt(ledger, time) {
    const state = {quantity:ledger.opening.quantity,unitCost:ledger.opening.unitCost};
    for (const event of sortedEvents(ledger)) {
      if (event.at > time) break;
      apply(state,event);
    }
    return state;
  }

  function upsert(ledger, event) {
    const next = parseLedger(ledger);
    if (!next || !event || typeof event.id !== 'string' || !event.id || !finite(event.at)) throw new TypeError('Movimento DIO non valido.');
    next.events = next.events.filter(item=>item.id!==event.id);
    const clean = {id:event.id,at:Number(event.at),kind:event.kind};
    if (event.kind === 'adjustment') clean.delta = Number(event.delta);
    else if (event.kind === 'revalue') clean.unitCost = Number(event.unitCost);
    else if(event.kind==='sale'){clean.quantity=Number(event.quantity);clean.unitCost=event.unitCost===null?null:Number(event.unitCost);}
    else {clean.quantity=Number(event.quantity);clean.unitCost=Number(event.unitCost);}
    if (!['receipt','sale','adjustment','revalue'].includes(clean.kind) || clean.kind === 'receipt' && (!validQuantity(clean.quantity)||!validCost(clean.unitCost)) || clean.kind === 'sale' && (!validQuantity(clean.quantity)||!(clean.unitCost===null||validCost(clean.unitCost))) || clean.kind === 'adjustment' && !finite(clean.delta) || clean.kind === 'revalue' && !validCost(clean.unitCost)) throw new TypeError('Movimento DIO non valido.');
    next.events.push(clean);
    return next;
  }

  function remove(ledger, id) {
    const next = parseLedger(ledger);
    if (!next) return null;
    next.events = next.events.filter(event=>event.id!==id);
    return next;
  }

  function summarize(value, asOf=Date.now(), periodStart) {
    const ledger = parseLedger(value);
    if (!ledger || !finite(asOf)) return {dioDays:null,reason:'storico non valido'};
    const start = periodStart === undefined ? ledger.startedAt : Number(periodStart), end = Number(asOf);
    if (!finite(start) || start < ledger.startedAt || end <= start) return {dioDays:null,reason:'periodo insufficiente'};
    const events = sortedEvents(ledger), state = stateAt(ledger,start);
    let cursor=start,inventoryValueMs=0,costOfGoodsSold=0,complete=true;
    if (state.quantity > 0 && state.unitCost === null) complete=false;
    for (const event of events) {
      if (event.at <= start || event.at > end) continue;
      const duration=event.at-cursor;
      if (duration>0) {
        if (state.quantity>0 && state.unitCost===null) complete=false;
        else if (state.quantity>0) inventoryValueMs+=state.quantity*state.unitCost*duration;
      }
      cursor=event.at;
      if (event.kind==='sale') {
        if (event.unitCost===null) complete=false;
        else costOfGoodsSold+=Number(event.quantity)*Number(event.unitCost);
      }
      apply(state,event);
      if (state.quantity>0 && state.unitCost===null) complete=false;
    }
    const tail=end-cursor;
    if (tail>0) {
      if (state.quantity>0 && state.unitCost===null) complete=false;
      else if (state.quantity>0) inventoryValueMs+=state.quantity*state.unitCost*tail;
    }
    const elapsedDays=(end-start)/DAY_MS, averageInventoryValue=inventoryValueMs/(end-start);
    if (!complete) return {dioDays:null,reason:'costo non disponibile',elapsedDays,averageInventoryValue:null,costOfGoodsSold};
    if (costOfGoodsSold<=0) return {dioDays:null,reason:'nessun consumo valorizzato',elapsedDays,averageInventoryValue,costOfGoodsSold};
    return {dioDays:averageInventoryValue/costOfGoodsSold*elapsedDays,reason:'',elapsedDays,averageInventoryValue,costOfGoodsSold};
  }

  return Object.freeze({DAY_MS,createLedger,parseLedger,upsert,remove,stateAt,summarize});
});
