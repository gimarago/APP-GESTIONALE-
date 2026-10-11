import { createHash } from 'node:crypto';
import { readSdiConfig, authenticateSdiGateway } from './sdi-config.mjs';
import { loadSdiCredentials, postSdiSoap } from './sdi-transport.mjs';
import { createSdiStore } from './sdi-store.mjs';
import * as protocol from './sdi-protocol.mjs';
import { HttpError } from './validation.mjs';

const MAX_BODY = 18 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function respond(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(message);
}
function readCallbackBody(req) {
  return new Promise((resolve, reject) => {
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) { reject(new HttpError(413, 'SDI_BODY_SIZE', 'Messaggio troppo grande.')); return; }
    let size = 0; const chunks = [];
    const timer = setTimeout(() => done(new HttpError(408, 'SDI_BODY_TIMEOUT', 'Ricezione incompleta.')), 30000);
    let settled = false;
    function done(error, value) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); }
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { req.pause(); done(new HttpError(413, 'SDI_BODY_SIZE', 'Messaggio troppo grande.')); } else chunks.push(chunk); });
    req.on('end', () => done(null, Buffer.concat(chunks)));
    req.on('aborted', () => done(new HttpError(400, 'SDI_BODY_INTERRUPTED', 'Ricezione interrotta.')));
    req.on('error', () => done(new HttpError(400, 'SDI_BODY_INTERRUPTED', 'Ricezione interrotta.')));
  });
}

export function createSdiRuntime({ db, env = process.env, store: suppliedStore, onChange = () => {}, protocolApi = protocol, transport = postSdiSoap, credentialsLoader = loadSdiCredentials }) {
  let config, setupIssue = null;
  try { config = readSdiConfig(env); } catch (error) { setupIssue = error.message; config = { enabled: true, environment: ['test','production'].includes(env.SDI_ENVIRONMENT) ? env.SDI_ENVIRONMENT : null }; }
  // A paused channel must keep showing its existing production archive. The
  // normal compose file intentionally omits all SdI credentials/environment.
  const archivedEnvironment = !config.enabled && db?.prepare(`SELECT environment FROM sdi_outbox
    UNION SELECT environment FROM sdi_inbox UNION SELECT environment FROM sdi_notifications`).all();
  if (archivedEnvironment?.length === 1) config = { ...config, environment: archivedEnvironment[0].environment };
  const store = suppliedStore || createSdiStore(db, { environment: config.environment || 'test' });
  if (config.enabled && !setupIssue) {
    try { store.bindIdentity({ shopVat: config.shopVat, accreditationReference: config.accreditationReference, endpointHost: config.endpointHost }); }
    catch { setupIssue = 'L’archivio SdI appartiene a un altro ambiente o a un’altra identità del canale.'; }
  }
  let stopped = true, running = null, timer = null, callbackCount = 0, workerIssue = null, fatalWorkerIssue = null;
  function status() {
    let credentialIssue = null;
    if (config.enabled && !setupIssue) { try { credentialsLoader(config); } catch (error) { credentialIssue = error.message; } }
    const issues = [setupIssue, fatalWorkerIssue, credentialIssue, workerIssue].filter(Boolean);
    return { enabled: !!config.enabled, ready: !!config.enabled && !issues.length, environment: config.environment, issues,
      label: !config.enabled ? 'Disattivato: accreditamento da completare' : config.environment === 'test' ? 'Collaudo SdI: nessun valore fiscale' : 'Produzione SdI',
      callbacks: config.enabled && !setupIssue ? { notifications: `https://${config.callbackHost}/sdi/notifications`, invoices: `https://${config.callbackHost}/sdi/invoices` } : null };
  }
  function requireReady() {
    const state = status();
    if (!state.ready) throw new HttpError(503, 'SDI_NOT_READY', state.issues[0] || 'Il canale SdI non è attivo. Completare prima l’accreditamento.');
  }
  async function prepare(data) {
    const prepared = await protocolApi.prepareOutgoing({ filename: data.filename, xml: Buffer.isBuffer(data.xml) ? data.xml.toString('utf8') : data.xml });
    const seller = prepared.invoice?.seller;
    if (!seller || seller.country !== 'IT' || seller.vat !== config.shopVat) throw new HttpError(400, 'SDI_SELLER_MISMATCH', 'La partita IVA del cedente non coincide con quella configurata per il canale.');
    return prepared;
  }
  async function enqueue(data, auth) {
    requireReady();
    // The immutable legacy archive uses up to ten digits in ProgressivoInvio.
    // SdI's transport filename permits five. Store chooses its own unique name
    // atomically; use a temporary valid name only for this preflight and always
    // rebuild the SOAP envelope with the persisted name in the worker below.
    const provisionalFilename = typeof data.filename === 'string'
      ? data.filename.replace(/^([A-Z]{2}[A-Za-z0-9]{1,28})_[A-Za-z0-9]{6,}\.xml$/, '$1_00000.xml') : data.filename;
    await prepare({ ...data, filename: provisionalFilename });
    // Async validation can take time; recheck secrets and the authoritative
    // saved invoice synchronously before the transaction creates the attempt.
    requireReady();
    credentialsLoader(config);
    if (data.beforeEnqueue) {
      const result = data.beforeEnqueue();
      if (result && typeof result.then === 'function') throw new HttpError(500, 'SDI_ASYNC_GUARD', 'Il controllo finale deve essere sincrono.');
    }
    const xml = Buffer.isBuffer(data.xml) ? data.xml : Buffer.from(data.xml, 'utf8');
    const result = store.enqueue({ documentId: data.documentId, filename: data.filename, xml, digest: sha256(xml), fiscalKey: data.fiscalKey, metadata: data.metadata }, auth);
    onChange(); schedule(0); return result;
  }
  async function processIncoming() {
    const records = store.listIncoming();
    for (const item of (Array.isArray(records) ? records : records.items || []).filter(item => item.state === 'PENDING').slice(0, 10)) {
      if (stopped) return;
      try {
        const original = store.original('incoming', item.id);
        const payload = original.bytes;
        const invoice = await protocolApi.inspectIncoming({ filename: original.filename || item.filename, base64: Buffer.from(payload).toString('base64'), shopVat: config.shopVat });
        if (invoice.quarantineReason) store.reviewIncoming(item.id, invoice.quarantineReason);
        else store.markIncomingProcessed(item.id, invoice);
      } catch { store.reviewIncoming(item.id, 'Lettura automatica non riuscita: originale conservato per verifica.'); }
      onChange();
    }
  }
  async function tick() {
    if (stopped || !config.enabled || setupIssue || fatalWorkerIssue) return;
    let credentials;
    try { credentials = credentialsLoader(config); workerIssue = null; }
    catch (error) { workerIssue = error.message; await processIncoming(); return; }
    const job = store.claim();
    if (job) {
      let result;
      try {
        const request = await prepare(job);
        const reply = await transport(config, credentials, request);
        result = await protocolApi.parseOutgoingResponse({ xml: reply.body.toString('utf8'), bodyBase64: reply.body.toString('base64'), status: reply.status, contentType: reply.contentType });
      } catch { result = { kind: 'UNKNOWN', reason: 'Trasmissione o risposta non verificabile. Nessun nuovo invio automatico.' }; }
      store.finish(job.id, { claimToken: job.claimToken, state: ['SDI_RECEIVED','TRANSPORT_REJECTED'].includes(result.kind) ? result.kind : 'UNKNOWN',
        sdiId: result.identifier, code: result.code || (result.kind === 'UNKNOWN' ? 'SDI_UNCERTAIN' : undefined), message: result.reason });
      onChange();
    }
    await processIncoming();
  }
  function schedule(delay = 3000) {
    if (stopped || timer || running || !config.enabled || setupIssue || fatalWorkerIssue) return;
    timer = setTimeout(() => {
      timer = null;
      running = tick().catch(() => {
        // An unexpected failure can leave a sent attempt without a durable
        // result. Only a new runtime may recover it before sending more jobs.
        fatalWorkerIssue = 'Elaborazione SdI interrotta: verificare lo stato del canale e riavviare il server prima di procedere.';
      }).finally(() => { running = null; schedule(); });
    }, delay);
    timer.unref?.();
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    if (config.enabled && !setupIssue && !fatalWorkerIssue) { store.recoverInterrupted(); schedule(0); }
  }
  async function stop() { stopped = true; clearTimeout(timer); timer = null; if (running) await running; }
  async function callback(req, res) {
    const path = req.url?.split('?')[0];
    if (!['/sdi/notifications','/sdi/invoices'].includes(path)) return false;
    if (!config.enabled || setupIssue) { respond(res, 503, 'Canale SdI non configurato.'); return true; }
    if (req.method !== 'POST' || req.url !== path) { respond(res, 405, 'Metodo non consentito.'); return true; }
    if (!authenticateSdiGateway(req, config)) { respond(res, 403, 'Identità del canale non verificata.'); return true; }
    if (callbackCount >= 2) { respond(res, 503, 'Ricezione temporaneamente occupata.'); return true; }
    const contentType = req.headers['content-type'] || '';
    if (typeof contentType !== 'string' || !/^(?:text\/xml|multipart\/related)(?:;|$)/i.test(contentType) || req.headers['content-encoding']) { respond(res, 415, 'Formato messaggio non supportato.'); return true; }
    callbackCount += 1;
    try {
      const raw = await readCallbackBody(req);
      const parsed = await protocolApi.parseCallback({ xml: raw.toString('utf8'), bodyBase64: raw.toString('base64'), contentType, soapAction: req.headers.soapaction || '', kind: path.endsWith('/invoices') ? 'invoices' : 'notifications' });
      // Store commits raw SOAP + attachment and deduplicates before acknowledging.
      if (parsed.kind === 'invoices') store.acceptInvoice(parsed, raw);
      else if (parsed.kind === 'notifications') store.acceptNotification(parsed, raw);
      else throw new Error('SDI_CALLBACK_KIND');
      res.writeHead(parsed.response.status, { 'Content-Type': parsed.response.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(parsed.response.body);
      onChange(); schedule(0);
    } catch (error) {
      respond(res, error.status && [400,408,413,415].includes(error.status) ? error.status : 500, 'Messaggio non acquisito. Ripetere la consegna secondo il protocollo SdI.');
    } finally { callbackCount -= 1; }
    return true;
  }
  return { status, enqueue, callback, start, stop, store };
}
