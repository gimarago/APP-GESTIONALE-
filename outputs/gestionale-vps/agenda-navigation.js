(() => {
  'use strict';
  // A confirmed transfer opens its destination without another shared write.
  document.addEventListener('workshop:agenda-to-parking', event => {
    window.showPage('parking');
    const row=event.detail?.row;
    row?.querySelector('.parking-status')?.focus();
  });
})();
