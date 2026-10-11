import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase, transaction } from './database.mjs';
import { importPecInvoice } from './supplier-invoices.mjs';
import { xmlEngine } from '../backend/src/xml/engine.js';

const SCRIPT = fileURLToPath(new URL('./pec-fetch.py', import.meta.url));
const XML_MAX = 2_000_000;
const OUTPUT_MAX = 45_000_000;
const POLL_MS = 60_000;
const CODES = new Set([
  'PEC_MESSAGE_SIZE', 'PEC_ATTACHMENT_INVALID', 'PEC_SIGNED_FILE_UNSUPPORTED',
  'PEC_ZIP_SIZE', 'PEC_ZIP_ENTRY_LIMIT', 'PEC_ZIP_ENTRY_UNSAFE',
  'PEC_ZIP_EXPANSION', 'PEC_ZIP_SIZE_MISMATCH', 'PEC_ZIP_INVALID',
  'PEC_XML_SIZE', 'PEC_ATTACHMENT_LIMIT', 'PEC_MIME_COMPLEXITY',
  'PEC_FETCH_FAILED', 'PEC_NOT_CONFIGURED', 'PEC_LOGIN_FAILED',
  'PEC_MAILBOX_UNAVAILABLE', 'PEC_UIDVALIDITY_MISSING', 'PEC_CONFIG_INVALID',
  'PEC_CURSOR_INVALID', 'PEC_SEARCH_FAILED', 'PEC_CONNECTION_FAILED',
  'PEC_INPUT_LIMIT', 'PEC_ACTION_INVALID', 'PEC_INTERNAL',
]);

export function parseEuroCents(value) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) return null;
  const [integer, fraction = ''] = value.split('.');
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return cents > 0n && cents <= 1_000_000_000_000n ? Number(cents) : null;
}

export function planInvoices(parsed, xmlBytes, filename, shopVat) {
  if (!parsed?.xsdValidated || parsed.buyer?.country !== 'IT' || parsed.buyer?.vat !== shopVat) {
    return { items: [], issues: ['PEC_RECIPIENT_MISMATCH'] };
  }
  const seller = parsed.seller;
  if (!seller || !Array.isArray(parsed.documents) || !parsed.documents.length || !seller.vat && !seller.cf) {
    return { items: [], issues: ['PEC_DOCUMENT_INCOMPLETE'] };
  }
  const supplierTaxId = seller.vat ? `${seller.country || 'IT'}${seller.vat}` : seller.cf;
  if (typeof supplierTaxId !== 'string' || supplierTaxId.length > 32 || typeof seller.name !== 'string' || !seller.name.trim() || seller.name.trim().length > 200) {
    return { items: [], issues: ['PEC_DOCUMENT_INCOMPLETE'] };
  }
  const digest = createHash('sha256').update(xmlBytes).digest('hex');
  const items = [];
  let uncertain = false;
  for (const document of parsed.documents) {
    if (!Number.isInteger(document.bodyIndex) || document.bodyIndex < 0 ||
        !/^TD\d{2}$/.test(document.type || '') ||
        typeof document.number !== 'string' || !document.number.trim() || document.number.trim().length > 80 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(document.date || '')) {
      return { items: [], issues: ['PEC_DOCUMENT_INCOMPLETE'] };
    }
    const credit = ['TD04', 'TD08'].includes(document.type);
    const totalCents = credit || document.currency !== 'EUR' ? null : parseEuroCents(document.total);
    if (totalCents === null) uncertain = true;
    const dueDate = typeof document.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(document.dueDate) && document.dueDate >= document.date
      ? document.dueDate : null;
    items.push({
      sourceKey: `pec:${digest}:${document.bodyIndex}`,
      supplierName: seller.name.trim(), supplierTaxId,
      number: document.number.trim(), issueDate: document.date,
      dueDate, totalCents,
      documentType: document.type, originalBytes: xmlBytes,
      filename,
    });
  }
  return { items, issues: uncertain ? ['PEC_TOTAL_REVIEW_REQUIRED'] : [] };
}

export function openPecState(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pec_checkpoint (
    id INTEGER PRIMARY KEY CHECK(id=1),
    uidvalidity TEXT NOT NULL,
    last_uid INTEGER NOT NULL CHECK(last_uid>=0),
    updated_at INTEGER NOT NULL
  )`);
  return {
    read: () => ({ uidvalidity: '', lastUid: 0,
      ...db.prepare('SELECT uidvalidity AS uidvalidity,last_uid AS lastUid FROM pec_checkpoint WHERE id=1').get() }),
    write: (uidvalidity, lastUid) => {
      if (!/^[1-9]\d*$/.test(String(uidvalidity)) || !Number.isSafeInteger(lastUid) || lastUid < 0) throw Error('PEC_CURSOR_INVALID');
      db.prepare(`INSERT INTO pec_checkpoint(id,uidvalidity,last_uid,updated_at) VALUES(1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET uidvalidity=excluded.uidvalidity,last_uid=excluded.last_uid,updated_at=excluded.updated_at`)
        .run(String(uidvalidity), lastUid, Date.now());
    },
  };
}

function safeStatus(db, changes) {
  const old = readStatus(db);
  const value = {
    lastRunAt: changes.lastRunAt ?? old.lastRunAt ?? null,
    lastSuccessAt: changes.lastSuccessAt ?? old.lastSuccessAt ?? null,
    imported: changes.imported ?? old.imported ?? 0,
    issues: changes.issues ?? old.issues ?? 0,
    errorCode: changes.errorCode === undefined ? old.errorCode ?? null : changes.errorCode,
  };
  transaction(db, () => {
    db.prepare(`INSERT INTO metadata(key,value) VALUES('pec-sync-status',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(value));
    db.prepare('UPDATE supplier_ledger_meta SET revision=revision+1 WHERE id=1').run();
  });
  return value;
}

function readStatus(db) {
  try { return JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='pec-sync-status'").get()?.value || '{}'); }
  catch { return {}; }
}

export async function pythonFetch(input, { env = process.env, executable } = {}) {
  const python = executable || env.OFFICINA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let size = 0, output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolvePromise(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(Error('PEC_FETCH_TIMEOUT')); }, 120_000);
    child.on('error', () => finish(Error('PEC_FETCH_UNAVAILABLE')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > OUTPUT_MAX) { child.kill(); finish(Error('PEC_FETCH_OUTPUT_LIMIT')); }
      else output += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('close', () => {
      if (settled) return;
      try {
        const result = JSON.parse(output);
        if (!result.ok) return finish(Error(CODES.has(result.code) ? result.code : 'PEC_FETCH_FAILED'));
        finish(null, result.result);
      } catch { finish(Error('PEC_FETCH_FAILED')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function pollOnce(db, shopVat, fetcher = pythonFetch) {
  if (!/^\d{11}$/.test(shopVat || '') || /^0+$/.test(shopVat)) throw Error('PEC_SHOP_VAT_INVALID');
  const checkpoint = openPecState(db);
  const cursor = checkpoint.read();
  const started = new Date().toISOString();
  const previous = readStatus(db);
  const previousImported = Number.isSafeInteger(previous.imported) && previous.imported >= 0 ? previous.imported : 0;
  const previousIssues = Number.isSafeInteger(previous.issues) && previous.issues >= 0 ? previous.issues : 0;
  let imported = 0, issues = 0;
  safeStatus(db, { lastRunAt: started });
  try {
    const result = await fetcher({ action: 'poll', ...cursor });
    if (!result || !/^[1-9]\d*$/.test(String(result.uidvalidity)) || !Array.isArray(result.messages)) throw Error('PEC_FETCH_INVALID');
    if (result.uidvalidity !== cursor.uidvalidity && cursor.uidvalidity && !result.reset) throw Error('PEC_UIDVALIDITY_INVALID');
    let lastUid = result.reset ? 0 : cursor.lastUid;
    for (const message of result.messages) {
      if (!Number.isSafeInteger(message.uid) || message.uid <= lastUid || !Array.isArray(message.files) || !Array.isArray(message.issues)) throw Error('PEC_FETCH_INVALID');
      for (const issue of message.issues) {
        issues++;
        console.warn(`PEC_MESSAGE_ISSUE ${CODES.has(issue) ? issue : 'PEC_ATTACHMENT_INVALID'}`);
      }
      for (const file of message.files) {
        if (!file || typeof file.base64 !== 'string' || typeof file.filename !== 'string' || file.filename.length > 180) throw Error('PEC_FETCH_INVALID');
        const xmlBytes = Buffer.from(file.base64, 'base64');
        if (!xmlBytes.length || xmlBytes.length > XML_MAX) { issues++; console.warn('PEC_MESSAGE_ISSUE PEC_XML_SIZE'); continue; }
        let parsed;
        try {
          const xml = new TextDecoder('utf-8', { fatal: true }).decode(xmlBytes);
          if (/<\?xml[^?]*encoding\s*=\s*["'](?!utf-8["'])/i.test(xml)) throw Error('PEC_XML_ENCODING');
          parsed = await xmlEngine({ mode: 'inspect-invoice', xml });
        } catch {
          issues++; console.warn('PEC_MESSAGE_ISSUE PEC_XML_INVALID');
          continue;
        }
        const plan = planInvoices(parsed, xmlBytes, file.filename, shopVat);
        for (const issue of plan.issues) {
          // A missing/ambiguous amount is visible on the imported invoice as
          // "Da verificare"; it is not a lost document or collector failure.
          if (issue !== 'PEC_TOTAL_REVIEW_REQUIRED') issues++;
          console.warn(`PEC_MESSAGE_ISSUE ${issue}`);
        }
        for (const data of plan.items) {
          // The supplier invoice store serializes imports in BEGIN IMMEDIATE and
          // reconciles by both immutable source key and fiscal document identity.
          const saved = importPecInvoice(db, data);
          if (saved.imported) imported++;
          else if (!db.prepare('SELECT id FROM supplier_invoices WHERE source_key=?').get(data.sourceKey)) {
            // A different source (including a manually entered invoice) already
            // owns this fiscal identity. Keep the PEC mail and flag review.
            issues++; console.warn('PEC_MESSAGE_ISSUE PEC_FISCAL_DUPLICATE_REVIEW');
          }
        }
      }
      lastUid = message.uid;
      // Cursor is advanced only after every invoice in the message was committed.
      // Replaying after a crash is safe because imports are idempotent.
      checkpoint.write(result.uidvalidity, lastUid);
    }
    if (!result.messages.length && result.uidvalidity !== cursor.uidvalidity) checkpoint.write(result.uidvalidity, 0);
    safeStatus(db, { lastSuccessAt: new Date().toISOString(), imported: previousImported + imported,
      issues: previousIssues + issues,
      errorCode: previousIssues + issues ? 'PEC_IMPORT_ISSUES' : null });
    return { imported, issues, more: !!result.more };
  } catch (error) {
    const code = /^PEC_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PEC_IMPORT_FAILED';
    safeStatus(db, { imported: previousImported + imported, issues: previousIssues + issues, errorCode: code });
    console.error(`PEC_SYNC_FAILURE ${code}`);
    throw Error(code);
  }
}

export async function runWorker(env = process.env) {
  if (!env.PEC_USER || !env.PEC_APP_PASSWORD || !env.SHOP_VAT) throw Error('PEC_NOT_CONFIGURED');
  const db = openDatabase(resolve(env.DATA_DIR || join(fileURLToPath(new URL('..', import.meta.url)), 'data')));
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    while (!stopping) {
      let more = false;
      try { more = (await pollOnce(db, env.SHOP_VAT, input => pythonFetch(input, { env }))).more; }
      catch { /* Status and safe issue code were persisted by pollOnce. */ }
      if (!more) await new Promise(resolveDelay => setTimeout(resolveDelay, POLL_MS));
    }
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runWorker().catch(error => { console.error(/^PEC_[A-Z_]+$/.test(error?.message || '') ? error.message : 'PEC_WORKER_FAILED'); process.exitCode = 1; });
}
