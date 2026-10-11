/* Fatture domestiche ordinarie e fatture differite TD24 da rapporto: archivio e XML FPR12. */
(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const money = n => Number(n).toFixed(2);
  const typeLabel=type=>type==='TD04'?'Nota di credito':type==='TD24'?'Fattura differita':'Fattura';
  const reportNumber=report=>'RI-'+String(report?.id||'').replace(/-/g,'').slice(0,17).toUpperCase();
  const natureCodes=['N1','N2.1','N2.2','N3.1','N3.2','N3.3','N3.4','N3.5','N3.6','N4','N5','N6.1','N6.2','N6.3','N6.4','N6.5','N6.6','N6.7','N6.8','N6.9','N7'];
  const validDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&!Number.isNaN(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
  function totals(lines) {
    const groups=new Map();
    const details=lines.map(l=>{
      const price=l.grossPrice==null?Number(l.price):Number((Number(l.grossPrice)/(1+Number(l.vat)/100)).toFixed(8));
      const net=round(Number(l.quantity)*price*(1-Number(l.discount||0)/100)),nature=Number(l.vat)===0?(l.nature||''):'';
      const key=l.vat+'|'+nature+'|'+(nature?l.taxReference||'':'');
      if(!groups.has(key))groups.set(key,{vat:Number(l.vat),nature,net:0,reference:l.taxReference||''});
      const group=groups.get(key);group.net=round(group.net+net);
      return {...l,price,net,nature};
    });
    const summaries=[...groups.values()].map(g=>({...g,tax:round(g.net*g.vat/100)}));
    const net=round(summaries.reduce((s,g)=>s+g.net,0)),tax=round(summaries.reduce((s,g)=>s+g.tax,0));
    return {details,summaries,net,tax,total:round(net+tax)};
  }
  function invoiceRounding(lines){const gross=round(lines.reduce((sum,line)=>sum+round(Number(line.quantity)*(line.grossPrice==null?Number(line.price)*(1+Number(line.vat)/100):Number(line.grossPrice))*(1-Number(line.discount||0)/100)),0));return round(gross-totals(lines).total);}
  function documentTotals(doc){const t=totals(doc.lines),rounding=Number(doc.rounding||0);return {...t,rounding,stampDuty:Number(doc.stampDuty||0),total:round(t.total+rounding+Number(doc.stampDuty||0))};}
  function vatValid(s) {
    if(!/^\d{11}$/.test(s)||/^0+$/.test(s))return false;
    let sum=0;for(let i=0;i<10;i++){let n=Number(s[i]);if(i%2){n*=2;if(n>9)n-=9;}sum+=n;}
    return (10-sum%10)%10===Number(s[10]);
  }
  function validate(doc,seller) {
    const errors=[];const c=doc.customer||{};
    const invalidXml=v=>typeof v==='string'&&/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(v);
    const textValues=[...Object.values(seller||{}),...Object.values(c),doc.notes,doc.plate,doc.km,doc.reference,...(doc.lines||[]).flatMap(l=>[l.description,l.taxReference])];
    if(textValues.some(invalidXml))errors.push('Rimuovere i caratteri di controllo non ammessi dai dati del documento.');
    for(const [label,p]of [['Officina',seller||{}],['Cliente',c]]){
      for(const [key,name,max]of [['name','denominazione',80],['address','indirizzo',60],['city','comune',60]])if(!p[key]?.trim()||p[key].length>max)errors.push(label+': '+name+' obbligatorio, massimo '+max+' caratteri.');
      if(p.country&&p.country!=='IT')errors.push(label+': questa procedura gestisce soggetti con sede in Italia.');
      if(!/^\d{5}$/.test(p.zip||''))errors.push(label+': CAP di cinque cifre richiesto.');
      if(!/^[A-Z]{2}$/.test(p.province||''))errors.push(label+': provincia di due lettere richiesta.');
      if(p.vat&&!vatValid(p.vat))errors.push(label+': partita IVA non valida.');
      if(p.cf&&!/^(?:[A-Z0-9]{16}|\d{11})$/.test(p.cf))errors.push(label+': formato codice fiscale non valido.');
    }
    if(!seller?.vat)errors.push('Inserire la partita IVA dell’officina.');
    if(!['RF01','RF19'].includes(seller?.regime||'RF01'))errors.push('Regime fiscale non supportato.');
    if(!c.vat&&!/^(?:[A-Z0-9]{16}|\d{11})$/.test(c.cf||''))errors.push('Cliente: inserire codice fiscale o partita IVA.');
    if(!/^[A-Z0-9]{7}$/.test(c.code||'0000000'))errors.push('Codice destinatario: servono sette caratteri.');
    if(c.pec&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.pec)||c.pec.length>256))errors.push('PEC non valida.');
    if(c.pec&&(c.code||'0000000')!=='0000000')errors.push('Per usare la PEC impostare il codice destinatario a 0000000.');
    if(!validDate(doc.date))errors.push('Data documento non valida.');
    if(doc.paymentDue&&(!validDate(doc.paymentDue)||doc.paymentDue<doc.date))errors.push('La scadenza deve essere una data valida non precedente al documento.');
    if(!Array.isArray(doc.lines)||!doc.lines.length)errors.push('Inserire almeno una lavorazione.');
    (doc.lines||[]).forEach((l,i)=>{
      if(!l.description?.trim()||l.description.length>1000||!Number.isFinite(+l.quantity)||+l.quantity<0.00000001||+l.quantity>999999999999||!Number.isFinite(+l.price)||+l.price<0||+l.price>999999999.99||!Number.isFinite(+(l.grossPrice??l.price))||+(l.grossPrice??l.price)<0||+(l.grossPrice??l.price)>999999999.99||![0,4,5,10,22].includes(+l.vat)||!Number.isFinite(+(l.discount||0))||+(l.discount||0)<0||+(l.discount||0)>100)errors.push('Controllare descrizione, quantità, prezzo, sconto e IVA della riga '+(i+1)+'.');
      if(+l.vat===0&&(!natureCodes.includes(l.nature)||!l.taxReference?.trim()||l.taxReference.length>100))errors.push('Riga '+(i+1)+': per IVA 0% scegliere natura e riferimento normativo (massimo 100 caratteri).');
      if(+l.vat!==0&&l.nature)errors.push('Riga '+(i+1)+': la natura si usa solo con IVA 0%.');
      if(seller?.regime==='RF19'&&(+l.vat!==0||l.nature!=='N2.2'))errors.push('Regime forfettario: impostare IVA 0% e natura N2.2.');
    });
    if(Array.isArray(doc.lines)&&doc.lines.length&&(!Number.isFinite(documentTotals(doc).total)||Math.abs(documentTotals(doc).total)>999999999999.99))errors.push('Importo totale oltre il limite consentito.');
    if(!['TD01','TD04','TD24'].includes(doc.type))errors.push('Tipo documento non supportato.');
    if(doc.type==='TD04'&&(!doc.reference||doc.reference.length>20||!validDate(doc.referenceDate)||doc.referenceDate>doc.date))errors.push('Indicare numero (massimo 20 caratteri) e data valida della fattura da rettificare.');
    if(doc.type==='TD24'&&(!doc.sourceWorkReportId||!Array.isArray(doc.sourceWorkIds)||!doc.sourceWorkIds.length||!/^[0-9]{4}-[0-9]{2}$/.test(doc.deferredServiceMonth||'')||doc.date?.slice(0,7)!==doc.deferredServiceMonth||!/^RI-[A-Z0-9]{1,17}$/.test(doc.sourceWorkReportNumber||'')||!validDate(doc.sourceWorkReportDate)||!doc.notes?.includes(doc.sourceWorkReportNumber)||!doc.notes?.includes(doc.sourceWorkReportDate)||doc.cashLink))errors.push('TD24 richiede il riferimento datato a un rapporto di intervento dello stesso mese e non può essere collegata a un singolo incasso.');
    if(!['MP01','MP05','MP08'].includes(doc.payment))errors.push('Modalità pagamento non supportata.');
    if(doc.iban&&!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(doc.iban))errors.push('Formato IBAN non valido.');
    if(![0,2].includes(Number(doc.stampDuty||0)))errors.push('Bollo: scegliere nessuno oppure 2 euro.');
    if(doc.rounding!==undefined&&(!Number.isFinite(Number(doc.rounding))||round(Number(doc.rounding))!==Number(doc.rounding)||Math.abs(Number(doc.rounding))>((doc.lines?.length||0)*.02+.01)))errors.push('Arrotondamento del documento non valido.');
    if((doc.plate||'').length>80||(doc.km||'').toString().length>20)errors.push('Targa o chilometraggio troppo lunghi.');
    if((doc.notes||'').length>200)errors.push('Causale: massimo 200 caratteri.');
    return [...new Set(errors)];
  }
  function nextSequence(documents,year,floor=1){
    if(!/^\d{4}$/.test(String(year))||!Number.isSafeInteger(+floor)||+floor<1||+floor>999999)throw Error('Anno o numero iniziale non valido.');
    const prepared=documents.filter(d=>d.status==='prepared'&&d.date?.slice(0,4)===String(year));
    const seq=Math.max(+floor,1+Math.max(0,...prepared.map(d=>Number(d.sequence)||Number(String(d.number).split('/')[0])||0)));
    if(seq>999999)throw Error('Progressivo annuale esaurito.');return seq;
  }
  function prepare(doc,state){
    if(doc.status==='prepared')throw Error('Documento già definitivo.');
    const seller=structuredClone(state.seller),errors=validate(doc,seller);if(errors.length)throw Error(errors.join('\n'));
    const year=doc.date.slice(0,4),prepared=state.documents.filter(d=>d.status==='prepared'&&d.date.slice(0,4)===year);
    if(prepared.some(d=>d.date>doc.date))throw Error('La data precede un documento già numerato nello stesso anno.');
    const sequence=nextSequence(state.documents,year,state.numbering?.[year]||1),number=sequence+'/'+year;
    if(state.documents.some(d=>d.number===number))throw Error('Numero documento già presente.');
    const result={...structuredClone(doc),seller,sequence,number,progressive:year+String(sequence).padStart(6,'0'),status:'prepared',preparedAt:new Date().toISOString()};
    result.xml=xml(result,seller);result.filename='IT'+seller.vat+'_'+result.progressive+'.xml';return result;
  }
  function xml(doc,seller){
    const errors=validate(doc,seller);if(errors.length)throw Error(errors.join('\n'));
    if(!doc.number||doc.number.length>20||!/^[A-Za-z0-9]{1,10}$/.test(doc.progressive||''))throw Error('Numero o progressivo documento non valido.');
    const t=documentTotals(doc),c=doc.customer,tag=(n,v)=>`<${n}>${esc(v)}</${n}>`;
    const identity=p=>(p.vat?'<IdFiscaleIVA><IdPaese>IT</IdPaese>'+tag('IdCodice',p.vat)+'</IdFiscaleIVA>':'')+(p.cf?tag('CodiceFiscale',p.cf):'')+'<Anagrafica>'+tag('Denominazione',p.name)+'</Anagrafica>';
    const address=p=>'<Sede>'+tag('Indirizzo',p.address)+tag('CAP',p.zip)+tag('Comune',p.city)+tag('Provincia',p.province)+'<Nazione>IT</Nazione></Sede>';
    const notes=[doc.notes,doc.plate?'Targa: '+doc.plate+(doc.km?' - Km: '+doc.km:''):''].filter(Boolean).map(n=>tag('Causale',n)).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>\n<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12"><FatturaElettronicaHeader><DatiTrasmissione><IdTrasmittente><IdPaese>IT</IdPaese>'+tag('IdCodice',seller.vat)+'</IdTrasmittente>'+tag('ProgressivoInvio',doc.progressive)+'<FormatoTrasmissione>FPR12</FormatoTrasmissione>'+tag('CodiceDestinatario',c.code||'0000000')+(c.pec?tag('PECDestinatario',c.pec):'')+'</DatiTrasmissione><CedentePrestatore><DatiAnagrafici>'+identity(seller)+tag('RegimeFiscale',seller.regime||'RF01')+'</DatiAnagrafici>'+address(seller)+'</CedentePrestatore><CessionarioCommittente><DatiAnagrafici>'+identity(c)+'</DatiAnagrafici>'+address(c)+'</CessionarioCommittente></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento>'+tag('TipoDocumento',doc.type)+'<Divisa>EUR</Divisa>'+tag('Data',doc.date)+tag('Numero',doc.number)+(t.stampDuty?'<DatiBollo><BolloVirtuale>SI</BolloVirtuale>'+tag('ImportoBollo',money(t.stampDuty))+'</DatiBollo>':'')+tag('ImportoTotaleDocumento',money(t.total))+(t.rounding?tag('Arrotondamento',money(t.rounding)):'')+notes+'</DatiGeneraliDocumento>'+(doc.type==='TD04'?'<DatiFattureCollegate>'+tag('IdDocumento',doc.reference)+tag('Data',doc.referenceDate)+'</DatiFattureCollegate>':'')+'</DatiGenerali><DatiBeniServizi>'+t.details.map((l,i)=>'<DettaglioLinee>'+tag('NumeroLinea',i+1)+tag('Descrizione',l.description)+tag('Quantita',Number(l.quantity).toFixed(8))+tag('PrezzoUnitario',Number(l.price).toFixed(8))+(+l.discount?'<ScontoMaggiorazione><Tipo>SC</Tipo>'+tag('Percentuale',money(l.discount))+'</ScontoMaggiorazione>':'')+tag('PrezzoTotale',money(l.net))+tag('AliquotaIVA',money(l.vat))+(l.nature?tag('Natura',l.nature):'')+'</DettaglioLinee>').join('')+t.summaries.map(g=>'<DatiRiepilogo>'+tag('AliquotaIVA',money(g.vat))+(g.nature?tag('Natura',g.nature):'')+tag('ImponibileImporto',money(g.net))+tag('Imposta',money(g.tax))+'<EsigibilitaIVA>I</EsigibilitaIVA>'+(g.reference?tag('RiferimentoNormativo',g.reference):'')+'</DatiRiepilogo>').join('')+'</DatiBeniServizi><DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento>'+tag('ModalitaPagamento',doc.payment)+(doc.paymentDue?tag('DataScadenzaPagamento',doc.paymentDue):'')+tag('ImportoPagamento',money(t.total))+(doc.iban?tag('IBAN',doc.iban):'')+'</DettaglioPagamento></DatiPagamento></FatturaElettronicaBody></p:FatturaElettronica>';
  }
  const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  function validateWorkReport(report){
    const helper=typeof module!=='undefined'&&module.exports?require('./work-reports.js'):root.WorkshopWorkReports;
    if(!helper?.validateReport)throw Error('Gestione rapporti non disponibile. Ricarica il gestionale.');
    return helper.validateReport(report);
  }
  function validateWorkReportLinks(archive){
    const occupied=new Set(archive.documents.filter(doc=>doc.type==='TD01'&&!doc.sourceWorkReportId&&!doc.sourceWorkIds&&doc.cashLink).map(doc=>doc.cashLink)),claimed=new Set();
    for(const doc of archive.documents.filter(d=>['TD01','TD24'].includes(d.type))){
      if(doc.sourceWorkReportId||doc.sourceWorkIds){
        const report=(archive.workReports||[]).find(item=>item.id===doc.sourceWorkReportId);
        if(!report||!Array.isArray(doc.sourceWorkIds)||JSON.stringify([...doc.sourceWorkIds].sort())!==JSON.stringify(report.works.map(work=>work.id).sort())||doc.cashLink)throw Error('Collegamento tra rapporto e fattura non valido.');
        if(doc.type==='TD24'){const months=new Set(report.works.map(work=>work.date.slice(0,7)));if(months.size!==1||doc.deferredServiceMonth!==[...months][0]||doc.date?.slice(0,7)!==doc.deferredServiceMonth||doc.sourceWorkReportNumber!==reportNumber(report)||doc.sourceWorkReportDate!==report.date)throw Error('La fattura TD24 deve riferirsi a interventi dello stesso mese e riportare il riferimento datato al rapporto.');}
        for(const id of doc.sourceWorkIds){if(occupied.has(id)||claimed.has(id))throw Error('Un intervento è già presente in un’altra fattura.');claimed.add(id);}
      }
    }
  }
  function mergeBackup(state,incoming){
    if(!incoming||incoming.version!==1||!Array.isArray(incoming.documents)||!incoming.seller||typeof incoming.seller!=='object')throw Error('Backup non riconosciuto.');
    const next=structuredClone(state);
    for(const d of incoming.documents){
      if(!d||typeof d.id!=='string'||!d.id||!validDate(d.date)||!['draft','prepared'].includes(d.status)||!['TD01','TD04','TD24'].includes(d.type)||!d.customer||typeof d.customer.name!=='string'||!Array.isArray(d.lines))throw Error('Documento backup non valido.');
      if(d.lines.some(l=>!l||typeof l.description!=='string'||!Number.isFinite(+l.quantity)||+l.quantity<=0||!Number.isFinite(+l.price)||+l.price<0||!Number.isFinite(+(l.grossPrice??l.price))||!Number.isFinite(+(l.discount||0))||![0,4,5,10,22].includes(+l.vat)))throw Error('Righe del backup non valide.');
      if(!Number.isFinite(documentTotals(d).total))throw Error('Totali del backup non validi.');
      if(d.paid!==undefined&&typeof d.paid!=='boolean')throw Error('Stato pagamento del backup non valido.');
      if(d.paidDate&&!validDate(d.paidDate))throw Error('Data saldo del backup non valida.');
      if(d.status==='prepared'){
        if(!d.seller||validate(d,d.seller).length||typeof d.number!=='string'||!d.number||d.number.length>20||!/^[A-Za-z0-9]{1,10}$/.test(d.progressive||'')||d.filename!=='IT'+d.seller.vat+'_'+d.progressive+'.xml'||typeof d.xml!=='string'||!d.xml.includes('<Numero>'+esc(d.number)+'</Numero>')||!d.xml.includes('<Data>'+esc(d.date)+'</Data>')||!d.xml.includes('<TipoDocumento>'+d.type+'</TipoDocumento>')||!d.xml.includes('<p:FatturaElettronica')||!d.xml.includes('</p:FatturaElettronica>')||/<!DOCTYPE|<!ENTITY/i.test(d.xml))throw Error('Documento definitivo incompleto o incoerente nel backup: '+(d.number||d.id));
      }
      const existing=next.documents.find(x=>x.id===d.id);
      if(existing){if(JSON.stringify(canonical(existing))!==JSON.stringify(canonical(d)))throw Error('Conflitto per '+(d.number||d.customer.name)+': il documento presente è diverso dal backup. Nessun dato importato.');continue;}
      if(d.number&&next.documents.some(x=>x.number===d.number))throw Error('Numero duplicato '+d.number);
      next.documents.push(structuredClone(d));
    }
    if(!next.seller.vat)next.seller=structuredClone(incoming.seller);
    for(const [year,floor]of Object.entries(incoming.numbering||{})){nextSequence(next.documents,year,floor);next.numbering={...next.numbering,[year]:Math.max(next.numbering?.[year]||1,Number(floor))};}
    if(incoming.workReports!==undefined){
      if(!Array.isArray(incoming.workReports))throw Error('Archivio rapporti del backup non valido.');
      next.workReports=next.workReports||[];
      for(const report of incoming.workReports){validateWorkReport(report);const existing=next.workReports.find(item=>item.id===report.id);if(existing){if(JSON.stringify(canonical(existing))!==JSON.stringify(canonical(report)))throw Error('Conflitto nel rapporto di intervento: nessun dato importato.');}else next.workReports.push(structuredClone(report));}
    }
    validateWorkReportLinks(next);
    return next;
  }
  const api={totals,documentTotals,invoiceRounding,validate,xml,vatValid,nextSequence,prepare,natureCodes,mergeBackup};
  if(typeof module!=='undefined' && module.exports){module.exports=api;return;}
  root.WorkshopInvoices=api;
  const key='officina.invoices.v1', $=id=>document.getElementById(id);
  let state={version:1,seller:{},documents:[]}, current=null;
  try {const saved=localStorage.getItem(key);if(saved)state=JSON.parse(saved);if(state.version!==1 || !Array.isArray(state.documents))throw Error('Archivio non riconosciuto');}
  catch(e){alert('Impossibile aprire l’archivio fatture: '+e.message);return;}
  const today=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  const euro=n=>Number(n).toLocaleString('it-IT',{style:'currency',currency:'EUR'});
  const download=(name,content,type)=>{const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  let savedRevision=localStorage.getItem(key);
  let archiveChanged=false,archiveReloadError='';
  document.addEventListener('workshop-cloud-state-loading',event=>{
    archiveChanged=!event.detail?.storageKeys||event.detail.storageKeys.includes(key);
    if(!archiveChanged)return;
    try{
      const raw=localStorage.getItem(key),next=raw?JSON.parse(raw):{version:1,seller:{},documents:[]};
      if(next.version!==1||!Array.isArray(next.documents))throw Error('Archivio non riconosciuto');
      state=next;savedRevision=raw;archiveReloadError='';
      if(current&&$('invEditor')?.hidden)current=state.documents.find(doc=>doc.id===current.id)?structuredClone(state.documents.find(doc=>doc.id===current.id)):null;
    }catch(error){archiveReloadError='Impossibile aggiornare l’archivio fatture: '+error.message;}
  });
  document.addEventListener('workshop-cloud-state-applied',()=>{
    if(!archiveChanged)return;
    archiveChanged=false;
    if(archiveReloadError){$('invErrors').textContent=archiveReloadError;return;}
    fillParty('invSeller',state.seller);$('invSellerCf').value=state.seller.cf||'';$('invSellerRegime').value=state.seller.regime||'RF01';$('invSellerIban').value=state.seller.iban||'';
    numberHint();renderArchive();
  });
  function save(next){if(localStorage.getItem(key)!==savedRevision)throw Error('Archivio modificato in un’altra scheda: ricarica prima di salvare.');const json=JSON.stringify(next);localStorage.setItem(key,json);savedRevision=json;state=next;}
  const field=(id,label,type='text',value='')=>`<label>${label}<input id="${id}" type="${type}" value="${esc(value)}"></label>`;
  const party=(prefix)=>field(prefix+'Name','Nome / ragione sociale')+field(prefix+'Vat','Partita IVA italiana')+field(prefix+'Address','Indirizzo')+field(prefix+'Zip','CAP')+field(prefix+'City','Comune')+field(prefix+'Province','Provincia');
  const css=document.createElement('style');css.textContent=`#invoiceApp{display:none}#invoiceApp [hidden]{display:none!important}#invoiceApp .inv-grid label{align-self:start;align-content:start}#invoiceApp .inv-actions label{display:grid;gap:5px}#invoiceApp .inv-actions input,#invoiceApp .inv-actions select{box-sizing:border-box;padding:9px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--ink);font:inherit}#invoiceApp .inv-actions{align-items:end}.invoice-months{display:grid;grid-template-columns:repeat(12,minmax(100px,1fr));overflow:auto;gap:6px;padding-bottom:10px}.invoice-months button{display:grid;gap:12px;text-align:left;padding:12px}.invoice-months span{font-size:11px}.invoice-archive-table{width:100%;border-collapse:collapse;min-width:850px}.invoice-archive-table th,.invoice-archive-table td{text-align:left;padding:14px 10px;border-bottom:1px solid var(--line)}.invoice-archive-table th{font-size:11px;text-transform:uppercase;color:var(--muted)}.invoice-archive-table tbody tr:nth-child(odd){background:#f4f9f6}.inv-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:16px 0}.inv-summary>div{border:1px solid var(--line);border-radius:8px;padding:12px;display:grid;gap:8px}.inv-summary span{font-size:12px;color:var(--muted)}.inv-summary strong{font-size:18px}.inv-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.inv-grid label{display:grid;gap:5px;font-size:12px}.inv-grid input,.inv-grid select,.inv-lines input,.inv-lines select{width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;background:white;color:var(--ink)}.inv-actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.inv-lines{width:100%;border-collapse:collapse}.inv-lines td,.inv-lines th{padding:6px;text-align:left;font-size:12px}.inv-lines td:first-child{min-width:200px}.inv-lines input[type=number]{min-width:80px}.inv-error{white-space:pre-line;color:#b23c22}.inv-total{text-align:right;font-size:18px;font-weight:800;margin:15px}.inv-help{color:var(--muted);font-size:12px}.inv-scroll{overflow:auto}.inv-record{display:flex;justify-content:space-between;gap:12px;align-items:center;border-top:1px solid var(--line);padding:12px 0}.inv-record small{display:block;color:var(--muted)}@media(max-width:750px){.inv-grid{grid-template-columns:1fr}.inv-record{flex-wrap:wrap}}`;
  document.head.appendChild(css);
  const page=document.createElement('section');page.id='invoiceApp';page.className='section-page';
    page.innerHTML=`<div class="page-head"><div><h2>Fatture emesse</h2><p>Bozze, fatture e note di credito</p></div><button class="btn" id="invNew">+ Nuova fattura</button></div><p class="inv-help">Fatture e note di credito verso clienti in Italia: IVA ordinaria o natura IVA 0%, bollo, scadenze e saldi. Configura i dati fiscali e la numerazione prima di confermare i documenti. PA ed estero non inclusi.</p><details class="card"><summary>Dati fiscali dell’officina</summary><div class="inv-grid" style="margin-top:16px">${party('invSeller')}</div><div class="inv-actions"><button class="btn" id="invSaveSeller">Salva dati officina</button></div></details><div class="inv-actions"><button class="btn secondary" id="invBackup">Esporta backup fatture</button><label class="btn secondary">Importa backup<input id="invRestore" type="file" accept="application/json,.json" hidden></label></div><div class="card" id="invArchive"></div><div class="card" id="invEditor" hidden style="margin-top:18px"><h2 id="invHeading">Bozza</h2><div class="inv-grid" style="margin-top:16px"><label>Tipo<select id="invType"><option value="TD01">Fattura TD01</option><option value="TD04">Nota di credito TD04</option><option value="TD24" hidden>Fattura differita TD24 (da rapporto)</option></select></label>${field('invDate','Data','date')}${field('invNumber','Numero (assegnato all’esportazione)')}${field('invReference','Fattura da rettificare: numero')}${field('invReferenceDate','Data fattura da rettificare','date')}<label>Pagamento<select id="invPayment"><option value="MP05">Bonifico</option><option value="MP01">Contanti</option><option value="MP08">Carta</option></select></label></div><p class="inv-help" id="invTypeHelp" hidden>TD24 raggruppa prestazioni dello stesso cliente e dello stesso mese. La data viene impostata sull’ultimo intervento del mese; l’emissione va verificata entro il 15 del mese successivo.</p><h3>Cliente</h3><label>Compila dall’anagrafica <select id="invCustomers"></select></label><div class="inv-grid" style="margin-top:12px">${party('invCustomer')}${field('invCustomerCf','Codice fiscale')}${field('invCustomerCode','Codice destinatario','text','0000000')}${field('invCustomerPec','PEC destinatario','email')}</div><div class="inv-grid">${field('invPlate','Targa veicolo')}${field('invKm','Chilometraggio','number')}</div><div class="inv-actions"><label>Data intervento <input id="invWorkDate" type="date"></label><select id="invWorks"></select><button class="btn secondary" id="invImportWork">Importa lavori (importi IVA inclusa al 22%)</button></div><p class="inv-help">Verifica gli importi importati: i prezzi delle righe sotto includono IVA. L’importazione non modifica il magazzino.</p><div class="inv-scroll"><table class="inv-lines"><thead><tr><th>Lavorazione / prodotto</th><th>Quantità</th><th>Prezzo unitario IVA inclusa €</th><th>Sconto %</th><th>IVA % / Natura</th><th></th></tr></thead><tbody id="invLines"></tbody></table></div><button class="link" id="invAddLine">+ Aggiungi riga</button><div class="inv-total" id="invTotal"></div><div class="inv-grid">${field('invNotes','Causale (massimo 200 caratteri)')}</div><p class="inv-error" id="invErrors" role="status"></p><div class="inv-actions"><button class="btn" id="invSave">Salva bozza</button><button class="btn secondary" id="invPrint">Anteprima / stampa</button><button class="btn" id="invXml">Prepara e scarica XML</button><button class="btn secondary" id="invClose">Chiudi</button></div><p class="inv-help">La numerazione blocca il documento. PDF e XML sono generati localmente. Nessun invio al SdI. Il backup non è conservazione a norma.</p></div>`;
  document.querySelector('main').appendChild(page);
  css.textContent+='#invReminderDialog{border:1px solid var(--line);border-radius:12px;background:var(--paper);color:var(--ink);width:min(560px,calc(100vw - 28px));padding:22px;box-shadow:0 20px 70px #0005}#invReminderDialog::backdrop{background:#0009}#invReminderDialog textarea{box-sizing:border-box;width:100%;min-height:210px;resize:vertical;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font:13px/1.5 Manrope}#invReminderDialog .inv-actions{justify-content:flex-end}';
  const reminderDialog=document.createElement('dialog');reminderDialog.id='invReminderDialog';
  reminderDialog.innerHTML='<h2>Sollecito di pagamento</h2><p class="inv-help">Prepara il testo, poi copialo o scaricalo. Nessun messaggio viene inviato automaticamente.</p><label for="invReminderText">Testo del sollecito</label><textarea id="invReminderText"></textarea><p id="invReminderStatus" class="inv-help" role="status"></p><div class="inv-actions"><button type="button" class="btn secondary" id="invReminderClose">Chiudi</button><button type="button" class="btn secondary" id="invReminderCopy">Copia testo</button><button type="button" class="btn secondary" id="invReminderDownload">Scarica testo</button><button type="button" class="btn" id="invReminderRecord">Registra sollecito</button></div>';
  document.body.append(reminderDialog);
  let reminderId='';
  function openReminder(doc){
    if(doc.status!=='prepared'||!['TD01','TD24'].includes(doc.type)||doc.paid)return;
    reminderId=doc.id;
    $('invReminderRecord').disabled=false;
    $('invReminderText').value='Oggetto: Sollecito pagamento fattura '+doc.number+'\n\nGentile '+(doc.customer.name||'Cliente')+',\n\nrisulta ancora da saldare la fattura n. '+doc.number+' del '+doc.date.split('-').reverse().join('/')+', per un importo di '+euro(documentTotals(doc).total)+(doc.paymentDue?', con scadenza '+doc.paymentDue.split('-').reverse().join('/'):'')+'.\n\nLa invitiamo a verificare il pagamento e, se non ancora effettuato, a provvedere al saldo'+(doc.iban||state.seller.iban?' tramite bonifico all’IBAN '+(doc.iban||state.seller.iban):'')+'. Se ha già pagato, La preghiamo di ignorare questo promemoria e di comunicarci gli estremi del versamento.\n\nCordiali saluti.';
    $('invReminderStatus').textContent=(doc.reminders?.length?'Ultimo sollecito registrato: '+doc.reminders.at(-1).date.split('-').reverse().join('/')+'. ':'')+'Il testo resta modificabile prima di copiarlo.';
    reminderDialog.showModal();
  }
  $('invReminderClose').onclick=()=>reminderDialog.close();
  $('invReminderCopy').onclick=async()=>{try{await navigator.clipboard.writeText($('invReminderText').value);$('invReminderStatus').textContent='Testo copiato. Nessun messaggio è stato inviato.';}catch(e){$('invReminderStatus').textContent='Copia non riuscita: seleziona il testo e copialo manualmente.';}};
  $('invReminderDownload').onclick=()=>download('sollecito-fattura-'+(state.documents.find(d=>d.id===reminderId)?.number||'').replace('/','-')+'.txt',$('invReminderText').value,'text/plain;charset=utf-8');
  $('invReminderRecord').onclick=()=>{try{const next=structuredClone(state),doc=next.documents.find(d=>d.id===reminderId);if(!doc||doc.status!=='prepared'||!['TD01','TD24'].includes(doc.type)||doc.paid)throw Error('La fattura non risulta più da saldare.');const text=$('invReminderText').value.trim();if(!text)throw Error('Scrivi il testo del sollecito.');doc.reminders=[...(doc.reminders||[]),{date:today(),text}];save(next);renderArchive();$('invReminderRecord').disabled=true;$('invReminderStatus').textContent='Sollecito registrato il '+today().split('-').reverse().join('/')+'. Nessun messaggio è stato inviato.';}catch(e){$('invReminderStatus').textContent='Registrazione non riuscita: '+e.message;}};
  if(typeof pageIds!=='undefined' && !pageIds.includes('invoiceApp'))pageIds.push('invoiceApp');
  const localInfo=document.createElement('p');localInfo.id='sdiChannelBanner';localInfo.className='inv-help';localInfo.textContent='Canale SdI: verifica configurazione in corso. La numerazione non avvia l’invio.';page.prepend(localInfo);
  $('invEditor').lastElementChild.textContent='Conferma e numera conserva la versione definitiva e il relativo XML. PDF e XML si scaricano localmente. L’invio si conferma separatamente con “Invia allo SdI”. Il backup non è conservazione a norma.';
  $('invNumber').closest('label').firstChild.textContent='Numero documento';
  $('invXml').before(Object.assign(document.createElement('button'),{id:'invFinalize',className:'btn',textContent:'Conferma e numera'}));
  $('invPrint').textContent='Scarica PDF';
  $('invXml').textContent='Scarica XML';
  const lifecycle=document.createElement('div');lifecycle.className='inv-actions';lifecycle.innerHTML='<button id="invDuplicate" class="btn secondary">Duplica in bozza</button><button id="invCredit" class="btn secondary">Crea nota di credito</button><button id="invDelete" class="btn secondary">Elimina bozza</button>';$('invClose').parentElement.after(lifecycle);
  const sellerGrid=$('invSellerProvince').closest('.inv-grid');sellerGrid.insertAdjacentHTML('beforeend',field('invSellerCf','Codice fiscale officina')+'<label>Regime fiscale<select id="invSellerRegime"><option value="RF01">Ordinario (RF01)</option><option value="RF19">Forfettario (RF19)</option></select></label>'+field('invSellerIban','IBAN per i pagamenti'));
  const numbering=document.createElement('div');numbering.className='inv-actions';numbering.innerHTML='<label>Anno numerazione<input id="invNumberYear" type="number" min="2000" max="9999"></label><label>Primo numero disponibile<input id="invNumberStart" type="number" min="1" max="999999"></label><button id="invSaveNumbering" class="btn secondary">Salva numerazione</button><span id="invNumberHint" role="status"></span>';$('invSaveSeller').parentElement.after(numbering);
  numbering.after(Object.assign(document.createElement('p'),{className:'inv-help',textContent:'Serie annuale unica per fatture e note di credito: numero/anno. Se hai già fatture numerate in un altro programma, imposta il primo numero libero prima di confermare nuovi documenti.'}));
  $('invNumberYear').value=today().slice(0,4);
  function numberHint(){const y=$('invNumberYear').value;$('invNumberStart').value=nextSequence(state.documents,y,state.numbering?.[y]||1);$('invNumberHint').textContent='Prossimo documento: '+$('invNumberStart').value+'/'+y;}
  $('invNumberYear').onchange=()=>{try{numberHint();}catch(e){$('invNumberHint').textContent=e.message;}};
  $('invSaveNumbering').onclick=()=>{try{const y=$('invNumberYear').value,start=Number($('invNumberStart').value),nextNumber=nextSequence(state.documents,y,start);if(start!==nextNumber)throw Error('Il numero è già utilizzato. Primo disponibile: '+nextNumber);const next=structuredClone(state);next.numbering={...next.numbering,[y]:start};save(next);numberHint();$('invNumberHint').textContent+=' · Salvato';}catch(e){$('invNumberHint').textContent=e.message;}};numberHint();
  $('invNotes').maxLength=200;
  $('invPayment').parentElement.insertAdjacentHTML('afterend',field('invPaymentDue','Scadenza pagamento','date')+field('invIban','IBAN')+'<label>Bollo addebitato al cliente<select id="invStampDuty"><option value="0">Nessuno</option><option value="2">2,00 €</option></select></label>');
  const quotesBar=document.createElement('div');quotesBar.className='inv-actions';quotesBar.innerHTML='<label>Preventivo salvato<select id="invQuote"><option value="">Seleziona preventivo</option></select></label><button class="btn secondary" id="invImportQuote">Importa preventivo</button>';$('invWorkDate').closest('.inv-actions').after(quotesBar);
  $('invBackup').after(Object.assign(document.createElement('button'),{id:'invCsv',className:'btn secondary',textContent:'Esporta registro CSV'}));
  function readParty(prefix){return Object.fromEntries(['name','vat','address','zip','city','province'].map(k=>[k,$(prefix+k[0].toUpperCase()+k.slice(1)).value.trim()])).valueOf();}
  function fillParty(prefix,p){for(const k of ['name','vat','address','zip','city','province'])$(prefix+k[0].toUpperCase()+k.slice(1)).value=p[k]||'';}
  const paidLabel=document.createElement('label');paidLabel.style.alignSelf='start';paidLabel.style.alignContent='start';paidLabel.textContent='Stato pagamento (manuale)';const paidSelect=document.createElement('select');paidSelect.id='invPaid';paidSelect.add(new Option('Da saldare','unpaid'));paidSelect.add(new Option('Saldata','paid'));paidLabel.appendChild(paidSelect);$('invPayment').parentElement.after(paidLabel);
  const cashFields=document.createElement('div');cashFields.innerHTML='<label>Lavoro collegato nel libro contabile<select id="invCashLink"><option value="">Nessun lavoro collegato</option></select></label><label>Data saldo<input id="invPaidDate" type="date"></label><button type="button" class="btn secondary" id="invSavePayment">Salva pagamento</button><small>Il saldo azzera il fuori cassa del lavoro collegato e registra la cassa nella data scelta.</small>';paidLabel.after(cashFields);
  const normalizeCash=s=>String(s||'').toLocaleLowerCase('it-IT').replace(/[^a-z0-9]/g,'');
  function refreshCashLinks(){
    const selected=$('invCashLink').value||current?.cashLink||'';
    const entries=window.WorkshopLedgerCash?.snapshot().entries||[];
    $('invCashLink').replaceChildren(new Option('Nessun lavoro collegato',''));
    for(const e of entries)$('invCashLink').add(new Option(e.customer+' · '+e.vehicle+' · '+e.work+' · '+euro(e.amount),e.cashId));
    $('invCashLink').value=selected;
    if(current?.sourceWorkReportId){$('invCashLink').value='';return;}
    if(!selected&&current){const matches=entries.filter(e=>normalizeCash(e.customer)===normalizeCash(current.customer?.name)&&normalizeCash(e.vehicle).includes(normalizeCash(current.plate))&&Math.abs(e.amount-documentTotals(current).total)<.01);if(matches.length===1)$('invCashLink').value=matches[0].cashId;}
  }
  function paymentLabels(){const credit=$('invType').value==='TD04',report=!!current?.sourceWorkReportId;paidSelect.options[0].textContent=credit?'Da rimborsare / compensare':'Da saldare';paidSelect.options[1].textContent=credit?'Rimborsata / compensata':'Saldata';for(const id of ['invReference','invReferenceDate'])$(id).closest('label').hidden=!credit;$('invType').querySelector('option[value="TD24"]').hidden=!report;$('invTypeHelp').hidden=!report;cashFields.querySelector('small').textContent=report?'Fattura differita: la data deve restare nel mese degli interventi. Verifica la scadenza fiscale prima di numerare. Il pagamento resta nel registro fatture e non modifica gli incassi dei singoli lavori.':credit?'Registra qui il rimborso o la compensazione della nota. Il lavoro originario mantiene il proprio saldo.':'Il saldo azzera il fuori cassa del lavoro collegato e registra la cassa nella data scelta. Senza collegamento, il pagamento resta nel registro fatture.';if(credit||report)$('invCashLink').value='';$('invCashLink').disabled=credit||report;if(report)$('invType').disabled=true;for(const id of ['invImportWork','invImportQuote'])if($(id))$(id).disabled=report||current?.status==='prepared';}
  $('invType').onchange=paymentLabels;
  $('invCashLink').addEventListener('focus',refreshCashLinks);
  fillParty('invSeller',state.seller);$('invSellerCf').value=state.seller.cf||'';$('invSellerRegime').value=state.seller.regime||'RF01';$('invSellerIban').value=state.seller.iban||'';
  function show(){refreshCustomers();showPage('preventivi');renderArchive();}
  document.querySelector('[data-view="preventivi"]').addEventListener('click',show);
  let archiveYear=new Date().getFullYear(),archiveMonth='',archiveFilter='all',archiveQuery='';
  function renderArchive(){
    const box=$('invArchive');box.replaceChildren();
    const button=(text,action,active=false)=>{const b=document.createElement('button');b.type='button';b.className='btn '+(active?'':'secondary');b.textContent=text;b.onclick=action;return b;};
    const nav=document.createElement('div');nav.className='inv-actions';const year=document.createElement('strong');year.textContent='Archivio '+archiveYear;
    nav.append(button('← Anno precedente',()=>{archiveYear--;renderArchive();}),year,button('Anno successivo →',()=>{archiveYear++;renderArchive();}),button('Tutti i mesi',()=>{archiveMonth='';renderArchive();},archiveMonth===''));box.append(nav);
    const annual=state.documents.filter(d=>String(d.date).startsWith(archiveYear+'-'));
    const months=document.createElement('div');months.className='invoice-months';
    for(let m=1;m<=12;m++){const docs=annual.filter(d=>d.status==='prepared'&&Number(d.date.slice(5,7))===m),sum=docs.reduce((a,d)=>a+(d.type==='TD04'?-1:1)*documentTotals(d).total,0);const b=button('',()=>{archiveMonth=m;renderArchive();},archiveMonth===m);const title=document.createElement('b'),count=document.createElement('span'),value=document.createElement('strong');title.textContent=new Date(2026,m-1,1).toLocaleString('it',{month:'long'});count.textContent=docs.length+' documenti';value.textContent=euro(sum);b.append(title,count,value);months.append(b);}box.append(months);
    const period=annual.filter(d=>!archiveMonth||Number(d.date.slice(5,7))===archiveMonth);
    const definitive=period.filter(d=>d.status==='prepared'),sumDocs=docs=>docs.reduce((sum,d)=>sum+documentTotals(d).total,0);
    const standardInvoices=docs=>docs.filter(d=>['TD01','TD24'].includes(d.type));
    const summary=document.createElement('div');summary.className='inv-summary';const metrics=[['Da incassare',sumDocs(standardInvoices(definitive.filter(d=>!d.paid)))],['Incassato',sumDocs(standardInvoices(definitive.filter(d=>d.paid)))],['Scaduto',sumDocs(standardInvoices(definitive.filter(d=>!d.paid&&d.paymentDue&&d.paymentDue<today())))],['Note da rimborsare / compensare',sumDocs(definitive.filter(d=>d.type==='TD04'&&!d.paid))]];for(const [title,value]of metrics){const item=document.createElement('div'),label=document.createElement('span'),amount=document.createElement('strong');label.textContent=title;amount.textContent=euro(value);item.append(label,amount);summary.append(item);}box.append(summary);
    const filters={all:['Tutte',()=>true],unpaid:['Da saldare',d=>d.paid!==true],paid:['Saldate',d=>d.paid===true],draft:['Bozze',d=>d.status==='draft'],invoice:['Fatture',d=>['TD01','TD24'].includes(d.type)],credit:['Note di credito',d=>d.type==='TD04'],overdue:['Scadute',d=>d.status==='prepared'&&['TD01','TD24'].includes(d.type)&&!d.paid&&d.paymentDue&&d.paymentDue<today()]};
    const toolbar=document.createElement('div');toolbar.className='inv-actions';for(const [key,[label,test]]of Object.entries(filters))toolbar.append(button(label+' ('+period.filter(test).length+')',()=>{archiveFilter=key;renderArchive();},archiveFilter===key));
    const reportsMonth=archiveMonth||Number(today().slice(5,7)),reportsMonthKey=`${archiveYear}-${String(reportsMonth).padStart(2,'0')}`,periodReports=(state.workReports||[]).filter(report=>String(report.period?.start||report.date||'').slice(0,7)===reportsMonthKey),reportsButton=button('Rapporti di intervento ('+periodReports.length+')',()=>root.WorkshopWorkReports?.open({year:archiveYear,month:reportsMonth}));reportsButton.id='invWorkReports';reportsButton.title='Apri i rapporti salvati per '+new Date(archiveYear,reportsMonth-1,1).toLocaleString('it',{month:'long',year:'numeric'});toolbar.append(reportsButton);
    const search=document.createElement('input');search.type='search';search.placeholder='Filtra per cliente o targa';search.setAttribute('aria-label','Filtra fatture per cliente o targa');search.value=archiveQuery;search.oninput=()=>{archiveQuery=search.value;renderRows();};toolbar.append(search);box.append(toolbar);
    const scroll=document.createElement('div');scroll.className='inv-scroll';const table=document.createElement('table');table.className='invoice-archive-table';table.innerHTML='<thead><tr><th>Stato</th><th>Cliente / targa</th><th>Oggetto</th><th>Data, numero e scadenza</th><th>Imponibile</th><th>Totale IVA inclusa</th><th>Azioni</th></tr></thead>';const body=document.createElement('tbody');table.append(body);scroll.append(table);box.append(scroll);
    const note=document.createElement('p');note.className='inv-help';note.textContent='Totali mensili dei documenti definitivi, IVA e bollo inclusi; note di credito sottratte. Le bozze non concorrono ai totali. Gli esiti delle trasmissioni sono consultabili nel pannello Canale SdI.';box.append(note);
    function renderRows(){body.replaceChildren();const docs=period.filter(filters[archiveFilter][1]).filter(d=>(d.customer.name+' '+(d.plate||'')).toLocaleLowerCase('it').includes(archiveQuery.toLocaleLowerCase('it'))).sort((a,b)=>b.date.localeCompare(a.date));for(const d of docs){const tr=document.createElement('tr'),t=documentTotals(d);const values=[(d.status==='draft'?'Bozza':'Definitiva · '+(api.sdiLabel?.(d.id)||'Stato SdI da verificare'))+' · '+(d.type==='TD04'?(d.paid?'Rimborsata / compensata':'Da rimborsare / compensare'):(d.paid?'Saldata':'Da saldare'))+(d.reminders?.length?' · Solleciti: '+d.reminders.length:'') ,d.customer.name+(d.plate?' · '+d.plate:''),d.notes||d.lines.map(l=>l.description).filter(Boolean).join(' · '),d.date.split('-').reverse().join('/')+' · '+(d.number||'Bozza')+(d.type==='TD04'?' · Nota di credito':d.type==='TD24'?' · Fattura differita TD24':'')+(d.paymentDue?' · Scad. '+d.paymentDue.split('-').reverse().join('/'):''),euro(t.net),euro(t.total)];values.forEach((v,i)=>{const td=document.createElement('td');td.textContent=v;if(i===0){td.style.color=d.paid===true?'var(--ink)':'var(--ink)';td.style.fontWeight='700';}tr.append(td);});const action=document.createElement('td');action.append(button('Apri',()=>edit(d)));if(d.status==='prepared'&&['TD01','TD24'].includes(d.type)&&!d.paid)action.append(button('Sollecita',()=>openReminder(d)));tr.append(action);body.append(tr);}if(!docs.length){const row=body.insertRow(),cell=row.insertCell();cell.colSpan=7;cell.textContent='Nessun documento per i filtri selezionati.';}}
    renderRows();
  }

  function addLine(l={description:'',quantity:1,price:0,discount:0,vat:22}){const row=document.createElement('tr');row.innerHTML='<td><input data-key="description" aria-label="Descrizione"></td><td><input data-key="quantity" aria-label="Quantità" type="number" min="0.0001" step="0.0001"></td><td><input data-key="price" aria-label="Prezzo IVA inclusa" type="number" min="0" step="0.0001"></td><td><input data-key="discount" aria-label="Sconto" type="number" min="0" max="100" step="0.01"></td><td><select data-key="vat" aria-label="IVA"><option>22</option><option>10</option><option>5</option><option>4</option><option>0</option></select><select data-key="nature" aria-label="Natura IVA"><option value="">Natura IVA 0%</option>'+natureCodes.map(n=>'<option>'+n+'</option>').join('')+'</select><input data-key="taxReference" aria-label="Riferimento normativo" placeholder="Riferimento normativo" maxlength="100"></td><td><button type="button" class="link">×</button></td>';for(const input of row.querySelectorAll('[data-key]'))input.value=input.dataset.key==='price'?(l.grossPrice??round(Number(l.price)*(1+Number(l.vat)/100))):l[input.dataset.key]??'';const syncTax=()=>{const zero=row.querySelector('[data-key=vat]').value==='0';for(const k of ['nature','taxReference']){const el=row.querySelector('[data-key='+k+']');el.hidden=!zero;if(!zero)el.value='';}};syncTax();row.querySelector('[data-key=vat]').onchange=()=>{syncTax();updateTotal();};row.querySelector('button').onclick=()=>{row.remove();updateTotal();};row.oninput=updateTotal;$('invLines').appendChild(row);updateTotal();}
  function readDocBase(){return {...current,paymentDue:$('invPaymentDue').value,iban:$('invIban').value.trim().replace(/\s/g,'').toUpperCase(),stampDuty:Number($('invStampDuty').value),plate:$('invPlate').value.trim(),km:$('invKm').value,paid:$('invPaid').value==='paid',cashLink:$('invCashLink').value,paidDate:$('invPaid').value==='paid'?$('invPaidDate').value:'',type:$('invType').value,date:$('invDate').value,reference:$('invReference').value.trim(),referenceDate:$('invReferenceDate').value,payment:$('invPayment').value,notes:$('invNotes').value.trim(),customer:{...readParty('invCustomer'),cf:$('invCustomerCf').value.trim().toUpperCase(),code:$('invCustomerCode').value.trim().toUpperCase()||'0000000',pec:$('invCustomerPec').value.trim()},lines:[...$('invLines').rows].map(row=>Object.fromEntries([...row.querySelectorAll('[data-key]')].map(i=>[i.dataset.key,['description','nature','taxReference'].includes(i.dataset.key)?i.value.trim():Number(i.value)]))).map(l=>({...l,grossPrice:l.price,price:l.price/(1+l.vat/100)}))};}
  function readDoc(){const d=readDocBase();if(d.sourceWorkReportId||d.rounding!==undefined)d.rounding=invoiceRounding(d.lines);return d;}
  function updateTotal(){const t=documentTotals(readDoc());$('invTotal').textContent=`Imponibile ${euro(t.net)} + IVA ${euro(t.tax)}${t.rounding?' + Arrotondamento '+euro(t.rounding):''}${t.stampDuty?' + Bollo '+euro(t.stampDuty):''} = ${euro(t.total)}`;}
  $('invStampDuty').onchange=updateTotal;
  let workSources=[];
  const cellValue=cell=>cell?.querySelector('input,textarea')?.value??cell?.textContent?.trim()??'';
  function refreshWorks(){
    const works=$('invWorks'), previous=works.selectedOptions[0]?.textContent;
    workSources=[...document.querySelectorAll('#agendaRows tr')].filter(r=>r.cells.length>=6).map(r=>({cashId:r.dataset.cashAccountId,source:'Agenda',date:r.dataset.completedDate||r.dataset.date||'',km:r.dataset.km||'',name:cellValue(r.cells[1]),plate:cellValue(r.cells[2]),lines:r.dataset.acceptanceLines,description:cellValue(r.cells[3]),amount:cellValue(r.cells[4])}));
    for(const r of document.querySelectorAll('#agenda .parking-section .parking-row')){
      if(r.hidden||r.dataset.removed==='true')continue;
      const identity=r.children[0];
      workSources.push({cashId:r.dataset.cashAccountId,source:'Parcheggio',date:r.dataset.completedDate||r.dataset.exit||r.dataset.entry||'',km:r.dataset.km||'',name:identity?.querySelector('b')?.textContent?.trim()||'',plate:window.parkingDataFromRow?.(r)?.plate||'',lines:r.dataset.workLines,description:r.children[3]?.querySelector('b')?.textContent?.trim()||'',amount:r.querySelector('.parking-total strong')?.textContent||'0'});
    }
    works.replaceChildren(new Option('Seleziona intervento (agenda o parcheggio)',''));
    workSources=workSources.filter(w=>!$('invWorkDate').value||w.date===$('invWorkDate').value).sort((a,b)=>b.date.localeCompare(a.date));
    workSources.forEach((w,i)=>{let lines=[];try{lines=JSON.parse(w.lines||'[]');}catch(_){}const description=Array.isArray(lines)?lines.map(l=>l.description||'').filter(Boolean).join(' · '):'';works.add(new Option((w.date?w.date.split('-').reverse().join('/'):'Senza data')+' · '+w.source+' · '+w.name+' · '+w.plate+' · '+(description||w.description),String(i)));});
    works.value=[...works.options].find(o=>o.textContent===previous)?.value||'';
  }
  $('invWorks').addEventListener('focus',refreshWorks);
  $('invWorkDate').addEventListener('change',refreshWorks);
  function edit(d){current=structuredClone(d);$('invWorkDate').value=d.date||today();$('invEditor').hidden=false;$('invErrors').textContent='';$('invHeading').textContent=d.number||'Nuova bozza';for(const [id,k] of [['invType','type'],['invDate','date'],['invNumber','number'],['invReference','reference'],['invReferenceDate','referenceDate'],['invPayment','payment'],['invNotes','notes'],['invPlate','plate'],['invKm','km'],['invPaymentDue','paymentDue'],['invIban','iban'],['invStampDuty','stampDuty']])$(id).value=d[k]??(id==='invStampDuty'?'0':'');fillParty('invCustomer',d.customer);for(const k of ['cf','code','pec'])$('invCustomer'+k[0].toUpperCase()+k.slice(1)).value=d.customer[k]|| (k==='code'?'0000000':'');$('invLines').replaceChildren();d.lines.forEach(addLine);updateTotal();const locked=d.status==='prepared';$('invEditor').querySelectorAll('input,select,button').forEach(e=>e.disabled=locked);for(const id of ['invPrint','invXml','invClose','invDuplicate','invCredit'])$(id).disabled=false;$('invNumber').readOnly=true;$('invXml').textContent='Scarica XML archiviato';$('invXml').hidden=!locked;$('invFinalize').hidden=locked;$('invSave').hidden=locked;$('invCredit').hidden=!locked||d.type!=='TD01';$('invDelete').hidden=locked;$('invHeading').textContent=locked?typeLabel(d.type)+' '+d.number+' · '+(api.sdiLabel?.(d.id)||'Stato SdI da verificare'):'Bozza';refreshCustomers();$('invPaid').value=d.paid===true?'paid':'unpaid';$('invCashLink').value=d.cashLink||'';$('invPaidDate').value=d.paidDate||today();$('invPaidDate').max=today();refreshCashLinks();for(const id of ['invPaid','invCashLink','invPaidDate','invSavePayment'])$(id).disabled=false;refreshWorks();refreshQuotes();paymentLabels();window.dispatchEvent(new Event('workshop-invoice-edit'));$('invEditor').scrollIntoView({block:'start',behavior:'smooth'});}
  function newDoc(){show();edit({id:crypto.randomUUID(),status:'draft',type:'TD01',date:today(),number:'',payment:'MP05',iban:state.seller.iban||'',stampDuty:0,paymentDue:today(),customer:{},lines:[{description:'',quantity:1,price:0,discount:0,vat:state.seller.regime==='RF19'?0:22,nature:state.seller.regime==='RF19'?'N2.2':'',taxReference:state.seller.regime==='RF19'?'Regime forfettario art. 1 commi 54-89 L. 190/2014':''}],notes:''});}
  $('invNew').onclick=newDoc;$('invAddLine').onclick=()=>addLine();$('invClose').onclick=()=>{$('invEditor').hidden=true;};
  let customerChoices=[];
  const customerSearchLabel=document.createElement('label');
  customerSearchLabel.textContent='Cerca cliente, veicolo o targa';
  customerSearchLabel.style.cssText='display:grid;gap:6px;margin:12px 0;max-width:480px';
  const customerSearch=document.createElement('input');
  customerSearch.id='invCustomerSearch';customerSearch.type='search';
  customerSearch.placeholder='Es. Carlo, Fiesta o AB123AC';
  customerSearch.style.cssText='padding:10px;border:1px solid var(--line);border-radius:7px';
  customerSearchLabel.appendChild(customerSearch);
  $('invCustomers').parentElement.before(customerSearchLabel);
  $('invCustomers').parentElement.hidden=true;
  customerSearchLabel.style.position='relative';
  customerSearch.autocomplete='off';
  const customerResults=document.createElement('div');
  customerResults.id='invCustomerResults';customerResults.hidden=true;
  customerResults.style.cssText='position:absolute;top:100%;left:0;right:0;z-index:20;background:white;border:1px solid #cbd5d1;border-radius:8px;max-height:240px;overflow:auto;box-shadow:0 8px 20px #0002';
  customerSearchLabel.after(customerResults);
  // Keep the popup in a positioned wrapper, outside the input label.
  const customerPicker=document.createElement('div');customerPicker.style.cssText='position:relative;max-width:480px';
  customerSearchLabel.before(customerPicker);customerPicker.append(customerSearchLabel,customerResults);
  customerSearch.setAttribute('aria-controls',customerResults.id);
  customerSearch.setAttribute('aria-expanded','false');
  function closeCustomerResults(){customerResults.hidden=true;customerSearch.setAttribute('aria-expanded','false');}
  customerSearch.addEventListener('focus',refreshCustomers);
  customerSearch.addEventListener('keydown',e=>{if(e.key==='Escape')closeCustomerResults();if(e.key==='ArrowDown'){e.preventDefault();customerResults.querySelector('button')?.focus();}});
  customerPicker.addEventListener('focusout',()=>setTimeout(()=>{if(!customerPicker.contains(document.activeElement))closeCustomerResults();},0));
  customerResults.addEventListener('keydown',e=>{if(e.key==='Escape'){customerSearch.focus();closeCustomerResults();}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const buttons=[...customerResults.querySelectorAll('button')],i=buttons.indexOf(document.activeElement);buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}});
  const normalizeSearch=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('it').replace(/[^a-z0-9]/g,'');
  customerSearch.addEventListener('input',refreshCustomers);
  function refreshCustomers(){
    const sel=$('invCustomers'), previous=sel.value;
    customerChoices=[...document.querySelectorAll('#customerRows tr')].filter(r=>r.cells.length>=5).map(r=>({name:r.cells[0].textContent.trim(),plate:r.cells[4].textContent.trim(),vehicle:r.cells[3].textContent.trim()}));
    const query=normalizeSearch(customerSearch.value);
    const matches=customerChoices.filter(c=>normalizeSearch(c.name+' '+c.vehicle+' '+c.plate).includes(query));
    sel.replaceChildren(new Option(matches.length?'Seleziona cliente / veicolo':'Nessun cliente o veicolo trovato',''));
    matches.forEach(c=>sel.add(new Option(c.name+' · '+c.vehicle+' · '+c.plate,JSON.stringify([c.name,c.plate]))));
    sel.value=previous;
    customerResults.replaceChildren();
    for(const c of matches){const choice=document.createElement('button');choice.type='button';choice.textContent=c.name+' · '+c.vehicle+' · '+c.plate;choice.style.cssText='display:block;width:100%;padding:12px;text-align:left;background:white;color:#153d32;border:0;border-bottom:1px solid #e5ece8;cursor:pointer';choice.onclick=()=>{sel.value=JSON.stringify([c.name,c.plate]);sel.dispatchEvent(new Event('change'));customerSearch.value=choice.textContent;customerSearch.focus();closeCustomerResults();};customerResults.append(choice);}
    if(!matches.length){const empty=document.createElement('p');empty.textContent='Nessun cliente o veicolo trovato';empty.style.padding='12px';customerResults.append(empty);}
    const opened=document.activeElement===customerSearch;customerResults.hidden=!opened;customerSearch.setAttribute('aria-expanded',String(opened));
  }
  $('invCustomers').addEventListener('focus',refreshCustomers);
  new MutationObserver(refreshCustomers).observe($('customerRows'),{childList:true,subtree:true,characterData:true});
  $('invCustomers').onchange=()=>{const c=customerChoices.find(c=>JSON.stringify([c.name,c.plate])===$('invCustomers').value);if(!c)return;$('invPlate').value=c.plate;$('invKm').value='';const p=window.WorkshopCustomerFiscal?.get(c.name)||{};fillParty('invCustomer',{...p,name:p.name||c.name});$('invCustomerCf').value=p.cf||'';$('invCustomerCode').value=p.code||'0000000';$('invCustomerPec').value=p.pec||'';};

  $('invImportWork').onclick=()=>{const w=workSources[Number($('invWorks').value)];if($('invWorks').value===''||!w)return;$('invPlate').value=w.plate;$('invKm').value=w.km;const cp=window.WorkshopCustomerFiscal?.get(w.name)||{};fillParty('invCustomer',{...cp,name:cp.name||w.name});for(const k of ['cf','code','pec'])$('invCustomer'+k[0].toUpperCase()+k.slice(1)).value=cp[k]||(k==='code'?'0000000':'');if(w.cashId){current.cashLink=w.cashId;refreshCashLinks();$('invCashLink').value=w.cashId;}let lines=[];try{lines=JSON.parse(w.lines||'[]');}catch(e){}if(!Array.isArray(lines))lines=[];if(!lines.length)lines=[{description:w.description,amount:typeof parseAmount==='function'?parseAmount(w.amount):0}];const blank=$('invLines').rows[0];if($('invLines').rows.length===1&&!blank.querySelector('input').value)blank.remove();for(const l of lines)addLine({description:l.description||w.description,quantity:1,grossPrice:Number(l.amount||0),price:Number(l.amount||0)/1.22,discount:0,vat:22});};
  function persistDocument(doc){
    const next=structuredClone(state),previous=state.documents.find(d=>d.id===doc.id);
    if(previous?.reminders)doc.reminders=previous.reminders;
    if(doc.paid&&(!validDate(doc.paidDate)||doc.paidDate>today()))throw Error('Indica una data saldo valida, non futura.');
    if(previous?.paid&&previous.cashLink&&previous.type!==doc.type)throw Error('Imposta prima Da saldare e salva il pagamento prima di cambiare tipo documento.');
    if(previous?.status==='prepared'){
      const fiscal=d=>Object.fromEntries(Object.entries(d).filter(([key])=>!['paid','paidDate','cashLink'].includes(key)));
      if(JSON.stringify(canonical(fiscal(previous)))!==JSON.stringify(canonical(fiscal(doc))))throw Error('Il documento definitivo è bloccato. Crea una nota di credito per rettificarlo.');
    }
    if(doc.sourceQuoteId&&doc.type==='TD01'&&next.documents.some(d=>d.id!==doc.id&&d.type==='TD01'&&d.sourceQuoteId===doc.sourceQuoteId))throw Error('Esiste già una fattura per questo preventivo.');
    if(previous?.paid && previous.cashLink && doc.cashLink!==previous.cashLink)throw Error('Prima imposta la fattura Da saldare per modificare il collegamento.');
    const i=next.documents.findIndex(d=>d.id===doc.id);if(i>=0)next.documents[i]=doc;else next.documents.push(doc);
    validateWorkReportLinks(next);
    if(doc.cashLink && doc.type==='TD01'){
      if(next.documents.some(d=>d.id!==doc.id&&d.type==='TD01'&&d.cashLink===doc.cashLink))throw Error('Questo lavoro è già collegato a un’altra fattura. Apri quella esistente o rimuovi il collegamento.');
      const entry=window.WorkshopLedgerCash.snapshot().entries.find(e=>e.cashId===doc.cashLink);
      if(!entry)throw Error('Il lavoro collegato non è completato o non è disponibile.');
      if(normalizeCash(entry.customer)!==normalizeCash(doc.customer.name))throw Error('Il cliente della fattura non corrisponde al lavoro collegato.');
      if(doc.paid && Math.abs(documentTotals(doc).total-entry.amount)>.01)throw Error('Il totale della fattura deve corrispondere all’importo del lavoro collegato.');
      window.WorkshopLedgerCash.invoicePayment(doc.cashLink,doc.id,doc.paid,doc.paidDate||today(),()=>save(next));
    }else save(next);
    current=structuredClone(doc);renderArchive();
    document.dispatchEvent(new Event('workshop-invoices-updated'));
  }
  function safe(fn){return async()=>{try{await fn();$('invErrors').textContent='';}catch(e){$('invErrors').textContent=e.message;}};}
  const withInvoiceLock=fn=>navigator.locks?navigator.locks.request('officina-invoices',fn):Promise.resolve().then(fn);
  $('invSaveSeller').onclick=()=>{try{const next=structuredClone(state);next.seller=readParty('invSeller');next.seller.province=next.seller.province.toUpperCase();next.seller.cf=$('invSellerCf').value.trim().toUpperCase();next.seller.regime=$('invSellerRegime').value;next.seller.iban=$('invSellerIban').value.replace(/\s/g,'').toUpperCase();next.seller.logo=$('shopLogoPreview')?.querySelector('img')?.src||'';save(next);alert('Dati officina salvati.');}catch(e){alert('Salvataggio non riuscito: '+e.message);}};
  $('invSavePayment').onclick=safe(()=>{const doc=current.status==='prepared'?{...current,paid:$('invPaid').value==='paid',cashLink:$('invCashLink').value,paidDate:$('invPaid').value==='paid'?$('invPaidDate').value:''}:readDoc();persistDocument(doc);$('invHeading').textContent=doc.status==='prepared'?typeLabel(doc.type)+' '+doc.number+' · '+(api.sdiLabel?.(doc.id)||'Stato SdI da verificare')+' · Pagamento salvato':'Bozza · Pagamento salvato';});
  $('invSave').onclick=safe(()=>{persistDocument(readDoc());$('invHeading').textContent='Bozza salvata';});
  $('invFinalize').onclick=safe(()=>withInvoiceLock(async()=>{if(localStorage.getItem(key)!==savedRevision)throw Error('Archivio modificato in un’altra scheda: ricarica prima di numerare.');const d=readDoc();d.customer.province=d.customer.province.toUpperCase();const prepared=prepare(d,state);if(!confirm('Confermare '+typeLabel(d.type).toLowerCase()+' '+prepared.number+' per '+euro(documentTotals(prepared).total)+'? Il documento sarà bloccato alle modifiche. Nessun invio al SdI. Verifica i termini di emissione per la fattura differita.'))return;persistDocument(prepared);if(window.WorkshopCloud)await window.WorkshopCloud.flush();edit(prepared);numberHint();}));
  $('invXml').onclick=safe(async()=>{if(window.WorkshopCloud)await window.WorkshopCloud.flush();if(current.status!=='prepared')throw Error('Conferma e numera prima di scaricare XML.');download(current.filename,current.xml,'application/xml');});
  $('invPrint').onclick=async()=>{try{if(window.WorkshopCloud)await window.WorkshopCloud.flush();const d=current.status==='prepared'?current:readDoc();if(!d.lines.length||d.lines.some(l=>!l.description||!Number.isFinite(l.price)||!Number.isFinite(l.quantity)))throw Error('Compila le righe del documento prima di creare il PDF.');const seller=d.seller||{...state.seller,logo:$('shopLogoPreview')?.querySelector('img')?.src||state.seller.logo||''};const bytes=await window.WorkshopInvoicePDF.create(d,seller);download((d.type==='TD04'?'Nota-credito-':d.type==='TD24'?'Fattura-differita-':'Fattura-')+(d.number||'bozza').replace(/[^a-z0-9-]/gi,'-')+'.pdf',bytes,'application/pdf');$('invErrors').textContent='';}catch(e){$('invErrors').textContent=e.message;}};
  $('invDuplicate').onclick=safe(()=>{const d=structuredClone(current.status==='prepared'?current:readDoc());for(const key of ['number','sequence','progressive','xml','filename','seller','preparedAt','cashLink','paidDate','sourceQuoteId','sourceWorkReportId','sourceWorkIds','deferredServiceMonth','sourceWorkReportNumber','sourceWorkReportDate'])delete d[key];if(d.type==='TD24')d.type='TD01';d.id=crypto.randomUUID();d.date=today();d.paymentDue=today();d.status='draft';d.paid=false;edit(d);});
  $('invCredit').onclick=safe(()=>{if(current.status!=='prepared'||current.type!=='TD01')throw Error('Apri una fattura definitiva.');const source=structuredClone(current);$('invDuplicate').click();current.type='TD04';current.reference=source.number;current.referenceDate=source.date;current.sourceInvoiceId=source.id;edit(current);});
  $('invDelete').onclick=safe(()=>{if(current.status!=='draft')throw Error('Puoi eliminare solo bozze.');if(current.paid&&current.cashLink)throw Error('Rimuovi prima il saldo collegato impostando Da saldare e salvando il pagamento.');if(!confirm('Eliminare questa bozza?'))return;const next=structuredClone(state);next.documents=next.documents.filter(d=>d.id!==current.id);save(next);$('invEditor').hidden=true;current=null;renderArchive();});
  let quoteChoices=[];
  function refreshQuotes(){try{quoteChoices=JSON.parse(localStorage.getItem('officina-quotes-v1')||'[]');if(!Array.isArray(quoteChoices))quoteChoices=[];}catch{quoteChoices=[];}$('invQuote').replaceChildren(new Option('Seleziona preventivo',''));for(const q of quoteChoices)$('invQuote').add(new Option(q.date+' · '+q.customer+' · '+q.vehicle,q.id));}
  $('invImportQuote').onclick=safe(()=>{const q=quoteChoices.find(q=>q.id===$('invQuote').value);if(!q)throw Error('Scegli un preventivo.');if(state.documents.some(d=>d.sourceQuoteId===q.id&&d.type==='TD01'))throw Error('Preventivo già importato: apri la fattura presente nell’archivio.');const cp=window.WorkshopCustomerFiscal?.get(q.customer)||{};fillParty('invCustomer',{...cp,name:cp.name||q.customer});for(const k of ['cf','code','pec'])$('invCustomer'+k[0].toUpperCase()+k.slice(1)).value=cp[k]||(k==='code'?'0000000':'');$('invPlate').value=q.vehicle||'';$('invNotes').value=q.notes||'';$('invLines').replaceChildren();for(const l of q.lines)addLine({...l,grossPrice:l.price,price:l.price/(1+(q.vat??22)/100),discount:0,vat:q.vat??22});current.sourceQuoteId=q.id;updateTotal();});
  $('invCsv').onclick=safe(async()=>{if(window.WorkshopCloud)await window.WorkshopCloud.flush();const quote=v=>'"'+String(v??'').replace(/"/g,'""').replace(/^[=+@-]/,"'")+'"';const rows=[['Numero','Data','Tipo','Cliente','Targa','Imponibile','IVA','Bollo','Totale','Pagamento','Scadenza','Data saldo','Trasmissione'],...state.documents.filter(d=>d.status==='prepared').map(d=>{const t=documentTotals(d),sign=d.type==='TD04'?-1:1;return[d.number,d.date,d.type,d.customer.name,d.plate,money(sign*t.net),money(sign*t.tax),money(sign*t.stampDuty),money(sign*t.total),d.paid?'Saldata':'Da saldare',d.paymentDue,d.paid?d.paidDate:'',api.sdiLabel?.(d.id)||'Da verificare sul server'];})];download('registro-fatture-'+today()+'.csv','\uFEFF'+rows.map(r=>r.map(quote).join(';')).join('\r\n'),'text/csv;charset=utf-8');});
  $('invBackup').onclick=safe(async()=>{if(window.WorkshopCloud)await window.WorkshopCloud.flush();download('backup-fatture-'+today()+'.json',JSON.stringify(state,null,2),'application/json');});
  $('invRestore').onchange=async()=>{try{const f=$('invRestore').files[0];if(!f)return;if(f.size>20000000)throw Error('Backup troppo grande (massimo 20 MB).');const incoming=JSON.parse(await f.text());const next=mergeBackup(state,incoming);for(const d of incoming.documents.filter(d=>d.status==='prepared')){const parsed=new DOMParser().parseFromString(d.xml,'application/xml');if(parsed.querySelector('parsererror')||parsed.documentElement.localName!=='FatturaElettronica')throw Error('XML non valido nel backup: '+d.number);}save(next);fillParty('invSeller',state.seller);$('invSellerCf').value=state.seller.cf||'';$('invSellerRegime').value=state.seller.regime||'RF01';$('invSellerIban').value=state.seller.iban||'';numberHint();renderArchive();alert('Backup importato.');}catch(e){alert('Importazione non riuscita: '+e.message);}finally{$('invRestore').value='';}};

  api.currentDocument=()=>current?structuredClone(current):null;
  api.documents=()=>structuredClone(state.documents);
  api.seller=()=>structuredClone(state.seller);
  api.workReports=()=>structuredClone(state.workReports||[]);
  api.saveWorkReport=report=>{
    if(root.WorkshopCloud&&root.WorkshopCloud.boot?.features?.workReports!==1)throw Error('Riavvia il servizio con il pacchetto aggiornato e ricarica la pagina per creare rapporti e fatture.');
    if(root.WorkshopCloud?.boot?.user?.role==='viewer'||(root.WorkshopCloud&&!root.parent.WorkshopCloudHost?.canWrite?.()))throw Error('Non puoi modificare i rapporti.');
    validateWorkReport(report);
    const next=structuredClone(state);next.workReports=next.workReports||[];const prior=next.workReports.find(item=>item.id===report.id);
    if(prior){if(JSON.stringify(canonical(prior))!==JSON.stringify(canonical(report)))throw Error('Il rapporto salvato non può essere sostituito.');return structuredClone(prior);}
    next.workReports.push(structuredClone(report));save(next);renderArchive();document.dispatchEvent(new Event('workshop-invoices-updated'));return structuredClone(report);
  };
  api.openDocument=id=>{const doc=state.documents.find(item=>item.id===id);if(!doc)throw Error('Fattura non trovata.');edit(doc);return structuredClone(doc);};
  api.deleteWorkReport=async id=>{
    if(root.WorkshopCloud&&root.WorkshopCloud.boot?.features?.workReports!==1)throw Error('Riavvia il servizio con il pacchetto aggiornato e ricarica la pagina per modificare i rapporti.');
    if(root.WorkshopCloud?.boot?.user?.role==='viewer'||(root.WorkshopCloud&&!root.parent.WorkshopCloudHost?.canWrite?.()))throw Error('Non puoi eliminare i rapporti.');
    if(state.documents.some(doc=>doc.sourceWorkReportId===id))throw Error('Il rapporto è collegato a una fattura e non può essere eliminato.');
    const next=structuredClone(state);next.workReports=(next.workReports||[]).filter(report=>report.id!==id);save(next);if(root.WorkshopCloud)await root.WorkshopCloud.flush();renderArchive();document.dispatchEvent(new Event('workshop-invoices-updated'));
  };
  api.invoiceFromWorkReport=async id=>{
    const existing=state.documents.find(doc=>['TD01','TD24'].includes(doc.type)&&doc.sourceWorkReportId===id);if(existing){if(root.WorkshopCloud)await root.WorkshopCloud.flush();return structuredClone(existing);}
    if(root.WorkshopCloud&&root.WorkshopCloud.boot?.features?.workReports!==1)throw Error('Riavvia il servizio con il pacchetto aggiornato e ricarica la pagina per creare rapporti e fatture.');
    if(root.WorkshopCloud?.boot?.user?.role==='viewer'||(root.WorkshopCloud&&!root.parent.WorkshopCloudHost?.canWrite?.()))throw Error('Non puoi creare fatture.');
    const report=(state.workReports||[]).find(item=>item.id===id);validateWorkReport(report);
    const works=root.WorkshopWorkReports.fromEntries(root.WorkshopLedgerCash?.snapshot().entries||[]);
    for(const work of report.works){const now=works.find(item=>item.id===work.id);if(!now||now.date!==work.date||normalizeCash(now.customer)!==normalizeCash(report.customer)||now.amount!==work.amount||JSON.stringify(now.lines)!==JSON.stringify(work.lines))throw Error('Un intervento del rapporto è cambiato o non è più completato. Crea un nuovo rapporto con i dati aggiornati.');}
    const months=new Set(report.works.map(work=>work.date.slice(0,7)));if(months.size!==1)throw Error('Per generare una TD24, crea un rapporto con interventi dello stesso mese.');
    const fiscal=root.WorkshopCustomerFiscal?.get(report.customer)||{},lines=root.WorkshopWorkReports.reportLines(report),deferredServiceMonth=[...months][0],serviceDates=report.works.map(work=>work.date).sort(),serviceDate=serviceDates.at(-1),reference=root.WorkshopWorkReports.reportNumber(report);
    const draft={id:crypto.randomUUID(),status:'draft',type:'TD24',deferredServiceMonth,sourceWorkReportNumber:reference,sourceWorkReportDate:report.date,date:serviceDate,number:'',payment:'MP05',iban:state.seller.iban||'',stampDuty:0,paymentDue:today(),customer:{...fiscal,name:fiscal.name||report.customer,code:fiscal.code||'0000000'},lines,notes:`Rif. rapporto ${reference} del ${report.date}; interventi ${serviceDates[0].split('-').reverse().join('/')}–${serviceDates.at(-1).split('-').reverse().join('/')}.`,plate:'',km:'',paid:false,cashLink:'',paidDate:'',sourceWorkReportId:report.id,sourceWorkIds:report.works.map(work=>work.id),rounding:invoiceRounding(lines)};
    persistDocument(draft);if(root.WorkshopCloud)await root.WorkshopCloud.flush();return structuredClone(draft);
  };
  api.refreshSdi=()=>{renderArchive();if(current?.status==='prepared')$('invHeading').textContent=typeLabel(current.type)+' '+current.number+' · '+(api.sdiLabel?.(current.id)||'Stato SdI da verificare');};
  renderArchive();
})(typeof window==='undefined'?globalThis:window);
