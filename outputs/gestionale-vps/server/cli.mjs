import { DatabaseSync, backup } from 'node:sqlite';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { openDatabase, addUser, passwordHash, transaction, audit, normalizeEmail } from './database.mjs';
import { acquireProcessLock } from './server.mjs';
import { makeStateValidator } from './validation.mjs';
import { createSdiStore } from './sdi-store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const databasePath = join(dataDir, 'officina.sqlite');
const [command, argument, ...rest] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const validateState = makeStateValidator(require(join(root, 'cloud-schema.js')));

async function readPassword() {
  if (process.stdin.isTTY) {
    process.stderr.write('Password (almeno 12 caratteri, input nascosto): ');
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const input = createInterface({ input: process.stdin, output: sink, terminal: true });
    return await new Promise((resolvePassword, reject) => {
      input.once('line', line => { input.close(); process.stderr.write('\n'); resolvePassword(line); });
      input.once('SIGINT', () => { input.close(); reject(new Error('Operazione annullata.')); });
    });
  }
  let text = '';
  for await (const chunk of process.stdin) { text += chunk.toString('utf8'); if (text.length > 2048) throw new Error('Password troppo lunga.'); }
  return text.replace(/\r?\n$/, '');
}

function verifyDatabase(db) {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Controllo integrità SQLite fallito.');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![1,2,3,4,5].includes(version)) throw new Error('Versione database non supportata.');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  if (!['state','users','sessions','lease','receipts','audit'].every(t => tables.has(t))) throw new Error('Backup incompleto o non appartenente al gestionale.');
  if (version >= 4 && !['supplier_ledger_meta','supplier_invoices','supplier_invoice_payments','supplier_invoice_originals','supplier_invoice_mutations'].every(t => tables.has(t))) throw new Error('Backup incompleto: manca il registro delle fatture fornitori.');
  if (version >= 5 && !['sdi_channel_identity','sdi_outbox','sdi_outbox_attempts','sdi_inbox','sdi_inbox_documents','sdi_notifications'].every(t => tables.has(t))) throw new Error('Backup incompleto: manca l’archivio del canale SdI.');
  const row = db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Revisione archivio non valida.');
  if (row.payload) validateState(JSON.parse(row.payload));
}

async function backupTo(db, destination) {
  if (!destination || !isAbsolute(destination)) throw new Error('Specificare un percorso assoluto per il backup.');
  if (existsSync(destination)) throw new Error('Il file destinazione esiste già: non verrà sovrascritto.');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.partial-${randomUUID()}`;
  try {
    await backup(db, temporary);
    const check = new DatabaseSync(temporary, { readOnly: true });
    try { verifyDatabase(check); } finally { check.close(); }
    chmodSync(temporary, 0o600);
    renameSync(temporary, destination);
  } catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
}

async function restoreFrom(sourcePath) {
  if (!sourcePath || !isAbsolute(sourcePath) || !existsSync(sourcePath) || resolve(sourcePath) === databasePath) throw new Error('Specificare un backup esistente con percorso assoluto, diverso dal database attivo.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const unlock = acquireProcessLock(dataDir);
  const stagingPath = join(dataDir, `restore-${randomUUID()}.sqlite`);
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try { verifyDatabase(source); await backupTo(source, stagingPath); } finally { source.close(); }
    const staging = new DatabaseSync(stagingPath);
    try {
      staging.exec('PRAGMA foreign_keys=ON');
      // A restored queue may predate an actual transmission. Never replay it.
      if (staging.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sdi_outbox'").get()) {
        for (const environment of ['test','production']) createSdiStore(staging,{environment}).recoverInterrupted({afterRestore:true});
      }
      transaction(staging, () => {
        // Restoring never resurrects old browser sessions or old write permissions.
        staging.exec('DELETE FROM lease; DELETE FROM sessions; DELETE FROM receipts;');
        if (staging.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='password_reset_tokens'").get()) staging.exec('DELETE FROM password_reset_tokens');
        audit(staging, null, 'database-restored', staging.prepare('SELECT revision FROM state WHERE id=1').get().revision);
      });
      staging.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
    } finally { staging.close(); }
    if (existsSync(databasePath)) {
      const current = new DatabaseSync(databasePath);
      try {
        await backupTo(current, join(dataDir, `before-restore-${Date.now()}.sqlite`));
        current.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
      } finally { current.close(); }
      // Both databases are closed and server.lock excludes the application.
      for (const suffix of ['-wal','-shm']) if (existsSync(databasePath + suffix)) unlinkSync(databasePath + suffix);
      const replaced = join(dataDir, `replaced-${randomUUID()}.sqlite`);
      renameSync(databasePath, replaced);
      try { renameSync(stagingPath, databasePath); unlinkSync(replaced); }
      catch (error) { if (!existsSync(databasePath)) renameSync(replaced, databasePath); throw error; }
    } else renameSync(stagingPath, databasePath);
    console.log('Ripristino completato. Le sessioni precedenti sono state invalidate. Riavviare il server e accedere.');
  } finally {
    if (existsSync(stagingPath)) unlinkSync(stagingPath);
    unlock();
  }
}

let db;
try {
  if (command === 'restore') await restoreFrom(argument);
  else if (['user-add','user-password','user-email','user-email-clear','user-disable','user-enable','users','backup','audit','check'].includes(command)) {
    db = openDatabase(dataDir);
    if (command === 'user-add') {
      const roleIndex = rest.indexOf('--role');
      const role = roleIndex >= 0 ? rest[roleIndex + 1] : 'operator';
      const emailIndex = rest.indexOf('--email');
      const email = emailIndex >= 0 ? rest[emailIndex + 1] : null;
      if (emailIndex >= 0 && !normalizeEmail(email)) throw new Error('Indirizzo email non valido.');
      await addUser(db, argument, await readPassword(), role, email);
      console.log(`Utente ${argument} creato con ruolo ${role}.`);
    } else if (command === 'user-password') {
      const user = db.prepare('SELECT id,username FROM users WHERE username=?').get(argument);
      if (!user) throw new Error('Utente non trovato.');
      const digest = await passwordHash(await readPassword());
      transaction(db, () => {
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(digest, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(user.id);
        audit(db, user, 'password-changed');
      });
      console.log(`Password aggiornata; sessioni di ${user.username} invalidate.`);
    } else if (command === 'user-email' || command === 'user-email-clear') {
      const user = db.prepare('SELECT id,username FROM users WHERE username=?').get(argument);
      if (!user) throw new Error('Utente non trovato.');
      const email = command === 'user-email-clear' ? null : normalizeEmail(rest[0]);
      if (command === 'user-email' && !email) throw new Error('Specificare un indirizzo email valido.');
      transaction(db, () => {
        db.prepare('UPDATE users SET email=? WHERE id=?').run(email, user.id);
        db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(user.id);
        audit(db, user, email ? 'user-email-set' : 'user-email-cleared');
      });
      console.log(email ? `Email di ${user.username} impostata. Associare solo indirizzi di cui si è già verificata la proprietà con l’utente.` : `Email di ${user.username} rimossa.`);
    } else if (['user-disable','user-enable'].includes(command)) {
      const user = db.prepare('SELECT id,username,role,disabled FROM users WHERE username=?').get(argument);
      if (!user) throw new Error('Utente non trovato.');
      const disabled = command === 'user-disable' ? 1 : 0;
      transaction(db, () => {
        if (disabled && user.role === 'admin' && !user.disabled && db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n < 2) throw new Error('Non si può disabilitare l’ultimo amministratore attivo.');
        db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled, user.id);
        if (disabled) {
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
          db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(user.id);
        }
        audit(db, user, disabled ? 'user-disabled' : 'user-enabled');
      });
      console.log(`Utente ${user.username} ${disabled ? 'disabilitato' : 'abilitato'}.`);
    } else if (command === 'users') console.table(db.prepare('SELECT id,username,role,email,disabled FROM users ORDER BY username').all());
    else if (command === 'audit') {
      const limit = Number(argument || 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Numero eventi: da 1 a 1000.');
      console.table(db.prepare('SELECT at,username,action,revision,details FROM audit ORDER BY id DESC LIMIT ?').all(limit).map(row => ({ ...row, at: new Date(row.at).toISOString() })));
    } else if (command === 'backup') { await backupTo(db, argument); console.log(`Backup verificato: ${argument}`); }
    else if (command === 'check') { verifyDatabase(db); console.log('Integrità archivio verificata.'); }
  } else {
    console.log('Comandi: user-add <nome> --role admin|operator|viewer [--email indirizzo] (password stdin), user-password <nome> (password stdin), user-email <nome> <indirizzo>, user-email-clear <nome>, user-disable <nome>, user-enable <nome>, users, audit [numero], backup <percorso-assoluto>, restore <percorso-assoluto> (server fermo), check. Impostare DATA_DIR. Associare email solo dopo averne verificato la proprietà con l’utente.');
    if (command) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }
