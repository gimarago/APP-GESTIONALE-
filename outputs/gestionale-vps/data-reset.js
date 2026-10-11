(() => {
  'use strict';

  const resetMarker = 'officina.data-reset.v1';
  const preservedKeys = new Set([
    'officina-email-settings-v1',
    'officinaWorkshopLogo',
    'officina-theme-v1',
    'officina.revisionReminders.v1',
    'officina.personal-access.v1'
  ]);
  const dataKeys = [
    'ma-gomme-cashbook-v1',
    'officina-quotes-v1',
    'officina.invoices.v1',
    'officina.customerFiscal.v1',
    'officina.customerFiscal.v1.history',
    'officina.deliveryLoads.v1',
    'officina-table-import-v1',
    'officina-moduli-v1',
    'officina-work-notes',
    'officina-postit'
  ];

  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');
  const italianToday = now.toLocaleDateString('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  [
    '#appDate',
    '#ledgerDatePicker',
    '#workDate',
    '#agendaDatePicker',
    '#salesDate',
    '#parkEntry',
    '#recallDate'
  ].forEach(selector => {
    const element = document.querySelector(selector);
    if (element) {
      element.value = today;
      if (selector === '#agendaDatePicker' || selector === '#ledgerDatePicker' || selector === '#salesDate') {
        element.dispatchEvent(new Event('change', {bubbles: true}));
      }
    }
  });
  document.querySelector('header.greeting small')?.replaceChildren(
    document.createTextNode(italianToday.charAt(0).toUpperCase() + italianToday.slice(1))
  );
  document.querySelector('#agenda .page-head p')?.replaceChildren(
    document.createTextNode(italianToday.charAt(0).toUpperCase() + italianToday.slice(1))
  );

  const firstReset = localStorage.getItem(resetMarker) !== '1';
  if (firstReset) {
    for (const key of dataKeys) localStorage.removeItem(key);
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && !preservedKeys.has(key) && /^(officina|ma-gomme)/.test(key)) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem(resetMarker, '1');
  }

  const hasAppData = dataKeys.some(key => localStorage.getItem(key));
  if (!firstReset && hasAppData) return;

  const clear = selector => document.querySelector(selector)?.replaceChildren();
  [
    '#jobRows',
    '#agendaRows',
    '#customerRows',
    '#stockRows',
    '#ledgerRows',
    '#incomeRows',
    '#salesList',
    '#revisionModal tbody',
    '#analysisPieLegend',
    '#analysisTyreMeasures',
    '#analysisTrendContent'
  ].forEach(clear);
  document.querySelectorAll('.parking-section .card').forEach(card => card.replaceChildren());
  document.querySelectorAll('#richiami .agenda-list').forEach(list => list.replaceChildren());
  document.querySelectorAll('.bottom .card:not(.revenue) .agenda-list').forEach(list => list.replaceChildren());
  document.querySelectorAll('#richiami .section-note').forEach(element => {
    element.textContent = 'Nessun richiamo registrato';
  });
  document.querySelectorAll('#analysisPie').forEach(svg => svg.replaceChildren());
  document.querySelectorAll('#analysisChartSummary').forEach(element => {
    element.textContent = 'Nessun dato registrato';
  });

  const values = {
    '#jobs': '0',
    '#dashboard .stat:nth-child(2) strong': '€ 0',
    '#dashboard .stat:nth-child(3) strong': '0',
    '#dashboard .stat:nth-child(4) strong': '0',
    '.revenue .amount': '€ 0',
    '#incomeTotal': '€ 0',
    '#tyreSalesAmount': '0 pneumatici',
    '#salesDayTotal': '0 pneumatici venduti',
    '#analysisTyreCount': '0',
    '#analysisRevisionCount': '0',
    '#analysisAirCount': '0'
  };
  for (const [selector, value] of Object.entries(values)) {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  }
  document.querySelectorAll('.trend').forEach(element => {
    element.textContent = 'Nessun dato registrato';
  });
  document.querySelectorAll('#tyreStockTotal, .tyre-copy').forEach(element => {
    element.textContent = 'Nessun dato registrato';
  });
})();
