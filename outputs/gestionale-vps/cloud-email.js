(() => {
 if(window.WorkshopCloud){
  const key='officina-email-settings-v1',panel=document.createElement('section');panel.className='import-settings';
  panel.innerHTML='<h3>Email preventivi e rapporti</h3><p>Il pulsante Email invia direttamente il PDF del rapporto con il servizio selezionato. Il server deve avere le credenziali SMTP del mittente: Gmail usa una password per le app. Il mittente deve coincidere con SMTP_FROM (o SMTP_USER) configurato sul VPS.</p><label>Servizio<select id="cloudMailProvider"><option value="gmail">Gmail</option><option value="outlook">Outlook / Microsoft 365</option></select></label><label>Mittente<input id="cloudMailSender" type="email" autocomplete="email"></label><button type="button" class="btn" id="cloudMailSave">Salva mittente</button><p id="cloudMailStatus" role="status"></p>';
  document.querySelector('#impostazioni .content > .card:nth-child(2)').append(panel);
  const provider=panel.querySelector('select'),sender=panel.querySelector('input');let settings={provider:'gmail',email:''};try{settings=JSON.parse(localStorage.getItem(key)||'null')||settings;}catch{}
  provider.value=settings.provider;sender.value=settings.email;
  let preferencesChanged=false;
  document.addEventListener('workshop-cloud-state-loading',event=>{
   preferencesChanged=!event.detail?.storageKeys||event.detail.storageKeys.includes(key);
   if(preferencesChanged){try{settings=JSON.parse(localStorage.getItem(key)||'null')||{provider:'gmail',email:''};}catch{settings={provider:'gmail',email:''};}}
  });
  document.addEventListener('workshop-cloud-state-applied',()=>{if(preferencesChanged){provider.value=settings.provider;sender.value=settings.email;}preferencesChanged=false;});
  panel.querySelector('button').onclick=()=>{if(!sender.checkValidity()){sender.reportValidity();return;}settings={provider:provider.value,email:sender.value.trim()};localStorage.setItem(key,JSON.stringify(settings));panel.querySelector('[role=status]').textContent='Mittente salvato. Gli invii usano il servizio selezionato e le credenziali SMTP configurate sul VPS.';};
  window.WorkshopEmail={async send(data){if(!settings.email||!sender.validity.valid)throw Error('Configura un indirizzo mittente valido nelle Impostazioni.');if(!parent.WorkshopCloudHost?.sendEmail)throw Error('Servizio di invio non disponibile. Ricarica l’app.');try{return await parent.WorkshopCloudHost.sendEmail(window,{...data,provider:settings.provider,from:settings.email});}catch(error){if(/^Preventivo-\d{4}-\d{2}-\d{2}-[A-Z0-9]{8}\.pdf$/i.test(data.attachment?.name||'')&&['EMAIL_UNCONFIGURED','EMAIL_UNAVAILABLE','EMAIL_SENDER'].includes(error.code))return {manual:true,provider:settings.provider,email:settings.email};throw error;}}};return;
 }
})();
