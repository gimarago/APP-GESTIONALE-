import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from './server.mjs';
import { addUser, hash, openDatabase } from './database.mjs';

const ORIGIN = 'https://officina.example.test';
const OLD_PASSWORD = 'old password for testing';
const NEW_PASSWORD = 'new password for testing';

async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'officina-reset-test-'));
  let time = Date.now();
  const sent = [];
  const app = await createApplication({
    dataDir,
    origin: ORIGIN,
    env: { NODE_ENV: 'test' },
    now: () => time,
    ...(options.sender === false ? {} : { sendPasswordResetEmail: async mail => { sent.push(mail); } })
  });
  await addUser(app.db, 'mario', OLD_PASSWORD, 'operator', 'mario@example.test');
  await addUser(app.db, 'lucia', OLD_PASSWORD, 'operator', 'lucia@example.test');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', payload, cookie = '') {
    const response = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' })
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json().catch(() => null)
    };
  }
  return { app, request, sent, advance(ms) { time += ms; } };
}

test('reset uses a fixed HTTPS link, reveals no account, and revokes old sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/session')).body.passwordResetAvailable, true);
  const login = await f.request('/api/login', 'POST', { username: 'mario', password: OLD_PASSWORD });
  assert.equal(login.status, 200);
  const oldCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/state', 'GET', undefined, oldCookie)).status, 200);

  const known = await f.request('/api/password-reset/request', 'POST', { email: 'MARIO@EXAMPLE.TEST' });
  const unknown = await f.request('/api/password-reset/request', 'POST', { email: 'nobody@example.test' });
  assert.deepEqual(known.body, { ok: true });
  assert.deepEqual(unknown.body, known.body);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'mario@example.test');
  const link = new URL(f.sent[0].resetUrl);
  assert.equal(link.origin, ORIGIN);
  assert.equal(link.pathname, '/reset-password');
  const token = link.searchParams.get('token');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const stored = f.app.db.prepare('SELECT token_hash FROM password_reset_tokens').get();
  assert.equal(stored.token_hash, hash(token));
  assert.notEqual(stored.token_hash, token);

  const page = await fetch(`http://127.0.0.1:${f.app.server.address().port}/reset-password?token=${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store');

  assert.equal((await f.request('/api/password-reset/confirm', 'POST', { token: 'invalid', password: NEW_PASSWORD })).body.error.code, 'RESET_INVALID');
  assert.equal((await f.request('/api/password-reset/confirm', 'POST', { token, password: 'too short' })).body.error.code, 'RESET_PASSWORD');
  assert.deepEqual((await f.request('/api/password-reset/confirm', 'POST', { token, password: NEW_PASSWORD })).body, { ok: true });
  assert.equal((await f.request('/api/state', 'GET', undefined, oldCookie)).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { username: 'mario', password: OLD_PASSWORD })).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { username: 'mario', password: NEW_PASSWORD })).status, 200);
  assert.equal((await f.request('/api/password-reset/confirm', 'POST', { token, password: OLD_PASSWORD })).body.error.code, 'RESET_INVALID');
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM password_reset_tokens').get().n, 0);
});

test('new request invalidates previous link, and expired link cannot change password', async t => {
  const f = await fixture(t);
  await f.request('/api/password-reset/request', 'POST', { email: 'mario@example.test' });
  const first = new URL(f.sent.at(-1).resetUrl).searchParams.get('token');
  await f.request('/api/password-reset/request', 'POST', { email: 'mario@example.test' });
  const second = new URL(f.sent.at(-1).resetUrl).searchParams.get('token');
  assert.notEqual(first, second);
  assert.equal((await f.request('/api/password-reset/confirm', 'POST', { token: first, password: NEW_PASSWORD })).body.error.code, 'RESET_INVALID');
  f.advance(30 * 60_000 + 1);
  assert.equal((await f.request('/api/password-reset/confirm', 'POST', { token: second, password: NEW_PASSWORD })).body.error.code, 'RESET_INVALID');
  assert.equal((await f.request('/api/login', 'POST', { username: 'mario', password: OLD_PASSWORD })).status, 200);
});

test('recovery is disabled without mail transport and requests are throttled', async t => {
  const disabled = await fixture(t, { sender: false });
  assert.equal((await disabled.request('/api/session')).body.passwordResetAvailable, false);
  assert.equal((await disabled.request('/api/password-reset/request', 'POST', { email: 'mario@example.test' })).body.error.code, 'RESET_UNAVAILABLE');

  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.request('/api/password-reset/request', 'POST', { email: 'nobody@example.test' })).status, 200);
  }
  const limited = await f.request('/api/password-reset/request', 'POST', { email: 'nobody@example.test' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMIT');
});

test('existing version-2 database gains email recovery tables without losing users', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'officina-reset-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const old = new DatabaseSync(join(dataDir, 'officina.sqlite'));
  old.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL); PRAGMA user_version=2;");
  old.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)').run(7, 'existing', 'legacy-hash', 'admin', 123);
  old.close();
  const db = openDatabase(dataDir);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.deepEqual({ ...db.prepare('SELECT id,username,password_hash,email FROM users WHERE id=7').get() }, { id: 7, username: 'existing', password_hash: 'legacy-hash', email: null });
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='password_reset_tokens'").get());
  } finally { db.close(); }
});
