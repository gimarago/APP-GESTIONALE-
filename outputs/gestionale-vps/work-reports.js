(function(root){
  'use strict';
  const cents=value=>Math.round((Number(value)+Number.EPSILON)*100);
  const customerKey=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('it-IT').replace(/[^a-z0-9]/g,'');
  const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const euro=value=>Number(value).toLocaleString('it-IT',{style:'currency',currency:'EUR'});
  const dateLabel=value=>validDate(value)?value.split('-').reverse().join('/'):String(value||'');
  const reportNumber=report=>'RI-'+String(report?.id||'').replace(/-/g,'').slice(0,17).toUpperCase();
  function workMessage(work,workshop='Officina'){
    const title=[work.plate,work.vehicle].filter(Boolean).join(' · ');
    const sourceLines=(work.lines||[]),lines=sourceLines.slice(0,20).map(line=>`• ${String(line.description).slice(0,240)}: ${euro(line.amount)}`).join('\n')+(sourceLines.length>20?'\n• Altre lavorazioni incluse nel totale.':'');
    const message=`Buongiorno ${work.customer},\nle comunichiamo i lavori eseguiti il ${dateLabel(work.date)}${title?' sul veicolo '+title:''}.${work.km!==''&&work.km!=null?' Chilometraggio: '+work.km+' km.':''}\n${lines}\nTotale intervento: ${euro(work.amount)}${work.notes?'\nNote: '+String(work.notes).slice(0,500):''}\n\n${workshop}`;
    return message.length<=3000?message:message.slice(0,2950)+'…\n\n'+workshop;
  }
  function whatsappNumber(value){let raw=String(value||'').trim();if(!raw)return '';let digits=raw.replace(/\D/g,'');if(raw.startsWith('00'))digits=digits.slice(2);else if(raw.startsWith('+')){}else if(digits.length>=8&&digits.length<=11)digits='39'+digits;return /^\d{8,15}$/.test(digits)?digits:'';}
  function shareLinks(work,contacts={},workshop='Officina'){
    const message=workMessage(work,workshop),subject=`Lavori eseguiti ${dateLabel(work.date)}${work.plate?' · '+work.plate:''}`;
    const mail=address=>address?`mailto:${String(address).trim().replace(/%40/gi,'@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`:'';
    const phone=whatsappNumber(contacts.phone);
    return {email:mail(contacts.email),pec:mail(contacts.pec),whatsapp:phone?`https://wa.me/${phone}?text=${encodeURIComponent(message)}`:''};
  }
  function reportMessage(report,workshop='Officina'){
    validateReport(report);
    const subject=`Rapporto interventi ${reportNumber(report)} · ${dateLabel(report.period.start)} – ${dateLabel(report.period.end)}`;
    const header=`Buongiorno ${report.customer},\necco il riepilogo degli interventi completati nel periodo ${dateLabel(report.period.start)} – ${dateLabel(report.period.end)} (rapporto ${reportNumber(report)}):\n`;
    const footer=`\nTotale interventi: ${euro(report.total)}\n\n${workshop}`;
    let body=header,added=0;
    for(const work of report.works){
      const detail=(work.lines||[]).map(line=>line.description).filter(Boolean).join(', ').slice(0,240);
      const title=[work.plate,work.vehicle].filter(Boolean).join(' · ');
      const line=`\n• ${dateLabel(work.date)}${title?' · '+title:''}${detail?' · '+detail:''} · ${euro(work.amount)}`;
      if((body+line+footer).length>3000)break;
      body+=line;added++;
    }
    if(added<report.works.length){const omitted=`\n• Altri ${report.works.length-added} interventi sono inclusi nel rapporto.`;if((body+omitted+footer).length<=3000)body+=omitted;}
    return {subject,body:body+footer};
  }
  function reportShareLinks(report,contacts={},workshop='Officina'){
    const {subject,body}=reportMessage(report,workshop),mail=address=>address?`mailto:${String(address).trim().replace(/%40/gi,'@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`:'';
    const phone=whatsappNumber(contacts.phone);
    return {email:mail(contacts.email),pec:mail(contacts.pec),whatsapp:phone?`https://wa.me/${phone}?text=${encodeURIComponent(body)}`:''};
  }
  function singleWorkHTML(work,seller={}){
    const rows=(work.lines||[]).map(line=>`<tr><td>${esc(line.description)}</td><td class="amount">${esc(euro(line.amount))}</td></tr>`).join('');
    return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Scheda intervento ${esc(work.plate||'')}</title><style>body{font:14px/1.5 Arial,sans-serif;color:#182d28;margin:35px}h1{font-size:24px}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{text-align:left;padding:10px;border-bottom:1px solid #cad7d2}.amount{text-align:right;white-space:nowrap}button{padding:10px 20px}small{color:#52695f}@media print{button{display:none}body{margin:0}tr{break-inside:avoid}}@page{size:A4;margin:0;padding:12mm}</style></head><body><button type="button" id="printWorkSheet">Stampa / salva PDF</button><p><b>${esc(seller.name||'Officina')}</b><br>${esc(seller.address||'')}${seller.vat?'<br>P. IVA '+esc(seller.vat):''}</p><h1>Riepilogo intervento</h1><p><b>${esc(work.customer)}</b></p><p>Data: ${esc(dateLabel(work.date))}<br>Veicolo: ${esc(work.vehicle||'—')}<br>Targa: ${esc(work.plate||'—')}${work.km!==''&&work.km!=null?'<br>Chilometraggio: '+esc(work.km)+' km':''}</p><table><thead><tr><th>Lavorazione</th><th class="amount">Importo IVA inclusa</th></tr></thead><tbody>${rows}</tbody></table>${work.notes?'<p>Note: '+esc(work.notes)+'</p>':''}<p class="amount"><b>Totale intervento: ${esc(euro(work.amount))}</b></p><small>Riepilogo informativo, non è una fattura.</small></body></html>`;
  }
  function fromEntries(entries){
    const seen=new Set(),works=[];
    for(const entry of entries){
      if(!entry.cashId||seen.has(entry.cashId)||!validDate(entry.date)||!String(entry.customer||'').trim()||!Number.isFinite(Number(entry.amount))||Number(entry.amount)<0)continue;
      const row=entry.sourceRow,source=row?entry.source:'archive';
      if(row&&!['agenda','parking'].includes(source))continue;
      const data=source==='parking'?root.parkingDataFromRow?.(row)||{}:{};
      const plate=source==='agenda'?(row.cells[2]?.firstChild?.textContent||row.cells[2]?.textContent||'').trim():source==='parking'?(data.plate||String(entry.vehicle||'').split('·')[0].trim()):String(entry.restoreData?.plate||String(entry.vehicle||'').split('·')[0]||'').trim();
      let lines=(entry.lines||[]).map(line=>({description:String(line.description||'').trim(),amount:cents(line.amount||0)/100})).filter(line=>line.description&&Number.isFinite(line.amount)&&line.amount>=0);
      const amount=cents(entry.amount)/100;
      if(!lines.length)lines=[{description:String(entry.work||'Intervento').trim(),amount}];
      const delta=cents(amount)-lines.reduce((sum,line)=>sum+cents(line.amount),0);
      if(delta){if(cents(lines.at(-1).amount)+delta>=0)lines.at(-1).amount=(cents(lines.at(-1).amount)+delta)/100;else lines=[{description:lines.map(line=>line.description).join(' · '),amount}];}
      works.push({id:entry.cashId,cashId:entry.cashId,source,sourceSelector:source==='agenda'?'#agendaRows':source==='parking'?'#agenda .parking-section .card':'',rowId:row?.dataset.cloudId||'',date:entry.date,customer:String(entry.customer).trim(),plate,vehicle:String(source==='parking'?data.vehicle||row.dataset.vehicle||'':source==='agenda'?row.dataset.vehicle||'':entry.restoreData?.vehicle||entry.vehicle||''),km:row?.dataset.km||entry.restoreData?.km||'',notes:String(entry.notes||row?.dataset.workNotes||''),amount,lines});
      seen.add(entry.cashId);
    }
    return works.sort((a,b)=>a.date.localeCompare(b.date)||a.plate.localeCompare(b.plate,'it'));
  }
  function validateReport(report){
    if(!report||typeof report.id!=='string'||!report.id||!validDate(report.date)||!String(report.customer||'').trim()||report.customerKey!==customerKey(report.customer)||!validDate(report.period?.start)||!validDate(report.period?.end)||report.period.start>report.period.end||!Array.isArray(report.works)||!report.works.length)throw Error('Rapporto incompleto: scegli cliente, periodo e almeno un intervento.');
    const seen=new Set();
    for(const work of report.works){
      if(!work||typeof work.id!=='string'||work.id!==work.cashId||seen.has(work.id)||!validDate(work.date)||work.date<report.period.start||work.date>report.period.end||!['agenda','parking','archive'].includes(work.source)||typeof work.plate!=='string'||typeof work.vehicle!=='string'||typeof work.notes!=='string'||!Number.isFinite(work.amount)||work.amount<0||cents(work.amount)/100!==work.amount||!Array.isArray(work.lines)||!work.lines.length||work.lines.some(line=>!line||!String(line.description||'').trim()||!Number.isFinite(line.amount)||line.amount<0||cents(line.amount)/100!==line.amount))throw Error('Interventi del rapporto non validi.');
      if(work.lines.reduce((sum,line)=>sum+cents(line.amount),0)!==cents(work.amount))throw Error('Gli importi delle lavorazioni non corrispondono al totale del rapporto.');
      seen.add(work.id);
    }
    if(!Number.isFinite(report.total)||report.works.reduce((sum,work)=>sum+cents(work.amount),0)!==cents(report.total))throw Error('Totale del rapporto non valido.');
    return report;
  }
  function reportLines(report){return validateReport(report).works.flatMap(work=>work.lines.map(line=>({description:[dateLabel(work.date),work.plate,work.vehicle,line.description].filter(Boolean).join(' · ').slice(0,1000),quantity:1,grossPrice:line.amount,price:line.amount/1.22,discount:0,vat:22})));}
  function printHTML(report,seller={}){
    validateReport(report);
    const rows=report.works.map(work=>`<tr><td>${esc(dateLabel(work.date))}</td><td><b>${esc(work.plate||'—')}</b><br>${esc(work.vehicle)}${work.km!==''?'<br>Km: '+esc(work.km):''}</td><td>${work.lines.map(line=>esc(line.description)+' · '+esc(euro(line.amount))).join('<br>')}${work.notes?'<p>'+esc(work.notes)+'</p>':''}</td><td class="amount">${esc(euro(work.amount))}</td></tr>`).join('');
    return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Rapporto di intervento - ${esc(report.customer)}</title><style>body{font:14px/1.5 Arial,sans-serif;color:#182d28;margin:35px}h1{font-size:24px}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #cad7d2}th{font-size:11px;text-transform:uppercase;background:#edf4f1}.amount{white-space:nowrap;text-align:right}p{margin:7px 0}.total{text-align:right;font-size:18px}button{padding:10px 20px}small{color:#52695f}@media print{button{display:none}body{margin:0}thead{display:table-header-group}tr{break-inside:avoid}}@page{size:A4;margin:0;padding:12mm}</style></head><body><button type="button" id="printWorkReport">Stampa</button><p><b>${esc(seller.name||'Officina')}</b><br>${esc(seller.address||'')}${seller.vat?'<br>P. IVA '+esc(seller.vat):''}</p><h1>Rapporto di intervento ${esc(reportNumber(report))}</h1><p><b>${esc(report.customer)}</b></p><p>Periodo: ${esc(dateLabel(report.period.start))} – ${esc(dateLabel(report.period.end))}<br>Data rapporto: ${esc(dateLabel(report.date))}</p><table><thead><tr><th>Data</th><th>Veicolo / targa</th><th>Lavorazioni</th><th class="amount">Importo IVA inclusa</th></tr></thead><tbody>${rows}</tbody></table><p class="total"><b>Totale IVA inclusa: ${esc(euro(report.total))}</b></p><small>Documento riepilogativo non fiscale, con riferimenti agli interventi eseguiti.</small></body></html>`;
  }
  const api={cents,customerKey,fromEntries,validateReport,reportLines,reportNumber,workMessage,whatsappNumber,shareLinks,reportMessage,reportShareLinks,singleWorkHTML,printHTML};
  if(typeof module!=='undefined'&&module.exports){module.exports=api;return;}
  root.WorkshopWorkReports=api;
  if(!root.WorkshopInvoices||!document.getElementById('invArchive'))return;
  const invoices=root.WorkshopInvoices,$=id=>document.getElementById(id),node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
  const supported=()=>!root.WorkshopCloud||root.WorkshopCloud.boot?.features?.workReports===1;
  const writer=()=>supported()&&root.WorkshopCloud?.boot?.user?.role!=='viewer'&&(!root.WorkshopCloud||root.parent.WorkshopCloudHost?.canWrite?.());
  const today=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
  const dialog=node('dialog',undefined,'work-reports-dialog');dialog.id='workReportsDialog';dialog.setAttribute('aria-labelledby','workReportsTitle');
  dialog.innerHTML='<div class="work-reports-heading"><h2 id="workReportsTitle">Rapporti di intervento</h2><button type="button" class="btn secondary" id="workReportsClose">Chiudi</button></div><p>Seleziona i lavori completati di un cliente nel mese per creare una fattura differita TD24. Puoi inviare il riepilogo dei rapporti salvati via email, WhatsApp o PEC. Gli interventi già fatturati non si possono selezionare di nuovo, ma puoi comunque inviare la scheda al cliente.</p><div class="work-report-filters"><label for="workReportCustomer">Cliente / azienda<input id="workReportCustomer" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="workReportCustomerOptions" placeholder="Scrivi per cercare" autocomplete="off"><div id="workReportCustomerOptions" class="work-report-customer-options" role="listbox" hidden></div></label><label for="workReportMonth">Mese<input id="workReportMonth" type="month"></label></div><div class="work-report-selection"><button type="button" class="btn secondary" id="workReportSelectAll">Seleziona tutti</button><span id="workReportSelection" role="status"></span></div><div class="work-report-scroll"><table class="work-report-table"><thead><tr><th>Seleziona</th><th>Data</th><th>Veicolo / targa</th><th>Lavorazioni</th><th>Importo IVA inclusa</th><th>Invia / stampa</th></tr></thead><tbody id="workReportRows"></tbody></table></div><div class="work-report-actions"><button type="button" class="btn" id="workReportSave">Salva rapporto</button></div><p id="workReportsStatus" role="status"></p><h3>Rapporti salvati</h3><div id="workReportsArchive"></div>';
  document.body.append(dialog);
  let selected=new Set(),saving=false,originalFocus=null,pendingReport=null,customerOptions=[],selectedCustomerKey='',activeCustomerIndex=-1;
  const allWorks=()=>fromEntries(root.WorkshopLedgerCash?.snapshot().entries||[]);
  const used=()=>new Set(invoices.documents().filter(doc=>['TD01','TD24'].includes(doc.type)).flatMap(doc=>[...(doc.sourceWorkIds||[]),...(doc.type==='TD01'&&doc.cashLink?[doc.cashLink]:[])]));
  function monthPeriod(value){if(!/^\d{4}-\d{2}$/.test(value||''))return null;const [year,month]=value.split('-').map(Number);if(month<1||month>12)return null;return {start:`${value}-01`,end:`${value}-${String(new Date(year,month,0).getDate()).padStart(2,'0')}`};}
  const normalizeSearch=value=>customerKey(value);
  function filtered(){const key=selectedCustomerKey||$('workReportCustomer').dataset.customerKey||'',period=monthPeriod($('workReportMonth').value);return key&&period?allWorks().filter(work=>customerKey(work.customer)===key&&validDate(work.date)&&work.date>=period.start&&work.date<=period.end):[];}
  function selection(){const blocked=used(),works=filtered().filter(work=>selected.has(work.id)&&!blocked.has(work.id)),months=new Set(works.map(work=>work.date.slice(0,7))),sameMonth=months.size<=1;$('workReportSelection').textContent=works.length+' interventi selezionati · '+euro(works.reduce((sum,work)=>sum+cents(work.amount),0)/100)+(sameMonth?'':' · seleziona un solo mese per TD24');$('workReportSelection').setAttribute('aria-invalid',sameMonth?'false':'true');$('workReportSave').disabled=saving||!writer()||!works.length||!sameMonth;return works;}
  function contactsFor(name){const fiscal=root.WorkshopCustomerFiscal?.get(name)||{},key=customerKey(name),row=[...document.querySelectorAll('#customerRows tr')].find(item=>customerKey(item.cells[0]?.textContent)===key);return {email:fiscal.email||row?.cells[2]?.textContent.replace('—','').trim()||'',phone:fiscal.phone||row?.cells[1]?.textContent.replace('—','').trim()||'',pec:fiscal.pec||''};}
  function openPrint(html,id){const popup=root.open('','_blank');if(!popup)throw Error('Consenti l’apertura della finestra di stampa nel browser.');popup.opener=null;popup.document.open();popup.document.write(html);popup.document.close();popup.document.getElementById(id)?.addEventListener('click',()=>popup.print());popup.focus();}
  function printWork(work){openPrint(singleWorkHTML(work,invoices.seller()),'printWorkSheet');}
  function print(report){const popup=root.open('','_blank');if(!popup)throw Error('Consenti l’apertura della finestra di stampa nel browser.');popup.opener=null;popup.document.write('<!doctype html><title>Preparazione PDF…</title><p style="font:16px Arial;padding:24px">Preparazione del rapporto PDF…</p>');void root.WorkshopWorkReportPDF.create(report,invoices.seller()).then(bytes=>{const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));popup.location.replace(url);setTimeout(()=>URL.revokeObjectURL(url),120000);}).catch(error=>{popup.close();$('workReportsStatus').textContent=error.message;});}
  async function sendReportEmail(report,email,button,details){if(button.disabled)return;button.disabled=true;button.textContent='Invio…';try{const attachment=await root.WorkshopWorkReportPDF.attachment(report,invoices.seller()),message=reportMessage(report,invoices.seller().name||'Officina'),result=await root.WorkshopEmail?.send({to:email,subject:message.subject,body:message.body,attachment,requestId:crypto.randomUUID()});if(!result||result.manual)throw Error('Invio email PDF non disponibile: configura le credenziali SMTP del servizio scelto sul VPS.');$('workReportsStatus').textContent=result.message||'Email inviata con il rapporto PDF allegato.';details.open=false;}catch(error){$('workReportsStatus').textContent=error.message||'Invio email non riuscito.';}finally{button.disabled=false;button.textContent='Email';}}
  async function copyText(text){try{await navigator.clipboard.writeText(text);return;}catch{}const field=node('textarea');field.value=text;field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();const copied=document.execCommand('copy');field.remove();if(!copied)throw Error('Copia non riuscita: seleziona e copia il testo manualmente.');}
  function reportSendActions(report){
    const details=node('details',undefined,'work-report-send'),summary=node('summary','Invia','btn secondary');details.append(summary);
    const menu=node('div',undefined,'work-report-send-menu'),links=reportShareLinks(report,contactsFor(report.customer),invoices.seller().name||'Officina');
    for(const [key,label]of [['email','Email'],['whatsapp','WhatsApp'],['pec','PEC']]){
      if(key==='email'){
        const email=contactsFor(report.customer).email,send=node('button',label,'btn secondary');send.type='button';send.dataset.reportEmail=report.id;send.disabled=!email||!writer();send.title=!email?'Inserisci l’email del cliente nei dati anagrafici.':!writer()?'Account in sola consultazione.':'Invia il PDF del rapporto con il servizio email scelto nelle Impostazioni.';send.setAttribute('aria-label',`Invia il PDF del rapporto via email a ${report.customer}`);send.onclick=()=>void sendReportEmail(report,email,send,details);menu.append(send);
      }else if(links[key]){const link=node('a',label,'btn secondary');link.href=links[key];link.target='_blank';link.rel='noopener';link.setAttribute('aria-label',`Prepara invio ${label} per ${report.customer}`);menu.append(link);}
      else{const missing=node('button',label,'btn secondary');missing.type='button';missing.disabled=true;missing.title=key==='pec'?'Configura la PEC del cliente nei dati fiscali.':key==='whatsapp'?'Configura il telefono del cliente nei dati anagrafici.':'Configura l’email del cliente nei dati anagrafici.';menu.append(missing);}
    }
    const copy=node('button','Copia testo','btn secondary');copy.type='button';copy.onclick=async()=>{try{await copyText(reportMessage(report,invoices.seller().name||'Officina').body);$('workReportsStatus').textContent='Testo del rapporto copiato: puoi incollarlo in un messaggio.';details.open=false;}catch(error){$('workReportsStatus').textContent=error.message;}};menu.append(copy);
    const note=node('small','Email invia automaticamente il PDF generato anche dal pulsante Stampa. WhatsApp e PEC aprono il testo del messaggio.');menu.append(note);details.append(menu);return details;
  }
  function workActions(work){const cell=node('td',undefined,'work-report-share-actions'),links=shareLinks(work,contactsFor(work.customer),invoices.seller().name||'Officina');for(const [key,label]of [['email','Email'],['whatsapp','WhatsApp'],['pec','PEC']]){if(links[key]){const a=node('a',label,'btn secondary');a.href=links[key];a.target='_blank';a.rel='noopener';a.setAttribute('aria-label',`Prepara ${label} per ${work.customer}, intervento ${dateLabel(work.date)}`);cell.append(a);}else{const b=node('button',label,'btn secondary');b.type='button';b.disabled=true;b.title=key==='pec'?'Configura la PEC del cliente nei dati fiscali.':key==='whatsapp'?'Configura il telefono del cliente nei dati anagrafici.':'Configura l’email del cliente nei dati anagrafici.';cell.append(b);}}const sheet=node('button','Scheda','btn secondary');sheet.type='button';sheet.dataset.printWork=work.id;sheet.onclick=()=>{try{printWork(work);}catch(error){$('workReportsStatus').textContent=error.message;}};cell.append(sheet);return cell;}
  function renderRows(){
    const body=$('workReportRows'),blocked=used();body.replaceChildren();
    const works=filtered();for(const work of works){
      const row=node('tr');row.dataset.workId=work.id;const td=node('td'),check=node('input');check.type='checkbox';check.dataset.workId=work.id;check.checked=selected.has(work.id)&&!blocked.has(work.id);check.disabled=saving||!writer()||blocked.has(work.id);check.title=blocked.has(work.id)?'Intervento già incluso in una fattura. Puoi ancora inviare o stampare la scheda.':'';check.setAttribute('aria-label','Seleziona intervento '+dateLabel(work.date)+' · '+work.plate+' · '+work.lines.map(line=>line.description).join(' · '));check.addEventListener('change',()=>{if(check.checked)selected.add(work.id);else selected.delete(work.id);selection();});td.append(check);if(blocked.has(work.id))td.append(node('small','Già in fattura','work-report-blocked'));row.append(td,node('td',dateLabel(work.date)),node('td',[work.plate,work.vehicle].filter(Boolean).join(' · ')),node('td',work.lines.map(line=>line.description).join(' · ')),node('td',euro(work.amount),'work-report-amount'),workActions(work));body.append(row);
    }
    if(!works.length){const row=node('tr'),cell=node('td','Nessun intervento completato per questo cliente e periodo.');cell.colSpan=6;row.append(cell);body.append(row);}
    selection();$('workReportSelectAll').disabled=saving||!writer()||!works.some(work=>!blocked.has(work.id));
  }
  function refreshCustomers(){
    const prior=selectedCustomerKey,names=new Map();for(const work of allWorks())if(!names.has(customerKey(work.customer)))names.set(customerKey(work.customer),work.customer);
    for(const row of document.querySelectorAll('#customerRows tr')){const name=row.cells[0]?.textContent.trim();if(name&&!names.has(customerKey(name)))names.set(customerKey(name),name);}
    customerOptions=[...names].map(([key,name])=>({key,name})).sort((a,b)=>a.name.localeCompare(b.name,'it'));const input=$('workReportCustomer');if(prior){input.value=names.get(prior)||input.value;input.dataset.customerKey=prior;closeCustomerOptions();}else renderCustomerOptions(false);
  }
  function closeCustomerOptions(){const input=$('workReportCustomer');$('workReportCustomerOptions').hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');activeCustomerIndex=-1;}
  function renderCustomerOptions(showAll=false){
    const input=$('workReportCustomer'),list=$('workReportCustomerOptions'),query=normalizeSearch(input.value),matches=customerOptions.filter(item=>!query||normalizeSearch(item.name).includes(query)).slice(0,12);list.replaceChildren();activeCustomerIndex=-1;
    if(!showAll&&!query){closeCustomerOptions();return;}
    if(!matches.length){closeCustomerOptions();return;}
    for(const item of matches){const option=node('button',item.name,'work-report-customer-option');option.type='button';option.id='workReportCustomerOption-'+item.key;option.dataset.customerKey=item.key;option.setAttribute('role','option');option.setAttribute('aria-selected','false');option.addEventListener('pointerdown',event=>event.preventDefault());option.addEventListener('click',()=>chooseCustomer(item));list.append(option);}
    list.hidden=false;input.setAttribute('aria-expanded','true');
  }
  function chooseCustomer(item){selectedCustomerKey=item.key;$('workReportCustomer').value=item.name;$('workReportCustomer').dataset.customerKey=item.key;selected.clear();closeCustomerOptions();renderRows();renderArchive();}
  function renderArchive(){
    const archive=$('workReportsArchive');archive.replaceChildren();const key=selectedCustomerKey||$('workReportCustomer').dataset.customerKey||'',period=monthPeriod($('workReportMonth').value);if(!key||!period){archive.append(node('p','Seleziona un cliente e un mese per vedere i rapporti salvati.'));return;}const reports=invoices.workReports().filter(report=>customerKey(report.customerKey||report.customer)===key&&report.period?.start<=period.end&&report.period?.end>=period.start).sort((a,b)=>b.date.localeCompare(a.date));
    for(const report of reports){
      const item=node('div',undefined,'work-report-archive-row');item.dataset.reportId=report.id;const title=node('div');title.append(node('b',report.customer),node('small',dateLabel(report.period.start)+' – '+dateLabel(report.period.end)+' · '+report.works.length+' interventi · '+euro(report.total)));const actions=node('div',undefined,'work-report-archive-actions');
      const printButton=node('button','Stampa','btn secondary');printButton.type='button';printButton.dataset.printReport=report.id;printButton.onclick=()=>{try{print(report);}catch(error){$('workReportsStatus').textContent=error.message;}};
      const invoice=invoices.documents().find(doc=>['TD01','TD24'].includes(doc.type)&&doc.sourceWorkReportId===report.id),convert=node('button',invoice?'Apri fattura':'Crea bozza TD24','btn secondary');convert.type='button';convert.dataset.invoiceReport=report.id;convert.disabled=saving||(!invoice&&!writer());convert.onclick=async()=>{if(saving)return;saving=true;renderRows();renderArchive();$('workReportsStatus').textContent=invoice?'Apertura della fattura…':'Creazione della bozza TD24…';try{if(!invoice&&root.WorkshopCloud)await root.WorkshopCloud.flush();const doc=await invoices.invoiceFromWorkReport(report.id);dialog.close();invoices.openDocument(doc.id);}catch(error){$('workReportsStatus').textContent=error.message;}finally{saving=false;renderRows();renderArchive();}};actions.append(printButton,convert);
      actions.prepend(reportSendActions(report));
      if(!invoice&&writer()){const remove=node('button','×','btn secondary');remove.type='button';remove.dataset.deleteReport=report.id;remove.setAttribute('aria-label','Elimina rapporto di '+report.customer);remove.onclick=async()=>{if(saving||!root.confirm('Eliminare questo rapporto? Gli interventi restano nello storico.'))return;try{await invoices.deleteWorkReport(report.id);$('workReportsStatus').textContent='Rapporto eliminato.';renderArchive();}catch(error){$('workReportsStatus').textContent=error.message;}};actions.append(remove);}
      item.append(title,actions);archive.append(item);
    }
    if(!reports.length)archive.append(node('p','Nessun rapporto salvato per questo cliente e mese.'));
  }
  async function save(){
    if(saving||!writer())return;const works=selection();if(!works.length)return;const name=works[0].customer;
    if(new Set(works.map(work=>work.date.slice(0,7))).size>1){$('workReportsStatus').textContent='Per una fattura differita TD24, tutti gli interventi del rapporto devono essere dello stesso mese.';return;}
    const period=monthPeriod($('workReportMonth').value);if(!period){$('workReportsStatus').textContent='Seleziona un mese valido.';return;}const snapshot={id:'',date:today(),customer:name,customerKey:customerKey(name),period,works:works.map(({customer,...work})=>work),total:works.reduce((sum,work)=>sum+cents(work.amount),0)/100};
    snapshot.id=pendingReport&&JSON.stringify({...pendingReport,id:''})===JSON.stringify(snapshot)?pendingReport.id:crypto.randomUUID();snapshot.number=reportNumber(snapshot);pendingReport=structuredClone(snapshot);
    saving=true;renderRows();$('workReportsStatus').textContent='Salvataggio del rapporto…';
    try{if(root.WorkshopCloud)await root.WorkshopCloud.flush();invoices.saveWorkReport(snapshot);if(root.WorkshopCloud)await root.WorkshopCloud.flush();pendingReport=null;selected.clear();$('workReportsStatus').textContent='Rapporto salvato. Puoi stamparlo o preparare la fattura.';renderArchive();}
    catch(error){$('workReportsStatus').textContent='Salvataggio non riuscito: '+error.message;}
    finally{saving=false;renderRows();renderArchive();}
  }
  function open(context={}){
    if(saving)return false;originalFocus=document.activeElement;selected.clear();selectedCustomerKey='';$('workReportsStatus').textContent=supported()?'':'Riavvia il servizio con il pacchetto aggiornato e ricarica la pagina per creare rapporti e fatture.';const date=today(),year=Number(context.year)||Number(date.slice(0,4)),requestedMonth=Number(context.month)||Number(date.slice(5,7)),month=requestedMonth>=1&&requestedMonth<=12?requestedMonth:Number(date.slice(5,7));
    $('workReportMonth').value=`${year}-${String(month).padStart(2,'0')}`;$('workReportCustomer').value='';$('workReportCustomer').removeAttribute('data-customer-key');closeCustomerOptions();
    refreshCustomers();renderRows();renderArchive();dialog.showModal();$('workReportCustomer').focus();return true;
  }
  $('workReportsClose').onclick=()=>{if(!saving)dialog.close();};dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});dialog.addEventListener('close',()=>originalFocus?.focus());
  const customerInput=$('workReportCustomer');customerInput.addEventListener('focus',()=>{refreshCustomers();renderCustomerOptions(true);renderRows();renderArchive();});customerInput.addEventListener('input',()=>{selectedCustomerKey='';customerInput.removeAttribute('data-customer-key');selected.clear();refreshCustomers();renderCustomerOptions();renderRows();renderArchive();});customerInput.addEventListener('blur',()=>setTimeout(closeCustomerOptions,100));customerInput.addEventListener('keydown',event=>{const list=$('workReportCustomerOptions');let options=[...list.querySelectorAll('[role=option]')];if(event.key==='ArrowDown'){if(list.hidden){renderCustomerOptions(true);options=[...list.querySelectorAll('[role=option]')];}options[activeCustomerIndex]?.setAttribute('aria-selected','false');activeCustomerIndex=Math.min(activeCustomerIndex+1,options.length-1);const next=options[activeCustomerIndex];if(next){next.setAttribute('aria-selected','true');customerInput.setAttribute('aria-activedescendant',next.id);next.scrollIntoView({block:'nearest'});}event.preventDefault();}else if(event.key==='ArrowUp'&&!list.hidden){options[activeCustomerIndex]?.setAttribute('aria-selected','false');activeCustomerIndex=Math.max(0,activeCustomerIndex-1);const next=options[activeCustomerIndex];if(next){next.setAttribute('aria-selected','true');customerInput.setAttribute('aria-activedescendant',next.id);next.scrollIntoView({block:'nearest'});}event.preventDefault();}else if(event.key==='Enter'&&!list.hidden){const item=customerOptions.find(option=>option.key===options[activeCustomerIndex]?.dataset.customerKey)||customerOptions.find(option=>normalizeSearch(option.name)===normalizeSearch(customerInput.value));if(item){event.preventDefault();chooseCustomer(item);}}else if(event.key==='Escape'&&!list.hidden){closeCustomerOptions();event.preventDefault();}});
  $('workReportMonth').addEventListener('change',()=>{selected.clear();refreshCustomers();closeCustomerOptions();renderRows();renderArchive();});
  $('workReportSelectAll').onclick=()=>{const blocked=used();for(const work of filtered())if(!blocked.has(work.id))selected.add(work.id);renderRows();};$('workReportSave').onclick=save;
  const refreshAfterCloudState=()=>{if(!dialog.open)return;refreshCustomers();renderRows();renderArchive();};document.addEventListener('workshop-cloud-state-applied',refreshAfterCloudState);document.addEventListener('workshop-cloud-state-settled',refreshAfterCloudState);
  document.addEventListener('workshop-invoices-updated',()=>{if(dialog.open){renderRows();renderArchive();}});
  Object.assign(api,{open,print,refresh:()=>{refreshCustomers();renderRows();renderArchive();},isSaving:()=>saving});
})(typeof window==='undefined'?globalThis:window);
