import { createRequire } from 'node:module';
import { hash } from './database.mjs';
import { HttpError } from './validation.mjs';

const invoices = createRequire(import.meta.url)('../fatturazione.js');
const KEY = 'officina.invoices.v1';
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

export function invoiceArchive(state) {
  let archive;
  try { archive = JSON.parse(state?.storage?.[KEY] || '{"documents":[]}'); }
  catch { fail(409, 'SDI_ARCHIVE', 'Archivio fatture non leggibile.'); }
  if (!Array.isArray(archive?.documents)) fail(409, 'SDI_ARCHIVE', 'Archivio fatture non valido.');
  const ids = new Set();
  for (const d of archive.documents) {
    if (!d || typeof d.id !== 'string' || ids.has(d.id)) fail(409, 'SDI_ARCHIVE', 'Identificativi fattura mancanti o duplicati.');
    ids.add(d.id);
  }
  return archive;
}

export function checkedInvoice(state, documentId, expectedDigest, shopVat) {
  shopVat = String(shopVat || '').replace(/^IT/i, '');
  const doc = invoiceArchive(state).documents.find(d => d.id === documentId);
  if (!doc) fail(404, 'SDI_DOCUMENT', 'Fattura non trovata nei dati salvati sul server.');
  if (doc.status !== 'prepared' || typeof doc.xml !== 'string' || !doc.xml || !doc.seller)
    fail(409, 'SDI_DRAFT', 'Confermare, numerare e salvare la fattura prima dell’invio.');
  if (!/^[a-f0-9]{64}$/.test(expectedDigest || '') || hash(doc.xml) !== expectedDigest)
    fail(409, 'SDI_STALE', 'La fattura sul server è diversa da quella visualizzata. Ricarica e verifica prima di inviare.');
  if (!/^\d{11}$/.test(shopVat || '') || doc.seller.vat !== shopVat)
    fail(409, 'SDI_SELLER', 'La partita IVA della fattura non corrisponde a SHOP_VAT del canale.');
  try {
    if (invoices.xml(doc, doc.seller) !== doc.xml) throw new Error();
  } catch { fail(409, 'SDI_XML_MISMATCH', 'I dati della fattura non corrispondono all’XML archiviato. Invio bloccato.'); }
  return { documentId: doc.id, xml: doc.xml, filename: doc.filename,
    fiscalKey: JSON.stringify([doc.seller.vat, doc.date.slice(0, 4), doc.type, doc.number]) };
}

// Called inside the shared-state write transaction. Browser imports and old
// tabs cannot rewrite or remove a document already handed to the channel.
export function guardSdiArchive(store, state) {
  const locked = store.bindings();
  if (!locked.length) return;
  const docs = new Map(invoiceArchive(state).documents.map(d => [d.id, d]));
  for (const binding of locked) {
    const d = docs.get(binding.documentId);
    try {
      if (!d || d.status !== 'prepared' || hash(d.xml || '') !== binding.digest ||
          invoices.xml(d, d.seller) !== d.xml) throw new Error();
    } catch { fail(409, 'SDI_DOCUMENT_LOCKED', 'Una fattura affidata al canale SdI non può essere modificata o eliminata. I pagamenti restano aggiornabili.'); }
  }
}

export function createSdiApi({ runtime, readState, env, assertWriter, session, body, send }) {
  return async function handle(req, res, path, auth) {
    if (!path.startsWith('/api/sdi/')) return false;
    const method = req.method;
    if (method === 'GET' && path === '/api/sdi/status') send(res, 200, runtime.status());
    else if (method === 'GET' && path === '/api/sdi/submissions') send(res, 200, { items: runtime.store.list() });
    else if (method === 'GET' && path === '/api/sdi/incoming') send(res, 200, { items: runtime.store.listIncoming() });
    else if (method === 'GET' && path === '/api/sdi/notifications') send(res, 200, { items: runtime.store.listNotifications() });
    else if (method === 'POST' && path === '/api/sdi/submissions') {
      assertWriter(auth);
      const data = await body(req, 4096), status = runtime.status();
      if (data.confirmed !== true || data.environment !== status.environment)
        fail(400, 'SDI_CONFIRMATION', 'Confermare esplicitamente il documento e l’ambiente di invio.');
      if (typeof data.documentId !== 'string' || data.documentId.length > 128)
        fail(400, 'SDI_DOCUMENT', 'Identificativo fattura non valido.');
      const get = () => checkedInvoice(readState(), data.documentId, data.expectedDigest, env.SHOP_VAT);
      const saved = get();
      const result = await runtime.enqueue({ ...saved, beforeEnqueue: () => {
        // Async XSD/certificate checks may have allowed another request to
        // change this invoice: validate again immediately before persistence.
        const active = session(req);
        if (!active) fail(401, 'UNAUTHENTICATED', 'Sessione scaduta durante la verifica. Accedere di nuovo.');
        assertWriter(active);
        const latest = get();
        if (latest.fiscalKey !== saved.fiscalKey) fail(409, 'SDI_STALE', 'Fattura modificata durante la verifica.');
      } }, auth);
      send(res, 202, result);
    } else {
      const match = path.match(/^\/api\/sdi\/(submissions|incoming|notifications)\/([a-zA-Z0-9_-]{1,128})(\/original)?$/);
      if (!match || method !== 'GET') fail(404, 'NOT_FOUND', 'Operazione SdI non trovata.');
      const [, collection, id, original] = match;
      if (original) {
        const kind = { submissions: 'outgoing', incoming: 'incoming', notifications: 'notification' }[collection];
        const file = runtime.store.original(kind, id);
        const name = String(file.filename || 'documento.xml').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
        const mime = /^(application\/xml|text\/xml|application\/pkcs7-mime)$/.test(file.mime) ? file.mime : 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime, 'content-length': file.bytes.length,
          'content-disposition': `attachment; filename="${name}"` });
        res.end(file.bytes);
      } else {
        if (collection === 'notifications') fail(404, 'NOT_FOUND', 'Scaricare la notifica originale dal dettaglio invio.');
        send(res, 200, collection === 'submissions' ? runtime.store.detail(id) : runtime.store.incomingDetail(id));
      }
    }
    return true;
  };
}
