/* Plain, bounded business descriptions shared by the conflict UI and audit.
 * Serialized DOM is data: never parse it as HTML or report visual attributes. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkshopConflictDetails=api;})(globalThis,function(){
 'use strict';
 const text=v=>String(v??'').replace(/\s+/g,' ').trim().slice(0,1000);
 const parse=(v,fallback=null)=>{try{return typeof v==='string'?JSON.parse(v):v??fallback;}catch{return fallback;}};
 const children=n=>Array.isArray(n?.c)?n.c:[];
 const attr=(n,key)=>n?.a?.[key];
 const hasClass=(n,c)=>String(attr(n,'class')||'').split(/\s+/).includes(c);
 function find(n,test){if(!n||typeof n!=='object')return null;if(test(n))return n;for(const c of children(n)){const found=find(c,test);if(found)return found;}return null;}
 function nodeText(n){
  if(typeof n==='string'||typeof n==='number')return String(n);if(!n)return '';
  if(n.t==='input')return attr(n,'type')==='checkbox'?(Object.hasOwn(n.a||{},'checked')?'Sì':'No'):attr(n,'value')||'';
  if(n.t==='select'){const opts=children(n).filter(c=>c?.t==='option'),selected=opts.find(c=>Object.hasOwn(c.a||{},'selected'))||opts[0];return selected?(attr(selected,'value')??nodeText(selected)):'';}
  if(n.t==='button')return '';return children(n).map(nodeText).join(' ');
 }
 const txt=n=>text(nodeText(n)),cls=(n,c)=>find(n,x=>hasClass(x,c));
 const cells=n=>children(n).filter(c=>c?.t==='td'||c?.t==='th');
 const euro=v=>Number.isFinite(Number(v))?Number(v).toLocaleString('it-IT',{style:'currency',currency:'EUR'}):text(v);
 const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')?v.split('-').reverse().join('/'):text(v);
 const lines=v=>Array.isArray(v)?text(v.slice(0,20).map(l=>typeof l==='string'?l:[l.description||l.work||'',l.quantity!=null?'× '+l.quantity:'',l.grossPrice!=null?euro(l.grossPrice):l.price!=null?euro(l.price):l.amount!=null?euro(l.amount):'',l.vat!=null?'IVA '+l.vat+'%':'',l.discount?'sconto '+l.discount+'%':'',l.done===true?'Eseguita':''].filter(Boolean).join(' ')).join('; ')+(v.length>20?' … ('+v.length+' lavorazioni)':'')):text(v);
 const publicKey=k=>!/password|passwd|token|secret|csrf|authorization|cookie|credential|private.?key/i.test(k);
 const fieldNames={shopName:'Ragione sociale',shopPhone:'Telefono',shopAddress:'Sede legale',shopOperatingAddress:'Sede operativa',shopVat:'Partita IVA',shopEmail:'Email',shopHours:'Orario di apertura',shopReminder:'Promemoria revisione'};
 const names={customer:'Cliente',name:'Nome',phone:'Telefono',email:'Email',vehicle:'Veicolo',plate:'Targa',date:'Data',time:'Ora',status:'Stato',notes:'Note',work:'Lavorazioni',description:'Descrizione',category:'Categoria',quantity:'Quantità',price:'Prezzo',location:'Posizione',unit:'Unità',minimum:'Scorta minima',vat:'IVA',validUntil:'Valido fino al',revisionCategory:'Categoria revisione',revisionInterval:'Intervallo revisione',address:'Indirizzo',taxCode:'Codice fiscale',vatNumber:'Partita IVA',pec:'PEC',recipientCode:'Codice destinatario',city:'Comune',zip:'CAP',province:'Provincia',type:'Tipo',done:'Completato',title:'Titolo',text:'Testo'};
 function describe(encoded,value){
  const parts=parse(encoded,[]),[kind,name]=Array.isArray(parts)?parts:[];
  let title=encoded==='domain:inventory'?'Magazzino collegato all’intervento':kind==='field'?(fieldNames[name]||'Impostazione officina'):({'#stockRows':'Articolo di magazzino','#customerRows':'Cliente','#agendaRows':'Appuntamento','#agenda .parking-section .card':'Veicolo in parcheggio','#richiami .agenda-list':'Richiamo'}[name]||'Dato condiviso');
  const fields=[],add=(key,label,v)=>{if(v!==undefined&&v!==null&&publicKey(key))fields.push({key,label,value:text(v)||'—'});};
  if(value===undefined||value===null)return {title,fields:[{key:'record',label:'Voce',value:value===null?'Eliminata':'Non presente'}]};
  if(kind==='field'){add('value',fieldNames[name]||'Valore',value);return {title,fields};}
  if(kind==='row'){
   const a=value.a||{},c=cells(value);
   if(name==='#stockRows'){
    title='Articolo di magazzino · '+txt(c[0]);
    add('name','Prodotto',txt(c[0]));add('category','Categoria',txt(c[1]));
    add('quantity','Quantità',(a['data-quantity']??txt(cls(c[2],'qty-adjust')&&find(cls(c[2],'qty-adjust'),n=>n.t==='b')))||txt(c[2]));
    add('unit','Unità',a['data-unit']);add('price','Prezzo',txt(c[3]));add('location','Posizione',a['data-location']??txt(c[4]));
    add('minimum','Scorta minima',a['data-minimum']??a['data-min']);
   }else if(name==='#customerRows'){
    title='Cliente · '+txt(c[0]);['name','phone','email','vehicle','plate'].forEach((k,i)=>add(k,names[k],txt(c[i])));
    add('lastWork','Ultimo intervento',txt(c[5]));
    add('revisionCategory','Categoria revisione',a['data-revision-category']);
   }else if(name==='#agendaRows'){
    title='Appuntamento · '+txt(c[1])+' · '+text(a['data-plate']||txt(c[2]));
    add('date','Data',date(a['data-date']));add('time','Ora',txt(c[0]));add('customer','Cliente',txt(c[1]));add('vehicle','Veicolo / targa',text(a['data-plate']||txt(c[2])));
    add('km','Chilometri',a['data-km']);add('work','Lavorazioni',a['data-acceptance-lines']?lines(parse(a['data-acceptance-lines'],[])):txt(c[3]));add('amount','Importo',txt(c[4]));
    add('status','Stato',txt(cls(value,'status-select')));add('cashDestination','Destinazione cassa',a['data-cash-destination']==='outside'?'Fuori cassa':a['data-cash-destination']==='inCash'?'In cassa':undefined);add('notes','Note',a['data-work-notes']);add('phone','Telefono',a['data-phone']);add('email','Email',a['data-email']);
   }else if(name==='#agenda .parking-section .card'){
    const first=children(value).find(n=>n?.t==='div'),customer=txt(find(first,n=>n.t==='b')),vehicle=txt(find(first,n=>n.t==='small'));
    title='Veicolo in parcheggio · '+customer+' · '+text(a['data-plate']||vehicle);
    add('customer','Cliente',customer);add('vehicle','Veicolo / targa',a['data-plate']||vehicle);add('entry','Ingresso',date(a['data-entry']));add('exit','Completato il',date(a['data-completed-date']||a['data-exit']));add('km','Chilometri',a['data-km']);
    add('work','Lavorazioni',a['data-work-lines']?lines(parse(a['data-work-lines'],[])):txt(children(value)[3]));
    add('amount','Importo',txt(find(cls(value,'parking-total'),n=>n.t==='strong')));add('status','Stato',txt(cls(value,'parking-status')));add('cashDestination','Destinazione cassa',a['data-cash-destination']==='outside'?'Fuori cassa':a['data-cash-destination']==='inCash'?'In cassa':undefined);add('notes','Note',a['data-work-notes']);add('phone','Telefono',a['data-phone']);add('email','Email',a['data-email']);
   }else {add('content','Contenuto',txt(value));}
  }else if(kind==='cash'){
   const meta=value.meta||{};title=(name==='payments'?'Incasso':'Conto cassa')+' · '+text(meta.customer||'')+(meta.vehicle?' · '+text(meta.vehicle):'');
   add('customer','Cliente',meta.customer);add('vehicle','Veicolo',meta.vehicle);add('date','Data',date(value.date||meta.date));add('work','Lavorazioni',meta.lines?lines(meta.lines):meta.work);
   if(name==='payments'){add('amount','Importo',euro(value.cents/100));add('kind','Tipo',value.kind==='deposit'?'Acconto':value.kind||'Saldo');}
   else{add('amount','Importo',euro(meta.amount));add('status','Stato',value.status);add('inCash','In cassa',euro(value.state?.inCash));add('outside','Fuori cassa',euro(value.state?.outside));add('profit','Utile',value.state?.profit==null?undefined:euro(value.state.profit));}
  }else if(kind==='item'){
   title=(name==='officina-quotes-v1'?'Preventivo':name==='officina-moduli-v1'?'Modulo':'Post-it')+' · '+text(value.customer||value.Customer||value.title||value.type||'')+((value.date||value.Date)?' · '+date(value.date||value.Date):'');
   for(const k of ['customer','vehicle','date','status','title','type','text','done','notes','vat','validUntil'])if(Object.hasOwn(value,k))add(k,names[k],k==='date'||k==='validUntil'?date(value[k]):value[k]);
   if(value.lines){add('work','Lavorazioni',lines(value.lines));add('amount','Totale IVA inclusa',euro(value.lines.reduce((s,l)=>s+(Number(l.quantity)||0)*(Number(l.price)||0),0)));}
   if(name==='officina-moduli-v1')for(const k of ['Customer','Plate','Vehicle','Date','Km','Operator','TaxCode','Details','Risks','Outcome','Declaration'])if(Object.hasOwn(value,k))add(k,({Customer:'Cliente',Plate:'Targa',Vehicle:'Veicolo',Date:'Data',Km:'Chilometri',Operator:'Operatore',TaxCode:'Codice fiscale',Details:'Dettagli',Risks:'Rischi comunicati',Outcome:'Decisione ed esito',Declaration:'Dichiarazione'}[k]),k==='Date'?date(value[k]):value[k]);
   if(value.data)for(const [k,v]of Object.entries(value.data).slice(0,20))if(v==null||typeof v!=='object')add('data.'+k,names[k]||k,v);
  }else if(kind==='entry'){
   title=(name==='officina.customerFiscal.v1'?'Dati cliente':'Note lavorazione')+' · '+text(parts[2]);
   if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value))if(k!=='id'&&k!=='history'&&(v==null||typeof v!=='object'))add(k,names[k]||k,v);}
   else add('notes','Note',value);
  }else if(kind==='storage'){
   const data=parse(value,{}),titles={'officina.invoices.v1':'Fatture e numerazione','officina.deliveryLoads.v1':'Bolle di consegna','officina-table-import-v1':'Importazioni','officina.inventory.v1':'Inventario','officina.revisionReminders.v1':'Promemoria revisione','officinaWorkshopLogo':'Logo officina','officina-email-settings-v1':'Impostazioni email','officina.customerFiscal.v1.history':'Storico dati clienti'};
   title=titles[name]||'Archivio condiviso';
   if(name==='officinaWorkshopLogo')add('logo','Logo',value?'Immagine presente':'Nessuna immagine');
   else if(name==='officina.inventory.v1'){
    const draft=data?.countDraft;add('countDraft','Conteggio',draft?'In corso':'Nessun conteggio');
    if(draft){add('startedAt','Iniziato',draft.startedAt);const counted=Array.isArray(draft.items)?draft.items.filter(item=>item?.counted===true).length:Object.keys(draft.counts||{}).length;add('counts','Prodotti contati',counted);}
    add('inventories','Inventari salvati',(data?.entries||data?.inventories||[]).length);
   }else if(data&&typeof data==='object'){
    for(const [k,v]of Object.entries(data).slice(0,24))if(Array.isArray(v))add(k,({documents:'Documenti',journal:'Bolle',loads:'Bolle',records:'Righe importate',history:'Storico'}[k]||k),v.length+' voci');else if(v==null||typeof v!=='object')add(k,names[k]||k,v);
    if(data.numbering)for(const [year,n]of Object.entries(data.numbering).slice(0,12))add('numbering.'+year,'Numerazione '+year,n);
    if(!fields.length)add('content','Archivio','Dati aggiornati');
   }else add('value','Valore',value);
  }else if(kind==='dom')add('content','Contenuto',txt({c:value}));
  else if(kind==='cash-meta'){title='Numerazione cassa';add('nextId','Prossimo numero',value.nextId);}
  else if(kind==='inventory-draft'){
   const draft=value.metadata||{};title='Conteggio inventario';
   add('status','Stato conteggio',({counting:'In corso',review:'Da verificare',applied:'Applicato'}[draft.status]||draft.status));
   add('startedAt','Iniziato',draft.startedAt);
  }else if(kind==='inventory-count-item'){
   const item=value.item||{};title='Conteggio inventario · '+text(item.product||'Scorta');
   add('product','Prodotto',item.product);add('category','Categoria',item.category);add('unit','Unità',item.unit);
   add('expectedQuantity','Quantità iniziale',item.expectedQuantity);add('countedQuantity','Quantità contata',item.countedQuantity);
   add('counted','Conteggio inserito',item.counted===true?'Sì':item.counted===false?'No':undefined);
   add('needsRecount','Richiede un nuovo conteggio',item.needsRecount===true?'Sì':item.needsRecount===false?'No':undefined);
  }
  else add('value','Valore',typeof value==='object'?'Dati aggiornati':value);
  return {title:text(title).slice(0,240),fields:fields.slice(0,24)};
 }
 function difference(key,before,after){
  const a=new Map(describe(key,before).fields.map(f=>[f.key,f])),b=new Map(describe(key,after).fields.map(f=>[f.key,f]));
  const result=[];for(const k of new Set([...a.keys(),...b.keys()])){const old=a.get(k),next=b.get(k);if(old?.value!==next?.value)result.push({key:k,label:next?.label||old.label,before:old?.value||'—',after:next?.value||'—'});}
  // Indivisible archives may change an existing document without changing its
  // count. Describe those documents as well, including entries beyond the first
  // screenful; never copy their XML, signatures, stock caches or credentials.
   const parts=parse(key,[]),kind=Array.isArray(parts)?parts[0]:null;if(kind==='storage'&&before!=null&&after!=null){
   const old=parse(before,{}),next=parse(after,{});
   const summary=item=>text([item.customer?.name||(typeof item.customer==='string'?item.customer:'')||item.supplier||'',item.number?'n. '+item.number:'',item.type||'',date(item.date),item.status||'',item.plate||'',item.paid===true?'Saldata':item.paid===false?'Da saldare':'',item.paidDate?date(item.paidDate):'',item.paymentDue?'Scadenza '+date(item.paymentDue):'',item.payment||'',item.cashLink?'Conto cassa '+item.cashLink:'',item.notes||'',lines(item.lines),item.stampDuty?'Bollo '+euro(item.stampDuty):''].filter(Boolean).join(' · '));
   for(const group of ['documents','journal','records'])if(Array.isArray(old?.[group])||Array.isArray(next?.[group])){
    const indexed=v=>new Map((Array.isArray(v)?v:[]).filter(item=>item&&typeof item==='object').map((item,i)=>[String(item.id||item.identity||i),item]));
    const x=indexed(old[group]),y=indexed(next[group]);
    for(const id of new Set([...x.keys(),...y.keys()])){const first=x.get(id),last=y.get(id),left=first?summary(first):'Non presente',right=last?summary(last):'Eliminata';if(left!==right)result.push({key:group+'.'+id,label:(group==='documents'?'Documento':'Bolla / importazione')+(last?.number||first?.number?' n. '+(last?.number||first.number):'')+(last?.customer?.name||first?.customer?.name?' · '+(last?.customer?.name||first.customer.name):''),before:left,after:right});}
   }
  }
  return result;
 }
 return Object.freeze({describe,difference});
});
