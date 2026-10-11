(() => {
 'use strict';const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=n=>Number(n).toLocaleString('it-IT',{style:'currency',currency:'EUR'});
 const today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
 const average=document.createElement('dialog');average.id='customerAverageDialog';average.setAttribute('aria-labelledby','customerAverageTitle');average.innerHTML='<h2 id="customerAverageTitle">Tempo medio di saldo per cliente</h2><p>Tutti i veicoli dello stesso cliente sono raggruppati. I debiti aperti maturano dal completamento fino a oggi; i saldi registrati mantengono i giorni effettivi.</p><div class="cash-table-wrap"><table><thead><tr><th>Cliente</th><th>Debiti aperti</th><th>Saldi registrati</th><th>Tempo medio</th></tr></thead><tbody id="customerAverageRows"></tbody></table></div><button class="btn secondary" id="closeCustomerAverage">Chiudi</button>';document.body.append(average);
 const card=$('cashMeanDays').parentElement;card.setAttribute('role','button');card.tabIndex=0;card.setAttribute('aria-label','Mostra il tempo medio di saldo per cliente');card.setAttribute('aria-haspopup','dialog');
 const showAverage=()=>{const snapshot=WorkshopLedgerCash.snapshot(),groups=WorkshopCashbookCore.customerAgingAverages(snapshot.entries,snapshot.payments,today());$('customerAverageRows').innerHTML=groups.map(g=>'<tr><td>'+esc(g.customer)+'</td><td>'+g.openCount+'</td><td>'+g.settledCount+'</td><td>'+g.average.toLocaleString('it-IT',{maximumFractionDigits:1})+' giorni</td></tr>').join('')||'<tr><td colspan="4">Nessun debito o saldo da calcolare.</td></tr>';average.showModal();};card.addEventListener('click',showAverage);card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showAverage();}});$('closeCustomerAverage').onclick=()=>average.close();
 const quoteKey='officina-quotes-v1';let quotes=[],error='';try{quotes=JSON.parse(localStorage.getItem(quoteKey)||'[]');if(!Array.isArray(quotes))throw Error();}catch{quotes=[];error='Archivio preventivi non leggibile: salvataggio sospeso.';}
 const section=document.createElement('section');section.id='quotes';section.style.display='none';section.innerHTML='<div class="page-head"><div><h2>Preventivi</h2><p>Prepara e conserva le proposte per i tuoi clienti.</p></div><button class="btn" id="newQuote">+ Nuovo preventivo</button></div><div class="card"><p id="quotesError" role="alert" hidden></p><div class="cash-table-wrap"><table><thead><tr><th>Data</th><th>Cliente / veicolo</th><th>Totale IVA inclusa</th><th>Stato</th><th>Azioni</th></tr></thead><tbody id="quotesList"></tbody></table></div></div>';
 const footer=document.querySelector('.tech-page-footer');if(footer)footer.before(section);else document.querySelector('main').append(section);pageIds.push('quotes');titles.quotes='Preventivi';
 const editor=document.createElement('dialog');editor.id='quoteEditor';editor.setAttribute('aria-labelledby','quoteTitle');editor.innerHTML='<form id="quoteForm"><h2 id="quoteTitle">Preventivo</h2><div class="quote-grid"><label>Cliente<input id="quoteCustomer" required list="quoteCustomers"></label><datalist id="quoteCustomers"></datalist><label>Targa / veicolo<input id="quoteVehicle"></label><label>Data<input id="quoteDate" type="date" required></label><label>Stato<select id="quoteState"><option>Bozza</option><option>Accettato</option><option>Rifiutato</option></select></label></div><div class="quote-grid"><label>IVA del preventivo<select id="quoteVat"><option value="22">22%</option><option value="10">10%</option><option value="5">5%</option><option value="4">4%</option><option value="0">0%</option></select></label><label>Valido fino al (facoltativo)<input id="quoteValidUntil" type="date"></label></div><div id="quoteLines"></div><button class="btn secondary" id="quoteAdd" type="button">+ Lavorazione</button><label>Note<textarea id="quoteNotes" rows="3"></textarea></label><p><b id="quoteTotal"></b></p><p id="quoteError" role="alert"></p><div class="modal-actions"><button class="btn secondary" type="button" id="quoteSend">Invia preventivo</button><button class="btn secondary" type="button" id="quoteCancel">Annulla</button><button class="btn" type="submit">Salva preventivo</button></div></form>';document.body.append(editor);
 document.head.insertAdjacentHTML('beforeend','<style>#customerAverageDialog,#quoteEditor{width:min(760px,90vw);max-height:85vh;overflow:auto;background:var(--white);color:var(--ink);border:1px solid var(--line);border-radius:14px;padding:24px}#customerAverageDialog::backdrop,#quoteEditor::backdrop{background:#0009}#customerAverageDialog td,#quotes td{padding:12px;border-bottom:1px solid var(--line)}.cash-kpis [role=button]{cursor:pointer}.cash-kpis [role=button]:focus-visible{outline:2px solid var(--green)}.quote-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}#quoteEditor label{display:block;font-size:12px;margin:12px 0}#quoteEditor input,#quoteEditor select,#quoteEditor textarea{display:block;width:100%;box-sizing:border-box;padding:9px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit}.quote-line{display:grid;grid-template-columns:1fr 70px 110px 30px;gap:10px;align-items:end;margin-bottom:10px}@media(max-width:600px){.quote-grid{grid-template-columns:1fr}.quote-line{grid-template-columns:1fr 65px 90px 30px}}</style>');
 let editing=null;
 const lines=()=>[...$('quoteLines').children].map(r=>({description:r.querySelector('[data-q=description]').value.trim(),quantity:Number(r.querySelector('[data-q=quantity]').value),price:Number(r.querySelector('[data-q=price]').value)}));
 const total=items=>Math.round(items.reduce((n,l)=>n+l.quantity*l.price,0)*100)/100;
 const update=()=>$('quoteTotal').textContent='Totale IVA inclusa: '+money(total(lines()));
 function addLine(l={description:'',quantity:1,price:0}){const row=document.createElement('div');row.className='quote-line';row.innerHTML='<label>Lavorazione<input data-q="description" required></label><label>Quantità<input data-q="quantity" type="number" min="0.001" step="0.001" required></label><label>Prezzo IVA inclusa<input data-q="price" type="number" min="0" step="0.01" required></label><button class="btn secondary" type="button" aria-label="Rimuovi lavorazione">×</button>';for(const key of ['description','quantity','price'])row.querySelector('[data-q='+key+']').value=l[key];row.addEventListener('input',update);row.querySelector('button').onclick=()=>{if($('quoteLines').children.length>1){row.remove();update();}};$('quoteLines').append(row);update();}
 function edit(q){editing=q?.id||null;$('quoteCustomer').value=q?.customer||'';$('quoteVehicle').value=q?.vehicle||'';$('quoteDate').value=q?.date||today();$('quoteState').value=q?.status||'Bozza';$('quoteNotes').value=q?.notes||'';$('quoteVat').value=String(q?.vat??22);$('quoteValidUntil').value=q?.validUntil||'';$('quoteError').textContent=error;$('quoteLines').replaceChildren();(q?.lines||[{description:'',quantity:1,price:0}]).forEach(addLine);$('quoteCustomers').replaceChildren(...[...new Set([...$('customerRows').rows].map(r=>r.cells[0]?.textContent.trim()).filter(Boolean))].map(n=>new Option(n,n)));editor.showModal();}
 function render(){ $('quotesList').innerHTML=quotes.map(q=>'<tr><td>'+esc(q.date.split('-').reverse().join('/'))+'</td><td>'+esc(q.customer)+'<br><small>'+esc(q.vehicle)+'</small></td><td>'+money(total(q.lines))+'</td><td>'+esc(q.status)+'</td><td><div class="quote-actions"><button type="button" class="btn secondary" data-quote="'+esc(q.id)+'">Apri</button><button type="button" class="btn secondary quote-book" data-quote-appointment="'+esc(q.id)+'">'+(linkedWork(q)?'Apri appuntamento':'Prendi appuntamento')+'</button><button type="button" class="btn secondary quote-delete" data-quote-delete="'+esc(q.id)+'" aria-label="'+esc('Elimina preventivo di '+q.customer+' del '+q.date.split('-').reverse().join('/'))+'">Elimina</button></div></td></tr>').join('')||'<tr><td colspan="5">Nessun preventivo salvato.</td></tr>';}
 function deleteQuote(id){
   if(error)throw Error(error);
   const quote=quotes.find(q=>q.id===id);if(!quote)return;
   if(!confirm('Eliminare il preventivo di '+quote.customer+' del '+quote.date.split('-').reverse().join('/')+'?'))return;
   const next=quotes.filter(q=>q.id!==id);
   localStorage.setItem(quoteKey,JSON.stringify(next));
   quotes=next;if(editing===id)editing=null;render();
 }
 document.addEventListener('workshop:customer-renamed',()=>{quotes=JSON.parse(localStorage.getItem(quoteKey)||'[]');render();});
 document.addEventListener('workshop-cloud-state-loading',event=>{
   if(event.detail?.storageKeys&&!event.detail.storageKeys.includes(quoteKey))return;
   try{const next=JSON.parse(localStorage.getItem(quoteKey)||'[]');if(!Array.isArray(next))throw Error();quotes=next;error='';}
   catch{quotes=[];error='Archivio preventivi non leggibile: salvataggio sospeso.';}
 });
 document.addEventListener('workshop-cloud-state-applied',event=>{
   const detail=event.detail;
   if(detail?.storageKeys&&!detail.storageKeys.includes(quoteKey)&&!detail.selectors?.some(selector=>['#agendaRows','#agenda .parking-section .card'].includes(selector)))return;
   render();$('quotesError').textContent=error;$('quotesError').hidden=!error;
 });
 const open=()=>{showPage('quotes');render();};
 const header=[...document.querySelectorAll('header.top .actions button')].find(b=>b.textContent.includes('Preventivo'));if(header){header.removeAttribute('onclick');header.addEventListener('click',event=>{event.stopImmediatePropagation();open();edit();},true);}
 const archiveButton=document.createElement('button');archiveButton.className='btn secondary';archiveButton.type='button';archiveButton.textContent='Apri preventivi';archiveButton.onclick=open;document.querySelector('#invArchive')?.before(archiveButton);
 $('newQuote').onclick=()=>edit();$('quoteCancel').onclick=()=>editor.close();$('quoteAdd').onclick=()=>addLine();$('quotesList').onclick=e=>{
   const booking=e.target.closest('[data-quote-appointment]');
   if(booking){try{bookQuote(booking.dataset.quoteAppointment);$('quotesError').textContent='';$('quotesError').hidden=true;}catch(err){$('quotesError').textContent=err.message;$('quotesError').hidden=false;}return;}
   const remove=e.target.closest('[data-quote-delete]');
   if(remove){try{deleteQuote(remove.dataset.quoteDelete);$('quotesError').textContent='';$('quotesError').hidden=true;}catch(err){$('quotesError').textContent=err.message;$('quotesError').hidden=false;}return;}
   const id=e.target.closest('[data-quote]')?.dataset.quote;if(id)edit(quotes.find(q=>q.id===id));
 };
 function readQuote(){const q={...quotes.find(item=>item.id===editing),id:editing||crypto.randomUUID(),customer:$('quoteCustomer').value.trim(),vehicle:$('quoteVehicle').value.trim(),date:$('quoteDate').value,status:$('quoteState').value,notes:$('quoteNotes').value,vat:Number($('quoteVat').value),validUntil:$('quoteValidUntil').value,lines:lines()};if(!q.customer||!q.date||q.lines.some(l=>!l.description||!Number.isFinite(l.quantity)||l.quantity<=0||!Number.isFinite(l.price)||l.price<0))throw Error('Compila cliente e lavorazioni con importi validi.');return q;}
 function saveQuote(){if(error)throw Error(error);const q=readQuote();const next=quotes.filter(item=>item.id!==q.id);next.unshift(q);localStorage.setItem(quoteKey,JSON.stringify(next));quotes=next;editing=q.id;render();return q;}
 const shopSnapshot=()=>({logo:$('shopLogoPreview')?.querySelector('img')?.getAttribute('src')||'',name:$('shopName').value,address:$('shopAddress').value,operatingAddress:$('shopOperatingAddress')?.value||'',vat:$('shopVat').value,phone:$('shopPhone').value,email:$('shopEmail').value});
 const quotePrintStyle=`@page{size:A4;margin:0;padding:15mm}*{box-sizing:border-box}body{margin:0;padding:32px;font:14px Arial,sans-serif;line-height:1.45;color:#20271b;background:white}.quote-document-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;border-bottom:2px solid #405729;padding-bottom:14px;margin-bottom:18px}h1{margin:0;font-size:27px;color:#405729}.quote-document-head p{margin:5px 0 0}.quote-document-head img{max-width:110px;max-height:75px;object-fit:contain}.quote-document-shop{margin-bottom:24px}.quote-document-shop h2{margin:0 0 6px;font-size:20px}.quote-document-shop p{margin:4px 0;overflow-wrap:anywhere}.quote-document-customer{border-top:1px solid #cbc5a6;padding-top:12px;margin-bottom:24px}.quote-document-customer h2{font-size:12px;letter-spacing:.06em;margin:0 0 5px}.quote-document-customer p{margin:4px 0;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}th,td{border:1px solid #cbc5a6;padding:10px 8px;vertical-align:top;overflow-wrap:anywhere}thead{display:table-header-group}th{background:#f3f4ee;color:#405729;text-align:left;font-size:11px}th:first-child{width:48%}th:nth-child(2){width:10%}th:nth-child(3),th:nth-child(4){width:16%}th:last-child{width:10%}.quote-numeric{text-align:right}tr{break-inside:avoid}.quote-document-totals{margin:22px 0 0 auto;width:min(310px,100%);break-inside:avoid}.quote-document-totals div{display:flex;justify-content:space-between;gap:14px;margin:8px 0}.quote-document-totals div:last-child{border-top:2px solid #405729;padding-top:9px;color:#405729;font-size:16px}.quote-document-notes{margin-top:24px;overflow-wrap:anywhere}.quote-document-notes h2{font-size:12px;margin:0 0 6px}.quote-document-notes p{white-space:pre-wrap;margin:0}h1,h2{break-after:avoid}@media(max-width:600px){body{padding:18px;font-size:12px}h1{font-size:23px}table{font-size:10px}th{font-size:9px}th,td{padding:8px 5px}}@media print{body{padding:0;font-size:11pt}table{font-size:9pt}th{font-size:8pt}.quote-document-totals div:last-child{font-size:12pt}}`;
 function quotePrintHtml(q,shop){
   const date=value=>value.split('-').reverse().join('/'),gross=total(q.lines),vat=Number(q.vat??22),net=Math.round(gross/(1+vat/100)*100)/100;
   const address=(label,value)=>value?.trim()?'<p><b>'+label+':</b> '+esc(value.trim())+'</p>':'';
   const lineRows=q.lines.map(line=>{const subtotal=Math.round(line.quantity*line.price*100)/100;return '<tr><td>'+esc(line.description)+'</td><td class="quote-numeric">'+esc(line.quantity.toLocaleString('it-IT',{maximumFractionDigits:3}))+'</td><td class="quote-numeric">'+esc(money(line.price/(1+vat/100)))+'</td><td class="quote-numeric">'+esc(money(subtotal/(1+vat/100)))+'</td><td class="quote-numeric">'+esc(vat)+'%</td></tr>';}).join('');
   return '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preventivo — '+esc(q.customer)+'</title><style>'+quotePrintStyle+'</style></head><body><header class="quote-document-head"><div><h1>PREVENTIVO</h1><p>'+esc(date(q.date))+'</p></div>'+(shop.logo?'<img src="'+esc(shop.logo)+'" alt="Logo officina">':'')+'</header><section class="quote-document-shop"><h2>'+esc(shop.name||'Officina')+'</h2>'+address('Sede legale',shop.address)+address('Sede operativa',shop.operatingAddress)+address('P.IVA / C.F.',shop.vat)+(shop.email||shop.phone?'<p>'+esc([shop.email,shop.phone].filter(Boolean).join(' · '))+'</p>':'')+'</section><section class="quote-document-customer"><h2>CLIENTE</h2><p><strong>'+esc(q.customer)+'</strong></p>'+(q.vehicle?'<p>Veicolo / targa: '+esc(q.vehicle)+'</p>':'')+(q.validUntil?'<p>Valido fino al: '+esc(date(q.validUntil))+'</p>':'')+'</section><table><thead><tr><th>Descrizione</th><th class="quote-numeric">Quantità</th><th class="quote-numeric">Prezzo</th><th class="quote-numeric">Subtotale</th><th class="quote-numeric">IVA</th></tr></thead><tbody>'+lineRows+'</tbody></table><div class="quote-document-totals"><div><span>Imponibile</span><strong>'+esc(money(net))+'</strong></div><div><span>IVA '+esc(vat)+'%</span><strong>'+esc(money(gross-net))+'</strong></div><div><span>Totale IVA inclusa</span><strong>'+esc(money(gross))+'</strong></div></div>'+(q.notes?'<section class="quote-document-notes"><h2>NOTE</h2><p>'+esc(q.notes)+'</p></section>':'')+'</body></html>';
 }
 async function quoteAttachment(q,shop){const bytes=await WorkshopQuotePDF(q,shop);let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));return {name:'Preventivo-'+q.date+'-'+q.id.slice(0,8)+'.pdf',base64:btoa(raw)};}
 function printQuote(){
   if(!$('quoteForm').reportValidity())return;
   try{
     const q=readQuote(),shop=shopSnapshot(),html=quotePrintHtml(q,shop),preview=document.createElement('dialog');preview.id='quotePrintPreview';preview.setAttribute('aria-labelledby','quotePrintTitle');
     preview.innerHTML='<div class="quote-print-toolbar"><h2 id="quotePrintTitle">Anteprima preventivo</h2><div class="quote-print-actions"><button type="button" class="btn" id="quotePrintNow" disabled>Stampa</button><button type="button" class="btn secondary" id="quotePrintDownload">Scarica PDF</button><button type="button" class="btn secondary" id="quotePrintClose">Torna al preventivo</button></div><p id="quotePrintHint" role="status">L’anteprima include i dati compilati. Premi Salva preventivo per conservarli nell’archivio.</p></div><iframe id="quotePrintFrame" title="Documento preventivo da stampare"></iframe>';
     document.body.append(preview);const frame=preview.querySelector('iframe'),hint=preview.querySelector('#quotePrintHint'),print=preview.querySelector('#quotePrintNow'),download=preview.querySelector('#quotePrintDownload');
     frame.onload=()=>{frame.style.height=Math.max(850,frame.contentDocument.documentElement.scrollHeight)+'px';print.disabled=false;};frame.srcdoc=html;
     print.onclick=async()=>{print.disabled=true;try{if(window.WorkshopNative?.printHtml)await window.WorkshopNative.printHtml(html,'Preventivo — '+q.customer);else frame.contentWindow.print();hint.textContent='Seleziona la stampante o salva come PDF nella finestra di stampa. Se non si apre, usa Scarica PDF.';}catch(err){hint.textContent='Stampa non disponibile: '+(typeof err==='string'?err:err.message)+'. Puoi usare Scarica PDF.';}finally{print.disabled=false;}};
     download.onclick=async()=>{download.disabled=true;try{const result=await downloadPDF(await quoteAttachment(q,shop));hint.textContent=result.status==='cancelled'?'Salvataggio o condivisione annullati.':result.status==='saved'?'PDF salvato nella posizione scelta.':result.status==='download-started'?'Download PDF avviato.':'Condivisione del PDF aperta.';}catch(err){hint.textContent='Impossibile scaricare il PDF: '+(typeof err==='string'?err:err.message);}finally{download.disabled=false;}};
     // Keep one dialog open so native Back closes the preview, while the form
     // retains every unsaved value for the return to the quote editor.
     preview.querySelector('#quotePrintClose').onclick=()=>preview.close();preview.addEventListener('close',()=>{preview.remove();editor.showModal();$('quotePrint').focus();},{once:true});editor.close();preview.showModal();$('quoteError').textContent='';
   }catch(err){$('quoteError').textContent=err.message;}
 }
 const printQuoteButton=document.createElement('button');printQuoteButton.id='quotePrint';printQuoteButton.type='button';printQuoteButton.className='btn secondary';printQuoteButton.textContent='Stampa preventivo';printQuoteButton.onclick=printQuote;$('quoteSend').before(printQuoteButton);
 document.head.insertAdjacentHTML('beforeend','<style>#quotePrintPreview{position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;border:0;padding:20px;overflow:auto;box-sizing:border-box;background:#e8ece9;color:#20271b}#quotePrintPreview::backdrop{background:#000a}.quote-print-toolbar{max-width:794px;margin:0 auto 18px;font:14px Arial,sans-serif}.quote-print-toolbar h2{font-size:20px;margin:0 0 12px}.quote-print-actions{display:flex;flex-wrap:wrap;gap:8px}.quote-print-toolbar p{font-size:12px;line-height:1.5}.quote-print-toolbar .btn.secondary{background:#fff;color:#20271b;border-color:#a7b2a0}#quotePrintFrame{display:block;border:0;background:white;width:100%;max-width:794px;margin:auto;box-shadow:0 2px 12px #0002}@media(max-width:600px){#quotePrintPreview{padding:12px}.quote-print-toolbar h2{font-size:18px}.quote-print-actions .btn{padding:10px}}@media print{#quotePrintPreview .quote-print-toolbar{display:none}}</style>');
 $('quoteForm').onsubmit=e=>{e.preventDefault();try{saveQuote();editor.close();}catch(e){$('quoteError').textContent=e.message;}};

 const share=document.createElement('dialog');share.id='quoteShare';share.setAttribute('aria-labelledby','quoteShareTitle');
 share.innerHTML='<h2 id="quoteShareTitle">Invia preventivo</h2><p>Preventivo salvato. Controlla destinatario e testo: Invia email spedisce tramite l’account collegato; se non è disponibile scarica il PDF e apre Gmail o Outlook secondo le Impostazioni: allega il PDF nella bozza. WhatsApp apre un messaggio da inviare nella sua app. Il preventivo è un PDF.</p><div class="quote-grid"><label>Email del cliente<input id="quoteEmail" type="email" autocomplete="email"></label><label>WhatsApp (prefisso internazionale)<input id="quotePhone" type="tel" placeholder="+39 333 1234567" autocomplete="tel"></label></div><button class="btn secondary" type="button" id="quoteDownloadPdf">Scarica preventivo PDF</button><label>Messaggio di accompagnamento<textarea id="quoteMessage" rows="10"></textarea></label><p id="quoteShareError" role="alert"></p><div class="modal-actions"><button class="btn secondary" id="quoteEmailLink" type="button">Invia email</button><a class="btn" id="quoteWhatsAppLink" href="#" target="_blank" rel="noopener noreferrer">Apri WhatsApp</a><button class="btn secondary" id="quoteShareClose" type="button">Chiudi</button></div>';
 document.body.append(share);
 const openDraft=document.createElement('button');openDraft.type='button';openDraft.id='quoteOpenDraft';openDraft.className='btn secondary';openDraft.textContent='Apri bozza email';openDraft.hidden=true;$('quoteShareError').after(openDraft);
 let manualCompose='';
 openDraft.onclick=async()=>{try{if(!manualCompose)return;await window.WorkshopNative.openExternal(manualCompose);$('quoteShareError').textContent='Allega il PDF salvato nella bozza email e completa l’invio.';}catch(e){$('quoteShareError').textContent=typeof e==='string'?e:e.message;}};
 let sharingQuote=null,mailRequest=null,pdfPromise=null;
 $('quoteSend').onclick=()=>{if(!$('quoteForm').reportValidity())return;try{
   sharingQuote=saveQuote();$('quoteError').textContent='';
   const matches=[...$('customerRows').rows].filter(r=>r.cells[0]?.textContent.trim().toLocaleLowerCase()===sharingQuote.customer.toLocaleLowerCase());
   const uniqueContact=index=>{const values=[...new Set(matches.map(r=>r.cells[index]?.textContent.trim()).filter(v=>v&&v!=='—'&&v!=='-'))];return values.length===1?values[0]:'';};
   $('quoteEmail').value=uniqueContact(2);$('quotePhone').value=uniqueContact(1);
   pdfPromise=null;manualCompose='';openDraft.hidden=true;$('quoteMessage').value='Buongiorno, in allegato il preventivo richiesto. Restiamo a disposizione per eventuali chiarimenti.';$('quoteShareError').textContent='';
   mailRequest=null;$('quoteEmailLink').disabled=false;$('quoteWhatsAppLink').href='#';share.showModal();
 }catch(e){$('quoteError').textContent=e.message;}};
 for(const [id,channel] of [['quoteWhatsAppLink','whatsapp']])$(id).onclick=e=>{
   try{const body=$('quoteMessage').value.trim();if(!body)throw Error('Scrivi il messaggio da inviare.');
     e.currentTarget.href=channel==='email'?WorkshopQuoteSharing.email($('quoteEmail').value,'Preventivo del '+sharingQuote.date.split('-').reverse().join('/')+' — '+sharingQuote.customer,body):WorkshopQuoteSharing.whatsapp($('quotePhone').value,body);
     $('quoteShareError').textContent='Il messaggio è pronto: completa l’invio nella tua app.';
   }catch(err){e.preventDefault();e.currentTarget.href='#';$('quoteShareError').textContent=err.message;}
 };
 $('quoteEmailLink').onclick=async()=>{
  const button=$('quoteEmailLink');button.disabled=true;let popup=null;
  try{const to=$('quoteEmail').value.trim(),body=$('quoteMessage').value.trim(),subject='preventivo ('+($('shopName').value.trim()||'Officina').replace(/[\r\n]+/g,' ')+')';
    WorkshopQuoteSharing.email(to,subject,body);if(!body)throw Error('Scrivi il messaggio da inviare.');
    const fingerprint=JSON.stringify([to,subject,body]);if(!mailRequest||mailRequest.fingerprint!==fingerprint)mailRequest={fingerprint,id:crypto.randomUUID()};
    manualCompose='';openDraft.hidden=true;
    // Browser popups must be reserved during the click; native mail opens only
    // after the user has finished the save/share sheet.
    if(!window.WorkshopNative)popup=window.open('about:blank','officina-quote-email');
    $('quoteShareError').textContent='Preparazione PDF…';
    const attachment=await preparePDF();
    const result=await WorkshopEmail.send({to,subject,body,attachment,requestId:mailRequest.id});
    if(result.manual){
      const exported=await downloadPDF(attachment);
      if(exported.status==='cancelled'){popup?.close();$('quoteShareError').textContent='Salvataggio o condivisione annullati. La bozza email non è stata aperta.';button.disabled=false;return;}
      const compose=WorkshopQuoteSharing.compose(result.provider,result.email,to,subject,body);
      if(window.WorkshopNative){
        if(exported.status!=='saved'){
          // A share sheet can send the file itself. Do not open a second email
          // automatically or claim that a mobile share target saved the PDF.
          manualCompose=compose;openDraft.hidden=false;
          $('quoteShareError').textContent=exported.status==='shared'?'Operazione sul PDF completata. Se lo hai salvato e vuoi allegarlo a un’email, premi “Apri bozza email”.':'Condivisione del PDF aperta. Se lo hai salvato, premi “Apri bozza email” per allegarlo. L’app non può confermare il salvataggio o l’invio.';
          button.disabled=false;return;
        }
        await window.WorkshopNative.openExternal(compose);
      }else if(popup)popup.location.href=compose;else window.open(compose,'_blank');
      $('quoteShareError').textContent=(exported.status==='saved'?'PDF salvato. ':'Download PDF avviato. ')+'Allega il file '+attachment.name+' nella bozza '+(result.provider==='outlook'?'Outlook':'Gmail')+' e completa l’invio.';button.disabled=false;
    }else {popup?.close();$('quoteShareError').textContent=result.message;}
  }catch(e){popup?.close();$('quoteShareError').textContent=typeof e==='string'?e:e.message;button.disabled=false;}
 };
 async function preparePDF(){if(!pdfPromise)pdfPromise=quoteAttachment(sharingQuote,shopSnapshot());return pdfPromise;}
 async function downloadPDF(attachment){const bytes=Uint8Array.from(atob(attachment.base64),c=>c.charCodeAt(0)),blob=new Blob([bytes],{type:'application/pdf'});if(window.WorkshopNative)return window.WorkshopNative.exportBlob(blob,attachment.name);const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=attachment.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);return {status:'download-started'};}
 $('quoteDownloadPdf').onclick=async()=>{const button=$('quoteDownloadPdf');button.disabled=true;try{const result=await downloadPDF(await preparePDF());$('quoteShareError').textContent=({saved:'PDF salvato nella posizione scelta.',cancelled:'Salvataggio o condivisione annullati.',shared:'Operazione sul PDF completata.',presented:'Condivisione del PDF aperta. L’app non può confermare il salvataggio o l’invio.','download-started':'Download PDF avviato.'})[result.status]||'Operazione sul PDF completata.';}catch(e){$('quoteShareError').textContent=typeof e==='string'?e:e.message;}finally{button.disabled=false;}};
 $('quoteShareClose').onclick=()=>share.close();
 document.head.insertAdjacentHTML('beforeend','<style>#quotes .quote-actions{display:flex;flex-wrap:wrap;gap:8px}#quotes .quote-delete{color:var(--ink);border-color:#c6282866}#quotes .quote-delete:hover{background:#c6282814}#quotesError,#quoteBookingError{color:var(--ink)}html[data-cloud-mode="read"] #quotes .quote-delete,html[data-cloud-mode="read"] #quotes .quote-book{display:none}</style>');
 document.head.insertAdjacentHTML('beforeend','<style>#quoteShare{width:min(700px,90vw);max-height:85vh;overflow:auto;box-sizing:border-box;padding:24px;border:1px solid var(--line);border-radius:14px;background:var(--white);color:var(--ink)}#quoteShare::backdrop{background:#0009}#quoteShare label{display:block;font-size:12px;margin:12px 0}#quoteShare input,#quoteShare textarea{display:block;box-sizing:border-box;width:100%;padding:9px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font:inherit}#quoteShare .modal-actions,#quoteEditor .modal-actions{display:flex;flex-wrap:wrap;gap:8px}#quoteShareError{color:var(--ink)}</style>');
 // The quote and the new agenda row are part of the same normal cloud change
 // set. Updating the quote item also fences simultaneous bookings by two users.
 let pendingBooking=null,submittedBooking=null,quoteRenderTimer;
 const acceptance=$('appointmentForm'),acceptanceModal=$('appointmentModal');
 const bookingError=document.createElement('p');bookingError.id='quoteBookingError';bookingError.setAttribute('role','alert');bookingError.hidden=true;acceptance.querySelector('.modal-actions').before(bookingError);
 const normalizePlate=value=>String(value||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
 const present=value=>value&&value!=='—'&&value!=='-'?value:'';
 function linkedWork(q){
   if(!q)return null;
   return [...document.querySelectorAll('#agendaRows tr:not(.agenda-empty),#agenda .parking-row')].find(row=>row.dataset.quoteId===q.id||q.appointmentId&&(row.dataset.cloudId===q.appointmentId||row.dataset.agendaOriginId===q.appointmentId))||null;
 }
 function acceptanceLines(q){
   let gross=0,previous=0;
   return q.lines.map(line=>{
     gross+=line.quantity*line.price;const cents=Math.round(gross*100),amount=(cents-previous)/100;previous=cents;
     const description=String(line.description).trim(),leading=description.match(/^(\d+(?:[.,]\d+)?)\s+(?:x\s+)?/i);
     const hasQuantity=leading&&Number(leading[1].replace(',','.'))===line.quantity;
     return {description:line.quantity===1||hasQuantity?description:line.quantity.toLocaleString('it-IT',{maximumFractionDigits:3})+' '+description,amount};
   });
 }
 function prefillQuote(q,slot){
   acceptance.reset();bookingError.hidden=true;bookingError.textContent='';
   const matches=[...$('customerRows').rows].filter(row=>row.cells[0]?.textContent.trim().toLocaleLowerCase('it-IT')===q.customer.trim().toLocaleLowerCase('it-IT'));
   const normalized=normalizePlate(q.vehicle),matched=matches.filter(row=>{
     const plate=normalizePlate(present(row.cells[4]?.textContent.trim()));
     return normalized&&plate&&normalized.includes(plate)||q.vehicle&&row.cells[3]?.textContent.trim().toLocaleLowerCase('it-IT')===q.vehicle.trim().toLocaleLowerCase('it-IT');
   });
   const vehicle=matched.length===1?matched[0]:!q.vehicle&&matches.length===1?matches[0]:null;
   const contact=index=>{const values=[...new Set(matches.map(row=>present(row.cells[index]?.textContent.trim())).filter(Boolean))];return values.length===1?values[0]:'';};
   $('appDate').value=slot.date;$('appTime').value=slot.time;$('appStatus').value='PROGRAMMATO';
   $('appCustomer').value=q.customer;$('appCustomer').dataset.selectedVehicleFor=q.customer;
   $('appPlate').value=present(vehicle?.cells[4]?.textContent.trim())||q.vehicle||'';
   $('appVehicle').value=present(vehicle?.cells[3]?.textContent.trim())||'';
   $('appPhone').value=present(vehicle?.cells[1]?.textContent.trim())||contact(1);
   $('appEmail').value=present(vehicle?.cells[2]?.textContent.trim())||contact(2);
   $('appKm').value='';$('appointmentNotes').value=q.notes||'';
   if($('appCashDestination'))$('appCashDestination').checked=true;
   window.WorkshopAppointmentLines.set(acceptanceLines(q));
   pendingBooking={quoteId:q.id,slot,before:new Set($('agendaRows').rows)};
 }
 function bookQuote(id){
   if(window.WorkshopCloud?.boot.user.role==='viewer'||!window.parent.WorkshopCloudHost?.canWrite?.())throw Error('Attendi la conferma delle modifiche prima di prendere un appuntamento.');
   if(error)throw Error(error);
   const q=quotes.find(item=>item.id===id);if(!q)return;
   const row=linkedWork(q);
   if(row){
     if(row.matches('.parking-row'))window.openParkingEditor?.(row);else window.openAcceptanceEditorForRow?.(row);
     return;
   }
   if(!q.customer||!Array.isArray(q.lines)||!q.lines.length||q.lines.some(line=>!line.description||!Number.isFinite(line.quantity)||line.quantity<=0||!Number.isFinite(line.price)||line.price<0))throw Error('Apri il preventivo e completa cliente e lavorazioni prima di prendere l’appuntamento.');
   if(!window.WorkshopAppointmentCalendar?.open({onBook:slot=>prefillQuote(q,slot)}))throw Error('Il calendario non è disponibile. Riprova dopo il salvataggio.');
 }
 // Older customer autofill listeners always choose the first vehicle. Keep
 // the quote's chosen vehicle when the customer name itself is unchanged.
 for(const type of ['input','change'])$('appCustomer').addEventListener(type,event=>{
   if(pendingBooking&&$('appCustomer').dataset.selectedVehicleFor===$('appCustomer').value.trim())event.stopImmediatePropagation();
 },true);
 acceptance.addEventListener('submit',event=>{
   if(!pendingBooking)return;
   const q=quotes.find(item=>item.id===pendingBooking.quoteId);
   if(!q||linkedWork(q)){
     event.preventDefault();event.stopImmediatePropagation();bookingError.textContent='Questo preventivo ha già un appuntamento oppure non è più disponibile. Chiudi la scheda e riapri il preventivo.';bookingError.hidden=false;
   }else{
     pendingBooking.savedSlot={date:$('appDate').value,time:$('appTime').value};
     submittedBooking=pendingBooking;
   }
 },true);
 acceptance.addEventListener('submit',()=>{
   const booking=submittedBooking;submittedBooking=null;if(!booking)return;
   const row=typeof latestCreatedAppointmentRow!=='undefined'?latestCreatedAppointmentRow:null;
   if(!row?.isConnected||row.parentElement!==$('agendaRows')||booking.before.has(row))return;
   const q=quotes.find(item=>item.id===booking.quoteId);if(!q)return;
   row.dataset.cloudId||=crypto.randomUUID();row.dataset.quoteId=q.id;
   const accepted={...q,status:'Accettato',appointmentId:row.dataset.cloudId,appointmentDate:booking.savedSlot.date,appointmentTime:booking.savedSlot.time};
   const next=quotes.map(item=>item.id===q.id?accepted:item);
   localStorage.setItem(quoteKey,JSON.stringify(next));quotes=next;pendingBooking=null;render();
 });
 // Cancel and native Back only discard this form's booking context. A later
 // ordinary intervention cannot accidentally be linked to the old quote.
 new MutationObserver(()=>{if(!acceptanceModal.classList.contains('open'))pendingBooking=null;}).observe(acceptanceModal,{attributes:true,attributeFilter:['class']});
 const updateBookingActions=()=>{clearTimeout(quoteRenderTimer);quoteRenderTimer=setTimeout(render,80);};
 for(const root of [$('agendaRows'),document.querySelector('#agenda .parking-section .card')])if(root)new MutationObserver(updateBookingActions).observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['data-cloud-id','data-quote-id','data-agenda-origin-id']});
 render();

})();
