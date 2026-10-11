/* Navigazione giornaliera e righe di lavorazione della nuova accettazione. */
(() => {
  'use strict';
  const picker=document.getElementById('ledgerDatePicker');
  if(picker){
    const bar=document.createElement('div');bar.className='ledger-day-navigation';
    picker.before(bar);bar.append(picker);picker.parentElement.parentElement.style.maxWidth='300px';
    for(const [step,label,symbol] of [[-1,'Giorno precedente','←'],[1,'Giorno successivo','→']]){
      const button=document.createElement('button');button.type='button';button.className='btn secondary';button.textContent=symbol;button.setAttribute('aria-label',label);button.title=label;
      if(step<0)bar.prepend(button);else bar.append(button);
      button.addEventListener('click',()=>{
        const value=picker.value;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return;
        const date=new Date(value+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+step);
        const next=date.toISOString().slice(0,10);
        if(next.length!==10 || (picker.min&&next<picker.min)||(picker.max&&next>picker.max))return;
        picker.value=next;picker.dispatchEvent(new Event('change',{bubbles:true}));
      });
    }
  }
  const form=document.getElementById('appointmentForm'),work=document.getElementById('appWork'),amount=document.getElementById('appAmount');
  if(!form||!work||!amount)return;
  const container=document.createElement('div');container.className='field full';
  const heading=document.createElement('strong');heading.textContent='Lavori da svolgere';
  const rows=document.createElement('div');rows.id='appointmentWorkLines';
  const add=document.createElement('button');add.type='button';add.className='link';add.textContent='+ Aggiungi lavorazione';
  container.append(heading,rows,add);work.closest('.field').before(container);
  work.closest('.field').classList.add('hidden');work.required=false;work.type='hidden';
  amount.readOnly=true;amount.setAttribute('aria-readonly','true');
  form.querySelector('label[for="appAmount"]').textContent='Totale lavorazioni (€)';
  const read=()=>[...rows.children].map(row=>({description:row.querySelector('[data-description]').value.trim(),amount:Number(row.querySelector('[data-amount]').value||0)}));
  function update(){
    const lines=read();work.value=lines.map(l=>l.description).filter(Boolean).join(' · ');
    amount.value=(lines.reduce((sum,l)=>sum+Math.round(l.amount*100),0)/100).toFixed(2);
  }
  let serial=0,resetTimer;
  function append(){
    const row=document.createElement('div');row.className='appointment-work-line';const id=++serial;
    row.innerHTML=`<label for="appointmentDescription${id}">Lavorazione<input id="appointmentDescription${id}" data-description required placeholder="Es. Sostituzione pneumatici"></label><label for="appointmentAmount${id}">Importo (€)<input id="appointmentAmount${id}" data-amount type="number" min="0" max="9999999" step="0.01" value="0.00" required></label><button type="button" class="line-remove" aria-label="Rimuovi lavorazione">×</button>`;
    row.querySelector('button').addEventListener('click',()=>{if(rows.children.length===1){row.querySelector('[data-description]').value='';row.querySelector('[data-amount]').value='0.00';}else row.remove();update();});
    rows.append(row);update();return row;
  }
  rows.addEventListener('input',update);add.addEventListener('click',()=>append().querySelector('input').focus());
  // Capture sul documento precede i vecchi listener di acquisizione sul form.
  document.addEventListener('submit',event=>{if(event.target===form)update();},true);
  function set(lines){
    clearTimeout(resetTimer);rows.replaceChildren();
    for(const line of lines?.length?lines:[{description:'',amount:0}]){
      const row=append();row.querySelector('[data-description]').value=line.description||'';
      row.querySelector('[data-amount]').value=Number(line.amount||0).toFixed(2);
    }
    update();
  }
  form.addEventListener('reset',()=>{clearTimeout(resetTimer);resetTimer=setTimeout(()=>set(),0);});
  window.WorkshopAppointmentLines=Object.freeze({read,set});append();
  const style=document.createElement('style');style.textContent=`.ledger-day-navigation{display:flex;align-items:center;gap:8px}.ledger-day-navigation input{min-width:0;flex:1}.ledger-day-navigation button{padding:9px 12px;min-width:38px}.appointment-work-line{display:grid;grid-template-columns:minmax(0,1fr) 120px 32px;gap:9px;align-items:end;margin:10px 0}.appointment-work-line label{display:grid;gap:5px;font-size:11px}.appointment-work-line input{width:100%;min-width:0}.appointment-work-line .line-remove{margin-bottom:4px}#appointmentModal .modal-card{max-height:calc(100dvh - 36px);overflow-y:auto}@media(max-width:480px){.appointment-work-line{grid-template-columns:minmax(0,1fr) 100px 30px;gap:6px}.appointment-work-line input{padding:8px 6px}}`;
  document.head.append(style);
})();
