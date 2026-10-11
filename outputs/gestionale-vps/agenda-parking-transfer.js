/* Move an existing work record; its stock and financial identity travel with it. */
(() => {
  'use strict';
  const agenda = document.getElementById('agendaRows');
  const parking = document.querySelector('#agenda .parking-section .card');
  if (!agenda || !parking || !window.renderParkingRow) return;
  const pending = new WeakSet();
  const cloud = window.WorkshopCloud;
  const canWrite = () => document.documentElement.dataset.cloudMode !== 'read' && (!cloud || window.parent.WorkshopCloudHost?.canWrite?.());
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
  const cleanText = value => String(value || '').trim() === '—' ? '' : String(value || '').trim();
  const money = value => {
    const text = String(value || '').replace(/[^\d,.-]/g, '');
    return Math.round((Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text) || 0) * 100) / 100;
  };
  const list = value => { try { const data = JSON.parse(value || '[]'); return Array.isArray(data) ? data : []; } catch { return []; } };
  const normalizePlate = value => String(value || '').replace(/[^a-z\d]/gi, '').toUpperCase();
  const notice = document.createElement('p');
  notice.id = 'agendaParkingTransferStatus'; notice.className = 'agenda-parking-transfer-status';
  notice.setAttribute('role', 'status'); notice.hidden = true;
  agenda.closest('.card').after(notice);
  const say = (text, error = false) => {
    notice.hidden = !text; notice.textContent = text;
    notice.classList.toggle('is-error', error); notice.setAttribute('role', error ? 'alert' : 'status');
  };

  function refresh() {
    for (const row of agenda.querySelectorAll('tr:not(.agenda-empty)')) {
      const select = row.querySelector('.status-select');
      if (!select) continue;
      let button = row.querySelector('.agenda-parking-transfer');
      if (!button) {
        button = document.createElement('button'); button.type = 'button';
        button.className = 'agenda-parking-transfer';
        button.innerHTML = '<span class="agenda-parking-transfer-icon" aria-hidden="true"></span>';
        let wrapper = select.closest('.agenda-status-actions');
        if (!wrapper) {
          wrapper = document.createElement('div'); wrapper.className = 'agenda-status-actions';
          select.before(wrapper); wrapper.append(select);
        }
        wrapper.append(button);
      }
      const customer = row.cells[1]?.textContent.trim() || 'il veicolo';
      button.setAttribute('aria-label', 'Sposta ' + customer + ' nel parcheggio');
      button.title = 'Sposta nel parcheggio';
      // A flush temporarily fences writes; that transient guard must not become
      // persisted row content or leave the button disabled after confirmation.
      button.disabled = document.documentElement.dataset.cloudMode === 'read' || pending.has(row);
    }
  }

  function dataFromAgenda(row) {
    const customer = cleanText(row.cells[1]?.textContent);
    const plateCell = row.cells[2]?.cloneNode(true);
    plateCell?.querySelectorAll('small,.vehicle-mileage,.mileage').forEach(node => node.remove());
    const plate = cleanText(plateCell?.textContent);
    const customerRow = [...document.querySelectorAll('#customerRows tr')].find(item =>
      normalizePlate(item.cells[4]?.textContent) === normalizePlate(plate) && cleanText(item.cells[0]?.textContent) === customer
    );
    const work = row.querySelector('.work-input')?.value || cleanText(row.cells[3]?.textContent);
    const amount = money(row.querySelector('.amount-input')?.value || row.cells[4]?.textContent);
    const lines = list(row.dataset.acceptanceLines).filter(line => String(line?.description || '').trim());
    const status = row.querySelector('.status-select').value;
    const date = row.dataset.date || document.getElementById('agendaDatePicker')?.value || '';
    const completedDate = status === 'COMPLETATO' ? row.dataset.completedDate || date : row.dataset.completedDate || '';
    return {
      customer, plate, vehicle:row.dataset.vehicle || cleanText(customerRow?.cells[3]?.textContent),
      phone:row.dataset.phone || cleanText(customerRow?.cells[1]?.textContent),
      email:row.dataset.email || cleanText(customerRow?.cells[2]?.textContent),
      km:row.dataset.km ?? '', entry:date, end:row.dataset.end || '',
      exit:status === 'COMPLETATO' ? completedDate : row.dataset.exit || '', completedDate,
      work, workLines:lines.length ? lines : [{description:work, amount, done:status === 'COMPLETATO'}],
      workNotes:row.dataset.workNotes || '', cashDestination:row.dataset.cashDestination || 'inCash', status
    };
  }

  function createParkingRow(source, data) {
    const target = document.createElement('div'); target.className = 'parking-row';
    // Preserve future finance fields too, including the deposit's account link.
    for (const [key, value] of Object.entries(source.dataset)) target.dataset[key] = value;
    target.dataset.cloudId = crypto.randomUUID(); target.dataset.agendaOriginId = source.dataset.cloudId;
    target.dataset.agendaTime = source.cells[0]?.textContent.match(/\d{1,2}:\d{2}/)?.[0] || '';
    target.dataset.parkingTyreDeductions = source.dataset.agendaTyreDeductions || '[]';
    target.dataset.parkingConsumableDeductions = source.dataset.agendaConsumableDeductions || '[]';
    delete target.dataset.agendaTyreDeductions; delete target.dataset.agendaConsumableDeductions;
    delete target.dataset.acceptanceLines; delete target.dataset.acceptanceRow; delete target.dataset.acceptanceEdited;
    delete target.dataset.removedFromParking;
    window.renderParkingRow(target, {...data, customer:esc(data.customer), plate:esc(data.plate), vehicle:esc(data.vehicle), work:esc(data.work)});
    // The legacy renderer interpolates headings; retain the original structured values.
    target.dataset.vehicle = data.vehicle; target.dataset.phone = data.phone; target.dataset.email = data.email;
    const select = target.querySelector('.parking-status');
    if (![...select.options].some(option => option.value === data.status)) select.add(new Option(data.status, data.status));
    select.value = data.status; window.styleParkingStatus?.(select);
    return target;
  }

  async function transfer(row) {
    if (!canWrite() || !row?.isConnected || row.parentElement !== agenda || pending.has(row)) return false;
    pending.add(row); refresh(); say('Spostamento nel parcheggio…');
    let target;
    try {
      // Settle delayed acceptance edits before carrying their current values across roots.
      await cloud?.flush();
      if (!canWrite() || !row.isConnected || row.parentElement !== agenda) return false;
      if (typeof window.WorkshopLedgerCash?.transferRow !== 'function') throw new Error('Il collegamento al libro contabile non è pronto. Ricarica l’app.');
      if (!row.dataset.cloudId) row.dataset.cloudId = crypto.randomUUID();
      const existing = [...parking.querySelectorAll('.parking-row')].find(item => item.dataset.agendaOriginId === row.dataset.cloudId);
      if (existing) throw new Error('Questo appuntamento è già presente nel parcheggio. Aggiorna i dati cambiando sezione.');
      const data = dataFromAgenda(row);
      target = createParkingRow(row, data); parking.append(target);
      // There is no render or await between relinking and removing the old row.
      // Their changes and account metadata form one normal shared transaction.
      window.WorkshopLedgerCash.transferRow(row, target);
      row.remove();
      for (const name of ['renderAgendaDay', 'syncDashboardToday', 'syncParkingCustomers', 'renderDailyIncome', 'syncAcceptanceRevenue', 'renderLiveTyreSummary', 'syncAllFinalTotals', 'renderSelectedLedger', 'renderDataAnalysis']) window[name]?.();
      window.WorkshopCashDestination?.refresh(); window.WorkshopLedgerCash.save(target);
      cloud?.changed(); await cloud?.flush();
      say('Veicolo spostato nel parcheggio.');
      const actions = target.querySelector('.parking-actions'); actions?.querySelector('select')?.focus();
      document.dispatchEvent(new CustomEvent('workshop:agenda-to-parking', {detail:{row:target, originId:target.dataset.agendaOriginId}}));
      return true;
    } catch (error) {
      if (row.isConnected) target?.remove();
      // A rejected shared write stays as a recoverable draft in the host.
      say(row.isConnected ? 'Spostamento non eseguito: ' + error.message : 'Spostamento non confermato dal server: ' + error.message + ' Conserva la bozza prima di ricaricare i dati.', true);
      return false;
    } finally { pending.delete(row); refresh(); }
  }

  agenda.addEventListener('click', event => {
    const button = event.target.closest('.agenda-parking-transfer');
    if (!button) return;
    event.preventDefault(); event.stopPropagation(); transfer(button.closest('tr'));
  });
  let scheduled = false;
  new MutationObserver(() => { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; refresh(); }); }).observe(agenda, {childList:true, subtree:true});
  document.addEventListener('cashbook:changed', refresh);
  new MutationObserver(refresh).observe(document.documentElement, {attributes:true, attributeFilter:['data-cloud-mode']});
  window.WorkshopAgendaParkingTransfer = Object.freeze({transfer, refresh, dataFromAgenda});
  refresh();
})();
