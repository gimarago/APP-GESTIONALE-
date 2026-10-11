import http from 'node:http';
import { recordStore } from './records.mjs';
import { supplierInvoiceStore } from './supplier-invoices.mjs';
import { appearanceStore } from './user-appearance.mjs';
import { moduleFileStore } from './module-files.mjs';
import { guardWorkReports } from './work-reports.mjs';
import { createSdiRuntime } from './sdi-runtime.mjs';
import { createSdiApi, guardSdiArchive } from './sdi-api.mjs';
import { createAppUpdateHandler } from './app-updates.mjs';
import { readFileSync, existsSync, writeFileSync, unlinkSync, openSync, closeSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { openDatabase, transaction, audit, hash, secret, safeEqual, passwordMatches, passwordHash, normalizeEmail } from './database.mjs';
import { sendPasswordResetEmail, sendReportEmail, isPasswordResetEmailConfigured } from './email.mjs';
import { HttpError, makeStateValidator } from './validation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PUBLIC = new Set(['/', '/app', '/index.html', '/reset-password', '/api/health', '/api/session', '/api/login', '/api/password-reset/request', '/api/password-reset/confirm']);
const MAX_BODY = 16 * 1024 * 1024;
const COOKIE = 'officina_session';
const HOURS_12 = 12 * 60 * 60 * 1000;
const RESET_LIFETIME = 30 * 60 * 1000;
const activeLocks = new Set();
const send = (res, status, object, headers = {}) => { if (!res.writableEnded) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(object)); };
const fail = (status, code, message, extra = {}) => { throw new HttpError(status, code, message, extra); };
const stateEtag = revision => `"officina-state-${revision}"`;
const matchesStateEtag = (value, etag) => typeof value === 'string' &&
  (value.trim() === '*' || value.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag));

function body(req, maxBytes = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'CONTENT_TYPE', 'Usare application/json.'));
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new HttpError(413, 'TOO_LARGE', 'Richiesta troppo grande.')); req.resume(); }
      else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (bytes > maxBytes) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolveBody(value);
      } catch { reject(new HttpError(400, 'BAD_JSON', 'JSON non valido.')); }
    });
  });
}

export function acquireProcessLock(dataDir) {
  const file = resolve(dataDir, 'server.lock');
  if (activeLocks.has(file)) throw new Error('Un server di questo processo usa già il database.');
  const fingerprint = pid => {
    if (process.platform !== 'linux') return null;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const started = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${started}`;
    } catch { return null; }
  };
  if (existsSync(file)) {
    let owner;
    try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Lock server illeggibile: verificare manualmente che il server sia fermo.'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Lock server non valido.');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    const currentFingerprint = fingerprint(owner.pid);
    const recycledPid = owner.fingerprint && currentFingerprint && owner.fingerprint !== currentFingerprint;
    // Docker often reuses the old PID on restart. An active same-process lock
    // was already excluded above; a legacy PID-only self lock is stale.
    const staleSelf = owner.pid === process.pid && !owner.fingerprint;
    if (alive && !recycledPid && !staleSelf) throw new Error('Un processo usa il database (server.lock). Fermarlo prima di avviare o ripristinare.');
    unlinkSync(file);
  }
  const fd = openSync(file, 'wx', 0o600);
  const token = secret();
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, fingerprint: fingerprint(process.pid), createdAt: Date.now() })); } finally { closeSync(fd); }
  activeLocks.add(file);
  return () => {
    activeLocks.delete(file);
    try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); } catch { /* Already removed. */ }
  };
}

export async function createApplication(options = {}) {
  const env = options.env || process.env;
  const development = ['test', 'development'].includes(env.NODE_ENV);
  const originText = options.origin || env.OFFICINA_ORIGIN || (development ? 'http://localhost:8080' : '');
  let origin;
  try { origin = new URL(originText); } catch { throw new Error('Impostare OFFICINA_ORIGIN=https://gestionale.example.it.'); }
  if (origin.origin !== originText || origin.username || origin.password || (!development && origin.protocol !== 'https:') || !['http:','https:'].includes(origin.protocol)) throw new Error('OFFICINA_ORIGIN deve essere un origine HTTPS senza percorso o slash finale. HTTP è ammesso solo con NODE_ENV=development/test.');
  const root = options.root || ROOT;
  const dataDir = resolve(options.dataDir || env.DATA_DIR || join(ROOT, 'data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const unlock = options.noProcessLock ? () => {} : acquireProcessLock(dataDir);
  let db;
  try { db = openDatabase(dataDir); } catch (error) { unlock(); throw error; }
  const schema = options.schema || require(join(root, 'cloud-schema.js'));
  const validateState = makeStateValidator(schema);
  const sessionMs = options.sessionMs || HOURS_12;
  const now = options.now || Date.now;
  const secure = origin.protocol === 'https:';
  const peers = new Set();
  const attempts = new Map();
  const resetAttempts = new Map();
  const reportEmailRequests = new Map(), reportEmailAttempts = new Map();
  const resetSender = options.sendPasswordResetEmail || (message => sendPasswordResetEmail(message, env));
  const reportEmailSender = options.sendReportEmail || (message => sendReportEmail(message, env));
  const passwordResetAvailable = (secure &&
    (typeof options.sendPasswordResetEmail === 'function' || isPasswordResetEmailConfigured(env))) ||
    (env.NODE_ENV === 'test' && typeof options.sendPasswordResetEmail === 'function');
  // The same expensive password check is used for unknown usernames.
  const dummyPassword = await passwordHash(secret());
  // Resolve permitted frontend assets per request so an update adding a file
  // cannot leave newly served HTML pointing at a stale startup directory list.
  const isPublicScript = file => /^[A-Za-z0-9._-]+\.(?:js|css|webmanifest)$/.test(file) && !/(?:\.test\.|email-service|^server)/.test(file);
  const cookieHeader = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const stateRevision = () => db.prepare('SELECT revision FROM state WHERE id=1').get().revision;
  const status = () => ({ protocol: 2, revision: stateRevision() });
  let records, sdi, appearances, moduleFiles;
  try {
    appearances = appearanceStore(db, now);
    moduleFiles = moduleFileStore(db, now);
    // Injection is only available to local integration tests, never via HTTP.
    sdi = (options.createSdiRuntime || createSdiRuntime)({ db, env, onChange: () => {
      for (const peer of peers) if (!peer.res.writableEnded) peer.res.write('event: sdi\ndata: {}\n\n');
    } });
    records = recordStore(db, validateState, now, state => {guardSdiArchive(sdi.store, state);moduleFiles.validateState(state);guardWorkReports(state);});
  } catch (error) { db.close(); unlock(); throw error; }
  const supplierInvoices = supplierInvoiceStore(db, now);
  let lastSupplierRevision = supplierInvoices.revision();
  function session(req) {
    const raw = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const row = db.prepare('SELECT s.id AS sessionId,s.csrf,s.expires_at,u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.disabled=0').get(hash(raw), now());
    return row || null;
  }
  const sessionResult = auth => ({ user: auth ? { id: auth.id, username: auth.username, role: auth.role } : null, csrf: auth?.csrf || null, appearance: auth ? appearances.read(auth) : null, passwordResetAvailable,
    features: { operatingAddress: schema.fields.includes('shopOperatingAddress'), inventoryCount: 4, inventoryCountSales: 1, inventoryNewStock: 1, workReports: 1 } });
  function assertWriter(auth) { if (!['admin', 'operator'].includes(auth.role)) fail(403, 'READ_ONLY', 'Questo account può solo consultare i dati.'); }
  const sdiApi = createSdiApi({ runtime: sdi, readState: () => records.read().state, env, assertWriter, session, body, send });
  const appUpdates = createAppUpdateHandler({releaseDir:options.appUpdatesDir || env.OFFICINA_APP_UPDATES_DIR || join(root,'app-updates','windows-x86_64'),origin:origin.origin,allowHttp:env.NODE_ENV === 'test'});
  function announce() {
    for (const peer of peers) {
      if (!peer.res.writableEnded) peer.res.write(`event: change\ndata: ${JSON.stringify(status(peer.sessionId))}\n\n`);
    }
  }
  function rateLimit(req, username) {
    const time = now();
    for (const [key, item] of attempts) if (item.until <= time) attempts.delete(key);
    if (attempts.size > 10_000) fail(429, 'RATE_LIMIT', 'Troppi tentativi. Riprovare tra 15 minuti.');
    for (const [key, limit] of [[`ip:${req.socket.remoteAddress}`, 100], [`user:${String(username).toLowerCase()}`, 12]]) {
      const current = attempts.get(key) || { count: 0, until: time + 15 * 60_000 };
      current.count += 1; attempts.set(key, current);
      if (current.count > limit) fail(429, 'RATE_LIMIT', 'Troppi tentativi. Riprovare tra 15 minuti.');
    }
  }
  function announceSupplierInvoices() {
    lastSupplierRevision = supplierInvoices.revision();
    const data = JSON.stringify({ revision: lastSupplierRevision });
    for (const peer of peers) {
      if (peer.res.writableEnded || peer.res.destroyed) { peers.delete(peer); continue; }
      try { peer.res.write(`event: supplier-invoices\ndata: ${data}\n\n`); }
      catch { peers.delete(peer); }
    }
  }
  function resetRateLimit(req, email = null) {
    const time = now();
    for (const [key, item] of resetAttempts) if (item.until <= time) resetAttempts.delete(key);
    if (resetAttempts.size > 10_000) fail(429, 'RATE_LIMIT', 'Troppi tentativi. Riprovare tra 15 minuti.');
    const buckets = [[`ip:${req.socket.remoteAddress}`, email ? 30 : 60]];
    if (email) buckets.push([`email:${hash(email)}`, 3]);
    for (const [key, limit] of buckets) {
      const current = resetAttempts.get(key) || { count: 0, until: time + 15 * 60_000 };
      current.count += 1;
      resetAttempts.set(key, current);
      if (current.count > limit) fail(429, 'RATE_LIMIT', 'Troppi tentativi. Riprovare tra 15 minuti.');
    }
  }
  function reportEmailRateLimit(userId) {
    const time = now(), recent = (reportEmailAttempts.get(userId) || []).filter(at => at > time - 60 * 60_000);
    if (recent.length >= 20) fail(429, 'EMAIL_RATE_LIMIT', 'Limite di invii raggiunto. Riprova tra un’ora.');
    recent.push(time); reportEmailAttempts.set(userId, recent);
    if (reportEmailAttempts.size > 10_000) for (const [id, values] of reportEmailAttempts) if (!values.some(at => at > time - 60 * 60_000)) reportEmailAttempts.delete(id);
  }
  function security(res, nonce) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('content-security-policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: ipc: http://ipc.localhost https://ipc.localhost; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`);
    if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');
  }
  async function handler(req, res) {
    const nonce = randomBytes(18).toString('base64');
    security(res, nonce);
    try {
      let pathname;
      try {pathname = decodeURIComponent(new URL(req.url, origin.origin).pathname);} catch {fail(400,'BAD_PATH','Percorso non valido.');}
      const method = req.method;
      if (await appUpdates(req,res,pathname)) return;
      // These two machine endpoints use the SdI gateway's mutual-TLS identity,
      // not browser cookies. All /api/sdi routes retain normal auth and CSRF.
      if (['/sdi/notifications', '/sdi/invoices'].includes(pathname) && await sdi.callback(req, res)) return;
      const auth = session(req);
      if (pathname.startsWith('/api/') && !PUBLIC.has(pathname) && !auth) fail(401, 'UNAUTHENTICATED', 'Accedere per continuare.');
      if (!['GET', 'HEAD'].includes(method)) {
        if (req.headers.origin !== origin.origin || (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site']))) fail(403, 'ORIGIN', 'Origine della richiesta non autorizzata.');
        if (!['/api/login','/api/password-reset/request','/api/password-reset/confirm'].includes(pathname) && (!auth || !safeEqual(req.headers['x-csrf-token'], auth.csrf))) fail(403, 'CSRF', 'Sessione di sicurezza non valida. Ricaricare la pagina.');
      }
      if (method === 'GET' && pathname === '/api/health') { db.prepare('SELECT revision FROM state WHERE id=1').get(); return send(res, 200, { ok: true }); }
      if (method === 'GET' && pathname === '/api/session') return send(res, 200, sessionResult(auth));
      if (method === 'GET' && pathname === '/api/appearance') return send(res, 200, appearances.read(auth));
      if (method === 'PUT' && pathname === '/api/appearance') return send(res, 200, appearances.save(auth, await body(req, 1024)));
      if (method === 'POST' && pathname === '/api/module-files') {
        assertWriter(auth);
        return send(res, 200, moduleFiles.upload(auth, await body(req, 15 * 1024 * 1024)));
      }
      if (method === 'POST' && ['/api/email/send', '/api/email/send-report'].includes(pathname)) {
        assertWriter(auth);
        const data = await body(req, 3_100_000);
        if (!['gmail', 'outlook'].includes(data.provider) || typeof data.from !== 'string' || typeof data.to !== 'string' ||
            typeof data.subject !== 'string' || typeof data.body !== 'string' || !data.attachment ||
            typeof data.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.requestId) ||
            !/^(?:Rapporto-RI-[A-Z0-9]{1,17}|Preventivo-\d{4}-\d{2}-\d{2}-[A-Z0-9]{8})\.pdf$/i.test(data.attachment.name || '')) fail(400, 'EMAIL_INPUT', 'Richiesta email con allegato PDF non valida.');
        const key = auth.id + ':' + data.requestId, digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        const respondFailure = error => {
          if (error instanceof HttpError) throw error;
          const unavailable = ['EMAIL_UNCONFIGURED', 'EMAIL_UNAVAILABLE'].includes(error.code);
          const statusCode = unavailable ? 503 : error.code === 'EMAIL_SEND_FAILED' ? 502 : 400;
          throw new HttpError(statusCode, error.code || 'EMAIL_FAILED', error.message || 'Invio email non riuscito.');
        };
        const previous = reportEmailRequests.get(key);
        if (previous) {
          if (previous.digest !== digest) fail(409, 'EMAIL_REQUEST_REUSED', 'Richiesta di invio già usata per contenuti diversi.');
          if (previous.result) return send(res, 200, previous.result);
          if (previous.error) respondFailure(previous.error);
          if (previous.promise) {
            try { const result = await previous.promise; previous.result = result; previous.promise = null; return send(res, 200, result); }
            catch (error) { previous.error = error; previous.promise = null; respondFailure(error); }
          }
        }
        reportEmailRateLimit(auth.id);
        const entry = { digest, result: null, error: null, promise: null };
        reportEmailRequests.set(key, entry);
        while (reportEmailRequests.size > 2000) {
          const oldest = reportEmailRequests.entries().next().value;
          if (!oldest || oldest[1].promise) break;
          reportEmailRequests.delete(oldest[0]);
        }
        entry.promise = Promise.resolve().then(() => reportEmailSender(data));
        try { entry.result = await entry.promise; return send(res, 200, entry.result); }
        catch (error) { entry.error = error; respondFailure(error); }
        finally { entry.promise = null; }
      }
      const moduleOriginal = /^\/api\/module-files\/([A-Za-z0-9-]+)\/original$/.exec(pathname);
      if (method === 'GET' && moduleOriginal) {
        const id = moduleOriginal[1];
        const modules = JSON.parse(records.read().state?.storage?.['officina-moduli-v1'] || '[]');
        if (!modules.some(record => record.Attachment?.id === id)) fail(404, 'MODULE_FILE_NOT_FOUND', 'File del modulo non trovato nell’archivio.');
        const original = moduleFiles.original(id);
        if (!original) fail(404, 'MODULE_FILE_NOT_FOUND', 'File del modulo non disponibile.');
        const fallback = original.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
        const encodedName = encodeURIComponent(original.filename).replace(/[!'()*]/g, character => '%'+character.charCodeAt(0).toString(16).toUpperCase());
        res.writeHead(200, {'content-type': original.contentType, 'content-length': original.bytes.length,
          'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodedName}`});
        return res.end(original.bytes);
      }
      if (method === 'POST' && pathname === '/api/password-reset/request') {
        if (!passwordResetAvailable) fail(503, 'RESET_UNAVAILABLE', 'Recupero password non ancora configurato sul server.');
        const data = await body(req, 2048);
        const email = normalizeEmail(data.email);
        if (!email) fail(400, 'RESET_INPUT', 'Indirizzo email non valido.');
        resetRateLimit(req, email);
        const started = Date.now();
        const user = db.prepare('SELECT id,username,email FROM users WHERE email=? AND disabled=0').get(email);
        // The token is never stored in plaintext or returned to the browser.
        // Dispatching mail after this response avoids revealing account existence
        // through SMTP latency and keeps the response identical for unknown mail.
        const token = secret();
        const tokenHash = hash(token);
        if (user) {
          transaction(db, () => {
            db.prepare('DELETE FROM password_reset_tokens WHERE user_id=? OR expires_at<=?').run(user.id, now());
            db.prepare('INSERT INTO password_reset_tokens(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(tokenHash, user.id, now() + RESET_LIFETIME, now());
            audit(db, user, 'password-reset-requested');
          });
          const resetUrl = `${origin.origin}/reset-password?token=${encodeURIComponent(token)}`;
          res.once('finish', () => {
            void Promise.resolve().then(() => resetSender({ to: user.email, resetUrl, expiresMinutes: 30 })).catch(() => {
              console.error('Invio email di recupero password non riuscito. Controllare la configurazione SMTP.');
              try { db.prepare('DELETE FROM password_reset_tokens WHERE token_hash=?').run(tokenHash); } catch { /* Server may have closed. */ }
            });
          });
        }
        // Match the browser-visible timing for known and unknown addresses.
        const remaining = 250 - (Date.now() - started);
        if (remaining > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, remaining));
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && pathname === '/api/password-reset/confirm') {
        const data = await body(req, 2048);
        resetRateLimit(req);
        if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) fail(400, 'RESET_INVALID', 'Link non valido o scaduto.');
        if (typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 1024) fail(400, 'RESET_PASSWORD', 'La password deve contenere da 12 a 1024 caratteri.');
        const tokenHash = hash(data.token);
        const pending = db.prepare('SELECT r.user_id,u.username FROM password_reset_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.expires_at>? AND u.disabled=0').get(tokenHash, now());
        if (!pending) fail(400, 'RESET_INVALID', 'Link non valido o scaduto.');
        const digest = await passwordHash(data.password);
        transaction(db, () => {
          const current = db.prepare('SELECT r.user_id,u.username FROM password_reset_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.expires_at>? AND u.disabled=0').get(tokenHash, now());
          if (!current) fail(400, 'RESET_INVALID', 'Link non valido o scaduto.');
          db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(digest, current.user_id);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.user_id);
          db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(current.user_id);
          audit(db, { id: current.user_id, username: current.username }, 'password-reset-completed');
        });
        return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0) });
      }
      if (method === 'POST' && pathname === '/api/login') {
        const data = await body(req);
        rateLimit(req, typeof data.username === 'string' ? data.username.slice(0,64) : '');
        if (typeof data.username !== 'string' || data.username.length > 64 || typeof data.password !== 'string' || data.password.length > 1024) fail(400, 'LOGIN_INPUT', 'Credenziali non valide.');
        const user = db.prepare('SELECT * FROM users WHERE username=? AND disabled=0').get(data.username);
        const matches = await passwordMatches(data.password, user?.password_hash || dummyPassword);
        if (!user || !matches) { audit(db, null, 'login-failed', null, { username: data.username }); fail(401, 'LOGIN_FAILED', 'Nome utente o password non corretti.'); }
        const raw = secret(), sessionId = hash(raw), csrf = secret();
        transaction(db, () => {
          if (auth) db.prepare('DELETE FROM sessions WHERE id=?').run(auth.sessionId);
          db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
          db.prepare('INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(sessionId, user.id, csrf, now() + sessionMs);
          audit(db, user, 'login');
        });
        announce();
        return send(res, 200, sessionResult({ ...user, csrf }), { 'set-cookie': cookieHeader(raw, Math.floor(sessionMs / 1000)) });
      }
      if (method === 'POST' && pathname === '/api/logout') {
        transaction(db, () => { db.prepare('DELETE FROM sessions WHERE id=?').run(auth.sessionId); audit(db, auth, 'logout'); });
        announce(); return send(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0) });
      }
      if (method === 'GET' && pathname === '/api/state') {
        res.setHeader('vary', 'Cookie');
        // Check only the revision before loading or parsing the business state.
        const etag = stateEtag(stateRevision());
        if (matchesStateEtag(req.headers['if-none-match'], etag)) return res.writeHead(304, { etag }).end();
        const snapshot = records.read();
        return send(res, 200, snapshot, { etag: stateEtag(snapshot.revision) });
      }
      if (method === 'GET' && pathname === '/api/supplier-invoices') return send(res, 200, supplierInvoices.list());
      if (method === 'POST' && pathname === '/api/supplier-invoices') {
        assertWriter(auth);
        const result = supplierInvoices.create(auth, await body(req, 16 * 1024));
        if (!result.replayed) announceSupplierInvoices();
        return send(res, 200, result);
      }
      const supplierRoute = /^\/api\/supplier-invoices\/([^/]+)(?:\/(payments|original))?$/.exec(pathname);
      if (supplierRoute) {
        const [, invoiceId, action] = supplierRoute;
        if (method === 'GET' && !action) return send(res, 200, supplierInvoices.detail(invoiceId));
        if (method === 'GET' && action === 'original') {
          const original = supplierInvoices.original(invoiceId);
          const name = original.filename.replace(/[\\/\r\n\0]/g, '_').slice(0, 200) || 'fattura.xml';
          const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
          const mime = ['application/xml','text/xml','application/pkcs7-mime'].includes(original.mime) ? original.mime : 'application/octet-stream';
          res.writeHead(200, { 'content-type': mime, 'content-length': original.bytes.length,
            'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}` });
          return res.end(original.bytes);
        }
        if (method === 'PATCH' && !action) {
          assertWriter(auth);
          const result = supplierInvoices.edit(auth, invoiceId, await body(req, 16 * 1024));
          announceSupplierInvoices(); return send(res, 200, result);
        }
        if (method === 'POST' && action === 'payments') {
          assertWriter(auth);
          const result = supplierInvoices.pay(auth, invoiceId, await body(req, 4096));
          if (!result.replayed) announceSupplierInvoices();
          return send(res, 200, result);
        }
      }
      if (await sdiApi(req, res, pathname, auth)) return;
      if (method === 'GET' && pathname === '/api/events') {
        if (peers.size >= 200 || [...peers].filter(p => p.sessionId === auth.sessionId).length >= 10) fail(429, 'TOO_MANY_STREAMS', 'Troppe connessioni aperte.');
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', connection: 'keep-alive' });
        const peer = { res, sessionId: auth.sessionId };
        peers.add(peer);
        res.write(`retry: 3000\nevent: change\ndata: ${JSON.stringify(status(auth.sessionId))}\n\n`);
        res.write(`event: supplier-invoices\ndata: ${JSON.stringify({ revision: supplierInvoices.revision() })}\n\n`);
        req.on('close', () => peers.delete(peer));
        return;
      }
      if ((method === 'PUT' && pathname === '/api/changes') || (method === 'POST' && pathname === '/api/import')) {
        const result = records.commit(auth, await body(req), pathname === '/api/import');
        announce(); return send(res, 200, result);
      }
      if (pathname.startsWith('/api/lease') || (method === 'PUT' && pathname === '/api/state')) {
        assertWriter(auth);
        fail(409, 'UPGRADE_REQUIRED', 'Questa pagina usa il vecchio salvataggio. Ricaricala: i turni di modifica non sono più necessari.');
      }
      if (pathname.startsWith('/api/')) fail(404, 'NOT_FOUND', 'Endpoint non trovato.');
      if (!['GET', 'HEAD'].includes(method)) fail(405, 'METHOD', 'Metodo non consentito.');
      let filename;
      if (['/', '/app', '/index.html', '/reset-password'].includes(pathname)) filename = join(root, 'index.html');
      else if (['/legacy', '/officina-fatturazione.html'].includes(pathname)) { if (!auth) fail(401, 'UNAUTHENTICATED', 'Accedere per continuare.'); filename = join(root, 'officina-fatturazione.html'); }
      else if (['/cloud-icon.svg','/cloud-icon-180.png','/cloud-icon-192.png','/cloud-icon-512.png'].includes(pathname)) filename = join(root, pathname.slice(1));
      else if (['/fonts/Manrope-Variable.ttf','/fonts/DMMono-Regular.ttf','/fonts/DMMono-Medium.ttf'].includes(pathname)) filename = join(root, pathname.slice(1));
      else if (pathname.startsWith('/vendor/') && /^[A-Za-z0-9._-]+\.js$/.test(pathname.slice(8))) filename = join(root, 'vendor', pathname.slice(8));
      else if (isPublicScript(pathname.slice(1))) filename = join(root, pathname.slice(1));
      else fail(404, 'NOT_FOUND', 'File non trovato.');
      if (!existsSync(filename) || !statSync(filename).isFile()) fail(404, 'NOT_FOUND', 'File non trovato.');
      let content = readFileSync(filename);
      if (extname(filename) === '.html') content = Buffer.from(content.toString('utf8').replace(/<script\b/gi, `<script nonce="${nonce}"`));
      const contentType = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' }[extname(filename)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType, 'content-length': content.length });
      return res.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
      const statusCode = error instanceof HttpError ? error.status : 500;
      send(res, statusCode, { error: { code: error instanceof HttpError ? error.code : 'INTERNAL', message: error instanceof HttpError ? error.message : 'Errore interno: nessun dato è stato salvato.' }, ...(error.extra || {}) }, statusCode === 429 ? { 'retry-after': '900' } : {});
    }
  }
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const timer = setInterval(() => {
    for (const peer of peers) {
      if (!db.prepare('SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.disabled=0').get(peer.sessionId, now())) { peer.res.end(); peers.delete(peer); }
      else peer.res.write(': heartbeat\n\n');
    }
  }, options.eventIntervalMs || 15_000);
  timer.unref();
  // The PEC collector runs in another process and commits to this same SQLite
  // database. Detect its revisions so connected browsers update automatically.
  const supplierTimer = setInterval(() => {
    const current = supplierInvoices.revision();
    if (current !== lastSupplierRevision) announceSupplierInvoices();
  }, options.supplierEventIntervalMs || 5_000);
  supplierTimer.unref();
  sdi.start();
  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    clearInterval(timer);
    clearInterval(supplierTimer);
    for (const peer of peers) peer.res.end();
    peers.clear();
    if (server.listening) await new Promise(resolveClose => { server.close(resolveClose); server.closeIdleConnections(); });
    await sdi.stop();
    db.close(); unlock();
  }
  return { server, db, close, origin: origin.origin, dataDir, announceSupplierInvoices, sdi };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let app;
  try {
    app = await createApplication();
    const port = Number(process.env.PORT || 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT non valida.');
    await new Promise((resolveListen, reject) => { app.server.once('error', reject); app.server.listen(port, process.env.HOST || '127.0.0.1', resolveListen); });
    console.log(`Gestionale pronto: ${app.origin} — archivio ${app.dataDir}`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exitCode = 0; };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { console.error(error.message); if (app) await app.close(); process.exitCode = 1; }
}
