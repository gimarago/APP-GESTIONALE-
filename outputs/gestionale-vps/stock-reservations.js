(function(root,factory){const core=factory();if(typeof module==='object'&&module.exports)module.exports=core;else root.WorkshopReservations=core;})(globalThis,()=>{
  const normalized=s=>String(s||'').toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  function exactProduct(description,stocks){
    if(/\b(?:test|controllo|verifica|diagnosi|ricarica batteria)\b/i.test(description))return null;
    const text=normalized(description);
    const candidates=stocks.filter(s=>normalized(s.name).length>4 && text.includes(normalized(s.name)));
    if(candidates.length!==1)return null;
    const stock=candidates[0];
    const prefix=String(description).match(/^\s*(?:(?:sostituzione|montaggio|fornitura|installazione|cambio|aggiunta|rabbocco)\s+)?(\d+(?:[.,]\d+)?)\s+(?:(?:pz|pezzi|pneumatici|gomme|lt|litri|l|kg)\s+)?/i);
    // A leading number that belongs to the product name is not a quantity.
    const quantity=prefix && !normalized(stock.name).startsWith(normalized(prefix[0]))?Number(prefix[1].replace(',','.')):1;
    return {row:stock.row,quantity};
  }
  function aggregate(works,match){
    const totals=new Map();
    works.filter(w=>w.status && w.status!=='COMPLETATO').forEach(work=>work.lines.forEach(line=>{
      match(line.description||'').forEach(item=>{if(item.row && item.quantity>0)totals.set(item.row,(totals.get(item.row)||0)+item.quantity);});
    }));
    return totals;
  }
  return {exactProduct,aggregate};
});
if(typeof document!=='undefined') (()=>{
  const inventory=window.stockInventoryApi,stockBody=document.getElementById('stockRows');
  if(!inventory||!stockBody)return;
  const table=stockBody.closest('table');
  const header=document.createElement('th');header.textContent='Prenotato';header.title='Quantità richieste dai lavori non completati';table.tHead.rows[0].append(header);
  const note=document.createElement('p');note.className='reservation-note';note.textContent='Prenotato: prodotti riconosciuti nei lavori non completati, inclusi quelli ancora aperti dei giorni precedenti. La disponibilità indica la scorta fisica.';table.parentElement.after(note);
  document.head.insertAdjacentHTML('beforeend','<style>.stock-reserved{font-weight:700;white-space:nowrap;color:var(--ink)}.stock-reserved.overbooked{color:var(--orange,#ce703e)}.reservation-note{font-size:11px;line-height:1.6;color:var(--muted);margin:12px 0}</style>');
  const read=(row,key,fallback)=>{try{const lines=JSON.parse(row.dataset[key]||'[]');if(Array.isArray(lines)&&lines.length)return lines;}catch{}return [{description:fallback}];};
  const works=()=>[
    ...[...document.querySelectorAll('#agendaRows tr:not(.agenda-empty)')].map(row=>({status:row.querySelector('.status-select')?.value,lines:read(row,'acceptanceLines',row.querySelector('.work-input')?.value||row.cells[3]?.textContent||'')})),
    ...[...document.querySelectorAll('#agenda .parking-row')].map(row=>({status:row.querySelector('.parking-status')?.value,lines:read(row,'workLines',row.children[3]?.querySelector('b')?.textContent||'')}))
  ];
  function render(){
    const stocks=inventory.rows();
    // Tyre rows must only be matched by the tyre parser, even when a malformed
    // work description contains their normalized product name as a substring.
    const genericStocks=stocks.filter(row=>!(typeof WorkshopTyreRecognition!=='undefined'&&WorkshopTyreRecognition.stockDetails(inventory.productName(row),row.cells[1]?.textContent||''))).map(row=>({row,name:inventory.productName(row)}));
    const match=description=>{
      const result=[];
      (typeof WorkshopTyreRecognition!=='undefined'?WorkshopTyreRecognition.segments(description):String(description).split(/[+;·]/)).forEach(segment=>{
        const consumables=window.workshopProductRequests?.(segment)||[];if(consumables.length){result.push(...consumables);return;}
        const detail=typeof tyreDetails==='function'?tyreDetails(segment):null;
        if(detail){const row=typeof exactTyreStockRow==='function'?exactTyreStockRow(detail):null;if(row)result.push({row,quantity:detail.quantity});return;}
        // A tyre whose quantity, identity or season cannot be resolved must not
        // bypass the same checks through the generic product-name fallback.
        if(typeof WorkshopTyreRecognition!=='undefined'&&WorkshopTyreRecognition.stockDetails(segment))return;
        const exact=WorkshopReservations.exactProduct(segment,genericStocks);if(exact)result.push(exact);
      });
      return result;
    };
    const totals=WorkshopReservations.aggregate(works(),match);
    stocks.forEach(row=>{
      let cell=row.querySelector('.stock-reserved');if(!cell){cell=row.insertCell();cell.className='stock-reserved';}
      const quantity=inventory.quantize(totals.get(row)||0,inventory.unitFor(row));
      const text=quantity.toLocaleString('it-IT',{maximumFractionDigits:3})+' '+inventory.unitFor(row);
      if(cell.textContent!==text)cell.textContent=text;
      const over=quantity>inventory.quantityFor(row);cell.classList.toggle('overbooked',over);
      const title=over?'Prenotazioni superiori alla scorta fisica':'Quantità richiesta nei lavori non completati';if(cell.title!==title)cell.title=title;
    });
    stockBody.querySelectorAll('.empty-filter td').forEach(cell=>{cell.colSpan=table.tHead.rows[0].cells.length;});
  }
  let timer;const schedule=()=>{clearTimeout(timer);timer=setTimeout(render,80);};
  document.addEventListener('input',event=>{if(event.target.closest('#agenda,#magazzino'))schedule();});
  document.addEventListener('change',schedule);
  document.addEventListener('submit',schedule,true);
  new MutationObserver(schedule).observe(document.getElementById('agenda'),{childList:true,subtree:true,attributes:true,attributeFilter:['data-work-lines','data-acceptance-lines']});
  new MutationObserver(mutations=>{if(mutations.some(m=>!m.target.closest?.('.stock-reserved')))schedule();}).observe(stockBody,{childList:true,subtree:true,characterData:true});
  document.querySelector('[data-view="magazzino"]')?.addEventListener('click',schedule);render();
})();
