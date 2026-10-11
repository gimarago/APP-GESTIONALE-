/* Shared, closed whitelist for the legacy workshop snapshot.
 * Snapshot nodes are text strings or {t:tag, a:{attribute:value}, c:[nodes]}.
 * Runtime code must additionally accept only data-* and aria-* attribute names.
 * No event attributes, URL attributes, executable elements or inline styles.
 */
(function (root, factory) {
  'use strict';
  const schema = factory();
  if (typeof module === 'object' && module.exports) module.exports = schema;
  else root.WorkshopCloudSchema = schema;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return Object.freeze({
    version: 1,
    // Only authoritative roots. Cashbook, invoices, quotes and documents use
    // storageKeys; dashboard totals, ledger views and charts are derived.
    selectors: Object.freeze([
      '#agendaRows',
      '#customerRows',
      '#stockRows',
      '#agenda .parking-section .card',
      '#richiami .agenda-list',
      '#billingWorks',
      '#billingHeading',
      '#billingData'
    ]),
    storageKeys: Object.freeze([
      'ma-gomme-cashbook-v1',
      'officina-quotes-v1',
      'officina.invoices.v1',
      'officina.customerFiscal.v1',
      'officina.customerFiscal.v1.history',
      'officina.deliveryLoads.v1',
      'officina-table-import-v1',
      'officina-moduli-v1',
      'officina-work-notes',
      'officina-postit',
      'officina.inventory.v1',
      'officina.revisionReminders.v1',
      'officinaWorkshopLogo',
      'officina-email-settings-v1'
    ]),
    // IDs, not CSS selectors. Includes only saved business settings; transient
    // modal fields and personal appearance/access preferences stay per device.
    fields: Object.freeze([
      'shopName', 'shopPhone', 'shopAddress', 'shopOperatingAddress', 'shopVat', 'shopEmail',
      'shopHours', 'shopReminder'
    ]),
    tags: Object.freeze([
      'tr', 'td', 'th', 'div', 'span', 'b', 'strong', 'small', 'br',
      'p', 'i', 'em', 'button', 'input', 'select', 'option', 'textarea',
      'label', 'ul', 'ol', 'li'
    ]),
    attributes: Object.freeze([
      'class', 'title', 'role', 'type', 'value', 'checked', 'selected',
      'readonly', 'disabled', 'hidden', 'tabindex', 'colspan', 'rowspan',
      'min', 'max', 'step', 'placeholder', 'maxlength', 'inputmode',
      'autocomplete', 'required', 'name', 'for'
    ])
  });
});
