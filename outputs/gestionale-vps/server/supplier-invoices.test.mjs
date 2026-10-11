import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { createApplication } from './server.mjs';
import { addUser } from './database.mjs';
import { importPecInvoice } from './supplier-invoices.mjs';

const ORIGIN = 'http://localhost:8080';
const PASSWORD = 'correct horse battery staple';
const TIME = Date.parse('2026-09-23T10:00:00Z');

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'officina-supplier-test-'));
  const app = await createApplication({ dataDir: directory, origin: ORIGIN, now: () => TIME,
    env: { NODE_ENV: 'test' }, supplierEventIntervalMs: 100 });
  await addUser(app.db, 'operator', PASSWORD, 'operator');
  await addUser(app.db, 'viewer', PASSWORD, 'viewer');
  await new Promise(ok => app.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('officina-supplier-test-')) throw new Error('Unsafe test cleanup');
    rmSync(absolute, { recursive: true, force: true });
  });
  async function request(user, path, method = 'GET', data) {
    const headers = { ...(user?.cookie ? { cookie: user.cookie } : {}),
      ...(method === 'GET' ? {} : { origin: ORIGIN, 'x-csrf-token': user?.csrf || '', 'content-type': 'application/json' }) };
    const response = await fetch(base + path, { method, headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('json') ? await response.json() : await response.text();
    return { status: response.status, body, headers: response.headers };
  }
  async function login(username) {
    const response = await request(null, '/api/login', 'POST', { username, password: PASSWORD });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.body.csrf };
  }
  return { app, request, login, base };
}

const invoice = (overrides = {}) => ({ mutationId: randomUUID(), supplierName: 'Ricambi Rossi',
  supplierTaxId: 'IT01234567890', number: '17/A', issueDate: '2026-09-20', dueDate: '2026-09-30',
  totalCents: 12500, notes: '', ...overrides });

test('supplier invoices: partial and final payments update the payable totals across users', async t => {
  const f = await fixture(t), a = await f.login('operator'), b = await f.login('operator');
  const created = await f.request(a, '/api/supplier-invoices', 'POST', invoice());
  assert.equal(created.status, 200);
  assert.equal(created.body.item.outstandingCents, 12500);
  const id = created.body.item.id;
  const partial = await f.request(b, `/api/supplier-invoices/${id}/payments`, 'POST',
    { mutationId: randomUUID(), amountCents: 4000, paidAt: '2026-09-21', method: 'bonifico', reference: 'TRN-1' });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.item.status, 'partial');
  const view = await f.request(a, '/api/supplier-invoices');
  assert.equal(view.body.summary.toPayCents, 8500);
  assert.equal(view.body.summary.dueSoonCents, 8500);
  assert.equal(view.body.summary.averagePaymentDays, 1, 'supplier payment days use the amount-weighted invoice-to-payment delay');
  assert.equal(view.body.summary.paymentCount, 1);
  assert.equal(view.body.items[0].paidCents, 4000);
  assert.equal((await f.request(a, `/api/supplier-invoices/${id}`)).body.payments[0].reference, 'TRN-1');
  const final = await f.request(b, `/api/supplier-invoices/${id}/payments`, 'POST',
    { mutationId: randomUUID(), amountCents: 8500, paidAt: '2026-09-23' });
  assert.equal(final.status, 200);
  assert.equal(final.body.item.status, 'paid');
  const settledView = await f.request(a, '/api/supplier-invoices');
  assert.equal(settledView.body.summary.toPayCents, 0);
  assert.equal(settledView.body.summary.averagePaymentDays, 2.36);
  assert.equal(settledView.body.summary.paymentCount, 2);
});

test('supplier invoices: concurrent payments cannot overpay; retries cannot duplicate', async t => {
  const f = await fixture(t), a = await f.login('operator'), b = await f.login('operator');
  const created = await f.request(a, '/api/supplier-invoices', 'POST', invoice());
  assert.equal((await f.request(a, '/api/supplier-invoices')).body.summary.averagePaymentDays, null,
    'unpaid invoices do not imply a supplier payment delay');
  const path = `/api/supplier-invoices/${created.body.item.id}/payments`;
  const payment = { mutationId: randomUUID(), amountCents: 8000, paidAt: '2026-09-23' };
  const competing = { ...payment, mutationId: randomUUID() };
  const results = await Promise.all([f.request(a, path, 'POST', payment),
    f.request(b, path, 'POST', competing)]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  const winning = results[0].status === 200 ? payment : competing;
  assert.equal((await f.request(a, path, 'POST', winning)).body.replayed, true);
  assert.equal((await f.request(a, '/api/supplier-invoices')).body.summary.toPayCents, 4500);
  assert.equal((await f.request(a, path, 'POST', { ...winning, amountCents: 1000 })).body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('supplier invoices: stale edits and read-only users are rejected', async t => {
  const f = await fixture(t), a = await f.login('operator'), b = await f.login('operator'), viewer = await f.login('viewer');
  const created = await f.request(a, '/api/supplier-invoices', 'POST', invoice());
  const path = `/api/supplier-invoices/${created.body.item.id}`;
  const version = created.body.item.version;
  assert.equal((await f.request(a, path, 'PATCH', { expectedVersion: version, dueDate: '2026-10-01' })).status, 200);
  const stale = await f.request(b, path, 'PATCH', { expectedVersion: version, notes: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'SUPPLIER_CONFLICT');
  assert.equal((await f.request(viewer, '/api/supplier-invoices', 'POST', invoice({ number: '18/A' }))).status, 403);
  assert.equal((await f.request(viewer, path + '/payments', 'POST', { mutationId: randomUUID(), amountCents: 1, paidAt: '2026-09-23' })).status, 403);
  assert.equal((await f.request(viewer, path)).status, 200);
  assert.equal((await f.request(a, path)).body.notes, '');
});

test('two users cannot count the same supplier invoice twice when tax ID was omitted', async t => {
  const f = await fixture(t), a = await f.login('operator'), b = await f.login('operator');
  const first = invoice({ supplierTaxId: '', number: 'SENZA-PIVA' });
  const second = { ...first, mutationId: randomUUID(), supplierName: 'ricambi rossi' };
  const results = await Promise.all([f.request(a, '/api/supplier-invoices', 'POST', first),
    f.request(b, '/api/supplier-invoices', 'POST', second)]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  assert.equal((await f.request(a, '/api/supplier-invoices')).body.summary.toPayCents, 12500);
});

test('PEC imports remain excluded from payables until reviewed, preserve XML and deduplicate', async t => {
  const f = await fixture(t), a = await f.login('operator');
  const originalBytes = Buffer.from('<FatturaElettronica>originale</FatturaElettronica>');
  const source = { sourceKey: 'legalmail:123:456:document-1', supplierName: 'Fornitore PEC',
    supplierTaxId: 'IT99999999999', number: '2026/4', issueDate: '2026-09-01',
    dueDate: '2026-09-15', totalCents: 9900, documentType: 'TD01', filename: 'fattura.xml', originalBytes };
  const imported = importPecInvoice(f.app.db, source, () => TIME);
  assert.equal(imported.imported, true);
  assert.equal(importPecInvoice(f.app.db, source, () => TIME).imported, false);
  const before = await f.request(a, '/api/supplier-invoices');
  assert.equal(before.body.summary.pendingReviewCount, 1);
  assert.equal(before.body.summary.toPayCents, 0);
  const id = imported.item.id;
  const xml = await f.request(a, `/api/supplier-invoices/${id}/original`);
  assert.equal(xml.status, 200);
  assert.equal(xml.body, originalBytes.toString());
  assert.equal((await f.request(a, `/api/supplier-invoices/${id}/payments`, 'POST',
    { mutationId: randomUUID(), amountCents: 100, paidAt: '2026-09-23' })).status, 409);
  const verified = await f.request(a, `/api/supplier-invoices/${id}`, 'PATCH',
    { expectedVersion: imported.item.version, verified: true });
  assert.equal(verified.status, 200);
  assert.equal((await f.request(a, '/api/supplier-invoices')).body.summary.overdueCents, 9900);
});

test('online SQLite backup includes supplier payments and original XML', async t => {
  const f = await fixture(t), a = await f.login('operator');
  const xml = Buffer.from('<FatturaElettronica>backup</FatturaElettronica>');
  const imported = importPecInvoice(f.app.db, { sourceKey: 'backup-test', supplierName: 'Fornitore',
    supplierTaxId: 'IT12345678901', number: '9', issueDate: '2026-09-20', dueDate: null,
    totalCents: 5000, documentType: 'TD01', filename: 'backup.xml', originalBytes: xml }, () => TIME);
  const id = imported.item.id;
  assert.equal((await f.request(a, `/api/supplier-invoices/${id}`, 'PATCH',
    { expectedVersion: imported.item.version, verified: true })).status, 200);
  assert.equal((await f.request(a, `/api/supplier-invoices/${id}/payments`, 'POST',
    { mutationId: randomUUID(), amountCents: 1200, paidAt: '2026-09-23' })).status, 200);
  const target = join(f.app.dataDir, 'supplier-backup.sqlite');
  await backup(f.app.db, target);
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT total_cents FROM supplier_invoices WHERE id=?').get(id).total_cents, 5000);
    assert.equal(copy.prepare('SELECT SUM(amount_cents) AS paid FROM supplier_invoice_payments WHERE invoice_id=?').get(id).paid, 1200);
    assert.deepEqual(Buffer.from(copy.prepare('SELECT bytes FROM supplier_invoice_originals WHERE invoice_id=?').get(id).bytes), xml);
  } finally { copy.close(); }
});
