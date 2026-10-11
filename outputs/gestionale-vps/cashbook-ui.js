(() => {
  'use strict';
  const api=window.WorkshopLedgerCash;
  const analysis=document.querySelector('#analysis .analysis-dashboard');
  if(!api || !analysis) return;
  const money=n=>'€ '+Number(n||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
  const dateLabel=date=>date.split('-').reverse().join('/');
  const waitDays=date=>Math.max(0,WorkshopCashbookCore.days(date,today()));
  const normalize=s=>String(s||'').toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]/gu,'');
  document.querySelector('#libroContabile .page-head').insertAdjacentHTML('beforeend','<button type="button" class="btn" id="openCashReturn">+ Rientro</button>');
  document.querySelector('#libroContabile .page-head').insertAdjacentHTML('afterend','<p class="cash-help">Il rientro registra la cassa nel giorno del pagamento. L’importo del lavoro e il profitto restano nella data originale.</p><p class="cash-error" id="cashLedgerError" role="status" hidden></p>');
  analysis.insertAdjacentHTML('afterbegin',`<section class="card cash-summary" aria-labelledby="cashSummaryTitle">
    <div class="cardhead"><div><h2 id="cashSummaryTitle">Fuori cassa e uscite</h2><p class="cash-help">Il saldo clienti comprende tutti i lavori registrati. Le uscite seguono il filtro “Periodo incassi”. L’attesa parte dal completamento: per i debiti aperti cresce ogni giorno e si ferma al saldo.</p></div><button type="button" class="btn secondary" id="analysisCashReturn">Registra rientro</button></div>
    <p class="cash-error" id="cashAnalysisError" role="status" hidden></p>
    <div class="cash-kpis"><div><span>Totale da ricevere</span><strong id="cashOutstandingTotal"></strong></div><div><span>Clienti con saldo aperto</span><strong id="cashOutstandingClients"></strong><small id="cashOutstandingWorks"></small></div><div><span>Uscite</span><strong id="cashExpensesTotal">—</strong><small id="cashExpensesPaid">Già pagato: —</small><small id="cashExpensesOutstanding">Da pagare: —</small><small id="cashExpensesPeriod">Fatture fornitori</small></div><div><span>Tempo medio al saldo</span><strong id="cashMeanDays"></strong><small id="cashMeanDaysDetail"></small></div></div>
    <label class="cash-search-label">Cerca nei fuori cassa<input type="search" id="cashAnalysisSearch" placeholder="Cliente, targa o lavorazione" autocomplete="off"></label>
    <h3>Clienti che devono ancora pagare</h3><div class="cash-table-wrap"><table class="page-table cash-table cash-customer-table"><thead><tr><th>Cliente</th><th>Debito totale</th><th>Attesa media al saldo</th><th>Interventi aperti</th></tr></thead><tbody id="cashOutstandingRows"></tbody></table></div>
    <details class="cash-history"><summary>Storico rientri e tempi di pagamento <span id="cashReturnCount"></span></summary><div class="cash-table-wrap"><table class="page-table cash-table"><thead><tr><th>Cliente / veicolo</th><th>Lavoro</th><th>Completato il</th><th>Saldato il</th><th>Rientro in cassa</th><th>Tempo al saldo</th></tr></thead><tbody id="cashHistoryRows"></tbody></table></div></details>
  </section>`);
  analysis.insertAdjacentHTML('beforeend',`<section class="card cash-cycle" aria-labelledby="cashCycleTitle"><div class="cash-cycle-head"><div><h3 id="cashCycleTitle">Ciclo di conversione di cassa (CCC)</h3><p>CCC = DIO + DSO − DPO · Valori cumulativi, indipendenti dal filtro dei grafici.</p></div></div><div class="cash-cycle-grid"><div><span>DIO · giorni di giacenza scorte</span><strong id="cashCycleDio">—</strong><small>Calcolato dai carichi, scarichi e costi registrati nel magazzino.</small></div><div><span>DSO · giorni medi di incasso</span><strong id="cashCycleDso"></strong><small>Posizioni aperte e saldate nel libro contabile.</small></div><div><span>DPO · giorni medi di pagamento</span><strong id="cashCycleDpo">—</strong><small id="cashCycleDpoDetail">Pagamenti fornitori confermati.</small></div><div class="cash-cycle-result"><span>CCC · giorni</span><strong id="cashCycleTotal">Non calcolabile</strong><small id="cashCycleResultDetail">Manca un valore DIO affidabile.</small></div></div><p class="cash-cycle-note" id="cashCycleNote">Il DIO e il CCC saranno calcolabili quando sarà disponibile lo storico delle scorte.</p></section>`);
  const dialog=document.createElement('dialog');
  dialog.id='cashReturnDialog';dialog.setAttribute('aria-labelledby','cashReturnTitle');
  dialog.innerHTML=`<form id="cashReturnForm"><div class="cardhead"><div><h2 id="cashReturnTitle">Registra un rientro</h2><p class="cash-help">Cerca e seleziona il lavoro da saldare.</p></div><button type="button" class="btn secondary" id="closeCashReturn">Chiudi</button></div>
    <label class="cash-search-label">Cerca lavoro fuori cassa<input type="search" id="cashReturnSearch" placeholder="Cliente, targa o lavorazione" autocomplete="off"></label>
    <div id="cashReturnResults" class="cash-return-results"></div>
    <div id="cashReturnSelection" class="cash-selection" hidden></div>
    <div class="field"><label for="cashReturnDate">Data del rientro</label><input id="cashReturnDate" type="date" required></div>
    <p class="cash-help">Saldo completo del residuo. Il lavoro passa a €0 fuori cassa. Il nuovo movimento avrà importo e profitto pari a €0: viene aggiunta soltanto la cassa.</p>
    <p id="cashReturnError" class="cash-error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn secondary" id="cancelCashReturn">Annulla</button><button type="submit" class="btn" id="confirmCashReturn" disabled>Conferma rientro</button></div></form>`;
  document.body.append(dialog);
  const get=id=>document.getElementById(id);
  let supplierCycle={loaded:false,averagePaymentDays:null,paymentCount:0,error:''};
  let stockCycle={loaded:false,averageInventoryDays:null,trackedItems:0,daysTracked:null,reason:''};
  const formatDays=value=>Number(value).toLocaleString('it-IT',{maximumFractionDigits:1})+' giorni';
  function renderCashCycle(dsoDays=null,dsoCount=0) {
    const dioDays=stockCycle.loaded&&Number.isFinite(stockCycle.averageInventoryDays)?stockCycle.averageInventoryDays:null,dpoDays=supplierCycle.loaded&&supplierCycle.paymentCount>0&&Number.isFinite(supplierCycle.averagePaymentDays)?supplierCycle.averagePaymentDays:null;
    const cccDays=[dioDays,dsoDays,dpoDays].every(Number.isFinite)?dioDays+dsoDays-dpoDays:null;
    get('cashCycleDio').textContent=dioDays===null?'—':formatDays(dioDays);
    get('cashCycleDso').textContent=dsoDays===null?'—':formatDays(dsoDays);
    get('cashCycleDpo').textContent=dpoDays===null?'—':formatDays(dpoDays);
    get('cashCycleDpoDetail').textContent=dpoDays===null?'Nessun pagamento fornitore utile registrato.':supplierCycle.paymentCount+' '+(supplierCycle.paymentCount===1?'pagamento registrato.':'pagamenti registrati.');
    get('cashCycleTotal').textContent=cccDays===null?'Non calcolabile':formatDays(cccDays);
    get('cashCycleResultDetail').textContent=cccDays===null?'Serve anche il DIO delle scorte.':'DIO + DSO − DPO';
    const dioNote=dioDays===null?'DIO complessivo non disponibile: '+(stockCycle.reason||'manca uno storico completo di tutte le scorte')+'. Il DIO per articolo è visibile nel magazzino.':'DIO complessivo calcolato su '+stockCycle.trackedItems+' scorte per '+Number(stockCycle.daysTracked||0).toLocaleString('it-IT',{maximumFractionDigits:1})+' giorni di storico comune.';
    get('cashCycleNote').textContent=dioNote+' Il DSO usa '+dsoCount+' '+(dsoCount===1?'posizione':'posizioni')+' aperte o saldate; il DPO è ponderato per importo sui pagamenti fornitori registrati.'+(supplierCycle.error?' Ultimo aggiornamento fornitori: '+supplierCycle.error:'');
  }
  let selectedId=''; let busy=false; let lastStorageError='';
  function match(entry,query) {return !query || normalize([entry.customer,entry.vehicle,entry.work,entry.date].join(' ')).includes(normalize(query));}
  function outstanding(snapshot) {return snapshot.entries.filter(entry=>entry.state.outside>0).sort((a,b)=>a.date.localeCompare(b.date)||a.customer.localeCompare(b.customer));}
  function outstandingByCustomer(entries,payments,asOf=today()) {
    const groups=new Map(),averages=new Map(WorkshopCashbookCore.customerAgingAverages(entries,payments,asOf).map(group=>[group.key,group]));
    for(const entry of entries) {
      const rawCustomer=String(entry.customer||'').trim(),customer=rawCustomer||'Cliente non specificato';
      const key=normalize(rawCustomer)||'senza-nome:'+entry.cashId;
      const group=groups.get(key)||{key,customer,entries:[]};
      group.entries.push(entry);groups.set(key,group);
    }
    return [...groups.values()].map(group=>{
      const history=averages.get(group.key);
      return {...group,total:group.entries.reduce((sum,entry)=>sum+Math.round((Number(entry.state.outside)||0)*100),0)/100,averageDays:history?.average??null,openCount:history?.openCount||0,settlements:history?.settledCount||0};
    }).sort((a,b)=>a.customer.localeCompare(b.customer,'it'));
  }
  function storageStatus(snapshot) {
    const message=snapshot.error || lastStorageError;
    for(const id of ['cashLedgerError','cashAnalysisError']) {get(id).textContent=message;get(id).hidden=!message;}
  }
  function renderSummary() {
    const snapshot=api.snapshot(), pending=outstanding(snapshot), payments=snapshot.payments.filter(payment=>payment.kind!=='deposit');
    storageStatus(snapshot);
    get('cashOutstandingTotal').textContent=money(pending.reduce((sum,e)=>sum+e.state.outside,0));
    get('cashOutstandingClients').textContent=new Set(pending.map(e=>normalize(e.customer))).size;
    get('cashOutstandingWorks').textContent=pending.length+(pending.length===1?' lavoro aperto':' lavori aperti');
    const aging=WorkshopCashbookCore.customerAgingAverages(snapshot.entries,payments,today()),agingCount=aging.reduce((sum,group)=>sum+group.count,0),agingDays=aging.reduce((sum,group)=>sum+group.totalDays,0),openCount=aging.reduce((sum,group)=>sum+group.openCount,0),settledCount=aging.reduce((sum,group)=>sum+group.settledCount,0);
    get('cashMeanDays').textContent=agingCount?(agingDays/agingCount).toLocaleString('it-IT',{maximumFractionDigits:1})+' giorni':'—';
    get('cashMeanDaysDetail').textContent=agingCount?openCount+' '+(openCount===1?'debito aperto':'debiti aperti')+' · '+settledCount+' '+(settledCount===1?'saldo registrato':'saldi registrati'):'Nessun debito o saldo da calcolare';
    renderCashCycle(agingCount?agingDays/agingCount:null,agingCount);
    const query=get('cashAnalysisSearch').value,groups=outstandingByCustomer(pending,payments,today()).filter(group=>!query||group.entries.some(entry=>match(entry,query)));
    get('cashOutstandingRows').innerHTML=groups.map((group,index)=>{
      const detailId='cash-customer-'+index, countLabel=group.entries.length===1?'1 intervento aperto':group.entries.length+' interventi aperti';
      const average=group.averageDays===null?'<b>—</b><small>Nessuna posizione da calcolare</small>':'<b>'+group.averageDays.toLocaleString('it-IT',{maximumFractionDigits:1})+' giorni</b><small>su '+(group.openCount+group.settlements)+' posizioni: '+group.openCount+(group.openCount===1?' aperta':' aperte')+' · '+group.settlements+(group.settlements===1?' saldata':' saldate')+'</small>';
      const works=group.entries.map(entry=>'<article class="cash-customer-work"><div class="cash-customer-work-title"><b>'+esc(entry.vehicle)+'</b><small>'+esc(entry.work)+'</small></div><div class="cash-customer-work-meta">Completato il '+dateLabel(entry.date)+' · '+waitDays(entry.date)+' '+(waitDays(entry.date)===1?'giorno':'giorni')+' di attesa</div><strong>'+money(entry.state.outside)+'</strong><button type="button" class="btn secondary" data-start-return="'+esc(entry.cashId)+'">Rientro</button></article>').join('');
      return '<tr class="cash-customer-row"><td><button type="button" class="cash-customer-toggle" data-cash-customer="'+detailId+'" aria-controls="'+detailId+'" aria-expanded="false"><span class="cash-customer-chevron" aria-hidden="true">›</span><span><b>'+esc(group.customer)+'</b><small>Mostra '+countLabel+'</small></span></button></td><td><b>'+money(group.total)+'</b></td><td class="cash-customer-average">'+average+'</td><td>'+countLabel+'</td></tr><tr id="'+detailId+'" class="cash-customer-detail" data-cash-detail="'+detailId+'" hidden><td colspan="4"><div class="cash-customer-worklist">'+works+'</div></td></tr>';
    }).join('')||'<tr><td colspan="4" class="no-results">'+(pending.length?'Nessun cliente corrisponde alla ricerca.':'Nessun fuori cassa da ricevere.')+'</td></tr>';
    get('cashReturnCount').textContent='('+payments.length+')';
    get('cashHistoryRows').innerHTML=[...payments].sort((a,b)=>b.date.localeCompare(a.date)).map(payment=>'<tr><td><b>'+esc(payment.meta.customer)+'</b><small>'+esc(payment.meta.vehicle)+'</small></td><td>'+esc(payment.meta.work)+'</td><td>'+dateLabel(payment.meta.date)+'</td><td>'+dateLabel(payment.date)+'</td><td><b>'+money(payment.cents/100)+'</b></td><td>'+payment.days+' giorni</td></tr>').join('')||'<tr><td colspan="6" class="no-results">Nessun rientro registrato.</td></tr>';
  }
  function renderSelection(pending) {
    const entry=pending.find(entry=>entry.cashId===selectedId);
    if(!entry) selectedId='';
    get('confirmCashReturn').disabled=!entry||busy;
    get('cashReturnSelection').hidden=!entry;
    get('cashReturnSelection').textContent=entry?entry.customer+' · '+entry.vehicle+' · saldo da registrare: '+money(entry.state.outside):'';
    get('cashReturnDate').min=entry?.date||'';
    get('cashReturnDate').max=today();
  }
  function renderSearch() {
    const snapshot=api.snapshot(), pending=outstanding(snapshot);
    const matches=pending.filter(entry=>match(entry,get('cashReturnSearch').value));
    get('cashReturnResults').innerHTML=matches.map(entry=>'<label class="cash-return-option"><input type="radio" name="cashReturnWork" value="'+entry.cashId+'" '+(selectedId===entry.cashId?'checked':'')+'><span><b>'+esc(entry.customer)+' · '+esc(entry.vehicle)+'</b><small>'+esc(entry.work)+' · lavoro del '+dateLabel(entry.date)+'</small></span><strong>'+money(entry.state.outside)+'</strong></label>').join('')||'<p class="cash-help">Nessun lavoro fuori cassa trovato.</p>';
    renderSelection(pending);
    if(snapshot.error) {get('cashReturnError').textContent=snapshot.error;get('confirmCashReturn').disabled=true;}
  }
  function open(id='') {
    selectedId=id;get('cashReturnSearch').value='';get('cashReturnDate').value=today();get('cashReturnError').textContent='';renderSearch();dialog.showModal();
  }
  get('openCashReturn').addEventListener('click',()=>open());
  get('analysisCashReturn').addEventListener('click',()=>open());
  get('cashOutstandingRows').addEventListener('click',event=>{
    const toggle=event.target.closest('[data-cash-customer]');
    if(toggle){const detail=[...get('cashOutstandingRows').querySelectorAll('[data-cash-detail]')].find(row=>row.dataset.cashDetail===toggle.dataset.cashCustomer);if(!detail)return;const expanded=toggle.getAttribute('aria-expanded')==='true';toggle.setAttribute('aria-expanded',String(!expanded));detail.hidden=expanded;return;}
    const button=event.target.closest('[data-start-return]');if(button) open(button.dataset.startReturn);
  });
  get('closeCashReturn').addEventListener('click',()=>dialog.close());get('cancelCashReturn').addEventListener('click',()=>dialog.close());
  get('cashReturnSearch').addEventListener('input',renderSearch);
  get('cashAnalysisSearch').addEventListener('input',renderSummary);
  get('cashReturnResults').addEventListener('change',event=>{
    if(event.target.name!=='cashReturnWork') return;
    selectedId=event.target.value;renderSelection(outstanding(api.snapshot()));
  });
  get('cashReturnForm').addEventListener('submit',event=>{
    event.preventDefault();if(busy||!selectedId)return;
    busy=true;get('confirmCashReturn').disabled=true;
    try {
      api.settle(selectedId,get('cashReturnDate').value);
      lastStorageError='';dialog.close();
      document.querySelector('[data-view="libroContabile"]').click();
      renderSummary();
    } catch(error) {get('cashReturnError').textContent=error.message;}
    finally {busy=false;get('confirmCashReturn').disabled=!selectedId;}
  });
  document.addEventListener('cashbook:changed',()=>{renderSummary();if(dialog.open&&!busy)renderSearch();});
  document.addEventListener('cashbook:storage',event=>{lastStorageError=event.detail;renderSummary();});
  window.addEventListener('supplier-invoices:cash-cycle',event=>{const detail=event.detail||{};supplierCycle={loaded:detail.loaded===true,averagePaymentDays:Number.isFinite(detail.averagePaymentDays)?detail.averagePaymentDays:null,paymentCount:Number(detail.paymentCount)||0,error:String(detail.error||'')};renderSummary();});
  window.addEventListener('stock-inventory:cash-cycle',event=>{const detail=event.detail||{};stockCycle={loaded:detail.loaded===true,averageInventoryDays:Number.isFinite(detail.averageInventoryDays)?detail.averageInventoryDays:null,trackedItems:Number(detail.trackedItems)||0,daysTracked:Number.isFinite(detail.daysTracked)?detail.daysTracked:null,reason:String(detail.reason||'')};renderSummary();});
  document.querySelector('[data-view="analysis"]').addEventListener('click',renderSummary);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)renderSummary();});
  renderSummary();
  let agingRefreshTimer;
  function scheduleAgingRefresh(){clearTimeout(agingRefreshTimer);const now=new Date(),next=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,1);agingRefreshTimer=setTimeout(()=>{renderSummary();scheduleAgingRefresh();},Math.max(1000,next-now));}
  scheduleAgingRefresh();
})();
