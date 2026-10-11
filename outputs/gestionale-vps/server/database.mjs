import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0].length < 1 || parts[0].length > 64 || parts[1].length > 253 || !/^[a-z0-9._%+-]+$/.test(parts[0])) return null;
  const labels = parts[1].split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return email;
}

export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('La password deve contenere da 12 a 1024 caratteri.');
  const salt = randomBytes(16).toString('hex');
  const result = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${result.toString('hex')}`;
}

export async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || password.length > 1024 || typeof stored !== 'string') return false;
  const [algorithm, salt, expected] = stored.split(':');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(expected || '')) return false;
  const result = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return safeEqual(result.toString('hex'), expected);
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = resolve(dataDir, 'officina.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 5) { db.close(); throw new Error('Database più recente del software: aggiornare il server.'); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, payload TEXT, updated_at INTEGER);
    INSERT OR IGNORE INTO state(id,revision) VALUES(1,0);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')), disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, client_id TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (mutation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id INTEGER, username TEXT, action TEXT NOT NULL, revision INTEGER, details TEXT);
    CREATE INDEX IF NOT EXISTS audit_revision ON audit(revision,id);
    CREATE TABLE IF NOT EXISTS record_versions (key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(receipts)').all().some(c => c.name === 'result')) db.exec('ALTER TABLE receipts ADD COLUMN result TEXT');
  if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS password_reset_expiry ON password_reset_tokens(expires_at);
  `);
  try { db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS supplier_ledger_meta (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO supplier_ledger_meta(id,revision) VALUES(1,0);
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
      source TEXT NOT NULL,
      source_key TEXT UNIQUE,
      document_type TEXT,
      supplier_name TEXT NOT NULL,
      supplier_tax_id TEXT,
      number TEXT NOT NULL,
      issue_date TEXT NOT NULL,
      due_date TEXT,
      total_cents INTEGER CHECK(total_cents IS NULL OR total_cents > 0),
      verified INTEGER NOT NULL DEFAULT 1 CHECK(verified IN (0,1)),
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS supplier_invoices_due ON supplier_invoices(due_date,issue_date);
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_document_unique
      ON supplier_invoices(supplier_tax_id,number,issue_date)
      WHERE supplier_tax_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS supplier_invoice_payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      paid_at TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS supplier_invoice_payments_invoice ON supplier_invoice_payments(invoice_id);
    CREATE TABLE IF NOT EXISTS supplier_invoice_originals (
      invoice_id TEXT PRIMARY KEY REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplier_invoice_mutations (
      mutation_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sdi_channel_identity (
      environment TEXT PRIMARY KEY CHECK(environment IN ('test','production')),
      identity TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sdi_outbox (
      id TEXT PRIMARY KEY, environment TEXT NOT NULL CHECK(environment IN ('test','production')),
      document_id TEXT NOT NULL, filename TEXT NOT NULL, digest TEXT NOT NULL, fiscal_key TEXT NOT NULL,
      xml BLOB NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL CHECK(state IN ('READY','IN_FLIGHT','SDI_RECEIVED','TRANSPORT_REJECTED','UNKNOWN')),
      sdi_id TEXT, fiscal_state TEXT NOT NULL DEFAULT 'PENDING', conflict INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(environment,document_id), UNIQUE(environment,filename), UNIQUE(environment,digest), UNIQUE(environment,fiscal_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sdi_outbox_identifier ON sdi_outbox(environment,sdi_id) WHERE sdi_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS sdi_outbox_attempts (
      id TEXT PRIMARY KEY, outbox_id TEXT NOT NULL REFERENCES sdi_outbox(id), started_at INTEGER NOT NULL,
      finished_at INTEGER, result TEXT
    );
    CREATE TABLE IF NOT EXISTS sdi_notifications (
      id TEXT PRIMARY KEY, environment TEXT NOT NULL, sdi_id TEXT NOT NULL, invoice_filename TEXT NOT NULL,
      filename TEXT NOT NULL, outcome TEXT NOT NULL, digest TEXT NOT NULL, payload BLOB NOT NULL,
      raw_body BLOB NOT NULL, parsed TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'UNMATCHED',
      outbox_id TEXT REFERENCES sdi_outbox(id), reason TEXT, created_at INTEGER NOT NULL,
      UNIQUE(environment,sdi_id,filename,digest)
    );
    CREATE INDEX IF NOT EXISTS sdi_notifications_pending ON sdi_notifications(environment,sdi_id,invoice_filename);
    CREATE TABLE IF NOT EXISTS sdi_inbox (
      id TEXT PRIMARY KEY, environment TEXT NOT NULL, sdi_id TEXT NOT NULL, filename TEXT NOT NULL,
      digest TEXT NOT NULL, payload BLOB NOT NULL, raw_body BLOB NOT NULL, metadata BLOB,
      state TEXT NOT NULL DEFAULT 'PENDING', conflict INTEGER NOT NULL DEFAULT 0, reason TEXT,
      supplier_invoice_id TEXT REFERENCES supplier_invoices(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(environment,sdi_id,filename,digest)
    );
    CREATE INDEX IF NOT EXISTS sdi_inbox_identifier ON sdi_inbox(environment,sdi_id);
    CREATE TABLE IF NOT EXISTS sdi_inbox_documents (
      inbox_id TEXT NOT NULL REFERENCES sdi_inbox(id),
      body_index INTEGER NOT NULL CHECK(body_index >= 0),
      supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id),
      PRIMARY KEY(inbox_id,body_index)
    );
    INSERT OR IGNORE INTO sdi_inbox_documents(inbox_id,body_index,supplier_invoice_id)
      SELECT id,0,supplier_invoice_id FROM sdi_inbox WHERE supplier_invoice_id IS NOT NULL;
    PRAGMA user_version=5;
    COMMIT;
  `); } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ }
    db.close();
    throw error;
  }
  try { chmodSync(filename, 0o600); } catch { /* Windows may not support chmod. */ }
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function audit(db, user, action, revision = null, details = null) {
  db.prepare('INSERT INTO audit(at,user_id,username,action,revision,details) VALUES(?,?,?,?,?,?)').run(Date.now(), user?.id ?? null, user?.username ?? null, action, revision, details === null ? null : JSON.stringify(details));
}

export function addUser(db, username, password, role = 'operator', email = null) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]{2,63}$/.test(username || '')) throw new Error('Nome utente: 3–64 lettere, numeri, punto, trattino, @ o underscore.');
  if (!['admin', 'operator', 'viewer'].includes(role)) throw new Error('Ruolo non valido.');
  if (email !== null) {
    email = normalizeEmail(email);
    if (!email) throw new Error('Indirizzo email non valido.');
  }
  return passwordHash(password).then(digest => transaction(db, () => {
    const result = db.prepare('INSERT INTO users(username,password_hash,role,email,created_at) VALUES(?,?,?,?,?)').run(username, digest, role, email, Date.now());
    audit(db, { id: Number(result.lastInsertRowid), username }, 'user-created', null, { role });
    return Number(result.lastInsertRowid);
  }));
}
