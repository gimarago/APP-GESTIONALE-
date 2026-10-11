/* Per-item Days Inventory Outstanding (DIO) from shared, dated stock movements. */
(() => {
  'use strict';
  const core=window.WorkshopInventoryDioCore,inventory=window.stockInventoryApi,body=document.getElementById('stockRows');
  if(!core||!inventory||!body)return;
  const localDate=()=>{const date=new Date();return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');};
  const startOfLocalDay=()=>new Date(localDate()+'T00:00:00').getTime();
  const money=value=>'€ '+Number(value||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
  const days=value=>Number(value).toLocaleString('it-IT',{maximumFractionDigits:1});
  const priceFor=row=>{const text=String(row?.cells[3]?.textContent||'').trim();return /\d/.test(text)?Math.max(0,inventory.numberFrom(text)):null;};
  const id=()=>crypto.randomUUID?.()||('dio-'+Date.now()+'-'+Math.random().toString(36).slice(2));
  const ledgerFor=row=>core.parseLedger(row?.dataset.dioHistory||'');
  const saveLedger=(row,ledger)=>{if(row&&ledger)row.dataset.dioHistory=JSON.stringify(ledger);scheduleRender();};
  function ensureLedger(row,knownPriorCost){
    let ledger=ledgerFor(row);
    if(ledger){
      if(ledger.opening.unitCost===null&&Number.isFinite(knownPriorCost)&&!ledger.events.some(event=>event.kind==='sale'||event.kind==='receipt')){ledger.opening.unitCost=knownPriorCost;saveLedger(row,ledger);}
      return ledger;
    }
    const quantity=inventory.quantityFor(row),cost=quantity>0&&Number.isFinite(knownPriorCost)?knownPriorCost:priceFor(row);
    ledger=core.createLedger(startOfLocalDay(),quantity,cost);
    row.dataset.dioHistory=JSON.stringify(ledger);
    return ledger;
  }
  function reconcileQuantity(row,ledger,at){
    const actual=inventory.quantityFor(row),recorded=core.stateAt(ledger,at).quantity;
    if(Math.abs(actual-recorded)>1e-8)ledger=core.upsert(ledger,{id:'reconcile:'+id(),at,kind:'adjustment',delta:actual-recorded});
    return ledger;
  }
  function eventIdentity(row,options){return String(options.eventId||('adjust:'+String(row.dataset.cloudId||row.dataset.ledgerKey||id())+':'+id()));}
  function updateLedgerForChange(row,before,next,options={}){
    if(window.WorkshopCloud?.applying||Math.abs(next-before)<1e-8)return;
    const now=Date.now(),kind=options.kind||'adjustment';before=Number.isFinite(Number(options.beforeQuantity))?Number(options.beforeQuantity):before;let ledger=ensureLedger(row,options.priorUnitCost);
    ledger=reconcileQuantity(row,ledger,now);
    const state=core.stateAt(ledger,now),quantity=Number(options.quantity??Math.abs(next-before));
    if(kind==='receipt'){
      const cost=Number(options.unitCost);
      if(!(quantity>0)||!Number.isFinite(cost)||cost<0)return;
      ledger=core.upsert(ledger,{id:'receipt:'+id(),at:now,kind:'receipt',quantity,unitCost:cost});
    }else if(kind==='sale'){
      if(!(quantity>0))return;
      ledger=core.upsert(ledger,{id:eventIdentity(row,options),at:Number(options.at)||now,kind:'sale',quantity,unitCost:state.unitCost});
    }else if(kind==='adjustment')ledger=core.upsert(ledger,{id:eventIdentity(row,options),at:now,kind:'adjustment',delta:next-before});
    saveLedger(row,ledger);
  }
  const originalSetQuantity=inventory.setQuantity;
  inventory.setQuantity=function setQuantityWithDio(row,value,options={}){
    if(!row||typeof originalSetQuantity!=='function')return 0;
    const before=Number.isFinite(Number(options.beforeQuantity))?Number(options.beforeQuantity):inventory.quantityFor(row),next=inventory.quantize(value,inventory.unitFor(row));
    if(options.kind!=='reversal')updateLedgerForChange(row,before,next,options);
    return originalSetQuantity(row,next);
  };
  inventory.removeDioSale=function removeDioSale(row,eventId){
    const ledger=ledgerFor(row);if(!ledger)return;
    const next=core.remove(ledger,String(eventId));if(next)saveLedger(row,next);
  };
  inventory.initializeDioHistory=function initializeDioHistory(row,quantity,cost){
    if(!row||ledgerFor(row))return;
    const ledger=core.createLedger(startOfLocalDay(),Math.max(0,Number(quantity)||0),cost!==null&&cost!==undefined&&cost!==''&&Number.isFinite(Number(cost))?Number(cost):null);
    saveLedger(row,ledger);
  };
  inventory.recordDioRevaluation=function recordDioRevaluation(row,cost){
    const value=Number(cost);if(!row||!Number.isFinite(value)||value<0)return;
    let ledger=ensureLedger(row);ledger=reconcileQuantity(row,ledger,Date.now());
    saveLedger(row,core.upsert(ledger,{id:'revalue:'+id(),at:Date.now(),kind:'revalue',unitCost:value}));
  };
  inventory.recordDioAdjustment=function recordDioAdjustment(row,beforeQuantity,afterQuantity,priorUnitCost){
    const before=Number(beforeQuantity),after=Number(afterQuantity);if(!row||!Number.isFinite(before)||!Number.isFinite(after)||Math.abs(after-before)<1e-8)return;
    const now=Date.now();let ledger=ledgerFor(row);
    if(!ledger){const cost=priorUnitCost===null?null:priorUnitCost!==undefined&&Number.isFinite(Number(priorUnitCost))?Number(priorUnitCost):priceFor(row);ledger=core.createLedger(startOfLocalDay(),Math.max(0,before),cost);}
    const recorded=core.stateAt(ledger,now).quantity;
    if(Math.abs(recorded-after)<1e-8)return; // A normal API quantity write already recorded this change.
    if(Math.abs(recorded-before)>1e-8)ledger=core.upsert(ledger,{id:'reconcile:'+id(),at:now,kind:'adjustment',delta:before-recorded});
    saveLedger(row,core.upsert(ledger,{id:'edit-adjust:'+id(),at:now,kind:'adjustment',delta:after-before}));
  };

  const table=body.closest('table'),head=table?.querySelector('thead tr');
  if(head&&!head.querySelector('[data-stock-dio-heading]'))head.insertAdjacentHTML('beforeend','<th data-stock-dio-heading title="Giacenza media al costo ÷ costo del venduto × giorni del periodo">DIO (giorni)</th>');
  const description=document.querySelector('#magazzino .page-head > div');
  if(description&&!description.querySelector('.stock-dio-help'))description.insertAdjacentHTML('beforeend','<small class="stock-dio-help">DIO per articolo = giacenza media al costo ÷ costo del venduto × giorni. Il conteggio parte dal primo movimento registrato; i periodi precedenti non hanno uno storico ricostruibile.</small>');
  if(!document.getElementById('stockDioStyles')){
    const style=document.createElement('style');style.id='stockDioStyles';style.textContent='#stockRows td.stock-dio-cell{min-width:112px;white-space:nowrap;font-variant-numeric:tabular-nums}#stockRows td.stock-dio-cell b{font-size:12px}#stockRows td.stock-dio-cell small{display:block;margin-top:3px;color:var(--muted,#718079);font-size:10px}#magazzino .stock-dio-help{display:block;margin-top:6px;color:var(--muted,#718079);font-size:10px;line-height:1.5;max-width:760px}#magazzino [data-stock-dio-heading]{white-space:nowrap}';document.head.append(style);
  }
  function renderRow(row,now){
    if(row.classList.contains('empty-filter')){const cell=row.querySelector('td');if(cell)cell.colSpan=head?.cells.length||cell.colSpan;return;}
    let cell=row.querySelector(':scope > td.stock-dio-cell');if(!cell){cell=row.insertCell();cell.className='stock-dio-cell';}
    const ledger=ledgerFor(row),summary=ledger?core.summarize(ledger,now):null;
    let content,title;
    if(!ledger){content='<b>—</b><small>storico assente</small>';title='Lo storico DIO inizierà con il primo carico o scarico registrato.';}
    else if(summary?.dioDays!==null&&Number.isFinite(summary?.dioDays)){
      content='<b>'+days(summary.dioDays)+'</b><small>giorni · dal '+new Date(ledger.startedAt).toLocaleDateString('it-IT')+'</small>';
      title='DIO = giacenza media al costo / costo del venduto × giorni. Periodo: '+new Date(ledger.startedAt).toLocaleDateString('it-IT')+' – '+new Date(now).toLocaleDateString('it-IT')+'. Giacenza media: '+money(summary.averageInventoryValue)+'; costo del venduto: '+money(summary.costOfGoodsSold)+'.';
    }else{
      const reason=summary?.reason==='costo non disponibile'?'costo mancante':summary?.reason==='nessun consumo valorizzato'?'attende consumi':summary?.reason==='periodo insufficiente'?'periodo insufficiente':'storico non valido';
      content='<b>—</b><small>'+reason+'</small>';
      title=summary?.reason==='costo non disponibile'?'Inserisci il costo medio della scorta per valorizzare correttamente il DIO.':summary?.reason==='nessun consumo valorizzato'?'Il DIO sarà calcolato quando lo storico includerà almeno uno scarico valorizzato.':'Il periodo di osservazione non è ancora sufficiente.';
    }
    if(cell.innerHTML!==content)cell.innerHTML=content;
    if(cell.title!==title)cell.title=title;
  }
  function globalSummary(now){
    const rows=inventory.rows(),ledgers=rows.map(ledgerFor),missing=ledgers.filter(ledger=>!ledger).length;
    if(!rows.length||missing)return {dioDays:null,reason:missing?'storico mancante per '+missing+' scorte':'nessuna scorta'};
    const start=Math.max(...ledgers.map(ledger=>ledger.startedAt));let averageValue=0,cogs=0,daysTracked=null;
    for(const ledger of ledgers){const summary=core.summarize(ledger,now,start);if(summary.dioDays===null&&summary.reason==='costo non disponibile')return {dioDays:null,reason:'costo non disponibile per almeno una scorta'};averageValue+=summary.averageInventoryValue||0;cogs+=summary.costOfGoodsSold||0;daysTracked=summary.elapsedDays;}
    if(!(cogs>0)||!(daysTracked>0))return {dioDays:null,reason:'nessun consumo valorizzato nel periodo comune'};
    return {dioDays:averageValue/cogs*daysTracked,reason:'',daysTracked,averageInventoryValue:averageValue,costOfGoodsSold:cogs};
  }
  function renderAll(){
    const now=Date.now();for(const row of body.rows)renderRow(row,now);
    const summary=globalSummary(now);
    window.dispatchEvent(new CustomEvent('stock-inventory:cash-cycle',{detail:{loaded:true,averageInventoryDays:summary.dioDays,trackedItems:inventory.rows().length,daysTracked:summary.daysTracked,reason:summary.reason}}));
  }
  let renderTimer;function scheduleRender(){clearTimeout(renderTimer);renderTimer=setTimeout(renderAll,0);}
  new MutationObserver(scheduleRender).observe(body,{childList:true});
  document.addEventListener('workshop-cloud-state-applied',event=>{if(event.detail?.selectors?.includes('#stockRows'))scheduleRender();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleRender();});
  // A product's first recorded quantity is an opening balance. Later changes
  // are tracked as receipts, cost revaluations, sales, or count adjustments.
  let pendingCreation=null;
  document.getElementById('stockForm')?.addEventListener('submit',()=>{
    pendingCreation={before:new Set(inventory.rows()),quantity:Number(document.getElementById('stockQuantity')?.value)||0,cost:document.getElementById('stockPrice')?.value};
    setTimeout(()=>{
      const pending=pendingCreation;pendingCreation=null;if(!pending)return;
      const row=inventory.rows().find(item=>!pending.before.has(item));if(!row)return;
      const cost=pending.cost===''||pending.cost===undefined?null:Math.max(0,inventory.numberFrom(pending.cost));
      inventory.initializeDioHistory(row,pending.quantity,cost);
    },180);
  },true);
  // If an operator corrects the weighted purchase cost in the stock editor,
  // preserve the correction date so earlier COGS retain their original cost.
  window.addEventListener('submit',event=>{
    if(event.target?.id!=='stockEditForm')return;
    const row=inventory.editingRow?.(),beforeQuantity=row?inventory.quantityFor(row):0,oldCost=row?priceFor(row):null;
    setTimeout(()=>{if(!row?.isConnected)return;const afterQuantity=inventory.quantityFor(row),newCost=priceFor(row);inventory.recordDioAdjustment(row,beforeQuantity,afterQuantity,oldCost);if(newCost!==null&&newCost!==oldCost)inventory.recordDioRevaluation(row,newCost);},150);
  },true);
  renderAll();
  let dailyTimer;function scheduleDaily(){clearTimeout(dailyTimer);const now=new Date(),next=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,1);dailyTimer=setTimeout(()=>{renderAll();scheduleDaily();},Math.max(1000,next-now));}scheduleDaily();
})();
