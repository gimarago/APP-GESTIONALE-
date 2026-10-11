import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.mjs';
import { openPecState, parseEuroCents, planInvoices, pollOnce, pythonFetch } from './pec-worker.mjs';
import { XmlGenerator } from '../backend/src/fatture/xml-generator.js';
import { sampleInvoice } from '../backend/fixtures/invoice.js';
import { xmlEngine } from '../backend/src/xml/engine.js';

const VAT = '12345678903';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'officina-pec-'));
  const db = openDatabase(directory);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return db;
}

function emailWithAttachment(filename, bytes) {
  return Buffer.from([
    'MIME-Version: 1.0', 'From: example@example.invalid',
    'Content-Type: multipart/mixed; boundary="outer"', '',
    '--outer', `Content-Type: application/octet-stream; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64', '', bytes.toString('base64'),
    '--outer--', '',
  ].join('\r\n'));
}

test('Legalmail MIME extractor handles nested PEC envelope without mailbox credentials', async () => {
  const xml = Buffer.from('<synthetic>invoice</synthetic>');
  const inner = emailWithAttachment('IT12345678903_1.xml', xml);
  const outer = emailWithAttachment('postacert.eml', inner);
  const result = await pythonFetch({ action: 'extract', base64: outer.toString('base64') });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].filename, 'IT12345678903_1.xml');
  assert.deepEqual(Buffer.from(result.files[0].base64, 'base64'), xml);
  const certification = await pythonFetch({ action: 'extract', base64: emailWithAttachment('daticert.xml', Buffer.from('<postacert/>')).toString('base64') });
  assert.deepEqual(certification.files, []);
  assert.deepEqual(certification.issues, []);
  const unsupported = await pythonFetch({ action: 'extract', base64: emailWithAttachment('signed.xml.p7m', Buffer.from('not-a-signature')).toString('base64') });
  assert.deepEqual(unsupported.files, []);
  assert.deepEqual(unsupported.issues, ['PEC_SIGNED_FILE_UNSUPPORTED']);
  const unnamedSigned = Buffer.from('MIME-Version: 1.0\r\nContent-Type: application/pkcs7-mime\r\nContent-Transfer-Encoding: base64\r\n\r\nbm90LWEtc2lnbmF0dXJl\r\n');
  const unnamed = await pythonFetch({ action: 'extract', base64: unnamedSigned.toString('base64') });
  assert.deepEqual(unnamed.issues, ['PEC_SIGNED_FILE_UNSUPPORTED']);
});

test('IMAP collector uses read-only SELECT, BODY.PEEK and UIDVALIDITY cursor', () => {
  const script = fileURLToPath(new URL('./pec-fetch.py', import.meta.url));
  const py = process.env.OFFICINA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const program = `import importlib.util,json,sys\n`
    + `spec=importlib.util.spec_from_file_location('pec',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n`
    + `class Fake:\n`
    + ` def login(self,user,password): assert user=='fake-user' and password=='fake-password'; return ('OK',[])\n`
    + ` def select(self,box,readonly=False): assert box=='INBOX' and readonly; return ('OK',[b'2'])\n`
    + ` def response(self,key): assert key=='UIDVALIDITY'; return ('UIDVALIDITY',[b'42'])\n`
    + ` def uid(self,method,*args):\n`
    + `  if method=='SEARCH': assert args== (None,'UID','6:*'); return ('OK',[b'5 6 7'])\n`
    + `  assert method=='FETCH' and args[0] in ('6','7')\n`
    + `  if args[1]=='(RFC822.SIZE)': return ('OK',[('1 (UID '+args[0]+' RFC822.SIZE '+('9999999' if args[0]=='6' else '100')+')').encode()])\n`
    + `  if args[1]=='(BODY.PEEK[])': return ('OK',[(b'1 BODY[]',b'MIME-Version: 1.0\\r\\nContent-Type: text/plain\\r\\n\\r\\nhello')])\n`
    + `  raise AssertionError('collector attempted a flag-changing fetch')\n`
    + ` def logout(self): pass\n`
    + `m.imaplib.IMAP4_SSL=lambda *a,**kw: Fake()\n`
    + `r=m.poll({'uidvalidity':'42','lastUid':5}); assert r['messages'][0]['issues']==['PEC_MESSAGE_SIZE'] and r['messages'][1]['issues']==[]\n`
    + `print(json.dumps({'uidvalidity':r['uidvalidity'],'uids':[x['uid'] for x in r['messages']]}))\n`;
  const result = JSON.parse(execFileSync(py, ['-c', program, script], { encoding: 'utf8',
    env: { ...process.env, PEC_USER: 'fake-user', PEC_APP_PASSWORD: 'fake-password' } }));
  assert.deepEqual(result, { uidvalidity: '42', uids: [6, 7] });
});

test('amounts are exact cents and uncertain documents cannot be counted automatically', () => {
  assert.equal(parseEuroCents('123.45'), 12345);
  assert.equal(parseEuroCents('1.2'), 120);
  assert.equal(parseEuroCents('1'), 100);
  assert.equal(parseEuroCents('0.00'), null);
  assert.equal(parseEuroCents('1.234'), null);
  assert.equal(parseEuroCents('10000000001.00'), null);
  const parsed = { xsdValidated: true, buyer: { country: 'IT', vat: VAT },
    seller: { country: 'IT', vat: VAT, name: 'FORNITORE DI PROVA' },
    documents: [{ bodyIndex: 0, type: 'TD04', number: 'NC-1', date: '2026-09-23', dueDate: null, currency: 'EUR', total: '45.00' }] };
  const credit = planInvoices(parsed, Buffer.from('test'), 'invoice.xml', VAT);
  assert.equal(credit.items[0].totalCents, null);
  assert.deepEqual(credit.issues, ['PEC_TOTAL_REVIEW_REQUIRED']);
  assert.deepEqual(planInvoices(parsed, Buffer.from('test'), 'invoice.xml', '99999999999').issues, ['PEC_RECIPIENT_MISMATCH']);
});

test('XSD parser infers due date only from one payment deadline', async () => {
  const document = sampleInvoice();
  document.payment.dueDate = '2026-10-11';
  const one = await new XmlGenerator().generate(document);
  assert.equal((await xmlEngine({ mode: 'inspect-invoice', xml: one })).documents[0].dueDate, '2026-10-11');
  const installments = one.replace('</DatiPagamento>',
    '<DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-11-11</DataScadenzaPagamento><ImportoPagamento>1.00</ImportoPagamento></DettaglioPagamento></DatiPagamento>');
  assert.equal((await xmlEngine({ mode: 'inspect-invoice', xml: installments })).documents[0].dueDate, null);
});

test('validated XML imports once, preserves original and advances UIDVALIDITY cursor after commit', async t => {
  const db = await fixture(t);
  const document = sampleInvoice();
  document.payment.dueDate = '2026-10-11';
  const original = Buffer.from(await new XmlGenerator().generate(document));
  const batch = (uidvalidity, uid, more = false) => ({ uidvalidity, reset: uidvalidity === '8', more,
    messages: [{ uid, files: [{ filename: 'invoice.xml', base64: original.toString('base64') }], issues: [] }] });
  const first = await pollOnce(db, VAT, async () => batch('7', 1));
  assert.equal(first.imported, 1);
  const row = db.prepare('SELECT id,source,verified,number,due_date,total_cents FROM supplier_invoices').get();
  assert.equal(row.source, 'pec');
  assert.equal(row.verified, 0);
  assert.equal(row.due_date, '2026-10-11');
  assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM supplier_invoice_originals WHERE invoice_id=?').get(row.id).bytes), original);
  assert.deepEqual(openPecState(db).read(), { uidvalidity: '7', lastUid: 1 });
  const second = await pollOnce(db, VAT, async () => batch('7', 2));
  assert.equal(second.imported, 0);
  const mailboxRecreated = await pollOnce(db, VAT, async () => batch('8', 1));
  assert.equal(mailboxRecreated.imported, 0);
  assert.deepEqual(openPecState(db).read(), { uidvalidity: '8', lastUid: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_invoices').get().count, 1);
});

test('invalid invoice issues remain visible after subsequent clean polls; failed import keeps cursor', async t => {
  const db = await fixture(t);
  const bad = Buffer.from('<not-invoice/>');
  const first = await pollOnce(db, VAT, async () => ({ uidvalidity: '1', reset: false, more: false,
    messages: [{ uid: 3, files: [{ filename: 'bad.xml', base64: bad.toString('base64') }], issues: [] }] }));
  assert.equal(first.issues, 1);
  assert.equal(openPecState(db).read().lastUid, 3);
  await pollOnce(db, VAT, async () => ({ uidvalidity: '1', reset: false, more: false, messages: [] }));
  let status = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='pec-sync-status'").get().value);
  assert.equal(status.issues, 1);
  assert.equal(status.errorCode, 'PEC_IMPORT_ISSUES');
  await assert.rejects(pollOnce(db, VAT, async () => { throw Error('PEC_CONNECTION_FAILED'); }), /PEC_CONNECTION_FAILED/);
  assert.equal(openPecState(db).read().lastUid, 3);
  status = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='pec-sync-status'").get().value);
  assert.equal(status.issues, 1);
  assert.equal(status.errorCode, 'PEC_CONNECTION_FAILED');
});

test('fiscal duplicate from a manually entered invoice creates a visible PEC issue', async t => {
  const db = await fixture(t);
  const document = sampleInvoice();
  const original = Buffer.from(await new XmlGenerator().generate(document));
  const now = Date.now();
  db.prepare(`INSERT INTO supplier_invoices(id,version,source,source_key,supplier_name,supplier_tax_id,number,issue_date,due_date,total_cents,verified,notes,created_at,updated_at)
    VALUES(?,1,'manual',NULL,?,?,?,?,?,?,1,'',?,?)`)
    .run(randomUUID(), document.seller.name, null, document.number, document.date, null, 21960, now, now);
  const result = await pollOnce(db, VAT, async () => ({ uidvalidity: '1', reset: false, more: false,
    messages: [{ uid: 1, files: [{ filename: 'invoice.xml', base64: original.toString('base64') }], issues: [] }] }));
  assert.equal(result.imported, 0);
  assert.equal(result.issues, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_invoices').get().count, 1);
});
