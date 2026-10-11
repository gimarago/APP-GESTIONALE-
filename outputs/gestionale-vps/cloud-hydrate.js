(() => {
 'use strict';const cloud=window.WorkshopCloud,state=cloud.boot.state;
 if(state){for(const selector of WorkshopCloudSchema.selectors){const root=document.querySelector(selector);if(root)root.replaceChildren(...(state.dom[selector]||[]).map(cloud.deserialize));}for(const [id,value]of Object.entries(state.fields||{})){const field=document.getElementById(id);if(field)field.value=value;}}
 else {for(const selector of WorkshopCloudSchema.selectors){const root=document.querySelector(selector);if(root)root.replaceChildren();}const title=document.getElementById('billingHeading');if(title)title.textContent='Nessun intestatario selezionato';}
 document.querySelectorAll('#customerRows td:first-child button').forEach(button=>button.replaceWith(document.createTextNode(button.textContent)));
 if(cloud.failed)return;
 for(const name of ['makeCustomerNamesClickable','bindStockEditors','updateCustomerSuggestions','renderAgendaDay','syncDashboardToday','syncAllCustomerInterventions','syncParkingCustomers','renderStockPageTotal','renderCriticalStock'])window[name]?.();
 const brand=document.querySelector('.brand-name');if(brand)brand.textContent=document.getElementById('shopName')?.value||'Officina';
})();
