(() => {
 'use strict';
 if(window.parent===window||!window.parent.WorkshopCloudBoot){location.replace(location.protocol==='file:'?'avvio-necessario.html':'/');throw Error('Aprire il gestionale dalla schermata di accesso.');}
 const boot=structuredClone(parent.WorkshopCloudBoot),schema=window.WorkshopCloudSchema;
 const values=new Map(Object.entries(boot.state?.storage||{}));
 values.set('officina.data-reset.v1','1');
 values.set('officina.personal-access.v1',JSON.stringify({name:boot.user.username,role:boot.user.role==='admin'?'Amministratore':boot.user.role==='viewer'?'Consultazione':'Operatore'}));
 let writable=false,initializing=true,applying=false,changeTimer,failed=false,lastInteraction=0,lastEdit=0,navigating=false;
 const memory={getItem:key=>values.has(String(key))?values.get(String(key)):null,setItem(key,value){key=String(key);value=String(value);if(values.get(key)===value)return;values.set(key,value);changed();},removeItem(key){if(values.delete(String(key)))changed();},clear(){if(values.size){values.clear();changed();}},key:index=>[...values.keys()][index]??null,get length(){return values.size;}};
 Object.defineProperty(window,'localStorage',{value:memory,configurable:false});
 function changed(settle=true){if(initializing||applying||!writable)return;if(settle)lastEdit=Date.now();clearTimeout(changeTimer);changeTimer=setTimeout(()=>parent.WorkshopCloudHost.changed(window),400);}
 // Legacy handlers finalize some business records in delayed callbacks. Only
 // actual edits need this quiet window; sidebar clicks and filters do not.
 const settleDelay=()=>lastEdit?Math.max(0,650-(Date.now()-lastEdit)):0;
 // Rendering stock controls can mutate a business root without changing any
 // record. Observers extend a real edit's callbacks, not a read-only redraw.
 function observedChange(){changed(settleDelay()>0);}
 const isAttr=name=>schema.attributes.includes(name)||/^(data|aria)-[a-z0-9_-]+$/.test(name);
 // Cash allocation and deposit controls are derived UI. Their disabled,
 // locked, and label states follow the work status and must never become
 // shared row edits when a remote status update redraws them.
 const ignored='.agenda-empty,.empty-filter,[data-revision-auto],a.whatsapp-reminder,.stock-reserved,.stock-dio-cell,.agenda-parking-transfer,.cash-destination-cell,.deposit-cell,.cash-destination,.deposit-control';
 function serialize(node){
   if(node.nodeType===3)return node.textContent;
   if(node.nodeType!==1||node.matches(ignored))return null;
   if(node.matches('#customerRows td:first-child button'))return node.textContent;
   const tag=node.localName;if(!schema.tags.includes(tag))return null;
   // The acceptance marker only styles a clickable row. Opening the editor
   // must not turn this per-page decoration into a shared work mutation.
   const attrs={};for(const {name,value} of node.attributes){if(!isAttr(name)||name==='hidden'||name==='data-acceptance-row'||/data-.*(?:ready|bound)$/i.test(name))continue;attrs[name]=value;}
   if(node.classList.contains('parking-row')&&node.dataset.removedFromParking==='true')attrs.hidden='';
   if(tag==='input'){attrs.value=node.value;if(node.checked)attrs.checked='';else delete attrs.checked;}
   if(tag==='option'){if(node.selected)attrs.selected='';else delete attrs.selected;}
   return {t:tag,a:attrs,c:tag==='textarea'?[node.value]:[...node.childNodes].map(serialize).filter(n=>n!==null)};
 }
 function deserialize(node){if(typeof node==='string')return document.createTextNode(node);if(!schema.tags.includes(node.t))throw Error('Elemento archivio non ammesso');const element=document.createElement(node.t);for(const [name,value]of Object.entries(node.a||{})){if(!isAttr(name))throw Error('Attributo archivio non ammesso');element.setAttribute(name,value);}for(const child of node.c||[])element.append(deserialize(child));return element;}
 function capture(){const storage={},dom={},fields={};for(const key of schema.storageKeys){const value=values.get(key);if(value!==undefined)storage[key]=value;}for(const selector of schema.selectors){const root=document.querySelector(selector);if(root&&WorkshopCloudRecords.rows.includes(selector))for(const row of root.children)if(!row.matches(ignored)&&!row.dataset.cloudId)row.dataset.cloudId=crypto.randomUUID();dom[selector]=root?[...root.childNodes].map(serialize).filter(n=>n!==null):[];}for(const id of schema.fields){if(id==='shopOperatingAddress'&&!boot.features?.operatingAddress)continue;const field=document.getElementById(id);if(field)fields[id]=field.value;}return WorkshopCloudRecords.normalize({schemaVersion:1,storage,dom,fields});}
 const readonlyInput='#workReportCustomer,#workReportFrom,#workReportTo,#primaryColor,#accentColor,#search,#stockSearch,#stockState,#inventoryCountSearch,#inventoryCountCategory,#appointmentCalendarDate,#appointmentCalendarFullDay,#agendaDatePicker,#ledgerDatePicker,#incomePeriod,#compareSelector,#salesDate,#salesRange,#salesMonth,#salesYear,#salesStartDate,#salesEndDate,#salesStart,#salesEnd,#customerSearch,#supplierInvoiceSearch,#supplierInvoiceFilter,#analysis .analysis-filter input,#analysis .analysis-filter select';
 const liveCountInput='#inventoryCountList [data-count-quantity]';
 const readonlyClick='#invWorkReports,#workReportsClose,#workReportsArchive [data-print-report],#workReportsArchive [data-invoice-report],#workReportCustomerOptions [role="option"],.sdi-readonly,.nav button,[data-view],.stock-quick-filter,.stock-warning-dismiss,.customer-open,.history-trigger,[data-cloud-close],#settingsLogout,#settingsManagement,#inventoryCountClose,#inventoryCountDone,#appointmentCalendarClose,#appointmentCalendarPrevious,#appointmentCalendarNext,#appointmentCalendarToday,#appointmentCalendarFullDay,.appointment-calendar-slot,#agendaPreviousDay,#agendaNextDay,#salesPreviousDay,#salesNextDay,#salesShowMore,#moduleClose,#manualModuleCancel,#quoteClose,#quotePrint,#quotePrintNow,#quotePrintDownload,#quotePrintClose,#cancelDeposit,#openVehicleRevisions,#vehicleRevisionClose,#cancelRevisionReminders,#invClose,#openFormsArchive,#backToModules,#formsArchive [data-customer-key],#formsArchive [data-record],#formsArchive a.module-original,#supplierInvoiceDetail a[href$="/original"],.form-modal:not(.open)';
 function guard(event){
   if(initializing)return;
   const navigation=event.type==='click'&&event.target.closest('.nav button[data-view]');
   if(navigation&&!navigating&&parent.WorkshopCloudHost.navigate?.(window,navigation.dataset.view)){event.preventDefault();event.stopImmediatePropagation();return;}
   // Theme and color controls save to the signed-in account, never to shared
   // workshop records. A read-only account can personalize them as well.
   if(event.target.closest('#chooseTheme,#closeThemePicker,[data-theme-choice],#themeRetrySave,#themePickerRetry,.color-settings'))return;
   lastInteraction=Date.now();
   if(writable&&parent.WorkshopCloudHost.canWrite()){changed(!event.target.matches(readonlyInput)&&!event.target.closest(readonlyClick));return;}
   const target=event.target;if(event.type==='click'&&(target.closest(readonlyClick)||target===document.body||target.closest('a.whatsapp-reminder')))return;
   if(['input','change','keydown','beforeinput','paste','click','focusin'].includes(event.type)&&target.matches(readonlyInput))return;
   if(event.type==='keydown'&&['Enter',' '].includes(event.key)&&target.closest('button')?.matches(readonlyClick))return;
   if(event.type==='keydown'&&['Tab','Escape','ArrowUp','ArrowDown','PageDown','PageUp'].includes(event.key))return;
   if(event.type==='click'&&!target.closest('button,input,select,textarea,[role=button],[contenteditable]'))return;
   event.preventDefault();event.stopImmediatePropagation();if(event.type==='click'||event.type==='submit')parent.WorkshopCloudHost.denied();
 }
 for(const event of ['click','input','change','submit','keydown','beforeinput','paste','drop'])document.addEventListener(event,guard,true);
 // Fixed handlers replacing historical inline onclick attributes. No eval and
 // no executable data is accepted from the saved workshop archive.
 document.addEventListener('click',event=>{const element=event.target.closest('[data-cloud-open],[data-cloud-close],[data-cloud-accept],[data-cloud-new-appointment]');if(!element)return;event.preventDefault();if(element.dataset.cloudClose)window.closeModal(element.dataset.cloudClose);else if(element.dataset.cloudOpen)window.openModal(element.dataset.cloudOpen);else if(element.hasAttribute('data-cloud-accept'))window.openNewAcceptance();else{document.getElementById('appDate').value=window.localCreationDate();window.openModal('appointmentModal');}});
 window.addEventListener('error',event=>{if((initializing||applying)&&!failed){failed=true;parent.WorkshopCloudHost.failed(window,event.message);}});
 function busy(){return Date.now()-lastInteraction<1400||!!document.querySelector('.form-modal.open:not(#appointmentCalendarModal),dialog[open],#invEditor:not([hidden])')||!!document.getElementById('postitText')?.value.trim()||!!document.activeElement?.matches('input:not([type=button]):not([type=submit]),textarea,select,[contenteditable=true]');}
 function navigationBusy(){return !!document.querySelector('.form-modal.open:not(#appointmentCalendarModal),dialog[open],#invEditor:not([hidden])')||!!document.getElementById('postitText')?.value.trim();}
 function discardOpenForms(){
   if(window.WorkshopWorkReports?.isSaving?.())return false;
   for(const modal of document.querySelectorAll('.form-modal.open:not(#appointmentCalendarModal)')){try{if(typeof window.closeModal==='function')window.closeModal(modal.id);else modal.classList.remove('open');}catch{modal.classList.remove('open');}modal.querySelectorAll('form').forEach(form=>form.reset());}
   for(const dialog of document.querySelectorAll('dialog[open]')){try{dialog.close('discarded-for-navigation');}catch{}dialog.querySelectorAll('form').forEach(form=>form.reset());}
   const invoice=document.getElementById('invEditor');if(invoice&&!invoice.hidden)document.getElementById('invClose')?.click();
   const notes=document.getElementById('postitForm');if(notes){notes.reset();const status=document.getElementById('postitStatus');if(status)status.textContent='';}
   document.dispatchEvent(new CustomEvent('workshop-discard-open-forms'));
   return !navigationBusy();
 }
 // Shared data may arrive while a search field remains focused. Filters are
 // per-device controls and can keep their focus; writable fields and unfinished
 // business forms must retain their current data until the user finishes.
 function liveBusy(){const active=document.activeElement;const blockingModal=!!document.querySelector('.form-modal.open:not(#appointmentCalendarModal):not(#inventoryCountModal),dialog[open],#invEditor:not([hidden])')||!!document.getElementById('postitText')?.value.trim();return blockingModal||settleDelay()>0||!!(active?.matches('input:not([type=button]):not([type=submit]),textarea,select,[contenteditable=true]')&&!active.matches(readonlyInput)&&!active.matches(liveCountInput)&&!active.readOnly&&!active.disabled);}
 function navigate(view){const button=document.querySelector('.nav button[data-view="'+CSS.escape(view)+'"]');if(!button)return;navigating=true;try{button.click();window.dispatchEvent(new CustomEvent('workshop-section-change',{detail:{view}}));}finally{navigating=false;}}
 function formDraft(){return [...document.querySelectorAll('.form-modal.open input,.form-modal.open textarea,.form-modal.open select,#manualModuleDialog[open] input,#manualModuleDialog[open] select,#depositDialog[open] input,#invEditor:not([hidden]) input,#invEditor:not([hidden]) textarea,#invEditor:not([hidden]) select,#postitText')].filter(el=>el.type!=='password'&&el.type!=='file').map(el=>({id:el.id,name:el.name,value:el.value,checked:el.checked}));}
 function accountActions(){
   const actions=document.querySelector('#settingsForm .modal-actions');if(!actions||document.getElementById('settingsLogout'))return;
   const manage=document.createElement('button');manage.id='settingsManagement';manage.type='button';manage.className='btn secondary';manage.textContent='Gestione dati';manage.onclick=()=>parent.WorkshopCloudHost.manage(window);
   const logout=document.createElement('button');logout.id='settingsLogout';logout.type='button';logout.className='btn secondary';logout.textContent='Esci dall’account';logout.onclick=()=>parent.WorkshopCloudHost.logout(window);
   actions.prepend(manage,logout);
 }
 window.WorkshopCloud={boot,capture,busy,navigationBusy,discardOpenForms,liveBusy,navigate,settleDelay,formDraft,inventoryVersion:()=>parent.WorkshopCloudHost.inventoryVersion?.(window)??null,flush:()=>parent.WorkshopCloudHost.flush(),serialize,deserialize,changed,observedChange,get initializing(){return initializing||applying;},get applying(){return applying;},get failed(){return failed;},beginApply(state){applying=true;clearTimeout(changeTimer);for(const key of schema.storageKeys){if(Object.hasOwn(state.storage,key))values.set(key,state.storage[key]);else values.delete(key);}boot.state=state;},endApply(){clearTimeout(changeTimer);lastEdit=0;applying=false;},mode(value){writable=!!value;document.documentElement.dataset.cloudMode=writable?'edit':'read';},view(){return document.querySelector('.nav button.active')?.dataset.view||'dashboard';},finish(){accountActions();initializing=false;this.mode(boot.editing);parent.WorkshopCloudHost.ready(window);}};
 // Empty demo data before legacy migrations initialize. Authoritative rows are
 // restored after the main script, once its containers and listeners exist.
 for(const selector of ['#jobRows','#agendaRows','#customerRows','#stockRows','#ledgerRows','#incomeRows','#richiami .agenda-list','.parking-section .card','.bottom .card:not(.revenue) .agenda-list'])document.querySelectorAll(selector).forEach(root=>root.replaceChildren());
})();
