(function(root){
  'use strict';
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=v=>Number(v||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
  const safeLogo=v=>/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/.test(v||'')?v:'';
  const declaration='Il cliente prende atto che l’officina non risponde di furti o danni al veicolo causati esclusivamente da terzi e non imputabili all’officina, nei limiti consentiti dalla legge. Al momento della riconsegna il cliente verifica le condizioni del veicolo e segnala eventuali anomalie. Dopo l’effettiva riconsegna, le manovre effettuate dal cliente, compresa l’uscita dall’officina, restano sotto la sua responsabilità per i danni a lui imputabili. Restano ferme le responsabilità dell’officina per inadempimento degli obblighi di custodia o sicurezza, per fatti a essa imputabili, dolo o colpa grave e tutti i diritti inderogabili del cliente e del consumatore.';
  function buildSheet(data){
    const lines=data.lines||[];const logo=safeLogo(data.logo);
    return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${escape(data.title)}</title><style>
    @page{size:A4;margin:0;padding:15mm}*{box-sizing:border-box}body{font:11pt Arial,sans-serif;color:#111;margin:0;line-height:1.4}.heading{display:flex;gap:20px;align-items:center;border-bottom:2px solid #222;padding-bottom:12px;margin-bottom:16px}.heading img{width:85px;height:75px;object-fit:contain}.heading h1{font-size:19pt;margin:0}.heading p{margin:5px 0 0;font-size:13pt}.details{display:grid;grid-template-columns:1fr 1fr;gap:9px 20px;margin-bottom:18px}.details div{border-bottom:1px solid #ccc;min-height:32px;overflow-wrap:anywhere}.details b{font-size:9pt;color:#444;display:block}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #999;padding:8px;text-align:left;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}th:last-child,td:last-child{width:105px;text-align:right}.blank-work td{height:30px}.total{text-align:right;font-weight:bold;margin:12px 0 20px}.terms{font-size:9pt;break-inside:avoid}.terms h2{font-size:11pt;margin-bottom:5px}.signatures{display:flex;gap:25px;margin-top:32px;justify-content:space-between}.signatures span{border-top:1px solid #555;flex:1;padding-top:6px;font-size:9pt}.note{font-size:9pt;color:#444}button{font:inherit;padding:10px;margin-bottom:15px}@media print{button{display:none}}</style></head><body>
    <header class="heading">${logo?`<img src="${escape(logo)}" alt="Logo officina">`:''}<div><h1>${escape(data.shop)}</h1><p>${escape(data.title)}</p></div></header>
    <section class="details">${Object.entries(data.fields||{}).map(([label,value])=>`<div><b>${escape(label)}</b>${escape(value)||'____________________'}</div>`).join('')}</section>
    <table><thead><tr><th>Lavorazioni richieste / da svolgere</th><th>Importo (€)</th></tr></thead><tbody>${lines.map(l=>`<tr><td>${escape(l.description)}</td><td>${escape(money(l.amount))}</td></tr>`).join('')}${Array.from({length:5},()=>'<tr class="blank-work"><td>&nbsp;</td><td>&nbsp;</td></tr>').join('')}</tbody></table>
    <p class="total">Totale lavori indicati: € ${escape(money(lines.reduce((s,l)=>s+Math.round(Number(l.amount||0)*100),0)/100))}</p>
    <p class="note">Le righe aggiunte a mano devono essere concordate con il cliente. La stampa non salva la scheda nel gestionale.</p>
    <section class="terms"><h2>Dichiarazione su custodia, responsabilità e riconsegna</h2><p>${escape(declaration)}</p><div class="signatures"><span>Data e firma del cliente per presa visione</span><span>Firma del cliente al ritiro</span></div></section></body></html>`;
  }
  function buildLabel(data){
    const shop=String(data.shop||'Officina').trim()||'Officina';
    const logo=safeLogo(data.logo);
    const jobs=(Array.isArray(data.lines)?data.lines:[]).filter(line=>line?.done!==true&&String(line?.description||'').trim());
    return `<div class="key-label"><div class="key-label-brand">${logo?`<img class="key-label-logo" src="${escape(logo)}" alt="Logo officina">`:`<span class="key-label-logo key-label-monogram" aria-hidden="true">${escape(shop.charAt(0).toUpperCase())}</span>`}<strong>${escape(shop)}</strong></div><div class="key-label-identity"><div><small>CLIENTE</small><b>${escape(data.customer||'—')}</b></div><div><small>TARGA</small><b>${escape(data.plate||'—')}</b></div></div><div class="key-label-work"><strong>Lavorazioni da fare</strong>${jobs.length?`<ul>${jobs.map(line=>`<li>${escape(String(line.description).trim())}</li>`).join('')}</ul>`:'<p>Nessuna lavorazione in sospeso</p>'}</div><div class="key-label-extra"><span></span><span></span></div></div>`;
  }
  if(typeof module!=='undefined'&&module.exports){module.exports={buildSheet,buildLabel,declaration};return;}
  const $=id=>document.getElementById(id),value=id=>$(id)?.value||'';
  const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)?v.split('-').reverse().join('/'):v;
  const vehicle=$('parkVehicle')?.closest('.field'),km=$('parkKm')?.closest('.field');
  if(vehicle&&km){vehicle.classList.remove('full');vehicle.after(km);}
  function snapshot(kind){
    const shared={shop:document.querySelector('.brand-name')?.textContent.trim()||'Officina',logo:$('brandLogo')?.getAttribute('src')||''};
    if(kind==='acceptance')return {...shared,title:'Scheda di accettazione',...root.readAcceptancePrintData()};
    if(kind==='appointment')return {...shared,title:'Scheda di accettazione',fields:{Cliente:value('appCustomer'),Targa:value('appPlate'),Veicolo:value('appVehicle'),Chilometraggio:value('appKm'),'Data appuntamento':date(value('appDate')),Ora:value('appTime'),Telefono:value('appPhone'),Email:value('appEmail')},lines:root.WorkshopAppointmentLines?.read()||[{description:value('appWork'),amount:value('appAmount')}]};
    return {...shared,title:'Scheda veicolo in parcheggio',fields:{Cliente:value('parkCustomer'),Targa:value('parkPlate'),Veicolo:value('parkVehicle'),Chilometraggio:value('parkKm'),Telefono:value('parkPhone'),Email:value('parkEmail'),'Data ingresso':date(value('parkEntry')),'Data uscita':date(value('parkExit'))},lines:[{description:value('parkWork'),amount:value('parkWorkAmount')},...[...document.querySelectorAll('#extraParkingWorks .extra-parking-work')].map(row=>({description:row.querySelector('.parking-work-description').value,amount:row.querySelector('.parking-work-amount').value}))].filter(l=>l.description.trim())};
  }
  function labelSnapshot(kind,row){
    const shared={shop:document.querySelector('.brand-name')?.textContent.trim()||'Officina',logo:$('brandLogo')?.getAttribute('src')||''};
    if(row){
      const data=root.parkingDataFromRow?.(row)||{};
      let lines=[];try{lines=JSON.parse(row.dataset.workLines||'[]');}catch(_){/* A legacy row can lack structured work lines. */}
      if(!Array.isArray(lines)||!lines.length)lines=[{description:data.work||row.children[3]?.querySelector('b')?.textContent||''}];
      return {...shared,customer:data.customer||row.children[0]?.querySelector('b')?.textContent||'',plate:data.plate||'',lines};
    }
    if(kind==='acceptance'){
      const data=snapshot(kind);
      const lines=[...document.querySelectorAll('#acceptanceLines .acceptance-line')].map(item=>({description:item.querySelector('.acceptance-description')?.value||'',done:item.querySelector('.acceptance-done')?.checked===true}));
      return {...shared,customer:data.fields.Cliente,plate:data.fields.Targa,lines};
    }
    if(kind==='parking'){
      const lines=[{description:value('parkWork'),done:$('parkWorkDone')?.checked===true},...[...document.querySelectorAll('#extraParkingWorks .extra-parking-work')].map(item=>({description:item.querySelector('.parking-work-description')?.value||'',done:item.querySelector('.parking-work-done')?.checked===true}))];
      return {...shared,customer:value('parkCustomer'),plate:value('parkPlate').toUpperCase(),lines};
    }
    const data=snapshot(kind);
    return {...shared,customer:data.fields.Cliente,plate:data.fields.Targa,lines:data.lines};
  }
  function labelStyle(width,height){return `
    #workshopLabelPreview{position:fixed;inset:0;z-index:1100;background:#e8ece9;overflow:auto;padding:20px;color:#111;font:14px Arial,sans-serif}
    #workshopLabelToolbar{max-width:680px;margin:0 auto 14px;display:flex;flex-wrap:wrap;align-items:center;gap:10px}
    #workshopLabelToolbar label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700}
    #workshopLabelToolbar select{padding:8px;border:1px solid #aab5b0;border-radius:6px;background:white;color:#111}
    #workshopLabelToolbar p{flex-basis:100%;margin:0;font-size:12px}
    #workshopLabelPaper{box-sizing:border-box;width:${width}mm;min-height:60mm;height:auto;margin:auto;padding:3mm;background:white;color:#111;box-shadow:0 5px 25px #0002;overflow-wrap:anywhere}
    #workshopLabelPaper .key-label{font:9pt Arial,sans-serif;line-height:1.18;color:#111}
    #workshopLabelPaper .key-label-brand{display:flex;gap:2mm;align-items:center;padding-bottom:2mm;border-bottom:1px solid #111;font-size:11pt}
    #workshopLabelPaper .key-label-brand strong{overflow-wrap:anywhere}
    #workshopLabelPaper .key-label-logo{width:10mm;height:10mm;object-fit:contain;flex:none}
    #workshopLabelPaper .key-label-monogram{display:grid;place-items:center;border:1.5px solid #111;border-radius:2mm;font:bold 12pt Arial,sans-serif}
    #workshopLabelPaper .key-label-identity{display:grid;grid-template-columns:1fr 1fr;gap:2mm;padding:2mm 0;border-bottom:1px solid #777}
    #workshopLabelPaper .key-label-identity small{display:block;font-size:7pt;letter-spacing:.3px}
    #workshopLabelPaper .key-label-identity b{display:block;font-size:10pt;overflow-wrap:anywhere}
    #workshopLabelPaper .key-label-work{padding-top:2mm}
    #workshopLabelPaper .key-label-work strong{font-size:8pt}
    #workshopLabelPaper .key-label-work ul{margin:1mm 0 0;padding-left:4mm}
    #workshopLabelPaper .key-label-work li{margin:0 0 1mm;break-inside:avoid}
    #workshopLabelPaper .key-label-work p{margin:1mm 0}
    #workshopLabelPaper .key-label-extra{display:grid;gap:5mm;margin-top:4mm}
    #workshopLabelPaper .key-label-extra span{display:block;height:1mm;border-bottom:1px solid #777}
    @media print{@page{size:${width}mm ${height}mm;margin:0;padding:0}body>*:not(#workshopLabelPreview){display:none!important}#workshopLabelPreview{position:static!important;inset:auto!important;display:block!important;overflow:visible!important;padding:0!important;background:white!important}#workshopLabelToolbar{display:none!important}#workshopLabelPaper{width:${width}mm!important;min-height:${height}mm!important;height:${height}mm!important;margin:0!important;padding:3mm!important;box-shadow:none!important;print-color-adjust:exact}}`}
  function printLabel(data){
    $('workshopPrintClose')?.click();$('workshopLabelClose')?.click();
    const previousFocus=document.activeElement;
    const preview=document.createElement('div');preview.id='workshopLabelPreview';preview.setAttribute('role','dialog');preview.setAttribute('aria-modal','true');preview.setAttribute('aria-label','Anteprima etichetta chiavi');
    const toolbar=document.createElement('div');toolbar.id='workshopLabelToolbar';
    const widthLabel=document.createElement('label');widthLabel.textContent='Larghezza etichetta';
    const widthSelect=document.createElement('select');widthSelect.id='workshopLabelWidth';widthSelect.setAttribute('aria-label','Larghezza etichetta');for(const width of [58,80,100]){const option=document.createElement('option');option.value=String(width);option.textContent=width+' mm';widthSelect.append(option);}widthSelect.value='80';widthLabel.append(widthSelect);
    const printButton=document.createElement('button');printButton.type='button';printButton.className='btn';printButton.textContent='Stampa etichetta';
    const close=document.createElement('button');close.id='workshopLabelClose';close.type='button';close.className='btn secondary';close.textContent='Torna alla scheda';
    const hint=document.createElement('p');hint.textContent='Seleziona la larghezza del rotolo della stampante termica, poi scegli la stampante nella finestra di stampa.';
    const paper=document.createElement('div');paper.id='workshopLabelPaper';paper.innerHTML=buildLabel(data);
    const style=document.createElement('style');style.id='workshopLabelStyle';
    const size=()=>{const width=Number(widthSelect.value);paper.style.width=width+'mm';paper.style.height='auto';style.textContent=labelStyle(width,60);const height=Math.max(60,Math.ceil(paper.scrollHeight*25.4/96+3));style.textContent=labelStyle(width,height);paper.style.height=height+'mm';};
    const escapeKey=event=>{if(event.key==='Escape'){event.stopPropagation();close.click();}};
    close.onclick=()=>{preview.remove();style.remove();document.removeEventListener('keydown',escapeKey,true);previousFocus?.focus();};
    printButton.onclick=()=>{size();try{root.print();hint.textContent='Se la finestra di stampa non si apre, verifica che il browser permetta la stampa.';}catch(error){hint.textContent='Stampa non disponibile in questo browser.';}};
    widthSelect.addEventListener('change',size);
    toolbar.append(widthLabel,printButton,close,hint);preview.append(toolbar,paper);document.head.append(style);document.body.append(preview);size();document.addEventListener('keydown',escapeKey,true);printButton.focus();
  }
  function print(kind){
    $('workshopPrintClose')?.click();
    const data=snapshot(kind);
    const html=buildSheet(data);
    const parsed=new DOMParser().parseFromString(html,'text/html');
    const preview=document.createElement('div');preview.id='workshopPrintPreview';preview.setAttribute('role','dialog');preview.setAttribute('aria-modal','true');preview.setAttribute('aria-label','Anteprima scheda');
    const toolbar=document.createElement('div');toolbar.id='workshopPrintToolbar';
    const send=document.createElement('button');send.type='button';send.className='btn';send.textContent='Scarica PDF';send.onclick=async()=>{send.disabled=true;try{const bytes=await root.WorkshopSheetPDF(data,declaration);const pdfUrl=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));const a=document.createElement('a');a.href=pdfUrl;a.download='scheda-officina.pdf';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(pdfUrl),60000);hint.textContent='PDF scaricato: aprilo per stamparlo o conservarlo.';}catch(error){hint.textContent='Impossibile generare il PDF: '+error.message;}finally{send.disabled=false;}};
    const printButton=document.createElement('button');printButton.type='button';printButton.textContent='Stampa';printButton.className='btn secondary';printButton.onclick=()=>{try{root.print();hint.textContent='Se la finestra di stampa non si apre, usa Scarica PDF e stampa il file scaricato.';}catch(error){hint.textContent='Stampa non disponibile in questo browser. Usa Scarica PDF.';}};
    const labelButton=document.createElement('button');labelButton.type='button';labelButton.textContent='Stampa etichetta';labelButton.className='btn secondary';labelButton.onclick=()=>printLabel(labelSnapshot(kind));
    const close=document.createElement('button');close.id='workshopPrintClose';close.type='button';close.className='btn secondary';close.textContent='Torna alla scheda';
    const hint=document.createElement('p');hint.textContent='Scarica il PDF e aprilo per stampare la scheda.';
    const paper=document.createElement('div');paper.id='workshopPrintPaper';paper.append(...parsed.body.childNodes);
    const style=document.createElement('style');
    const scoped=parsed.querySelector('style').textContent.replace(/@page\{[^}]*\}/g,'').replace(/@media print\{button\{display:none\}\}/g,'').replace(/([^{}]+)\{/g,(_,selectors)=>selectors.split(',').map(s=>s.trim()==='body'?'#workshopPrintPaper':'#workshopPrintPaper '+s.trim()).join(',')+'{');
    style.textContent=scoped+'#workshopPrintPreview{position:fixed;inset:0;z-index:1000;background:#e8ece9;overflow:auto;padding:20px}#workshopPrintToolbar{max-width:794px;margin:0 auto 16px;display:flex;flex-wrap:wrap;gap:10px}#workshopPrintToolbar p{flex-basis:100%;margin:0;font:12px Arial;color:#333}#workshopPrintPaper{background:white;color:#111;max-width:794px;margin:auto;padding:40px;min-height:1000px}@media print{@page{size:A4;margin:0;padding:15mm}body>*:not(#workshopPrintPreview){display:none!important}#workshopPrintPreview{display:block!important;position:static;padding:0;background:white;overflow:visible}#workshopPrintToolbar{display:none!important}#workshopPrintPaper{max-width:none;padding:0;min-height:0}}';
    const previousFocus=document.activeElement;
    const escapeKey=e=>{if(e.key==='Escape'){e.stopPropagation();close.click();}};
    close.onclick=()=>{preview.remove();style.remove();document.removeEventListener('keydown',escapeKey,true);previousFocus?.focus();};
    toolbar.append(send,printButton,labelButton,close,hint);preview.append(toolbar,paper);document.head.append(style);document.body.append(preview);document.addEventListener('keydown',escapeKey,true);send.focus();
  }
  for(const [id,kind] of [['appointmentForm','appointment'],['parkingForm','parking'],['acceptanceForm','acceptance']]){
    const form=$(id);if(!form)continue;const button=document.createElement('button');button.type='button';button.className='btn secondary';button.textContent='Stampa scheda';button.addEventListener('click',()=>print(kind));form.querySelector('.modal-actions').prepend(button);
    if(kind!=='appointment'){const label=document.createElement('button');label.type='button';label.className='btn secondary';label.textContent='Stampa etichetta';label.addEventListener('click',()=>printLabel(labelSnapshot(kind)));button.after(label);}
  }
  const parkingCard=document.querySelector('.parking-section .card');
  if(parkingCard){
    const decorateParkingRows=()=>{parkingCard.querySelectorAll('.parking-row .parking-actions').forEach(actions=>{if(actions.querySelector('[data-print-parking-label]'))return;const button=document.createElement('button');button.type='button';button.className='btn secondary parking-label-button';button.dataset.printParkingLabel='';button.textContent='Stampa etichetta';actions.append(button);});};
    decorateParkingRows();new MutationObserver(decorateParkingRows).observe(parkingCard,{childList:true,subtree:true});
    document.addEventListener('click',event=>{const button=event.target.closest('[data-print-parking-label]');if(!button||!parkingCard.contains(button))return;event.preventDefault();event.stopPropagation();const row=button.closest('.parking-row');if(row)printLabel(labelSnapshot('parking',row));},true);
  }
  const style=document.createElement('style');style.textContent='#appointmentForm .modal-actions,#parkingForm .modal-actions{flex-wrap:wrap;gap:8px}#parkingForm{max-height:calc(100dvh - 36px);overflow-y:auto}';document.head.append(style);
})(typeof window!=='undefined'?window:globalThis);
