import { randomUUID } from 'node:crypto';
import { audit, hash, transaction } from './database.mjs';
import { HttpError } from './validation.mjs';

const MAX_CENTS = 1_000_000_000_000;
const CREDIT_TYPES = new Set(['TD04','TD08']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invoiceFields = new Set(['supplierName','supplierTaxId','number','issueDate','dueDate','totalCents','notes']);
const error = (status, code, message) => { throw new HttpError(status, code, message); };
const romeDate = time => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
const plusDays = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (start, end) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);

function text(value, label, max, required = false) {
  if (value === null && !required) return '';
  if (typeof value !== 'string' || value.length > max) error(400, 'SUPPLIER_INPUT', `${label} non valido.`);
  const clean = value.trim();
  if (required && !clean) error(400, 'SUPPLIER_INPUT', `${label} obbligatorio.`);
  return clean;
}
function date(value, label, optional = false) {
  if (optional && (value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) error(400, 'SUPPLIER_INPUT', `${label} non valida.`);
  return value;
}
function cents(value, label = 'Importo') {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CENTS) error(400, 'SUPPLIER_INPUT', `${label} non valido: usare centesimi interi positivi.`);
  return value;
}
function mutation(value) {
  if (typeof value !== 'string' || !UUID.test(value)) error(400, 'SUPPLIER_INPUT', 'Identificativo operazione UUID non valido.');
  return value.toLowerCase();
}
function shape(data, editing = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) error(400, 'SUPPLIER_INPUT', 'Dati fattura non validi.');
  const allowed = editing ? new Set([...invoiceFields, 'expectedVersion','verified']) : new Set([...invoiceFields, 'mutationId']);
  if (Object.keys(data).some(key => !allowed.has(key))) error(400, 'SUPPLIER_INPUT', 'Campo fattura non previsto.');
  if (!editing && [...invoiceFields].some(key => !Object.hasOwn(data,key) && !['supplierTaxId','dueDate','notes'].includes(key))) error(400, 'SUPPLIER_INPUT', 'Dati fattura incompleti.');
  if (editing && ![...invoiceFields,'verified'].some(key => Object.hasOwn(data,key))) error(400, 'SUPPLIER_INPUT', 'Indicare almeno un campo da modificare.');
  const clean = {};
  if (Object.hasOwn(data,'supplierName')) clean.supplierName = text(data.supplierName, 'Fornitore', 200, true);
  if (Object.hasOwn(data,'supplierTaxId')) {
    const id = text(data.supplierTaxId, 'Partita IVA o codice fiscale', 32);
    if (id && !/^[A-Za-z0-9 ./_-]+$/.test(id)) error(400, 'SUPPLIER_INPUT', 'Partita IVA o codice fiscale non valido.');
    clean.supplierTaxId = id ? id.toUpperCase() : null;
  }
  if (Object.hasOwn(data,'number')) clean.number = text(data.number, 'Numero fattura', 80, true);
  if (Object.hasOwn(data,'issueDate')) clean.issueDate = date(data.issueDate, 'Data fattura');
  if (Object.hasOwn(data,'dueDate')) clean.dueDate = date(data.dueDate, 'Scadenza', true);
  if (Object.hasOwn(data,'totalCents')) clean.totalCents = editing && data.totalCents === null ? null : cents(data.totalCents, 'Totale fattura');
  if (Object.hasOwn(data,'notes')) clean.notes = text(data.notes, 'Note', 4000);
  if (editing && Object.hasOwn(data,'verified')) {
    if (data.verified !== true) error(400, 'SUPPLIER_INPUT', 'La conferma richiede verified=true.');
    clean.verified = true;
  }
  if (!editing) {
    clean.supplierTaxId ??= null;
    clean.dueDate ??= null;
    clean.notes ??= '';
  }
  return clean;
}

const itemSql = `SELECT i.*,
  COALESCE((SELECT SUM(p.amount_cents) FROM supplier_invoice_payments p WHERE p.invoice_id=i.id),0) AS paid_cents,
  EXISTS(SELECT 1 FROM supplier_invoice_originals o WHERE o.invoice_id=i.id) AS has_original
  FROM supplier_invoices i`;

function existingDocument(db, { supplierTaxId, supplierName, number, issueDate }, excludedId = null) {
  // A manually entered invoice may lack a tax identifier. Match its supplier
  // name too, so a later PEC delivery does not count the same debt twice.
  return db.prepare(`SELECT id FROM supplier_invoices WHERE number=? AND issue_date=?
    AND (? IS NULL OR id<>?)
    AND ((? IS NOT NULL AND supplier_tax_id=?)
      OR ((? IS NULL OR supplier_tax_id IS NULL) AND lower(trim(supplier_name))=lower(trim(?))))`)
    .get(number, issueDate, excludedId, excludedId, supplierTaxId, supplierTaxId,
      supplierTaxId, supplierName);
}

export function supplierInvoiceStore(db, now = Date.now) {
  const revision = () => db.prepare('SELECT revision FROM supplier_ledger_meta WHERE id=1').get().revision;
  const bump = () => { db.prepare('UPDATE supplier_ledger_meta SET revision=revision+1 WHERE id=1').run(); return revision(); };
  function item(row) {
    if (!row) return null;
    const paidCents = Number(row.paid_cents);
    const outstandingCents = row.total_cents === null ? null : row.total_cents - paidCents;
    const today = romeDate(now());
    const status = !row.verified ? 'review' : outstandingCents === 0 ? 'paid' : row.due_date && row.due_date < today ? 'overdue' : paidCents > 0 ? 'partial' : 'open';
    return {
      id: row.id, version: row.version, source: row.source, verified: !!row.verified, documentType: row.document_type,
      supplierName: row.supplier_name, supplierTaxId: row.supplier_tax_id,
      number: row.number, issueDate: row.issue_date, dueDate: row.due_date,
      totalCents: row.total_cents, paidCents, outstandingCents, status,
      notes: row.notes, hasOriginal: !!row.has_original
    };
  }
  function getRow(id) {
    if (typeof id !== 'string' || !UUID.test(id)) error(404, 'SUPPLIER_NOT_FOUND', 'Fattura fornitore non trovata.');
    const row = db.prepare(`${itemSql} WHERE i.id=?`).get(id.toLowerCase());
    if (!row) error(404, 'SUPPLIER_NOT_FOUND', 'Fattura fornitore non trovata.');
    return row;
  }
  function detail(id) {
    const record = item(getRow(id));
    record.payments = db.prepare('SELECT id,amount_cents AS amountCents,paid_at AS paidAt,method,reference,created_at AS createdAt FROM supplier_invoice_payments WHERE invoice_id=? ORDER BY paid_at DESC,created_at DESC,id DESC').all(record.id);
    return record;
  }
  function list() {
    const items = db.prepare(`${itemSql} ORDER BY CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date ASC, i.issue_date DESC, i.id DESC`).all().map(item);
    const today = romeDate(now()), soon = plusDays(today, 7);
    const paymentDelays = db.prepare(`SELECT p.amount_cents AS amountCents,p.paid_at AS paidAt,i.issue_date AS issueDate
      FROM supplier_invoice_payments p JOIN supplier_invoices i ON i.id=p.invoice_id
      WHERE i.verified=1 AND COALESCE(upper(i.document_type),'') NOT IN ('TD04','TD08')`).all();
    let paidAmount = 0, weightedPaymentDays = 0;
    for (const payment of paymentDelays) {
      const amount = Number(payment.amountCents) || 0;
      const days = Math.max(0, daysBetween(payment.issueDate, payment.paidAt));
      paidAmount += amount;
      weightedPaymentDays += days * amount;
    }
    const summary = { toPayCents: 0, overdueCents: 0, dueSoonCents: 0, countOpen: 0, pendingReviewCount: 0,
      averagePaymentDays: paidAmount ? weightedPaymentDays / paidAmount : null, paymentCount: paymentDelays.length };
    for (const entry of items) {
      if (!entry.verified) { summary.pendingReviewCount += 1; continue; }
      if (!entry.outstandingCents) continue;
      summary.countOpen += 1;
      summary.toPayCents += entry.outstandingCents;
      if (entry.dueDate && entry.dueDate < today) summary.overdueCents += entry.outstandingCents;
      else if (entry.dueDate && entry.dueDate <= soon) summary.dueSoonCents += entry.outstandingCents;
    }
    let sync = null;
    const rawSync = db.prepare("SELECT value FROM metadata WHERE key='pec-sync-status'").get()?.value;
    if (rawSync) {
      try {
        const value = JSON.parse(rawSync);
        const stamp = value => Number.isSafeInteger(value) && value >= 0 ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? value : null;
        if (value && typeof value === 'object' && !Array.isArray(value)) sync = {
          lastRunAt: stamp(value.lastRunAt),
          lastSuccessAt: stamp(value.lastSuccessAt),
          imported: Number.isSafeInteger(value.imported) && value.imported >= 0 ? value.imported : 0,
          issues: Number.isSafeInteger(value.issues) && value.issues >= 0 ? value.issues : 0,
          errorCode: typeof value.errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.errorCode) ? value.errorCode : null
        };
      } catch { /* Ignore a malformed collector status without exposing it. */ }
    }
    return { items, summary, revision: revision(), sync };
  }
  function replayOrNull(id, digest) {
    const receipt = db.prepare('SELECT request_hash,result FROM supplier_invoice_mutations WHERE mutation_id=?').get(id);
    if (!receipt) return null;
    if (receipt.request_hash !== digest) error(409, 'IDEMPOTENCY_CONFLICT', 'Identificativo già usato per un’altra operazione.');
    return { ...JSON.parse(receipt.result), replayed: true };
  }
  function receipt(id, digest, action, result, auth) {
    db.prepare('INSERT INTO supplier_invoice_mutations(mutation_id,request_hash,action,result,user_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, digest, action, JSON.stringify(result), auth.id, now());
  }
  function create(auth, data) {
    const fields = shape(data);
    const mutationId = mutation(data.mutationId);
    const digest = hash(JSON.stringify(['create',fields]));
    return transaction(db, () => {
      const previous = replayOrNull(mutationId, digest);
      if (previous) return previous;
      if (fields.dueDate && fields.dueDate < fields.issueDate) error(400, 'SUPPLIER_INPUT', 'La scadenza precede la data della fattura.');
      if (existingDocument(db, fields)) error(409, 'SUPPLIER_DUPLICATE', 'Questa fattura del fornitore è già registrata.');
      const id = randomUUID(), time = now();
      db.prepare(`INSERT INTO supplier_invoices(id,version,source,source_key,document_type,supplier_name,supplier_tax_id,number,issue_date,due_date,total_cents,verified,notes,created_at,updated_at)
        VALUES(?,1,'manual',NULL,NULL,?,?,?,?,?,?,1,?,?,?)`)
        .run(id, fields.supplierName, fields.supplierTaxId, fields.number, fields.issueDate, fields.dueDate, fields.totalCents, fields.notes, time, time);
      const nextRevision = bump();
      const result = { item: detail(id), revision: nextRevision };
      receipt(mutationId, digest, 'supplier-invoice-created', result, auth);
      audit(db, auth, 'supplier-invoice-created', nextRevision, { invoiceId: id });
      return result;
    });
  }
  function edit(auth, id, data) {
    const fields = shape(data, true);
    if (!Number.isSafeInteger(data.expectedVersion) || data.expectedVersion < 1) error(400, 'SUPPLIER_INPUT', 'Versione fattura non valida.');
    return transaction(db, () => {
      const old = getRow(id);
      if (old.version !== data.expectedVersion) error(409, 'SUPPLIER_CONFLICT', 'La fattura è cambiata su un altro dispositivo. Ricarica i dati prima di modificarla.');
      const next = { supplierName: old.supplier_name, supplierTaxId: old.supplier_tax_id, number: old.number, issueDate: old.issue_date, dueDate: old.due_date, totalCents: old.total_cents, notes: old.notes, verified: !!old.verified, ...fields };
      if (next.dueDate && next.dueDate < next.issueDate) error(400, 'SUPPLIER_INPUT', 'La scadenza precede la data della fattura.');
      if (CREDIT_TYPES.has(old.document_type) && next.verified) error(409, 'SUPPLIER_CREDIT_NOTE', 'La nota di credito non è una fattura da pagare e richiede una gestione separata.');
      if (next.verified && (next.totalCents === null || !Number.isSafeInteger(next.totalCents) || next.totalCents < 1)) error(400, 'SUPPLIER_INPUT', 'Indicare un totale valido prima di confermare la fattura.');
      if (old.verified && next.totalCents === null) error(400, 'SUPPLIER_INPUT', 'Una fattura confermata deve avere un totale valido.');
      if (next.totalCents < old.paid_cents) error(409, 'SUPPLIER_PAID', 'Il totale non può essere inferiore ai pagamenti già registrati.');
      if (existingDocument(db, next, old.id)) error(409, 'SUPPLIER_DUPLICATE', 'Questa fattura del fornitore è già registrata.');
      db.prepare(`UPDATE supplier_invoices SET supplier_name=?,supplier_tax_id=?,number=?,issue_date=?,due_date=?,total_cents=?,verified=?,notes=?,version=version+1,updated_at=? WHERE id=?`)
        .run(next.supplierName, next.supplierTaxId, next.number, next.issueDate, next.dueDate, next.totalCents, next.verified ? 1 : 0, next.notes, now(), old.id);
      const nextRevision = bump();
      const result = { item: detail(old.id), revision: nextRevision };
      audit(db, auth, 'supplier-invoice-updated', nextRevision, { invoiceId: old.id });
      return result;
    });
  }
  function pay(auth, id, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['mutationId','amountCents','paidAt','method','reference'].includes(key))) error(400, 'SUPPLIER_INPUT', 'Dati pagamento non validi.');
    const mutationId = mutation(data.mutationId);
    const payment = { amountCents: cents(data.amountCents), paidAt: date(data.paidAt, 'Data pagamento'), method: text(data.method ?? '', 'Metodo', 40), reference: text(data.reference ?? '', 'Riferimento', 120) };
    const digest = hash(JSON.stringify(['payment',id,payment]));
    return transaction(db, () => {
      const previous = replayOrNull(mutationId, digest);
      if (previous) return previous;
      const old = getRow(id);
      if (!old.verified || old.total_cents === null) error(409, 'SUPPLIER_UNVERIFIED', 'Verifica la fattura e il suo importo prima di registrare pagamenti.');
      if (payment.amountCents > old.total_cents - old.paid_cents) error(409, 'SUPPLIER_OVERPAYMENT', 'Il pagamento supera il saldo residuo. Ricarica i dati e verifica.');
      db.prepare('INSERT INTO supplier_invoice_payments(id,invoice_id,amount_cents,paid_at,method,reference,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), old.id, payment.amountCents, payment.paidAt, payment.method, payment.reference, now());
      db.prepare('UPDATE supplier_invoices SET version=version+1,updated_at=? WHERE id=?').run(now(), old.id);
      const nextRevision = bump();
      const result = { item: detail(old.id), revision: nextRevision };
      receipt(mutationId, digest, 'supplier-invoice-payment', result, auth);
      audit(db, auth, 'supplier-invoice-payment', nextRevision, { invoiceId: old.id, amountCents: payment.amountCents });
      return result;
    });
  }
  function original(id) {
    const row = getRow(id);
    const file = db.prepare('SELECT filename,mime,sha256,bytes FROM supplier_invoice_originals WHERE invoice_id=?').get(row.id);
    if (!file) error(404, 'SUPPLIER_ORIGINAL_MISSING', 'Originale della fattura non disponibile.');
    return file;
  }
  return { list, detail, create, edit, pay, original, revision };
}

// Used only by the trusted PEC collector. The HTTP API has no raw upload route.
export function importPecInvoice(db, data, now = Date.now) {
  return importExternalInvoice(db, data, now, 'pec', false);
}

// The SdI inbox calls this inside its own transaction, so linking the original
// delivery and the supplier ledger is committed together. Never exposed to HTTP.
export function importSdiInvoiceInTransaction(db, data, now = Date.now) {
  return importExternalInvoice(db, data, now, 'sdi', true);
}

function importExternalInvoice(db, data, now, source, inTransaction) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) error(400, 'SUPPLIER_INPUT', 'Fattura ricevuta non valida.');
  const sourceKey = text(data.sourceKey, 'Chiave ricezione', 300, true);
  if (/[\u0000-\u001f\u007f]/.test(sourceKey)) error(400, 'SUPPLIER_INPUT', 'Chiave ricezione non valida.');
  const supplierName = text(data.supplierName, 'Fornitore', 200, true);
  const supplierTaxIdText = text(data.supplierTaxId ?? '', 'Partita IVA o codice fiscale', 32);
  if (supplierTaxIdText && !/^[A-Za-z0-9 ./_-]+$/.test(supplierTaxIdText)) error(400, 'SUPPLIER_INPUT', 'Partita IVA o codice fiscale non valido.');
  const supplierTaxId = supplierTaxIdText ? supplierTaxIdText.toUpperCase() : null;
  const number = text(data.number, 'Numero fattura', 80, true);
  const issueDate = date(data.issueDate, 'Data fattura');
  const dueDate = date(data.dueDate ?? null, 'Scadenza', true);
  if (dueDate && dueDate < issueDate) error(400, 'SUPPLIER_INPUT', 'La scadenza precede la data della fattura.');
  const totalCents = data.totalCents === null || data.totalCents === undefined ? null : cents(data.totalCents, 'Totale fattura');
  const documentType = text(data.documentType ?? '', 'Tipo documento', 8) || null;
  if (documentType && !/^TD\d{2}$/.test(documentType)) error(400, 'SUPPLIER_INPUT', 'Tipo documento non valido.');
  if (!Buffer.isBuffer(data.originalBytes) || !data.originalBytes.length || data.originalBytes.length > 10 * 1024 * 1024) error(400, 'SUPPLIER_INPUT', 'Originale XML non valido o troppo grande.');
  const filename = text(data.filename, 'Nome file XML', 255, true);
  if (/[\\/\u0000-\u001f\u007f]/.test(filename) || !/\.xml$/i.test(filename)) error(400, 'SUPPLIER_INPUT', 'Nome file XML non valido.');
  const store = supplierInvoiceStore(db, now);
  const originalHash = hash(data.originalBytes);
  const duplicate = id => {
    const original = db.prepare('SELECT sha256 FROM supplier_invoice_originals WHERE invoice_id=?').get(id);
    // A fiscal match is not enough: the newly received original could be a
    // conflicting invoice. Keep the previous ledger and all its payments intact.
    const conflict = !original || original.sha256 !== originalHash;
    // PEC retains the message in its mailbox and already reports a fiscal
    // duplicate as an issue; SdI must instead leave its durable inbox in REVIEW.
    if (conflict && source === 'sdi') error(409, 'SUPPLIER_SOURCE_CONFLICT', 'Esiste già una fattura con la stessa identità fiscale ma un originale diverso o assente. Verificare gli originali; dati e pagamenti esistenti sono conservati.');
    return { item: store.detail(id), revision: store.revision(), imported: false, conflict };
  };
  const importRecord = () => {
    const bySource = db.prepare('SELECT id FROM supplier_invoices WHERE source_key=?').get(sourceKey);
    if (bySource) return duplicate(bySource.id);
    const byDocument = existingDocument(db, { supplierTaxId, supplierName, number, issueDate });
    if (byDocument) return duplicate(byDocument.id);
    const id = randomUUID(), time = now();
    db.prepare(`INSERT INTO supplier_invoices(id,version,source,source_key,document_type,supplier_name,supplier_tax_id,number,issue_date,due_date,total_cents,verified,notes,created_at,updated_at)
      VALUES(?,1,?,?,?,?,?,?,?,?,?,0,'',?,?)`)
      .run(id, source, sourceKey, documentType, supplierName, supplierTaxId, number, issueDate, dueDate, totalCents, time, time);
    db.prepare('INSERT INTO supplier_invoice_originals(invoice_id,filename,mime,sha256,bytes,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, filename, 'application/xml', originalHash, data.originalBytes, time);
    db.prepare('UPDATE supplier_ledger_meta SET revision=revision+1 WHERE id=1').run();
    const nextRevision = store.revision();
    audit(db, null, `supplier-invoice-${source}-imported`, nextRevision, { invoiceId: id });
    return { item: store.detail(id), revision: nextRevision, imported: true };
  };
  return inTransaction ? importRecord() : transaction(db, importRecord);
}
