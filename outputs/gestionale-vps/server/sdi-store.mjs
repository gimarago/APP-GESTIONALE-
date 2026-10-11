import { randomUUID, randomBytes } from 'node:crypto';
import { audit, hash, transaction } from './database.mjs';
import { importSdiInvoiceInTransaction } from './supplier-invoices.mjs';
import { HttpError } from './validation.mjs';

const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const OUTCOMES = new Set(['SCARTO','CONSEGNA','MANCATA_CONSEGNA','ESITO','DECORRENZA_TERMINI','ATTESTAZIONE_TRASMISSIONE']);
const text = (value, label, max = 255) => {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(400,'SDI_INPUT',`${label} non valido.`);
  return value;
};
const filename = value => {
  const name = text(value, 'Nome file');
  if (/[\\/]/.test(name)) fail(400,'SDI_INPUT','Nome file non valido.');
  return name;
};
const identifier = value => {
  const id = text(String(value ?? ''), 'Identificativo SdI', 32);
  if (!/^[1-9][0-9]*$/.test(id)) fail(400,'SDI_INPUT','Identificativo SdI non valido.');
  return id;
};
function bytes(value, label, max = 12 * 1024 * 1024) {
  if (typeof value === 'string') value = Buffer.from(value, 'utf8');
  if (!Buffer.isBuffer(value) || !value.length || value.length > max) fail(400,'SDI_INPUT',`${label} non valido o troppo grande.`);
  return value;
}
function payload(value) {
  if (typeof value !== 'string' || !value.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(400,'SDI_INPUT','Allegato SdI non valido.');
  return bytes(Buffer.from(value, 'base64'), 'Allegato SdI');
}
const cloneJson = value => JSON.parse(JSON.stringify(value));
const OUTGOING_COLUMNS = 'id,environment,document_id,filename,digest,fiscal_key,metadata,state,sdi_id,fiscal_state,conflict,attempts,created_at,updated_at,error_code,error_message';
const INCOMING_COLUMNS = 'id,environment,sdi_id,filename,digest,state,conflict,reason,supplier_invoice_id,created_at,updated_at,(metadata IS NOT NULL) AS has_metadata';

// All records live in the same backed-up SQLite database as the application.
// Network calls must happen outside these short IMMEDIATE transactions.
export function createSdiStore(db, { environment, now = Date.now } = {}) {
  if (!['test','production'].includes(environment)) fail(400,'SDI_ENVIRONMENT','Ambiente SdI non valido.');
  function outboxRow(id) {
    const row = db.prepare('SELECT * FROM sdi_outbox WHERE id=? AND environment=?').get(id, environment);
    if (!row) fail(404,'SDI_NOT_FOUND','Invio SdI non trovato.');
    return row;
  }
  function outgoing(row) {
    return { id: row.id, environment: row.environment, documentId: row.document_id, filename: row.filename,
      digest: row.digest, fiscalKey: row.fiscal_key, metadata: JSON.parse(row.metadata), state: row.state,
      sdiId: row.sdi_id, fiscalState: row.fiscal_state, conflict: !!row.conflict, attempts: row.attempts,
      createdAt: row.created_at, updatedAt: row.updated_at, errorCode: row.error_code, errorMessage: row.error_message };
  }
  function events(id) {
    outboxRow(id);
    return db.prepare(`SELECT id,filename,outcome,state,reason,created_at AS createdAt,sdi_id AS sdiId,parsed
      FROM sdi_notifications WHERE outbox_id=? AND environment=? ORDER BY created_at,id`).all(id,environment)
      .map(row => ({ ...row, parsed: JSON.parse(row.parsed) }));
  }
  function detail(id) {
    const entry = outgoing(outboxRow(id));
    entry.events = events(id);
    entry.history = db.prepare('SELECT id,started_at AS startedAt,finished_at AS finishedAt,result FROM sdi_outbox_attempts WHERE outbox_id=? ORDER BY started_at,id').all(id)
      .map(row => ({ ...row, result: row.result ? JSON.parse(row.result) : null }));
    return entry;
  }
  const list = () => db.prepare(`SELECT ${OUTGOING_COLUMNS} FROM sdi_outbox WHERE environment=? ORDER BY created_at DESC,id DESC`).all(environment).map(outgoing);
  const bindings = () => db.prepare('SELECT document_id,digest,fiscal_key FROM sdi_outbox').all()
    .map(row => ({ documentId:row.document_id, digest:row.digest, fiscalKey:row.fiscal_key }));
  function assertEnvironment() {
    const other = db.prepare('SELECT 1 FROM sdi_outbox WHERE environment<>? UNION ALL SELECT 1 FROM sdi_inbox WHERE environment<>? UNION ALL SELECT 1 FROM sdi_notifications WHERE environment<>? LIMIT 1').get(environment,environment,environment);
    if (other) fail(409,'SDI_ENVIRONMENT_LOCKED','Questo archivio contiene documenti di un altro ambiente SdI. Usare un archivio separato per collaudo e produzione.');
  }
  function bindIdentity(identity) {
    const value = { environment, shopVat: text(identity.shopVat,'Partita IVA',32),
      accreditationReference: text(identity.accreditationReference,'Accreditamento',200), endpointHost: text(identity.endpointHost,'Endpoint',253).toLowerCase() };
    const canonical = JSON.stringify(value);
    return transaction(db, () => {
      assertEnvironment();
      const previous = db.prepare('SELECT identity FROM sdi_channel_identity WHERE environment=?').get(environment);
      if (previous?.identity === canonical) return value;
      const used = db.prepare(`SELECT 1 FROM sdi_outbox WHERE environment=? UNION ALL SELECT 1 FROM sdi_inbox WHERE environment=? UNION ALL SELECT 1 FROM sdi_notifications WHERE environment=? LIMIT 1`).get(environment,environment,environment);
      if (previous && used) fail(409,'SDI_IDENTITY_LOCKED','L’identità del canale è già associata a documenti archiviati. Usare un archivio separato.');
      db.prepare('INSERT INTO sdi_channel_identity(environment,identity) VALUES(?,?) ON CONFLICT(environment) DO UPDATE SET identity=excluded.identity').run(environment,canonical);
      return value;
    });
  }
  function markEventConflict(event, row, reason) {
    db.prepare("UPDATE sdi_notifications SET state='CONFLICT',reason=?,outbox_id=? WHERE id=?").run(reason,row?.id ?? null,event.id);
    if (row) db.prepare('UPDATE sdi_outbox SET conflict=1,updated_at=? WHERE id=?').run(now(),row.id);
  }
  function bindEventConflict(event) {
    const rows = db.prepare('SELECT id FROM sdi_outbox WHERE environment=? AND (filename=? OR sdi_id=? OR id=?)')
      .all(environment,event.invoice_filename,event.sdi_id,event.outbox_id || '');
    db.prepare("UPDATE sdi_notifications SET state='CONFLICT',reason=?,outbox_id=? WHERE id=?")
      .run(event.reason || 'La stessa notifica è arrivata con contenuto diverso.',event.outbox_id || rows[0]?.id || null,event.id);
    for (const row of rows) db.prepare('UPDATE sdi_outbox SET conflict=1,updated_at=? WHERE id=?').run(now(),row.id);
  }
  function reconcile(event) {
    if (event.state === 'CONFLICT') { bindEventConflict(event); return; }
    if (event.state !== 'UNMATCHED') return;
    const byId = db.prepare('SELECT * FROM sdi_outbox WHERE environment=? AND sdi_id=?').get(environment,event.sdi_id);
    const byName = db.prepare('SELECT * FROM sdi_outbox WHERE environment=? AND filename=?').get(environment,event.invoice_filename);
    if (!byId && !byName) return;
    const row = byName || byId;
    if ((byId && byId.filename !== event.invoice_filename) || (byName?.sdi_id && byName.sdi_id !== event.sdi_id) || (byId && byName && byId.id !== byName.id)) {
      markEventConflict(event,row,'Identificativo SdI e nome file non corrispondono entrambi all’invio.');
      if (byId && byId.id !== row.id) db.prepare('UPDATE sdi_outbox SET conflict=1,updated_at=? WHERE id=?').run(now(),byId.id);
      return;
    }
    const parsed = JSON.parse(event.parsed);
    if (parsed.fileHash != null && (typeof parsed.fileHash !== 'string' || parsed.fileHash.toLowerCase() !== row.digest)) {
      markEventConflict(event,row,'L’impronta della fattura nella notifica non coincide con l’originale archiviato.');
      return;
    }
    if (row.state === 'TRANSPORT_REJECTED') {
      markEventConflict(event,row,'Notifica ricevuta per un tentativo rifiutato dal trasporto: verifica necessaria.');
      return;
    }
    if (row.state === 'READY') {
      // A callback may precede the HTTP response, but cannot legitimately precede
      // our first send. Keep it unmatched until a claim/response can corroborate it.
      return;
    }
    const outcomes = db.prepare("SELECT outcome,parsed FROM sdi_notifications WHERE outbox_id=? AND state='APPLIED'").all(row.id);
    const incompatible = (event.outcome === 'SCARTO' && outcomes.some(e => e.outcome !== 'SCARTO')) ||
      (event.outcome !== 'SCARTO' && outcomes.some(e => e.outcome === 'SCARTO'));
    const contradictoryResult = event.outcome === 'ESITO' && outcomes.some(e => e.outcome === 'ESITO' && JSON.parse(e.parsed).recipientOutcome !== parsed.recipientOutcome);
    if (incompatible || contradictoryResult) { markEventConflict(event,row,'Notifica incompatibile con un esito già archiviato.'); return; }
    db.prepare("UPDATE sdi_notifications SET state='APPLIED',outbox_id=? WHERE id=?").run(row.id,event.id);
    const ranking = { PENDING:0, MANCATA_CONSEGNA:1, ATTESTAZIONE_TRASMISSIONE:2, CONSEGNA:3, DECORRENZA_TERMINI:4, ESITO:5, SCARTO:6 };
    const fiscalState = (ranking[event.outcome] ?? 0) >= (ranking[row.fiscal_state] ?? 0) ? event.outcome : row.fiscal_state;
    db.prepare("UPDATE sdi_outbox SET state='SDI_RECEIVED',sdi_id=?,fiscal_state=?,updated_at=? WHERE id=?").run(event.sdi_id,fiscalState,now(),row.id);
  }
  function reconcileFor(row) {
    const pending = db.prepare("SELECT * FROM sdi_notifications WHERE environment=? AND state IN ('UNMATCHED','CONFLICT') AND (invoice_filename=? OR sdi_id=?) ORDER BY created_at,id").all(environment,row.filename,row.sdi_id || '');
    for (const event of pending) reconcile(event);
  }
  function enqueue(data, auth = null) {
    const documentId = text(data.documentId,'Documento',200), sourceFilename = filename(data.filename);
    const xml = bytes(data.xml,'XML fattura'), digest = hash(xml), fiscalKey = text(data.fiscalKey,'Identità fiscale',500);
    if (data.digest !== digest) fail(409,'SDI_DIGEST_CHANGED','Il contenuto della fattura è cambiato. Ricaricare il documento.');
    const metadata = JSON.stringify({ ...(data.metadata || {}), sourceFilename });
    if (metadata.length > 16_000) fail(400,'SDI_INPUT','Metadati del documento troppo grandi.');
    return transaction(db, () => {
      assertEnvironment();
      const old = db.prepare('SELECT * FROM sdi_outbox WHERE environment=? AND document_id=?').get(environment,documentId);
      if (old) {
        if (old.digest !== digest || old.fiscal_key !== fiscalKey || JSON.parse(old.metadata).sourceFilename !== sourceFilename) fail(409,'SDI_IMMUTABLE','Questa fattura è già archiviata nel canale SdI e non può essere sostituita.');
        return { ...outgoing(old), duplicate: true };
      }
      if (db.prepare('SELECT 1 FROM sdi_outbox WHERE environment=? AND (fiscal_key=? OR digest=?)').get(environment,fiscalKey,digest)) fail(409,'SDI_DUPLICATE','Il documento fiscale risulta già presente nel canale SdI.');
      let transportFilename = sourceFilename;
      const parts = /^([A-Z]{2}[A-Za-z0-9]{1,28})_([A-Za-z0-9]+)\.xml$/.exec(sourceFilename);
      if (!parts) fail(400,'SDI_INPUT','Nome file fattura non valido per SdI.');
      if (parts[2].length > 5) {
        do { transportFilename = `${parts[1]}_${randomBytes(4).readUInt32BE(0).toString(36).slice(-5).padStart(5,'0')}.xml`; }
        while (db.prepare('SELECT 1 FROM sdi_outbox WHERE environment=? AND filename=?').get(environment,transportFilename));
      }
      if (db.prepare('SELECT 1 FROM sdi_outbox WHERE environment=? AND filename=?').get(environment,transportFilename)) fail(409,'SDI_FILENAME_USED','Nome file già usato da un altro invio.');
      const id = randomUUID(), time = now();
      db.prepare(`INSERT INTO sdi_outbox(id,environment,document_id,filename,digest,fiscal_key,xml,metadata,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'READY',?,?)`)
        .run(id,environment,documentId,transportFilename,digest,fiscalKey,xml,metadata,time,time);
      audit(db,auth,'sdi-enqueued',null,{ id, environment, digest });
      return outgoing(outboxRow(id));
    });
  }
  function claim() {
    return transaction(db, () => {
      const row = db.prepare("SELECT * FROM sdi_outbox WHERE environment=? AND state='READY' AND conflict=0 ORDER BY created_at,id LIMIT 1").get(environment);
      if (!row) return null;
      // Conflicts can arrive before the invoice is enqueued. Bind them before
      // starting any transmission; their original must never silently win.
      reconcileFor(row);
      if (outboxRow(row.id).conflict) return null;
      const claimToken = randomUUID(), time = now();
      db.prepare("UPDATE sdi_outbox SET state='IN_FLIGHT',claim_token=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='READY'").run(claimToken,time,row.id);
      db.prepare('INSERT INTO sdi_outbox_attempts(id,outbox_id,started_at) VALUES(?,?,?)').run(claimToken,row.id,time);
      reconcileFor(outboxRow(row.id));
      const current = outboxRow(row.id);
      // A previously archived authenticated receipt can prove this exact file
      // was already received. Never send it a second time.
      if (current.state !== 'IN_FLIGHT' || current.conflict) {
        if (current.state === 'IN_FLIGHT') db.prepare("UPDATE sdi_outbox SET state='UNKNOWN',error_code='SDI_NOTIFICATION_CONFLICT',updated_at=? WHERE id=?").run(now(),row.id);
        db.prepare('UPDATE sdi_outbox_attempts SET finished_at=?,result=? WHERE id=?').run(now(),JSON.stringify({ state:outboxRow(row.id).state, code:current.conflict ? 'SDI_NOTIFICATION_CONFLICT' : 'ALREADY_ACKNOWLEDGED', sdiId:current.sdi_id }),claimToken);
        return null;
      }
      return { ...outgoing(current), claimToken, xml: Buffer.from(current.xml) };
    });
  }
  function finish(id, result) {
    if (!['SDI_RECEIVED','TRANSPORT_REJECTED','UNKNOWN'].includes(result.state)) fail(400,'SDI_INPUT','Esito del trasporto non valido.');
    const sdiId = result.sdiId == null ? null : identifier(result.sdiId);
    if (result.state === 'SDI_RECEIVED' && !sdiId) fail(400,'SDI_INPUT','Identificativo SdI richiesto.');
    return transaction(db, () => {
      const row = outboxRow(id);
      if (!result.claimToken || result.claimToken !== row.claim_token) fail(409,'SDI_CLAIM','Tentativo di invio non corrispondente.');
      const attempt = db.prepare('SELECT * FROM sdi_outbox_attempts WHERE id=?').get(result.claimToken);
      const finalResult = { state: result.state, sdiId, code: String(result.code || '').slice(0,120), message: String(result.message || '').slice(0,1000) };
      if (attempt.finished_at !== null) {
        if (attempt.result !== JSON.stringify(finalResult)) fail(409,'SDI_RESULT_CONFLICT','Questo tentativo ha già un esito diverso.');
        return detail(id);
      }
      db.prepare('UPDATE sdi_outbox_attempts SET finished_at=?,result=? WHERE id=?').run(now(),JSON.stringify(finalResult),result.claimToken);
      const duplicateIdentifier = sdiId && db.prepare('SELECT id FROM sdi_outbox WHERE environment=? AND sdi_id=? AND id<>?').get(environment,sdiId,id);
      if (duplicateIdentifier || (row.sdi_id && sdiId && row.sdi_id !== sdiId) || (row.state === 'SDI_RECEIVED' && result.state === 'TRANSPORT_REJECTED')) {
        db.prepare('UPDATE sdi_outbox SET conflict=1,error_code=?,error_message=?,updated_at=? WHERE id=?').run('SDI_RESULT_CONFLICT','Risposta di trasporto incompatibile con le ricevute archiviate.',now(),id);
        return detail(id);
      }
      // An authenticated callback beats a timeout or lost HTTP response.
      const state = row.state === 'SDI_RECEIVED' ? row.state : result.state;
      db.prepare('UPDATE sdi_outbox SET state=?,sdi_id=?,error_code=?,error_message=?,updated_at=? WHERE id=?')
        .run(state,row.sdi_id || sdiId,finalResult.code || null,finalResult.message || null,now(),id);
      reconcileFor(outboxRow(id));
      return detail(id);
    });
  }
  function recoverInterrupted({ afterRestore = false } = {}) {
    return transaction(db, () => {
      const rows = db.prepare(`SELECT id,claim_token FROM sdi_outbox WHERE environment=? AND ${afterRestore ? "state IN ('READY','IN_FLIGHT')" : "state='IN_FLIGHT'"}`).all(environment);
      for (const row of rows) {
        db.prepare("UPDATE sdi_outbox SET state='UNKNOWN',error_code=?,error_message=?,updated_at=? WHERE id=?")
          .run(afterRestore ? 'RESTORED_BACKUP' : 'INTERRUPTED','Esito da verificare: nessun nuovo invio automatico.',now(),row.id);
        if (row.claim_token) db.prepare('UPDATE sdi_outbox_attempts SET finished_at=?,result=? WHERE id=? AND finished_at IS NULL').run(now(),JSON.stringify({ state:'UNKNOWN', code:afterRestore ? 'RESTORED_BACKUP' : 'INTERRUPTED' }),row.claim_token);
        reconcileFor(outboxRow(row.id));
      }
      return { recovered: rows.length };
    });
  }
  function acceptNotification(parsed, rawSoap) {
    const info = parsed.notification;
    if (!info || !OUTCOMES.has(info.outcome)) fail(400,'SDI_INPUT','Notifica SdI non valida.');
    const sdiId = identifier(info.identifier), invoiceFilename = filename(info.invoiceFilename), name = filename(parsed.filename);
    if (identifier(parsed.identifier) !== sdiId) fail(400,'SDI_INPUT','Identificativi notifica discordanti.');
    const content = payload(parsed.payloadBase64), raw = bytes(rawSoap,'Richiesta SOAP',30 * 1024 * 1024), digest = hash(content);
    const normalized = JSON.stringify(cloneJson(info));
    if (normalized.length > 64_000) fail(400,'SDI_INPUT','Notifica troppo grande.');
    return transaction(db, () => {
      assertEnvironment();
      const old = db.prepare('SELECT * FROM sdi_notifications WHERE environment=? AND sdi_id=? AND filename=? AND digest=?').get(environment,sdiId,name,digest);
      if (old) return { id: old.id, duplicate:true, conflict:old.state === 'CONFLICT', state:old.state };
      const id = randomUUID();
      const variant = db.prepare('SELECT * FROM sdi_notifications WHERE environment=? AND sdi_id=? AND filename=?').get(environment,sdiId,name);
      db.prepare(`INSERT INTO sdi_notifications(id,environment,sdi_id,invoice_filename,filename,outcome,digest,payload,raw_body,parsed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id,environment,sdiId,invoiceFilename,name,info.outcome,digest,content,raw,normalized,now());
      const event = db.prepare('SELECT * FROM sdi_notifications WHERE id=?').get(id);
      if (variant) {
        // Invalidate both variants, including an earlier applied or unmatched
        // one, and flag every affected invoice when their references differ.
        for (const conflicting of db.prepare('SELECT * FROM sdi_notifications WHERE environment=? AND sdi_id=? AND filename=?').all(environment,sdiId,name)) {
          bindEventConflict({ ...conflicting, reason:'La stessa notifica è arrivata con contenuto diverso.' });
        }
      } else reconcile(event);
      const saved = db.prepare('SELECT state FROM sdi_notifications WHERE id=?').get(id);
      return { id, duplicate:false, conflict:saved.state === 'CONFLICT', state:saved.state };
    });
  }
  function inboxRow(id) {
    const row = db.prepare('SELECT * FROM sdi_inbox WHERE id=? AND environment=?').get(id,environment);
    if (!row) fail(404,'SDI_NOT_FOUND','Fattura ricevuta SdI non trovata.');
    return row;
  }
  const linkedIds = id => db.prepare('SELECT supplier_invoice_id FROM sdi_inbox_documents WHERE inbox_id=? ORDER BY body_index').all(id).map(row => row.supplier_invoice_id);
  const incoming = row => ({ id:row.id, environment:row.environment, sdiId:row.sdi_id, filename:row.filename,
    digest:row.digest, state:row.state, conflict:!!row.conflict, reason:row.reason, supplierInvoiceId:row.supplier_invoice_id,
    supplierInvoiceIds:linkedIds(row.id), createdAt:row.created_at, updatedAt:row.updated_at, hasMetadata:row.has_metadata === undefined ? row.metadata !== null : !!row.has_metadata });
  const listIncoming = () => db.prepare(`SELECT ${INCOMING_COLUMNS} FROM sdi_inbox WHERE environment=? ORDER BY created_at DESC,id DESC`).all(environment).map(incoming);
  const incomingDetail = id => incoming(inboxRow(id));
  function acceptInvoice(parsed, rawSoap) {
    const sdiId = identifier(parsed.identifier), name = filename(parsed.filename), content = payload(parsed.payloadBase64);
    const raw = bytes(rawSoap,'Richiesta SOAP',30 * 1024 * 1024), digest = hash(content);
    const metadata = parsed.metadataBase64 ? payload(parsed.metadataBase64) : null;
    return transaction(db, () => {
      assertEnvironment();
      const old = db.prepare('SELECT * FROM sdi_inbox WHERE environment=? AND sdi_id=? AND filename=? AND digest=?').get(environment,sdiId,name,digest);
      if (old) return { ...incoming(old), duplicate:true };
      const variants = db.prepare('SELECT id FROM sdi_inbox WHERE environment=? AND sdi_id=?').all(environment,sdiId);
      const conflict = variants.length > 0, id = randomUUID(), time = now();
      db.prepare(`INSERT INTO sdi_inbox(id,environment,sdi_id,filename,digest,payload,raw_body,metadata,state,conflict,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id,environment,sdiId,name,digest,content,raw,metadata,conflict ? 'REVIEW' : 'PENDING',conflict ? 1 : 0,
          conflict ? 'Identificativo SdI già archiviato con nome o contenuto diverso.' : null,time,time);
      if (conflict) db.prepare("UPDATE sdi_inbox SET state='REVIEW',conflict=1,reason='Identificativo SdI ricevuto con varianti: verifica necessaria. Eventuali fatture e pagamenti già registrati sono conservati.',updated_at=? WHERE environment=? AND sdi_id=?").run(time,environment,sdiId);
      return { ...incoming(inboxRow(id)), duplicate:false };
    });
  }
  function reviewIncoming(id, reason) {
    return transaction(db, () => {
      const row = inboxRow(id);
      if (row.state === 'IMPORTED') return incoming(row);
      db.prepare("UPDATE sdi_inbox SET state='REVIEW',reason=?,updated_at=? WHERE id=?").run(String(reason || 'Verifica manuale richiesta.').slice(0,1000),now(),id);
      return incoming(inboxRow(id));
    });
  }
  function markIncomingProcessed(id, supplierData) {
    return transaction(db, () => {
      const row = inboxRow(id);
      if (row.conflict) fail(409,'SDI_INCOMING_CONFLICT','La consegna presenta varianti incompatibili e richiede verifica.');
      if (row.state === 'IMPORTED') return { ...incoming(row), imported:false };
      if (environment !== 'production') {
        db.prepare("UPDATE sdi_inbox SET state='REVIEW',reason='Documento di collaudo: escluso dalla contabilità fornitori.',updated_at=? WHERE id=?").run(now(),id);
        return { ...incoming(inboxRow(id)), imported:false };
      }
      const documents = Array.isArray(supplierData) ? supplierData : [{ ...supplierData, bodyIndex:0 }];
      if (!documents.length || documents.length > 1000 || documents.some(doc => !doc || !Number.isInteger(doc.bodyIndex) || doc.bodyIndex < 0) || new Set(documents.map(doc => doc.bodyIndex)).size !== documents.length) fail(400,'SDI_INPUT','Corpi della fattura ricevuta non validi.');
      const linkedInvoices = new Set();
      const results = documents.map(doc => {
        const result = importSdiInvoiceInTransaction(db,{ ...doc, sourceKey:`sdi:${environment}:${row.sdi_id}:${doc.bodyIndex}`, filename:row.filename, originalBytes:Buffer.from(row.payload) },now);
        if (linkedInvoices.has(result.item.id)) fail(409,'SDI_INCOMING_CONFLICT','Più corpi del file indicano la stessa identità fiscale: verificare l’originale.');
        linkedInvoices.add(result.item.id);
        db.prepare('INSERT INTO sdi_inbox_documents(inbox_id,body_index,supplier_invoice_id) VALUES(?,?,?)').run(id,doc.bodyIndex,result.item.id);
        return result;
      });
      db.prepare("UPDATE sdi_inbox SET state='IMPORTED',supplier_invoice_id=?,reason=NULL,updated_at=? WHERE id=?").run(results[0].item.id,now(),id);
      return { ...incoming(inboxRow(id)), imported:results.some(result => result.imported), revision:results.at(-1).revision };
    });
  }
  function original(kind, id) {
    let row, content, name;
    if (kind === 'outgoing') { row = outboxRow(id); content = row.xml; name = row.filename; }
    else if (['incoming','incoming-raw','incoming-metadata'].includes(kind)) {
      row = inboxRow(id); content = kind === 'incoming' ? row.payload : kind === 'incoming-raw' ? row.raw_body : row.metadata;
      name = kind === 'incoming' ? row.filename : `${row.id}-${kind}.xml`;
    } else if (['notification','notification-raw'].includes(kind)) {
      row = db.prepare('SELECT * FROM sdi_notifications WHERE id=? AND environment=?').get(id,environment);
      if (!row) fail(404,'SDI_NOT_FOUND','Notifica SdI non trovata.');
      content = kind === 'notification' ? row.payload : row.raw_body; name = kind === 'notification' ? row.filename : `${id}-soap.xml`;
    } else fail(400,'SDI_INPUT','Tipo originale non valido.');
    if (!content) fail(404,'SDI_NOT_FOUND','Originale non disponibile.');
    const body = Buffer.from(content);
    return { filename:name, mime:/\.xml$/i.test(name) ? 'application/xml' : 'application/octet-stream', bytes:body, sha256:hash(body) };
  }
  const listNotifications = () => db.prepare('SELECT id,sdi_id AS sdiId,invoice_filename AS invoiceFilename,filename,outcome,state,reason,created_at AS createdAt,outbox_id AS outboxId FROM sdi_notifications WHERE environment=? ORDER BY created_at DESC,id DESC').all(environment);
  return { environment, bindIdentity, enqueue, claim, finish, recoverInterrupted, acceptNotification, acceptInvoice,
    list, detail, events, bindings, listNotifications, listIncoming, incomingDetail, original, markIncomingProcessed, reviewIncoming };
}
