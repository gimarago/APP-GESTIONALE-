(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkshopCashbookCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const cents = n => Math.round((Number(n) || 0) * 100);
  const euros = n => n / 100;
  const cashIdPattern = /^cash-(?:\d+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
  function parseMoneyCents(value) {
    let text=String(value ?? '').trim();
    if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(text)) text=text.replace(/\./g,'').replace(',','.');
    else if (/^\d+(?:[.,]\d{1,2})?$/.test(text)) text=text.replace(',','.');
    else throw Error('Inserisci un importo positivo con al massimo due decimali.');
    const result=Math.round(Number(text)*100);
    if(!Number.isSafeInteger(result)||result<=0)throw Error('Inserisci un importo positivo con al massimo due decimali.');
    return result;
  }
  function dateValue(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('Seleziona una data valida.');
    const time = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) throw new Error('Seleziona una data valida.');
    return time;
  }
  const days = (start,end) => Math.round((dateValue(end)-dateValue(start))/86400000);
  function reconcile(amount, state, returned) {
    const available = Math.max(0, cents(amount)-cents(returned));
    const clamp = v => Math.min(available,Math.max(0,cents(v)));
    const outside = state.lastEdited === 'outside' ? clamp(state.outside) : available-clamp(state.inCash);
    return {...state,outside:euros(outside),inCash:euros(available-outside)};
  }
  class Journal {
    constructor(storage, key='ma-gomme-cashbook-v1') {
      this.storage=storage; this.key=key; this.loadError=''; this.lastRaw=null;this.cacheOnlyIds=new Set();
      this.data={version:1,nextId:1,accounts:[],payments:[]};
      try {
        const raw=storage.getItem(key);
        this.lastRaw=raw;
        if(raw) {
          const data=JSON.parse(raw);
          if(data.version!==1 || !Array.isArray(data.accounts) || !Array.isArray(data.payments) || !Number.isInteger(data.nextId)) throw new Error('invalid');
          if(data.accounts.some(a=>!cashIdPattern.test(a.id)||!a.meta||!a.state) || data.payments.some(p=>!data.accounts.some(a=>a.id===p.accountId)||!Number.isInteger(p.cents)||p.cents<0||!Number.isFinite(dateValue(p.date)))) throw new Error('invalid');
          this.data=data;
        }
      } catch {this.loadError='Archivio rientri non leggibile. La registrazione è sospesa per proteggere i dati esistenti.';}
    }
    account(id) {return this.data.accounts.find(a=>a.id===id);}
    resolve(entry, ordinal=0, options={}) {
      const reference=JSON.stringify([entry.source,entry.date,entry.time,entry.customer,entry.vehicle,entry.work,ordinal]);
      const suppliedId=entry.sourceRow?.dataset.cashAccountId || entry.cashId;
      const stableId=cashIdPattern.test(suppliedId)?suppliedId:null;
      let account=this.account(stableId);
      if(!account && !stableId) account=this.data.accounts.find(a=>a.reference===reference && (!entry.sourceRow || !a.meta?.key || a.meta.key.split(':').at(-1)===entry.key.split(':').at(-1)));
      if(!account) {
        // A shared work row can arrive before its derived cash account has
        // been persisted. Keep the server's identity when rebuilding the cache.
        let id=stableId;
        if(!id){do{id='cash-'+(globalThis.WorkshopCloud?crypto.randomUUID():this.data.nextId++);}while(this.account(id));}
        if(/^cash-\d+$/.test(id)&&!options.cacheOnly)this.data.nextId=Math.max(this.data.nextId,Number(id.slice(5))+1);
        account={id,reference,meta:{},state:null};this.data.accounts.push(account);
        if(options.cacheOnly)this.cacheOnlyIds.add(id);
      }
      entry.cashId=account.id;
      if(entry.sourceRow) entry.sourceRow.dataset.cashAccountId=account.id;
      return account;
    }
    adjustReturn(entry) {
      const account=this.account(entry.cashId);
      // Deposits are actual receipts: edits to a job must never rewrite them,
      // nor a later receipt belonging to the same account.
      if(account?.preserveReceipts || this.data.payments.some(p=>p.accountId===entry.cashId&&p.kind==='deposit'))return false;
      const payment=this.data.payments.find(p=>p.accountId===entry.cashId&&p.kind!=='deposit');
      if(!account || !payment) return false;
      const initial=Math.min(cents(entry.amount), cents(account.state.inCash));
      const updated=Math.max(0,cents(entry.amount)-initial);
      if(updated===payment.cents && payment.meta.work===entry.work) return false;
      const before=JSON.parse(JSON.stringify(this.data));
      payment.corrections=payment.corrections||[];
      payment.corrections.push({cents:payment.cents,at:new Date().toISOString()});
      payment.cents=updated;
      payment.meta={...payment.meta,amount:entry.amount,work:entry.work,lines:entry.lines};
      account.state.inCash=euros(initial);account.state.outside=0;
      account.meta.amount=entry.amount;account.meta.work=entry.work;account.meta.lines=entry.lines;
      try {this.persist();} catch(error) {this.data=before;throw error;}
      return true;
    }
    setStatus(id,status) {
      const account=this.account(id);
      if(!account || account.status===status&&!this.cacheOnlyIds.has(id)) return;
      const previous=account.status;
      account.status=status;
      try {this.persist(this.data,[id]);} catch(error) {account.status=previous;throw error;}
    }
    sync(entry,state) {
      const account=this.account(entry.cashId);
      if(!account) return;
      const {sourceRow,...meta}=entry;
      account.meta=JSON.parse(JSON.stringify(meta)); account.state=JSON.parse(JSON.stringify(state));
    }
    invoicePayment(id,invoiceId,paid,date,today,commit) {
      const wasCacheOnly=this.cacheOnlyIds.has(id);
      const previous=JSON.parse(JSON.stringify(this.data)),next=JSON.parse(JSON.stringify(this.data));
      const account=next.accounts.find(a=>a.id===id);
      if(!account)throw Error('Lavoro collegato non trovato.');
      const existing=next.payments.find(p=>p.invoiceId===invoiceId);
      if(existing && existing.accountId!==id)throw Error('La fattura è già collegata a un altro rientro.');
      if(paid && (existing || cents(account.state.outside)>0)){
        if(account.status && account.status!=='COMPLETATO')throw Error('Completa il lavoro prima di registrarne il saldo.');
        if(days(account.meta.date,date)<0 || days(date,today)<0)throw Error('Data saldo non valida per il lavoro.');
        if(existing){
          existing.date=date;existing.days=days(account.meta.date,date);
        }else{
          next.payments.push({id:'invoice-return-'+invoiceId,invoiceId,accountId:id,date,time:'—',cents:cents(account.state.outside),days:days(account.meta.date,date),meta:{...account.meta}});
          account.state.outside=0;account.state.lastEdited='inCash';
        }
      }else if(!paid && existing){
        account.state.outside=euros(cents(account.state.outside)+existing.cents);account.state.lastEdited='outside';
        next.payments=next.payments.filter(p=>p!==existing);
      }
      this.persist(next,[id]);
      try{commit();}catch(error){if(wasCacheOnly)this.cacheOnlyIds.add(id);this.persist(previous);throw error;}
      this.data=next;
    }
    activePayments() {
      return this.data.payments.filter(p=>{const a=this.account(p.accountId);return a && (p.kind==='deposit'||!a.status || a.status==='COMPLETATO');});
    }
    received(id) {return euros(this.data.payments.filter(p=>p.accountId===id).reduce((sum,p)=>sum+p.cents,0));}
    deposits(id) {return euros(this.data.payments.filter(p=>p.accountId===id&&p.kind==='deposit').reduce((sum,p)=>sum+p.cents,0));}
    recordDeposit(id,value,date,today,time,requestId) {
      if(this.loadError)throw Error(this.loadError);
      const amount=parseMoneyCents(value),paymentId='deposit-'+String(requestId||'');
      if(!/^[a-zA-Z0-9-]{8,100}$/.test(String(requestId||'')))throw Error('Identificativo acconto non valido.');
      const existing=this.data.payments.find(p=>p.id===paymentId);
      if(existing){
        if(existing.accountId!==id||existing.cents!==amount||existing.date!==date||existing.kind!=='deposit')throw Error('Questa registrazione è già stata utilizzata per un altro acconto.');
        return existing;
      }
      const account=this.account(id);
      if(!account?.state)throw Error('Lavoro collegato non trovato.');
      if(days(date,today)<0)throw Error('La data dell’acconto non può essere futura.');
      const available=Math.max(0,cents(account.meta.amount)-cents(this.received(id)));
      const limit=account.status==='COMPLETATO'?Math.min(available,cents(account.state.outside)):available;
      if(amount>limit)throw Error('L’acconto supera il residuo ancora da ricevere.');
      const next=JSON.parse(JSON.stringify(this.data)),target=next.accounts.find(a=>a.id===id);
      const payment={id:paymentId,kind:'deposit',accountId:id,date,time,cents:amount,days:0,meta:{...target.meta}};
      if(target.status==='COMPLETATO')target.state.outside=euros(cents(target.state.outside)-amount);
      else Object.assign(target.state,reconcile(target.meta.amount,target.state,this.received(id)+euros(amount)));
      next.payments.push(payment);
      this.persist(next,[id]);this.data=next;
      return payment;
    }
    deleteDeposit(paymentId) {
      if(this.loadError)throw Error(this.loadError);
      const payment=this.data.payments.find(p=>p.id===paymentId);
      if(!payment)return null;
      if(payment.kind!=='deposit')throw Error('Puoi eliminare soltanto un acconto.');
      const account=this.account(payment.accountId);
      if(!account?.state)throw Error('Lavoro collegato non trovato.');
      const next=JSON.parse(JSON.stringify(this.data)),target=next.accounts.find(a=>a.id===payment.accountId);
      next.payments=next.payments.filter(p=>p.id!==paymentId);
      const received=euros(next.payments.filter(p=>p.accountId===target.id).reduce((sum,p)=>sum+p.cents,0));
      const available=Math.max(0,cents(target.meta.amount)-cents(received));
      const settled=next.payments.some(p=>p.accountId===target.id&&p.kind!=='deposit');
      if(target.status==='COMPLETATO'||settled){
        // A deleted receipt becomes unpaid credit. It must never be silently
        // moved into cash on the work date or added to a later settlement.
        target.state.inCash=euros(Math.min(available,Math.max(0,cents(target.state.inCash))));
        target.state.outside=euros(available-cents(target.state.inCash));
        target.state.lastEdited='inCash';
      }else{
        const destination=target.state.lastEdited==='outside'?'outside':'inCash';
        target.state[destination]=euros(cents(target.state[destination])+payment.cents);
        Object.assign(target.state,reconcile(target.meta.amount,target.state,received));
      }
      target.preserveReceipts=true;
      this.persist(next,[target.id]);this.data=next;
      return payment;
    }
    persist(data=this.data, activeIds=[]) {
      if(this.loadError) throw new Error(this.loadError);
      const active=new Set(activeIds);
      // Receiving a work row may rebuild its account for consultation. Only
      // a financial action on that account can turn this cache into a record.
      const clean={...data,accounts:data.accounts.filter(a=>a.state&&(!this.cacheOnlyIds.has(a.id)||active.has(a.id)))};
      if(this.storage.getItem(this.key)!==this.lastRaw) throw new Error('Il registro è stato modificato in un’altra scheda. Riapri l’app prima di registrare altre modifiche.');
      const serialized=JSON.stringify(clean);
      try {this.storage.setItem(this.key,serialized);this.lastRaw=serialized;for(const id of active)this.cacheOnlyIds.delete(id);}
      catch {throw new Error('Impossibile salvare nel browser. Nessun rientro registrato: libera spazio o abilita il salvataggio locale.');}
    }
    settle(id,date,today,time) {
      if(this.loadError) throw new Error(this.loadError);
      const account=this.account(id);
      if(!account?.state || cents(account.state.outside)<=0) throw new Error('Il lavoro è già saldato o non ha un fuori cassa.');
      if(days(account.meta.date,date)<0) throw new Error('La data di rientro non può precedere il completamento del lavoro.');
      if(days(date,today)<0) throw new Error('La data di rientro non può essere futura.');
      const next=JSON.parse(JSON.stringify(this.data));
      const target=next.accounts.find(a=>a.id===id);
      let ordinal=next.payments.length;
      while(next.payments.some(p=>p.id==='return-'+id+'-'+ordinal))ordinal++;
      const payment={id:'return-'+id+'-'+ordinal,accountId:id,date,time,cents:cents(target.state.outside),days:days(target.meta.date,date),meta:{...target.meta}};
      target.state.outside=0;target.state.lastEdited='inCash';
      next.payments.push(payment);
      this.persist(next,[id]); this.data=next;
      return payment;
    }
  }
  function customerAverages(payments){
    const groups=new Map();
    for(const p of payments){const customer=String(p.meta?.customer||'').trim();if(p.kind==='deposit'||!customer||!Number.isFinite(p.days))continue;const key=customer.toLocaleLowerCase('it-IT').replace(/[^\p{L}\p{N}]/gu,'');const group=groups.get(key)||{customer,count:0,totalDays:0};group.count++;group.totalDays+=p.days;groups.set(key,group);}
    return [...groups.values()].filter(g=>g.count>=2).map(g=>({...g,average:g.totalDays/g.count})).sort((a,b)=>b.average-a.average||a.customer.localeCompare(b.customer,'it'));
  }
  function customerAgingAverages(entries,payments,today){
    const groups=new Map(),keyFor=customer=>String(customer||'').trim().toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]/gu,'');
    const ensure=(customer,key)=>{let group=groups.get(key);if(!group){group={key,customer,count:0,totalDays:0,openCount:0,settledCount:0};groups.set(key,group);}return group;};
    for(const payment of payments||[]){const customer=String(payment.meta?.customer||'').trim();if(payment.kind==='deposit'||!customer||!Number.isFinite(payment.days))continue;const key=keyFor(customer);if(!key)continue;const group=ensure(customer,key);group.count++;group.totalDays+=Math.max(0,payment.days);group.settledCount++;}
    for(const entry of entries||[]){const age=Number(entry.state?.outside);if(!(age>0)||!entry.date)continue;const customer=String(entry.customer||'').trim()||'Cliente non specificato',key=keyFor(customer)||'senza-nome:'+entry.cashId;let elapsed=0;try{elapsed=Math.max(0,days(entry.date,today));}catch{continue;}const group=ensure(customer,key);group.count++;group.totalDays+=elapsed;group.openCount++;}
    return [...groups.values()].map(group=>({...group,average:group.count?group.totalDays/group.count:0})).sort((a,b)=>b.average-a.average||a.customer.localeCompare(b.customer,'it'));
  }
  return {Journal,cents,euros,days,reconcile,dateValue,customerAverages,customerAgingAverages,parseMoneyCents};
});
