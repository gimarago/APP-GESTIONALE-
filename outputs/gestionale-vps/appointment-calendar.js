/* The weekly picker reads the shared agenda; accepting a slot uses the existing form. */
(() => {
  'use strict';
  const cloud = window.WorkshopCloud, agenda = document.getElementById('agendaRows');
  const parking = document.querySelector('#agenda .parking-section .card');
  const trigger = document.querySelector('#agenda .page-head [data-cloud-new-appointment]');
  if (!cloud || !agenda || !trigger) return;
  const iso = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const today = () => iso(new Date());
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(new Date(value + 'T12:00:00').getTime());
  const shift = (value, days) => { const date = new Date(value + 'T12:00:00'); date.setDate(date.getDate() + days); return iso(date); };
  const monday = value => shift(value, -((new Date(value + 'T12:00:00').getDay() + 6) % 7));
  const time = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
  const label = value => new Intl.DateTimeFormat('it-IT', {weekday:'long', day:'numeric', month:'long', year:'numeric'}).format(new Date(value + 'T12:00:00'));
  const canWrite = () => cloud.boot?.user?.role !== 'viewer' && window.parent.WorkshopCloudHost?.canWrite?.();
  const readOnly = () => cloud.boot?.user?.role === 'viewer' || document.documentElement.dataset.cloudMode === 'read';
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const button = (id, text, handler, secondary = true) => { const el = node('button', text, 'btn' + (secondary ? ' secondary' : '')); el.type = 'button'; el.id = id; el.addEventListener('click', handler); return el; };
  let week = monday(today()), selected = {date:today(), minute:8 * 60}, originalFocus, renderTimer, bookingContext=null;
  const modal = node('div', undefined, 'form-modal appointment-calendar-modal');
  modal.id = 'appointmentCalendarModal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'appointmentCalendarTitle');
  const card = node('div', undefined, 'modal-card appointment-calendar-card');
  const heading = node('div', undefined, 'appointment-calendar-heading');
  const title = node('h2', 'Scegli giorno e orario'); title.id = 'appointmentCalendarTitle'; title.tabIndex = -1;
  heading.append(title, button('appointmentCalendarClose', 'Chiudi', close));
  const hint = node('p', 'Fai doppio clic su un orario per compilare la scheda. Da telefono seleziona l’orario e premi “Nuovo appuntamento”.', 'appointment-calendar-hint');
  hint.id = 'appointmentCalendarHint';
  const controls = node('div', undefined, 'appointment-calendar-controls');
  const rangeLabel = node('strong'); rangeLabel.id = 'appointmentCalendarRange'; rangeLabel.setAttribute('aria-live', 'polite');
  controls.append(button('appointmentCalendarToday', 'Oggi', () => changeDate(today())), button('appointmentCalendarPrevious', '←', () => changeDate(shift(selected.date, -7))), button('appointmentCalendarNext', '→', () => changeDate(shift(selected.date, 7))), rangeLabel);
  controls.querySelector('#appointmentCalendarPrevious').setAttribute('aria-label', 'Settimana precedente');
  controls.querySelector('#appointmentCalendarNext').setAttribute('aria-label', 'Settimana successiva');
  const dateLabel = node('label', undefined, 'appointment-calendar-date-label');
  dateLabel.append(node('span', 'Vai alla data'));
  const datePicker = node('input'); datePicker.type = 'date'; datePicker.id = 'appointmentCalendarDate'; datePicker.addEventListener('change', () => { if (validDate(datePicker.value)) changeDate(datePicker.value); });
  dateLabel.append(datePicker); controls.append(dateLabel);
  const fullDayLabel = node('label', undefined, 'appointment-calendar-full-day');
  const fullDay = node('input'); fullDay.type = 'checkbox'; fullDay.id = 'appointmentCalendarFullDay';
  const fullDayText = node('span', 'Mostra 24 ore'); fullDayLabel.append(fullDay, fullDayText); controls.append(fullDayLabel);
  const scroll = node('div', undefined, 'appointment-calendar-scroll'); scroll.id = 'appointmentCalendarScroll';
  const table = node('table', undefined, 'appointment-calendar-table'); table.setAttribute('aria-describedby', hint.id); scroll.append(table);
  const footer = node('div', undefined, 'appointment-calendar-footer');
  const selectionLabel = node('p'); selectionLabel.id = 'appointmentCalendarSelection'; selectionLabel.setAttribute('role', 'status');
  const book = button('appointmentCalendarBook', 'Nuovo appuntamento', () => bookSlot(selected.date, selected.minute), false);
  footer.append(selectionLabel, book); card.append(heading, hint, controls, scroll, footer); modal.append(card); document.body.append(modal);

  function records() {
    return [...agenda.querySelectorAll('tr:not(.agenda-empty)')].map(row => {
      const raw = row.cells[0]?.textContent.match(/(\d{1,2}):(\d{2})/);
      const minute = raw ? Number(raw[1]) * 60 + Number(raw[2]) : -1;
      return {row, date:row.dataset.date, minute, customer:row.cells[1]?.textContent.trim() || 'Cliente', plate:row.cells[2]?.textContent.trim() || '', work:row.cells[3]?.querySelector('.work-input')?.value || row.cells[3]?.textContent.trim() || '', status:row.querySelector('.status-select')?.value || ''};
    }).filter(item => validDate(item.date) && item.minute >= 0 && item.minute < 1440 && item.date >= week && item.date < shift(week, 7));
  }
  function deadlineDate(value) {
    const text = String(value || '').trim();
    const italian = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const date = italian ? `${italian[3]}-${italian[2].padStart(2,'0')}-${italian[1].padStart(2,'0')}` : text;
    if (!validDate(date)) return '';
    return iso(new Date(date + 'T12:00:00')) === date ? date : '';
  }
  function deadlines() {
    return [...(parking?.querySelectorAll('.parking-row') || [])].map(row => {
      const data = window.parkingDataFromRow?.(row) || {};
      const status = String(row.querySelector('.parking-status')?.value || data.status || '').trim().toUpperCase();
      const date = deadlineDate(row.dataset.end ?? data.end);
      return {row, date, status, removed:row.dataset.removedFromParking === 'true', exit:row.dataset.exit || data.exit, customer:data.customer || row.children[0]?.querySelector('b')?.textContent.trim() || 'Cliente', plate:data.plate || '', vehicle:data.vehicle || '', work:data.work || row.children[3]?.querySelector('b')?.textContent.trim() || ''};
    }).filter(item => item.date && !item.removed && !item.exit && !['COMPLETATO','PRONTO AL RITIRO','USCITO','RITIRATO'].includes(item.status) && item.date >= week && item.date < shift(week,7));
  }
  function deadlineRow(days) {
    const items = deadlines();
    if (!items.length) return null;
    const row = node('tr', undefined, 'appointment-calendar-deadlines');
    const heading = node('th', 'Da finire entro'); heading.scope = 'row'; row.append(heading);
    for (const day of days) {
      const cell = node('td'); cell.dataset.date = day;
      const list = items.filter(item => item.date === day).sort((a,b) => a.customer.localeCompare(b.customer,'it') || a.plate.localeCompare(b.plate,'it'));
      for (const item of list) {
        const event = node('button', undefined, 'appointment-calendar-deadline'); event.type = 'button'; event.disabled = readOnly();
        event.dataset.parkingId = item.row.dataset.cloudId || ''; event.dataset.date = day;
        event.setAttribute('aria-label', 'Da finire entro ' + label(day) + ': ' + item.customer + ', ' + [item.plate,item.vehicle].filter(Boolean).join(' · '));
        event.title = ['Da finire entro ' + label(day),item.customer,item.plate,item.vehicle,item.work,item.status].filter(Boolean).join(' · ');
        event.append(node('b', item.customer), node('span', [item.plate,item.vehicle].filter(Boolean).join(' · ')), node('span', item.work));
        event.addEventListener('click', () => {
          if (!canWrite() || !item.row.isConnected || !deadlines().some(current => current.row === item.row && current.date === day)) return;
          close(false); window.openParkingEditor?.(item.row);
          const end = document.getElementById('parkEnd'); if (end) end.value = day;
        });
        cell.append(event);
      }
      row.append(cell);
    }
    return row;
  }
  function select(date, minute, focus = false) {
    selected = {date, minute}; datePicker.value = date;
    selectionLabel.textContent = label(date) + ' · ' + time(minute);
    table.querySelectorAll('.appointment-calendar-slot').forEach(slot => {
      const chosen = slot.dataset.date === date && Number(slot.dataset.minute) === minute;
      slot.setAttribute('aria-pressed', String(chosen)); slot.tabIndex = chosen ? 0 : -1;
      if (chosen && focus) slot.focus();
    });
    book.disabled = readOnly();
  }
  function changeDate(value) {
    if (!validDate(value)) return;
    const previous = week; week = monday(value); selected.date = value;
    if (week !== previous) scroll.scrollTop = 0;
    render();
  }
  function render() {
    const focus = document.activeElement;
    const focusSlot = focus?.matches('.appointment-calendar-slot') ? {date:focus.dataset.date,minute:focus.dataset.minute} : null;
    const focusDeadline = focus?.matches('.appointment-calendar-deadline') ? {date:focus.dataset.date,id:focus.dataset.parkingId} : null;
    const full = fullDay.checked, first = full ? 0 : 360, end = full ? 1440 : 1200;
    if (selected.minute < first || selected.minute >= end) selected.minute = first;
    const days = Array.from({length:7}, (_, index) => shift(week, index)), items = records();
    const outside = items.filter(item => item.minute < 360 || item.minute >= 1200).length;
    fullDayText.textContent = 'Mostra 24 ore' + (!full && outside ? ' (' + outside + ' fuori fascia)' : '');
    rangeLabel.textContent = new Intl.DateTimeFormat('it-IT', {day:'numeric',month:'short'}).format(new Date(week + 'T12:00:00')) + ' – ' + new Intl.DateTimeFormat('it-IT', {day:'numeric',month:'short',year:'numeric'}).format(new Date(shift(week,6) + 'T12:00:00'));
    const head = node('thead'), hr = node('tr'), corner = node('th', 'Ora'); corner.scope = 'col'; hr.append(corner);
    for (const day of days) {
      const th = node('th'); th.scope = 'col'; th.classList.toggle('is-today', day === today());
      th.append(node('span', new Intl.DateTimeFormat('it-IT', {weekday:'short'}).format(new Date(day + 'T12:00:00'))), node('strong', String(Number(day.slice(-2))))); hr.append(th);
    }
    head.append(hr); const body = node('tbody');
    const due = deadlineRow(days); if (due) body.append(due);
    for (let minute = first; minute < end; minute += 30) {
      const tr = node('tr'), th = node('th', time(minute)); th.scope = 'row'; tr.append(th);
      for (const day of days) {
        const td = node('td'), slot = node('button', undefined, 'appointment-calendar-slot');
        slot.type = 'button'; slot.dataset.date = day; slot.dataset.minute = String(minute); slot.setAttribute('aria-label', 'Nuovo appuntamento: ' + label(day) + ', ' + time(minute));
        slot.addEventListener('click', () => select(day, minute));
        slot.addEventListener('dblclick', () => bookSlot(day, minute));
        slot.addEventListener('keydown', event => slotKey(event, day, minute));
        td.append(slot);
        const list = items.filter(item => item.date === day && item.minute >= minute && item.minute < minute + 30).sort((a,b) => a.minute-b.minute);
        if (list.length) {
          const appointments = node('div', undefined, 'appointment-calendar-events');
          for (const item of list) {
            const event = node('button', undefined, 'appointment-calendar-event'); event.type = 'button';
            event.classList.toggle('is-completed', item.status === 'COMPLETATO');
            event.disabled = readOnly(); event.setAttribute('aria-label', 'Apri scheda: ' + item.customer + ', ' + label(day) + ', ' + time(item.minute));
            event.title = [time(item.minute), item.customer, item.plate, item.work, item.status].filter(Boolean).join(' · ');
            event.append(node('b', time(item.minute) + ' · ' + item.customer), node('span', [item.plate,item.work].filter(Boolean).join(' · ')));
            event.addEventListener('click', () => { if (!canWrite()) return; close(false); window.openAcceptanceEditorForRow?.(item.row); }); appointments.append(event);
          }
          td.append(appointments);
        }
        tr.append(td);
      }
      body.append(tr);
    }
    table.replaceChildren(head, body); select(selected.date, selected.minute);
    if (modal.classList.contains('open')) {
      if (focusSlot) [...table.querySelectorAll('.appointment-calendar-slot')].find(slot => slot.dataset.date === focusSlot.date && slot.dataset.minute === focusSlot.minute)?.focus({preventScroll:true});
      if (focusDeadline) [...table.querySelectorAll('.appointment-calendar-deadline')].find(event => event.dataset.date === focusDeadline.date && event.dataset.parkingId === focusDeadline.id)?.focus({preventScroll:true});
    }
  }
  function bookSlot(date, minute) {
    if (!canWrite() || !validDate(date) || minute < 0 || minute >= 1440) return false;
    const context=bookingContext;close(false,true);
    window.openNewAcceptance();
    document.getElementById('appDate').value = date;
    document.getElementById('appTime').value = time(minute);
    document.getElementById('appStatus').value = 'PROGRAMMATO';
    document.querySelector('#appointmentForm [type=submit]').textContent = 'Salva appuntamento';
    context?.onBook?.({date,time:time(minute)});
    document.getElementById('appCustomer').focus();
    return true;
  }
  function slotKey(event, date, minute) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); bookSlot(date, minute); return; }
    let nextDate = date, nextMinute = minute;
    if (event.key === 'ArrowLeft') nextDate = shift(date,-1);
    else if (event.key === 'ArrowRight') nextDate = shift(date,1);
    else if (event.key === 'ArrowUp') nextMinute -= 30;
    else if (event.key === 'ArrowDown') nextMinute += 30;
    else if (event.key === 'Home') nextMinute = fullDay.checked ? 0 : 360;
    else if (event.key === 'End') nextMinute = fullDay.checked ? 1410 : 1170;
    else return;
    event.preventDefault();
    const first = fullDay.checked ? 0 : 360, last = fullDay.checked ? 1410 : 1170;
    nextMinute = Math.max(first,Math.min(last,nextMinute));
    if (nextDate < week || nextDate >= shift(week,7)) { week = monday(nextDate); selected = {date:nextDate,minute:nextMinute}; render(); }
    select(nextDate, nextMinute, true);
  }
  function open(context = null) {
    if (!canWrite()) return false;
    bookingContext=context&&typeof context.onBook==='function'?context:null;
    originalFocus = document.activeElement;
    const date = document.getElementById('agendaDatePicker')?.value;
    selected = {date:validDate(date) ? date : today(), minute:480}; week = monday(selected.date);
    render(); modal.classList.add('open'); title.focus();
    scroll.scrollTop = fullDay.checked ? 16 * 72 : 4 * 72;
    return true;
  }
  function close(restoreFocus = true, booked = false) { const context=bookingContext;bookingContext=null;clearTimeout(renderTimer); modal.classList.remove('open');if(!booked)context?.onCancel?.(); if (restoreFocus) originalFocus?.focus(); }
  fullDay.addEventListener('change', render);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(el => el.tabIndex >= 0 && el.getClientRects().length);
    if (event.shiftKey && (document.activeElement === focusable[0] || document.activeElement === title)) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
  });
  // Capturing stops only the agenda header trigger; direct form hooks remain available.
  document.addEventListener('click', event => {
    if (!event.target.closest('#agenda .page-head [data-cloud-new-appointment]')) return;
    event.preventDefault(); event.stopImmediatePropagation(); open();
  }, true);
  new MutationObserver(() => {
    if (!modal.classList.contains('open')) return;
    clearTimeout(renderTimer); renderTimer = setTimeout(render, 80);
  }).observe(agenda, {childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-date','data-acceptance-lines']});
  if (parking) {
    const refreshDeadlines = () => {
      if (!modal.classList.contains('open')) return;
      clearTimeout(renderTimer); renderTimer = setTimeout(render,80);
    };
    new MutationObserver(refreshDeadlines).observe(parking, {childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-end','data-exit','data-vehicle','data-work-lines','data-cloud-id','data-removed-from-parking']});
    parking.addEventListener('change', refreshDeadlines);
    new MutationObserver(refreshDeadlines).observe(document.documentElement, {attributes:true,attributeFilter:['data-cloud-mode']});
  }
  window.WorkshopAppointmentCalendar = Object.freeze({open,close,select,book:bookSlot,refresh:render});
})();
