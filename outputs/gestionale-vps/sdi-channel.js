(() => {
  'use strict';
  const invoices=window.WorkshopInvoices, page=document.getElementById('invoiceApp');
  if(!invoices||!page||parent===window)return;
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn)=>{const b=node('button',text,'btn secondary sdi-readonly');b.type='button';b.onclick=fn;return b;};
  const statusNames={READY:'In coda',IN_FLIGHT:'Invio in corso',SDI_RECEIVED:'Ricevuta dallo SdI · attesa esiti',TRANSPORT_REJECTED:'Trasporto rifiutato',UNKNOWN:'Esito incerto · verifica necessaria',DELIVERED:'Consegnata',REJECTED:'Scartata',NOT_DELIVERED:'Mancata consegna',ACCEPTED:'Accettata',REVIEW:'Da verificare',PENDING:'Da elaborare',IMPORTED:'Importata nei fornitori',TEST_RECEIVED:'Ricevuta in collaudo'};
  Object.assign(statusNames,{SCARTO:'Scartata dallo SdI',CONSEGNA:'Consegnata',MANCATA_CONSEGNA:'Mancata consegna',ESITO:'Esito destinatario ricevuto',DECORRENZA_TERMINI:'Decorrenza termini',ATTESTAZIONE_TRASMISSIONE:'Attestazione di trasmissione',UNMATCHED:'Da abbinare a un invio',CONFLICT:'Esiti discordanti · verifica necessaria',APPLIED:'Abbinata'});
  const label=state=>statusNames[state]||state||'Da verificare';
  const itemLabel=item=>item.conflict?'Esiti discordanti · verifica necessaria':label(item.fiscalState&&item.fiscalState!=='PENDING'?item.fiscalState:item.state||item.status);
  let config=null, items=[],incoming=[],notifications=[],busy=false,loading=false,detailId='',lastSignature='';
  const panel=node('details',null,'card sdi-panel'),title=node('summary','Canale SdI · invii e ricezioni'),statusText=node('p',null,'inv-help'),message=node('p',null,'inv-error');
  panel.id='sdiChannelPanel';title.className='sdi-readonly';message.setAttribute('role','status');
  const content=node('div'),detail=node('div',null,'sdi-detail');
  panel.append(title,statusText,button('Aggiorna esiti',()=>refresh(true)),message,content,detail);
  document.getElementById('invArchive').after(panel);
  const sendButton=button('Invia allo SdI',sendCurrent);sendButton.id='invSdiSend';sendButton.className='btn';sendButton.hidden=true;
  document.getElementById('invXml').after(sendButton);
  const canWrite=()=>['admin','operator'].includes(parent.WorkshopCloudBoot?.user?.role)&&parent.WorkshopCloudHost?.canWrite();
  const itemFor=id=>items.find(i=>i.documentId===id);
  invoices.sdiLabel=id=>!config?'Stato SdI non disponibile':itemFor(id)?itemLabel(itemFor(id))+(config.environment==='test'?' (collaudo)':''):'Nessun invio da questo canale';
  async function api(path,method='GET',data){
    const headers={};
    if(method!=='GET'){
      const session=await fetch('/api/session',{cache:'no-store',credentials:'same-origin'}).then(r=>r.json());
      if(!session.csrf)throw Error('Sessione scaduta. Accedi di nuovo.');
      headers['Content-Type']='application/json';headers['X-CSRF-Token']=session.csrf;
    }
    const response=await fetch('/api/sdi/'+path,{method,headers,credentials:'same-origin',cache:'no-store',...(data?{body:JSON.stringify(data)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error?.message||'Operazione SdI non riuscita.');return result;
  }
  function syncButton(){const doc=invoices.currentDocument();sendButton.hidden=doc?.status!=='prepared';sendButton.disabled=busy||!config?.ready||!canWrite()||!!itemFor(doc?.id);sendButton.textContent=config?.environment==='test'?'Invia al collaudo SdI':'Invia allo SdI';}
  function downloadLink(collection,id,text){const link=node('a',text,'btn secondary sdi-readonly');link.href='/api/sdi/'+collection+'/'+encodeURIComponent(id)+'/original';link.download='';return link;}
  function render(){
    const environment=config?.environment==='production'?'PRODUZIONE':'COLLAUDO';
    const explanation=!config?'Stato del canale non disponibile.':!config.enabled?'Canale diretto disattivato. Per attivarlo occorrono accreditamento, collaudo e configurazione del VPS.':!config.ready?'Canale bloccato: '+(config.issues||[]).join(' '):'Canale '+environment+' configurato. Gli invii richiedono una conferma esplicita.';
    statusText.textContent=explanation;const banner=document.getElementById('sdiChannelBanner');if(banner)banner.textContent=explanation;
    content.replaceChildren();
    content.append(node('h3','Fatture affidate al canale'));
    if(!items.length)content.append(node('p','Nessun invio registrato da questo canale. Le eventuali trasmissioni da altri servizi vanno verificate prima di inviare.','inv-help'));
    const docs=new Map(invoices.documents().map(d=>[d.id,d]));
    for(const item of items){const row=node('div',null,'sdi-row'),doc=docs.get(item.documentId);row.append(node('strong',doc?(doc.number+' · '+doc.customer.name):item.filename),node('span',itemLabel(item)),button('Dettaglio',()=>showDetail('submissions',item.id)));content.append(row);}
    content.append(node('h3','Fatture fornitori ricevute'));
    content.append(node('p','Gli originali sono conservati sul server. Le fatture di produzione importate richiedono verifica nella sezione Fatture fornitori; il collaudo non alimenta la contabilità.','inv-help'));
    if(!incoming.length)content.append(node('p','Nessuna fattura ricevuta dal canale.','inv-help'));
    for(const item of incoming){const row=node('div',null,'sdi-row');row.append(node('strong',item.filename||'Fattura ricevuta'),node('span',itemLabel(item)),button('Dettaglio',()=>showDetail('incoming',item.id)));content.append(row);}
    const pending=notifications.filter(n=>n.state!=='APPLIED');
    if(pending.length){content.append(node('h3','Notifiche da verificare'));for(const item of pending){const row=node('div',null,'sdi-row');row.append(node('span',[item.filename,label(item.state),item.reason].filter(Boolean).join(' · ')),downloadLink('notifications',item.id,'Scarica notifica'));content.append(row);}}
    syncButton();invoices.refreshSdi();
  }
  async function showDetail(collection,id){
    try{
      const item=await api(collection+'/'+encodeURIComponent(id));detailId=collection+'/'+id;detail.replaceChildren();
      detail.append(node('h3','Dettaglio '+(item.filename||'')),node('p',itemLabel(item)));
      if(item.sdiId||item.identifier)detail.append(node('p','Identificativo SdI: '+(item.sdiId||item.identifier)));
      if(item.errorMessage||item.message||item.reason)detail.append(node('p',item.errorMessage||item.message||item.reason,'inv-help'));
      if(item.state==='UNKNOWN')detail.append(node('p','Non reinviare da un altro servizio prima di aver verificato l’esito con lo SdI. La richiesta potrebbe essere stata ricevuta.','inv-error'));
      detail.append(downloadLink(collection,id,'Scarica originale'));
      for(const receipt of item.events||[]){const row=node('div',null,'sdi-row');row.append(node('span',[label(receipt.outcome),label(receipt.state),receipt.reason,receipt.parsed?.recipientOutcome,(receipt.parsed?.errors||[]).map(e=>[e.code,e.description].filter(Boolean).join(': ')).join('; ')].filter(Boolean).join(' · ')),downloadLink('notifications',receipt.id,'Scarica notifica'));detail.append(row);}
      for(const event of item.history||[]){const p=node('p',null,'inv-help');p.textContent=[event.startedAt?new Date(event.startedAt).toLocaleString('it-IT'):'',label(event.result?.state||'IN_FLIGHT'),event.result?.code,event.result?.message].filter(Boolean).join(' · ');detail.append(p);}
      detail.append(button('Chiudi dettaglio',()=>{detailId='';detail.replaceChildren();}));
    }catch(e){message.textContent=e.message;}
  }
  async function refresh(manual=false){
    if(loading)return;loading=true;
    try{
      const [next,out,inc,notes]=await Promise.all([api('status'),api('submissions'),api('incoming'),api('notifications')]);config=next;items=out.items;incoming=inc.items;notifications=notes.items;
      const signature=JSON.stringify([config,items,incoming,notifications]);if(signature!==lastSignature){lastSignature=signature;render();if(detailId){const [kind,id]=detailId.split('/');await showDetail(kind,id);}}
      syncButton();
      if(manual)message.textContent='Esiti aggiornati.';
    }catch(e){config=null;syncButton();const banner=document.getElementById('sdiChannelBanner');if(banner)banner.textContent='Stato SdI non disponibile: '+e.message;if(manual)message.textContent=e.message;}
    finally{loading=false;}
  }
  async function sendCurrent(){
    if(busy||!canWrite())return;const doc=invoices.currentDocument();if(!doc||doc.status!=='prepared')return;
    busy=true;syncButton();
    try{
      await window.WorkshopCloud.flush();await refresh();if(!config?.ready)throw Error('Canale non pronto: consulta il pannello Canale SdI.');
      if(itemFor(doc.id))throw Error('Questo documento è già affidato al canale. Consulta gli esiti senza reinviarlo.');
      const total=invoices.documentTotals(doc).total.toLocaleString('it-IT',{style:'currency',currency:'EUR'});
      if(!confirm('Inviare '+doc.number+' · '+doc.customer.name+' · '+total+' allo SdI in '+(config.environment==='production'?'PRODUZIONE':'COLLAUDO')+'?\n\nConferma solo se questa fattura non è già stata trasmessa tramite Fatture in Cloud, PEC o altri servizi.'))return;
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(doc.xml));
      const expectedDigest=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
      await api('submissions','POST',{documentId:doc.id,expectedDigest,confirmed:true,environment:config.environment});
      panel.open=true;message.textContent='Richiesta registrata. Consulta gli esiti: la presa in carico non equivale alla consegna.';await refresh();
    }catch(e){panel.open=true;message.textContent=e.message;await refresh();}
    finally{busy=false;syncButton();}
  }
  window.addEventListener('workshop-invoice-edit',syncButton);
  window.addEventListener('workshop-section-change',event=>{if(event.detail?.view==='preventivi')refresh();});
  refresh();
})();
