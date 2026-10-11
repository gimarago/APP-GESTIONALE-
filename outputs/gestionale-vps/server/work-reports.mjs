import { HttpError } from './validation.mjs';

const storageKey = 'officina.invoices.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const keyFor = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it-IT').replace(/[^a-z0-9]/g, '');
const invalid = message => { throw new HttpError(400, 'WORK_REPORT_INVALID', message); };
const linkError = message => { throw new HttpError(400, 'WORK_REPORT_LINK', message); };
const duplicate = message => { throw new HttpError(409, 'WORK_ALREADY_INVOICED', message); };
const text = (value, max, allowEmpty = true) => typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
const id = value => text(value, 128, false);
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid('Importo del rapporto non valido.');
  const integer = Math.round(value * 100);
  if (!Number.isSafeInteger(integer) || Math.abs(value * 100 - integer) > 0.00001) invalid('Gli importi dei rapporti devono essere espressi in centesimi.');
  return integer;
}
const sum = values => {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result)) invalid('Totale del rapporto oltre il limite consentito.');
  return result;
};

// The report is a saved snapshot, not a live projection of historical work.
// Validate its own data and document links without comparing it with jobs that
// may legitimately change later. Protocol dependencies fence creation races.
export function guardWorkReports(state) {
  const raw = state.storage?.[storageKey];
  if (!raw) return;
  let archive;
  try { archive = JSON.parse(raw); } catch { invalid('Archivio dei rapporti non leggibile.'); }
  if (!plain(archive)) return;
  const documents = Array.isArray(archive.documents) ? archive.documents : [];
  const tagged = documents.filter(doc => ['TD01','TD24'].includes(doc?.type) && (Object.hasOwn(doc, 'sourceWorkReportId') || Object.hasOwn(doc, 'sourceWorkIds')));
  // Legacy invoices without report metadata retain their existing validation.
  if (!Object.hasOwn(archive, 'workReports') && !tagged.length) return;
  const reports = Object.hasOwn(archive, 'workReports') ? archive.workReports : [];
  if (!Array.isArray(reports) || reports.length > 20000) invalid('Elenco rapporti di intervento non valido.');
  const byId = new Map();
  for (const report of reports) {
    if (!plain(report) || !UUID.test(report.id || '') || byId.has(report.id)) invalid('Identificativo del rapporto mancante o duplicato.');
    if (!isoDate(report.date) || !text(report.customer, 500, false) || !text(report.customerKey, 500, false) || report.customerKey !== keyFor(report.customer)) invalid('Cliente o data del rapporto non validi.');
    if (!plain(report.period) || !isoDate(report.period.start) || !isoDate(report.period.end) || report.period.start > report.period.end) invalid('Periodo del rapporto non valido.');
    if (!Array.isArray(report.works) || !report.works.length || report.works.length > 20000) invalid('Il rapporto deve contenere almeno un intervento.');
    const ids = new Set(), amounts = [];
    for (const work of report.works) {
      if (!plain(work) || !id(work.id) || !id(work.cashId) || work.id !== work.cashId || ids.has(work.cashId)) invalid('Identità dell’intervento mancante o duplicata.');
      ids.add(work.cashId);
      const selector = {agenda:'#agendaRows', parking:'#agenda .parking-section .card', archive:''}[work.source];
      if (selector === undefined || work.sourceSelector !== selector || !text(work.rowId, 128, work.source === 'archive') || (work.source === 'archive' && work.rowId !== '')) invalid('Origine dell’intervento non valida.');
      if (!isoDate(work.date) || work.date < report.period.start || work.date > report.period.end) invalid('Data dell’intervento fuori dal periodo del rapporto.');
      if (!text(work.plate, 500) || !text(work.vehicle, 2000) || !(text(work.km, 128) || (typeof work.km === 'number' && Number.isFinite(work.km) && work.km >= 0)) || !text(work.notes, 200000)) invalid('Dati del veicolo o note dell’intervento non validi.');
      if (!Array.isArray(work.lines) || !work.lines.length || work.lines.length > 20000) invalid('Lavorazioni del rapporto non valide.');
      const lineAmounts = [];
      for (const line of work.lines) {
        if (!plain(line) || !text(line.description, 200000, false)) invalid('Descrizione della lavorazione non valida.');
        lineAmounts.push(cents(line.amount));
      }
      const amount = cents(work.amount);
      if (amount !== sum(lineAmounts)) invalid('Il totale dell’intervento non coincide con le lavorazioni.');
      amounts.push(amount);
    }
    if (cents(report.total) !== sum(amounts)) invalid('Il totale del rapporto non coincide con gli interventi.');
    byId.set(report.id, report);
  }
  const invoiceIds = new Set(), invoiced = new Map(), cashOwners = new Map(), documentIds = new Map();
  for (const doc of documents) if (plain(doc)) documentIds.set(doc.id, (documentIds.get(doc.id) || 0) + 1);
  // Imported/single-work invoices already identify their work via cashLink.
  // Preserve legacy archives as-is; only a report conversion is rejected if
  // its work is occupied by another TD01, including an older cash-linked one.
  for (const doc of documents) if (doc?.type === 'TD01' && id(doc.cashLink)) {
    if (!cashOwners.has(doc.cashLink)) cashOwners.set(doc.cashLink, []);
    cashOwners.get(doc.cashLink).push(doc.id);
  }
  for (const doc of tagged) {
    if (!id(doc.id) || invoiceIds.has(doc.id) || documentIds.get(doc.id) !== 1) linkError('Identificativo fattura collegata mancante o duplicato.');
    invoiceIds.add(doc.id);
    if (doc.cashLink) linkError('La fattura da rapporto non può essere collegata anche al conto cassa di un singolo intervento.');
    if (!UUID.test(doc.sourceWorkReportId || '') || !Array.isArray(doc.sourceWorkIds) || !doc.sourceWorkIds.length || doc.sourceWorkIds.some(value => !id(value)) || new Set(doc.sourceWorkIds).size !== doc.sourceWorkIds.length) linkError('Collegamento fattura–rapporto non valido.');
    const report = byId.get(doc.sourceWorkReportId);
    const expected = report?.works.map(work => work.cashId).sort();
    if (!report || JSON.stringify([...doc.sourceWorkIds].sort()) !== JSON.stringify(expected)) linkError('La fattura deve riferirsi agli interventi del rapporto selezionato.');
    if (doc.type === 'TD24') {
      const months = new Set(report.works.map(work => work.date.slice(0, 7)));
      const month = months.size === 1 ? [...months][0] : '';
      const reportNumber = `RI-${report.id.replace(/-/g, '').slice(0, 17).toUpperCase()}`;
      if (!month || doc.deferredServiceMonth !== month || !isoDate(doc.date) || doc.date.slice(0, 7) !== month || doc.sourceWorkReportNumber !== reportNumber || doc.sourceWorkReportDate !== report.date || !String(doc.notes || '').includes(reportNumber) || !String(doc.notes || '').includes(report.date)) linkError('La TD24 deve riferirsi a interventi dello stesso mese e riportare il riferimento datato al rapporto.');
    }
    for (const workId of doc.sourceWorkIds) {
      if (invoiced.has(workId) || (cashOwners.get(workId) || []).some(owner => owner !== doc.id)) duplicate('Un intervento del rapporto è già incluso in un’altra fattura. Apri la fattura esistente.');
      invoiced.set(workId, doc.id);
    }
  }
}
