(() => {
  'use strict';
  const $=id=>document.getElementById(id),input=$('parkCustomer'),form=$('parkingForm');if(!input||!form)return;
  const normalize=v=>String(v||'').trim().toLocaleLowerCase('it');
  const clean=v=>String(v||'').trim()==='—'?'':String(v||'').trim();
  const data=()=>[...$('customerRows').rows].filter(r=>r.cells.length>=5).map(r=>({name:clean(r.cells[0].textContent),phone:clean(r.cells[1].textContent),email:clean(r.cells[2].textContent),vehicle:clean(r.cells[3].textContent),plate:clean(r.cells[4].textContent)}));
  const list=document.createElement('div');list.id='parkingCustomerMatches';list.hidden=true;list.setAttribute('role','listbox');input.after(list);input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','false');input.autocomplete='off';input.removeAttribute('list');
  const plate=$('parkPlate'),plateRequired=plate.required;
  function vehicleMode(){plate.hidden=false;plate.style.display='';plate.required=plateRequired;}
  vehicleMode();
  let matches=[],vehicles=[],selectedName='',active=-1;
  function hide(){list.hidden=true;list.style.display='none';input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;}
  function setVehicle(v){$('parkPlate').value=v?.plate||'';$('parkVehicle').value=v?.vehicle||'';$('parkKm').value='';}
  function choose(name){
    vehicles=data().filter(r=>normalize(r.name)===normalize(name));if(!vehicles.length)return;
    selectedName=normalize(name);input.value=vehicles[0].name;
    $('parkPhone').value=vehicles.find(v=>v.phone)?.phone||'';$('parkEmail').value=vehicles.find(v=>v.email)?.email||'';
    const seen=new Set();vehicles=vehicles.filter(v=>{const key=v.plate.replace(/\s/g,'').toUpperCase()||v.vehicle;if(seen.has(key))return false;seen.add(key);return true;});
    vehicleMode();
    setVehicle(vehicles.length===1?vehicles[0]:null);hide();
    if(vehicles.length>1)window.openWorkshopVehicleSelection(input.value,vehicles,v=>{setVehicle(v);$('parkPhone').value=v.phone||'';$('parkEmail').value=v.email||'';plate.focus();});
    else plate.focus();
  }
  function render(){
    const q=normalize(input.value);list.replaceChildren();active=-1;
    matches=[...new Set(data().map(v=>v.name))].filter(n=>q&&normalize(n).includes(q)).slice(0,15);
    if(!matches.length){hide();return;}
    matches.forEach((name,i)=>{const b=document.createElement('button');b.type='button';b.id='parkingMatch'+i;b.setAttribute('role','option');b.textContent=name;b.addEventListener('click',()=>choose(name));list.append(b);});
    list.hidden=false;list.style.display='grid';input.setAttribute('aria-expanded','true');
  }
  input.addEventListener('input',()=>{
    if(selectedName&&normalize(input.value)!==selectedName){selectedName='';setVehicle(null);$('parkPhone').value='';$('parkEmail').value='';vehicleMode(false);}
    const exact=data().find(v=>normalize(v.name)===normalize(input.value));
    if(exact&&selectedName!==normalize(exact.name)){choose(exact.name);return;}
    render();
  });
  input.addEventListener('focus',render);
  input.addEventListener('keydown',e=>{
    if(e.key==='Escape'){hide();return;}
    if(list.hidden)return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+matches.length)%matches.length;[...list.children].forEach((b,i)=>b.setAttribute('aria-selected',String(i===active)));input.setAttribute('aria-activedescendant','parkingMatch'+active);}
    if(e.key==='Enter'&&active>=0){e.preventDefault();choose(matches[active]);}
  });
  document.addEventListener('click',e=>{if(e.target!==input&&!list.contains(e.target))hide();});
  form.addEventListener('reset',()=>{selectedName='';hide();vehicleMode(false);});
  const add=document.querySelector('.parking-head button');
  if(add)add.onclick=()=>{form.reset();editingParkingRow=null;form.querySelectorAll('input').forEach(el=>el.value='');$('extraParkingWorks')?.replaceChildren();delete $('parkWork').dataset.lines;$('parkStatus').value='PROGRAMMATO';const today=new Date();$('parkEntry').value=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');document.querySelector('#parkingModal h2').textContent='Aggiungi veicolo in parcheggio';openModal('parkingModal');input.focus();};
  const edit=window.openParkingEditor;
  window.openParkingEditor=function(row){form.reset();delete $('parkWork').dataset.lines;return edit(row);};
  const style=document.createElement('style');style.textContent='#parkingCustomerMatches{display:none;max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:white;padding:4px}#parkingCustomerMatches button{border:0;background:white;color:var(--ink);text-align:left;padding:10px;font:600 12px Manrope;cursor:pointer}#parkingCustomerMatches button:hover,#parkingCustomerMatches button[aria-selected=true]{background:#edf8f2}#parkingCustomerMatches button:focus-visible{outline:2px solid var(--green)}';document.head.append(style);
})();
