(() => {
 const $=id=>document.getElementById(id),inventory=window.stockInventoryApi;
 $('stockForm').querySelector('.form-grid').insertAdjacentHTML('beforeend','<div class="field"><label for="stockMinimum">Soglia riordino</label><input id="stockMinimum" type="number" min="0" step="any" value="5" required></div><div class="field full"><label><input id="stockReorderEnabled" type="checkbox" checked> Avviso di riordino attivo</label></div>');
 $('stockEditForm').querySelector('.form-grid').insertAdjacentHTML('beforeend','<div class="field full"><label><input id="editStockReorderEnabled" type="checkbox" checked> Avviso di riordino attivo</label></div>');
 document.head.insertAdjacentHTML('beforeend','<style>#stockReorderEnabled,#editStockReorderEnabled{width:auto;display:inline-block;vertical-align:middle;margin-right:8px}</style>');
 $('editStockMinimum').step='any';
 for(const [check,input] of [['stockReorderEnabled','stockMinimum'],['editStockReorderEnabled','editStockMinimum']])$(check).addEventListener('change',()=>{$(input).disabled=!$(check).checked;});
 $('stockForm').addEventListener('reset',()=>{$('stockMinimum').disabled=false;});
 const original=window.openStockEditor;
 window.openStockEditor=function(row){original(row);$('editStockReorderEnabled').checked=row.dataset.reorderEnabled!=='false';$('editStockMinimum').disabled=!$('editStockReorderEnabled').checked;};
 document.addEventListener('submit',event=>{
  if(!['stockForm','stockEditForm'].includes(event.target.id))return;
  const editing=event.target.id==='stockEditForm';
  const previousRows=editing?null:new Set($('stockRows').rows);
  const row=editing?editingStockRow:null,minimum=$(editing?'editStockMinimum':'stockMinimum').value||'5',enabled=$(editing?'editStockReorderEnabled':'stockReorderEnabled').checked;
  if(row){row.dataset.minimum=minimum;row.dataset.reorderEnabled=String(enabled);}
  // The legacy handler can replace an empty placeholder row rather than append.
  // Find the inserted element after submit; its numeric index is not stable.
  setTimeout(()=>{const target=row||[...$('stockRows').rows].find(item=>!previousRows.has(item)&&!item.classList.contains('empty-filter'));if(!target)return;target.dataset.minimum=minimum;target.dataset.reorderEnabled=String(enabled);if(row&&target.cells.length>=6)updateStockState(target,inventory.quantityFor(target));},0);
 },true);
 const deleteButton=document.createElement('button');deleteButton.type='button';deleteButton.className='btn secondary';deleteButton.id='deleteStock';deleteButton.textContent='Elimina scorta';
 deleteButton.style.marginRight='auto';$('stockEditForm').querySelector('.modal-actions').prepend(deleteButton);
 deleteButton.addEventListener('click',()=>{
  const row=editingStockRow;if(!row?.isConnected)return;
  const name=inventory.productName(row);
  if(!confirm('Eliminare definitivamente la scorta “'+name+'”? La disponibilità e le prenotazioni di questo articolo non saranno più visibili.'))return;
  row.remove();editingStockRow=null;closeModal('stockEditModal');
  filterStock();renderStockPageTotal();renderTyreSummary();renderCriticalStock();
 });
})();
