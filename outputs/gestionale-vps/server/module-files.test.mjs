import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { openDatabase } from './database.mjs';
import { HttpError } from './validation.mjs';
import { moduleFileStore, MAX_MODULE_FILE_BYTES } from './module-files.mjs';

const TIME = Date.parse('2026-10-05T10:00:00Z');
const PDF = Buffer.from('%PDF-1.7\nmanual document\n%%EOF');
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const JPEG = Buffer.from([255,216,255,224,0,0,255,217]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4,0,0,0]), Buffer.from('WEBP')]);
const input = (changes = {}) => ({ id: randomUUID(), filename: 'modulo firmato.pdf', contentType: 'application/pdf', data: PDF.toString('base64'), ...changes });
const error = (status, code) => e => e instanceof HttpError && e.status === status && (!code || e.code === code);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'officina-module-files-test-'));
  let database = openDatabase(directory);
  const createUser = (username, role) => {
    const result = database.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)').run(username, 'unused-in-store-tests', role, TIME);
    return { id: Number(result.lastInsertRowid), username, role };
  };
  const admin = createUser('admin', 'admin'), operator = createUser('operator', 'operator'), viewer = createUser('viewer', 'viewer');
  const store = moduleFileStore(database, () => TIME);
  t.after(() => {
    if (database) database.close();
    const absolute = resolve(directory);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('officina-module-files-test-')) throw new Error('Unsafe test cleanup');
    rmSync(absolute, { recursive: true, force: true });
  });
  return { directory, store, admin, operator, viewer, get db() { return database; },
    reopen() { database.close(); database = openDatabase(directory); return moduleFileStore(database, () => TIME); } };
}

test('manual module files: PDF and supported images are stored centrally with metadata-only responses and audit', t => {
  const f = fixture(t);
  for (const [contentType, bytes, filename] of [['application/pdf', PDF, 'modulo.pdf'], ['image/png', PNG, 'firma.png'], ['image/jpeg', JPEG, 'firma.jpg'], ['image/webp', WEBP, 'firma.webp']]) {
    const data = input({ contentType, data: bytes.toString('base64'), filename });
    const result = f.store.upload(f.operator, data);
    assert.deepEqual(result, { id: data.id, filename, contentType, size: bytes.length });
    assert.deepEqual(f.store.metadata(data.id), result);
    assert.deepEqual(f.store.original(data.id), { ...result, bytes });
    assert.equal(Object.hasOwn(result, 'data'), false);
    assert.equal(Object.hasOwn(result, 'bytes'), false);
  }
  const events = f.db.prepare("SELECT at,user_id,username,details FROM audit WHERE action='module-file-uploaded'").all();
  assert.equal(events.length, 4);
  for (const entry of events) {
    assert.equal(entry.at, TIME);
    assert.equal(entry.user_id, f.operator.id);
    assert.equal(entry.username, f.operator.username);
    assert.deepEqual(Object.keys(JSON.parse(entry.details)).sort(), ['contentType','filename','id','size']);
    assert.equal(entry.details.includes(PDF.toString('base64')), false);
  }
});

test('manual module files: only authenticated administrators and operators can upload', t => {
  const f = fixture(t);
  assert.throws(() => f.store.upload(null, input()), error(401, 'AUTH_REQUIRED'));
  assert.throws(() => f.store.upload(f.viewer, input()), error(403, 'FORBIDDEN'));
  assert.throws(() => f.store.upload({ ...f.operator, id: 0 }, input()), error(403));
  assert.ok(f.store.upload(f.admin, input()).id);
  assert.ok(f.store.upload(f.operator, input()).id);
});

test('manual module files: Unicode filenames are normalized and path/control injection is rejected', t => {
  const f = fixture(t);
  const data = input({ filename: '  informativa e\u0300 firmata — Rossi.pdf  ' });
  assert.equal(f.store.upload(f.operator, data).filename, 'informativa è firmata — Rossi.pdf');
  assert.equal(f.store.upload(f.operator, input({ filename: 'modulo firmato 📄.pdf' })).filename, 'modulo firmato 📄.pdf');
  for (const filename of ['', ' ', '.', '..', '../doc.pdf', '..\\doc.pdf', 'C:\\doc.pdf', 'doc\r\nContent-Type: text/html.pdf', 'doc\0.pdf', 'doc\u0085.pdf', 'doc\ud800.pdf', 'è'.repeat(121) + '.pdf']) {
    assert.throws(() => f.store.upload(f.operator, input({ filename })), error(400, 'MODULE_FILE_INPUT'), filename);
  }
});

test('manual module files: strict payload shape, UUID, MIME and canonical base64 are required', t => {
  const f = fixture(t);
  for (const changes of [{ id: 'not-a-uuid' }, { contentType: 'text/html' }, { contentType: 'image/svg+xml' }, { extra: true }, { data: '' }, { data: '%PDF-' }, { data: 'YW Jj' }, { data: 'YWJj\n' }, { data: 'YQ=' }, { data: 'YR==' }, { data: 'YQ===' }, { data: 'data:application/pdf;base64,' + PDF.toString('base64') }]) {
    assert.throws(() => f.store.upload(f.operator, input(changes)), error(400, 'MODULE_FILE_INPUT'));
  }
  assert.throws(() => f.store.upload(f.operator, null), error(400));
  assert.throws(() => f.store.upload(f.operator, []), error(400));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workshop_module_files').get().n, 0);
});

test('manual module files: MIME must match the file magic and executable text cannot masquerade as a PDF', t => {
  const f = fixture(t);
  for (const changes of [{ contentType: 'image/png' }, { contentType: 'image/jpeg' }, { contentType: 'image/webp' }, { data: Buffer.from('<html><script>alert(1)</script></html>').toString('base64') }, { data: PNG.toString('base64') }, { contentType: 'image/webp', data: Buffer.from('RIFFtiny').toString('base64') }]) {
    assert.throws(() => f.store.upload(f.operator, input(changes)), error(400, 'MODULE_FILE_INPUT'));
  }
  const fakePdf = Buffer.from(PDF), fakeWebp = Buffer.from(WEBP);
  fakePdf[0] |= 128; fakeWebp[0] |= 128;
  assert.throws(() => f.store.upload(f.operator, input({ data: fakePdf.toString('base64') })), error(400));
  assert.throws(() => f.store.upload(f.operator, input({ contentType: 'image/webp', data: fakeWebp.toString('base64') })), error(400));
});

test('manual module files: the decoded 10 MiB limit accepts the boundary and rejects one byte more', t => {
  const f = fixture(t), bytes = Buffer.alloc(MAX_MODULE_FILE_BYTES, 32);
  PDF.copy(bytes);
  const result = f.store.upload(f.operator, input({ data: bytes.toString('base64') }));
  assert.equal(result.size, MAX_MODULE_FILE_BYTES);
  assert.equal(f.store.original(result.id).bytes.length, MAX_MODULE_FILE_BYTES);
  const larger = Buffer.concat([bytes, Buffer.from([32])]);
  assert.throws(() => f.store.upload(f.operator, input({ data: larger.toString('base64') })), error(413, 'MODULE_FILE_TOO_LARGE'));
  assert.throws(() => f.store.upload(f.operator, input({ data: 'A'.repeat(Math.ceil(MAX_MODULE_FILE_BYTES / 3) * 4 + 4) })), error(413, 'MODULE_FILE_TOO_LARGE'));
});

test('manual module files: exact retries are idempotent and identities cannot replace another payload or owner', t => {
  const f = fixture(t), data = input(), first = f.store.upload(f.operator, data);
  assert.deepEqual(f.store.upload(f.operator, data), first);
  assert.deepEqual(f.store.upload(f.operator, { ...data, id: data.id.toUpperCase() }), first);
  assert.throws(() => f.store.upload(f.admin, data), error(409, 'IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.store.upload(f.operator, { ...data, filename: 'altro.pdf' }), error(409, 'IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.store.upload(f.operator, { ...data, data: Buffer.from('%PDF-1.7\nother\n%%EOF').toString('base64') }), error(409, 'IDEMPOTENCY_CONFLICT'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM workshop_module_files').get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='module-file-uploaded'").get().n, 1);
  assert.deepEqual(f.store.original(data.id).bytes, PDF);
});

test('manual module files: originals survive reopening and SQLite backup includes staged uploads', async t => {
  const f = fixture(t), data = input({ filename: 'consenso è firmato.pdf' });
  const metadata = f.store.upload(f.operator, data);
  assert.equal(f.db.prepare('SELECT payload FROM state WHERE id=1').get().payload, null, 'Upload does not publish a module record or blob snapshot');
  const reopened = f.reopen();
  assert.deepEqual(reopened.original(data.id), { ...metadata, bytes: PDF });
  const destination = join(f.directory, 'backup.sqlite');
  await backup(f.db, destination);
  const copiedDb = new DatabaseSync(destination);
  try {
    const restored = moduleFileStore(copiedDb, () => TIME);
    assert.deepEqual(restored.original(data.id), { ...metadata, bytes: PDF });
    assert.deepEqual(restored.upload(f.operator, data), metadata);
  } finally { copiedDb.close(); }
});

test('manual module files: missing identities are not exposed and existing files cannot outlive their user reference', t => {
  const f = fixture(t), data = input();
  assert.equal(f.store.original(randomUUID()), null);
  assert.equal(f.store.original('../../file'), null);
  assert.equal(f.store.metadata(null), null);
  f.store.upload(f.operator, data);
  assert.throws(() => f.db.prepare('DELETE FROM users WHERE id=?').run(f.operator.id), /FOREIGN KEY/);
});

test('manual module files: committed module attachments must point to exact stored metadata', t => {
  const f = fixture(t), attachment = f.store.upload(f.operator, input());
  const state = records => ({ storage: { 'officina-moduli-v1': JSON.stringify(records) } });
  f.store.validateState({ storage: {} });
  f.store.validateState(state([{ type: 'tyres', Customer: 'Legacy', Signature: 'legacy data' }]));
  for (const type of ['privacy','refusal','parts']) f.store.validateState(state([{ type, Customer: 'Rossi', Attachment: attachment }]));
  for (const [type, Attachment] of [['tyres', attachment], ['privacy', null], ['privacy', { ...attachment, id: randomUUID() }], ['privacy', { ...attachment, size: attachment.size + 1 }], ['privacy', { ...attachment, filename: 'changed.pdf' }], ['privacy', { ...attachment, contentType: 'image/png' }], ['privacy', { ...attachment, data: PDF.toString('base64') }], ['privacy', { ...attachment, size: 0 }]]) {
    assert.throws(() => f.store.validateState(state([{ type, Attachment }])), error(400, 'MODULE_FILE_INPUT'));
  }
  assert.throws(() => f.store.validateState({ storage: { 'officina-moduli-v1': '{}' } }), error(400));
  assert.throws(() => f.store.validateState({ storage: { 'officina-moduli-v1': 'bad JSON' } }), error(400));
});

test('manual module files: ordinary snapshot validation reads metadata only, never file bytes or digests', t => {
  const f = fixture(t), attachment = f.store.upload(f.operator, input()), reads = [];
  const wrapper = { exec: sql => f.db.exec(sql), prepare(sql) {
    const statement = f.db.prepare(sql);
    return { get(...args) { reads.push(sql); return statement.get(...args); }, run(...args) { return statement.run(...args); } };
  } };
  const store = moduleFileStore(wrapper, () => TIME);
  store.validateState({ storage: { 'officina-moduli-v1': JSON.stringify([{ type: 'privacy', Attachment: attachment }]) } });
  assert.equal(reads.length, 1);
  assert.doesNotMatch(reads[0], /\b(?:bytes|digest)\b/i);
});
