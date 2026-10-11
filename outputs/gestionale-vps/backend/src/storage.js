import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {assertSimulation} from './config.js';
export class Store {
  static async open(path) {
    assertSimulation();
    await mkdir(dirname(path), {recursive:true});
    return new Store(path);
  }
  constructor(path) {
    assertSimulation();
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, draft TEXT NOT NULL, status TEXT NOT NULL, payment TEXT NOT NULL, xml TEXT);
      CREATE TABLE IF NOT EXISTS queue(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id), state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), state TEXT NOT NULL, correlation TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, entity TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(type, entity, detail = {}) {
    this.db.prepare('INSERT INTO events(at,type,entity,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), type, entity, JSON.stringify(detail));
  }
  close() { this.db.close(); }
}
