import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, hash } from './database.mjs';
import { createSdiStore } from './sdi-store.mjs';
import { importPecInvoice, supplierInvoiceStore } from './supplier-invoices.mjs';

function fixture(t, environment='production') {
  const directory = mkdtempSync(join(tmpdir(),'officina-sdi-store-test-'));
  let db = openDatabase(directory);
  let clock = Date.parse('2026-10-01T10:00:00Z');
  const now = () => clock++;
  const value = { db, store:createSdiStore(db,{environment,now}), directory, now };
  value.reopen = () => { db.close(); db = openDatabase(directory); value.db = db; value.store = createSdiStore(db,{environment,now}); };
  t.after(() => {
    db.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir())+sep) && basename(absolute).startsWith('officina-sdi-store-test-'));
    rmSync(absolute,{recursive:true,force:true});
  });
  return value;
}
const document = (extra={}) => {
  const xml = Buffer.from('<FatturaElettronica numero="1"/>');
  return { documentId:'invoice-1', filename:'IT01234567890_0000000001.xml', xml, digest:hash(xml), fiscalKey:'IT01234567890|2026|TD01|1', metadata:{number:'1',year:2026}, ...extra };
};
const rawSoap = Buffer.from('<Envelope>original SOAP</Envelope>');
const notification = (filename, outcome='CONSEGNA', extra={}) => ({
  kind:'notifications', operation:'ricevutaConsegna', identifier:'123', filename:`IT01234567890_${outcome}_1.xml`,
  payloadBase64:Buffer.from(`<${outcome}>123</${outcome}>`).toString('base64'),
  notification:{identifier:'123',invoiceFilename:filename,outcome,errorCodes:[]}, ...extra
});
const invoiceCallback = (extra={}) => ({ kind:'invoices', identifier:'321', filename:'IT01234567890_AB123.xml',
  payloadBase64:Buffer.from('<FatturaElettronica/>').toString('base64'), ...extra });
const supplier = { supplierName:'Fornitore di prova', supplierTaxId:'IT01234567890',number:'17/A',issueDate:'2026-09-20',dueDate:'2026-09-30',totalCents:12500,documentType:'TD01' };

test('outbox persists one immutable invoice and fiscal identity through restart', t => {
  const f = fixture(t), data = document();
  const queued = f.store.enqueue(data);
  assert.match(queued.filename,/^IT01234567890_[a-z0-9]{5}\.xml$/);
  assert.equal(queued.metadata.sourceFilename,data.filename);
  assert.equal(f.store.enqueue(data).id,queued.id);
  assert.equal(f.store.enqueue(data).duplicate,true);
  assert.throws(() => f.store.enqueue({...data,xml:Buffer.from('different'),digest:hash('different')}),{code:'SDI_IMMUTABLE'});
  assert.throws(() => f.store.enqueue({...data,documentId:'renamed'}),{code:'SDI_DUPLICATE'});
  assert.throws(() => f.store.enqueue({...data,digest:'0'.repeat(64)}),{code:'SDI_DIGEST_CHANGED'});
  f.reopen();
  assert.equal(f.store.list()[0].filename,queued.filename);
  assert.deepEqual(f.store.bindings(),[{documentId:data.documentId,digest:data.digest,fiscalKey:data.fiscalKey}]);
  assert.deepEqual(f.store.original('outgoing',queued.id).bytes,data.xml);
});

test('claims serialize across database connections and uncertain work is never retried', t => {
  const f = fixture(t), queued = f.store.enqueue(document());
  const otherDb = new DatabaseSync(join(f.directory,'officina.sqlite'));
  const other = createSdiStore(otherDb,{environment:'production',now:f.now});
  try {
  const claim = f.store.claim();
  assert.equal(claim.id,queued.id);
  assert.equal(other.claim(),null);
  assert.throws(() => f.store.finish(queued.id,{state:'UNKNOWN',claimToken:'bad'}),{code:'SDI_CLAIM'});
  const recovered = f.store.recoverInterrupted();
  assert.equal(recovered.recovered,1);
  assert.equal(other.detail(queued.id).state,'UNKNOWN');
  assert.equal(other.claim(),null);
  assert.equal(f.store.recoverInterrupted().recovered,0);
  } finally { otherDb.close(); }
});

test('restoring a backup quarantines both unsent and in flight documents', t => {
  const f = fixture(t);
  const first = f.store.enqueue(document());
  f.store.claim();
  const nextXml = Buffer.from('<Fattura numero="2"/>');
  const second = f.store.enqueue(document({documentId:'invoice-2',filename:'IT01234567890_00002.xml',fiscalKey:'IT01234567890|2026|TD01|2',xml:nextXml,digest:hash(nextXml)}));
  assert.equal(f.store.recoverInterrupted({afterRestore:true}).recovered,2);
  for (const id of [first.id,second.id]) assert.equal(f.store.detail(id).state,'UNKNOWN');
  assert.equal(f.store.claim(),null);
});

test('early receipts beat lost transport responses; late notifications advance fiscal delivery', t => {
  const f = fixture(t), claim = (f.store.enqueue(document()),f.store.claim());
  const first = notification(claim.filename,'MANCATA_CONSEGNA');
  assert.equal(f.store.acceptNotification(first,rawSoap).state,'APPLIED');
  assert.equal(f.store.finish(claim.id,{state:'UNKNOWN',claimToken:claim.claimToken,code:'TIMEOUT'}).state,'SDI_RECEIVED');
  assert.equal(f.store.detail(claim.id).fiscalState,'MANCATA_CONSEGNA');
  assert.equal(f.store.acceptNotification(first,rawSoap).duplicate,true);
  f.reopen();
  f.store.acceptNotification(notification(claim.filename),rawSoap);
  assert.equal(f.store.detail(claim.id).fiscalState,'CONSEGNA');
  assert.equal(f.store.detail(claim.id).events.length,2);
  assert.equal(f.store.claim(),null);
});

test('notification correlation requires both SdI identifier and filename; conflicts retain originals', t => {
  const f = fixture(t), claim = (f.store.enqueue(document()),f.store.claim());
  f.store.finish(claim.id,{state:'SDI_RECEIVED',sdiId:'123',claimToken:claim.claimToken});
  const mismatched = notification('IT01234567890_OTHER.xml');
  const mismatch = f.store.acceptNotification(mismatched,rawSoap);
  assert.equal(mismatch.conflict,true);
  assert.equal(f.store.detail(claim.id).fiscalState,'PENDING');
  assert.equal(f.store.original('notification',mismatch.id).bytes.toString(),'<CONSEGNA>123</CONSEGNA>');
  const valid = notification(claim.filename,'SCARTO');
  f.store.acceptNotification(valid,rawSoap);
  const opposite = f.store.acceptNotification(notification(claim.filename,'CONSEGNA',{filename:'other-delivery.xml'}),rawSoap);
  assert.equal(opposite.conflict,true);
  assert.equal(f.store.detail(claim.id).fiscalState,'SCARTO');
  assert.equal(f.store.detail(claim.id).sdiId,'123');
});

test('unmatched receipts reconcile when the response arrives and unknown transmissions accept late receipts', t => {
  const f = fixture(t), queued = f.store.enqueue(document());
  const early = f.store.acceptNotification(notification(queued.filename),rawSoap);
  assert.equal(early.state,'UNMATCHED');
  // An already archived receipt for this exact file suppresses a second send.
  assert.equal(f.store.claim(),null);
  assert.equal(f.store.detail(queued.id).state,'SDI_RECEIVED');
  assert.notEqual(f.store.detail(queued.id).history[0].finishedAt,null);
  const f2 = fixture(t), claim = (f2.store.enqueue(document()),f2.store.claim());
  f2.store.finish(claim.id,{state:'UNKNOWN',claimToken:claim.claimToken});
  f2.store.acceptNotification(notification(claim.filename),rawSoap);
  assert.equal(f2.store.detail(claim.id).state,'SDI_RECEIVED');
});

test('conflicting notification variants received before enqueue block transmission and remain visible', t => {
  const f = fixture(t), name='IT01234567890_A1234.xml';
  const receipt=notification(name);
  const first=f.store.acceptNotification(receipt,rawSoap);
  const second=f.store.acceptNotification({...receipt,payloadBase64:Buffer.from('<ChangedReceipt/>').toString('base64')},rawSoap);
  assert.equal(second.conflict,true);
  assert.equal(f.store.acceptNotification(receipt,rawSoap).conflict,true);
  const queued=f.store.enqueue(document({filename:name}));
  assert.equal(f.store.claim(),null);
  const detail=f.store.detail(queued.id);
  assert.equal(detail.state,'READY');
  assert.equal(detail.conflict,true);
  assert.equal(detail.attempts,0);
  assert.equal(detail.events.length,2);
  assert.ok(detail.events.every(event=>event.state==='CONFLICT'));
  assert.equal(f.store.original('notification',first.id).bytes.toString(),'<CONSEGNA>123</CONSEGNA>');
  f.reopen();
  assert.equal(f.store.claim(),null);
  assert.equal(f.store.detail(queued.id).conflict,true);
});

test('changed notifications invalidate every referenced invoice including an already applied receipt', t => {
  const f=fixture(t), first=f.store.enqueue(document({filename:'IT01234567890_A1234.xml'}));
  const claim=f.store.claim(), receipt=notification(first.filename);
  f.store.acceptNotification(receipt,rawSoap);
  f.store.finish(first.id,{state:'SDI_RECEIVED',sdiId:'123',claimToken:claim.claimToken});
  const xml=Buffer.from('<SecondInvoice/>');
  const second=f.store.enqueue(document({documentId:'invoice-2',filename:'IT01234567890_B1234.xml',fiscalKey:'IT01234567890|2026|TD01|2',xml,digest:hash(xml)}));
  f.store.acceptNotification({...receipt,payloadBase64:Buffer.from('<ChangedReference/>').toString('base64'),notification:{...receipt.notification,invoiceFilename:second.filename}},rawSoap);
  assert.equal(f.store.detail(first.id).conflict,true);
  assert.equal(f.store.detail(second.id).conflict,true);
  assert.ok(f.store.detail(first.id).events.every(event=>event.state==='CONFLICT'));
  assert.equal(f.store.claim(),null);
});

test('late transport contradictions and mismatched SdI identifiers require review without replacing proven receipt', t => {
  const f=fixture(t), claim=(f.store.enqueue(document()),f.store.claim());
  f.store.acceptNotification(notification(claim.filename),rawSoap);
  const rejected=f.store.finish(claim.id,{state:'TRANSPORT_REJECTED',claimToken:claim.claimToken,code:'SOAP_REJECTED'});
  assert.equal(rejected.conflict,true);
  assert.equal(rejected.state,'SDI_RECEIVED');
  assert.equal(rejected.sdiId,'123');
  assert.equal(rejected.fiscalState,'CONSEGNA');
  assert.equal(f.store.claim(),null);
  const f2=fixture(t), other=(f2.store.enqueue(document()),f2.store.claim());
  f2.store.finish(other.id,{state:'TRANSPORT_REJECTED',claimToken:other.claimToken});
  const late=f2.store.acceptNotification(notification(other.filename),rawSoap);
  assert.equal(late.conflict,true);
  assert.equal(f2.store.detail(other.id).state,'TRANSPORT_REJECTED');
  assert.equal(f2.store.detail(other.id).conflict,true);
});

test('out-of-order receipts cannot downgrade delivery and opposing recipient outcomes are conflicts', t => {
  const f=fixture(t), claim=(f.store.enqueue(document()),f.store.claim());
  f.store.finish(claim.id,{state:'SDI_RECEIVED',sdiId:'123',claimToken:claim.claimToken});
  f.store.acceptNotification(notification(claim.filename),rawSoap);
  f.store.acceptNotification(notification(claim.filename,'MANCATA_CONSEGNA'),rawSoap);
  assert.equal(f.store.detail(claim.id).fiscalState,'CONSEGNA');
  const accepted=notification(claim.filename,'ESITO');
  accepted.notification.recipientOutcome='EC01';
  f.store.acceptNotification(accepted,rawSoap);
  const refused={...accepted,filename:'recipient-refused.xml',payloadBase64:Buffer.from('<Esito>EC02</Esito>').toString('base64'),notification:{...accepted.notification,recipientOutcome:'EC02'}};
  assert.equal(f.store.acceptNotification(refused,rawSoap).conflict,true);
  assert.equal(f.store.detail(claim.id).fiscalState,'ESITO');
  assert.equal(f.store.detail(claim.id).conflict,true);
});

test('notification hashes must identify the exact archived XML before proving receipt', t => {
  const f=fixture(t), claim=(f.store.enqueue(document()),f.store.claim());
  const receipt=notification(claim.filename);
  receipt.notification.fileHash='0'.repeat(64);
  assert.equal(f.store.acceptNotification(receipt,rawSoap).conflict,true);
  assert.equal(f.store.detail(claim.id).fiscalState,'PENDING');
  assert.equal(f.store.detail(claim.id).sdiId,null);
  f.store.finish(claim.id,{state:'UNKNOWN',claimToken:claim.claimToken});
  assert.equal(f.store.detail(claim.id).state,'UNKNOWN');
  const f2=fixture(t), good=(f2.store.enqueue(document()),f2.store.claim());
  const valid=notification(good.filename);
  valid.notification.fileHash=good.digest.toUpperCase();
  assert.equal(f2.store.acceptNotification(valid,rawSoap).state,'APPLIED');
  assert.equal(f2.store.detail(good.id).fiscalState,'CONSEGNA');
  const f3=fixture(t), early=f3.store.enqueue(document());
  const changed=notification(early.filename);
  changed.notification.fileHash='0'.repeat(64);
  assert.equal(f3.store.acceptNotification(changed,rawSoap).conflict,true);
  assert.equal(f3.store.claim(),null);
  assert.equal(f3.store.detail(early.id).attempts,0);
});

test('incoming deliveries persist before processing, deduplicate and quarantine conflicting bytes', t => {
  const f = fixture(t), parsed = invoiceCallback();
  const incoming = f.store.acceptInvoice(parsed,rawSoap);
  assert.equal(incoming.state,'PENDING');
  f.reopen();
  assert.equal(f.store.acceptInvoice(parsed,rawSoap).id,incoming.id);
  assert.equal(f.store.acceptInvoice(parsed,rawSoap).duplicate,true);
  assert.deepEqual(f.store.original('incoming-raw',incoming.id).bytes,rawSoap);
  const conflicting = f.store.acceptInvoice({...parsed,payloadBase64:Buffer.from('different bytes').toString('base64')},rawSoap);
  assert.equal(conflicting.conflict,true);
  assert.equal(f.store.incomingDetail(incoming.id).conflict,true);
  assert.equal(f.store.original('incoming',incoming.id).bytes.toString(),'<FatturaElettronica/>');
  assert.throws(() => f.store.markIncomingProcessed(incoming.id,supplier),{code:'SDI_INCOMING_CONFLICT'});
  assert.equal(supplierInvoiceStore(f.db).list().items.length,0);
});

test('SdI import is atomic, retry-safe and never overwrites PEC payments or edited supplier data', t => {
  const f = fixture(t), parsed = invoiceCallback();
  const created = importPecInvoice(f.db,{...supplier,sourceKey:'pec:original',filename:parsed.filename,originalBytes:Buffer.from(parsed.payloadBase64,'base64')},f.now);
  const ledger = supplierInvoiceStore(f.db,f.now), auth={id:1,username:'test'};
  ledger.edit(auth,created.item.id,{expectedVersion:1,totalCents:12500,verified:true,notes:'Dato corretto dall’operatore'});
  ledger.pay(auth,created.item.id,{mutationId:randomUUID(),amountCents:4000,paidAt:'2026-09-25'});
  const before = ledger.detail(created.item.id);
  const incoming = f.store.acceptInvoice(parsed,rawSoap);
  const imported = f.store.markIncomingProcessed(incoming.id,{...supplier,totalCents:99999});
  assert.equal(imported.imported,false);
  assert.equal(imported.supplierInvoiceId,created.item.id);
  assert.equal(imported.state,'IMPORTED');
  assert.deepEqual(ledger.detail(created.item.id),before);
  assert.equal(ledger.list().items.length,1);
  assert.equal(f.store.markIncomingProcessed(incoming.id,supplier).imported,false);
  const next = f.store.acceptInvoice(invoiceCallback({identifier:'322'}),rawSoap);
  assert.throws(() => f.store.markIncomingProcessed(next.id,{...supplier,number:'bad',totalCents:-1}),{code:'SUPPLIER_INPUT'});
  assert.equal(f.store.incomingDetail(next.id).state,'PENDING');
  const saved = f.store.markIncomingProcessed(next.id,{...supplier,number:'18/A'});
  assert.equal(ledger.detail(saved.supplierInvoiceId).source,'sdi');
  assert.equal(ledger.detail(saved.supplierInvoiceId).verified,false);
});

test('signed unsupported deliveries remain downloadable for review and test never alters ledger', t => {
  const f = fixture(t,'test');
  const signed = f.store.acceptInvoice(invoiceCallback({filename:'IT01234567890_AB123.xml.p7m',payloadBase64:Buffer.from([1,2,3,4]).toString('base64')}),rawSoap);
  f.store.reviewIncoming(signed.id,'Formato firmato da verificare.');
  assert.equal(f.store.incomingDetail(signed.id).state,'REVIEW');
  assert.deepEqual(f.store.original('incoming',signed.id).bytes,Buffer.from([1,2,3,4]));
  const unsigned = f.store.acceptInvoice(invoiceCallback({identifier:'322'}),rawSoap);
  assert.equal(f.store.markIncomingProcessed(unsigned.id,supplier).state,'REVIEW');
  assert.equal(supplierInvoiceStore(f.db).list().items.length,0);
  const production = createSdiStore(f.db,{environment:'production'});
  assert.equal(production.listIncoming().length,0);
  assert.throws(() => production.acceptInvoice(invoiceCallback(),rawSoap),{code:'SDI_ENVIRONMENT_LOCKED'});
});

test('multi-body supplier delivery commits all invoices and links atomically, including restart deduplication', t => {
  const f = fixture(t), incoming = f.store.acceptInvoice(invoiceCallback(),rawSoap);
  const documents = [{...supplier,bodyIndex:0},{...supplier,number:'18/A',bodyIndex:1}];
  assert.throws(() => f.store.markIncomingProcessed(incoming.id,[documents[0],{...documents[1],totalCents:-1}]),{code:'SUPPLIER_INPUT'});
  assert.equal(supplierInvoiceStore(f.db).list().items.length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sdi_inbox_documents').get().count,0);
  assert.equal(f.store.incomingDetail(incoming.id).state,'PENDING');
  const result = f.store.markIncomingProcessed(incoming.id,documents);
  assert.equal(result.imported,true);
  assert.equal(result.supplierInvoiceIds.length,2);
  assert.equal(result.supplierInvoiceId,result.supplierInvoiceIds[0]);
  assert.equal(supplierInvoiceStore(f.db).list().items.length,2);
  assert.deepEqual(f.db.prepare('SELECT source_key FROM supplier_invoices ORDER BY source_key').all().map(row=>row.source_key),['sdi:production:321:0','sdi:production:321:1']);
  f.reopen();
  assert.deepEqual(f.store.incomingDetail(incoming.id).supplierInvoiceIds,result.supplierInvoiceIds);
  assert.equal(f.store.markIncomingProcessed(incoming.id,documents).imported,false);
  assert.equal(supplierInvoiceStore(f.db).list().items.length,2);
  const other = f.store.acceptInvoice(invoiceCallback({identifier:'322'}),rawSoap);
  assert.throws(()=>f.store.markIncomingProcessed(other.id,[documents[0],documents[0]]),{code:'SDI_INPUT'});
});

test('different bodies sharing a fiscal identity require review instead of silently losing one body', t => {
  const f=fixture(t), incoming=f.store.acceptInvoice(invoiceCallback(),rawSoap);
  assert.throws(()=>f.store.markIncomingProcessed(incoming.id,[{...supplier,bodyIndex:0},{...supplier,totalCents:99999,bodyIndex:1}]),{code:'SDI_INCOMING_CONFLICT'});
  assert.equal(f.store.incomingDetail(incoming.id).state,'PENDING');
  assert.equal(supplierInvoiceStore(f.db).list().items.length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM sdi_inbox_documents').get().count,0);
});

test('version 4 migration preserves an existing supplier link and original bytes', t => {
  const f=fixture(t), incoming=f.store.acceptInvoice(invoiceCallback(),rawSoap);
  const imported=f.store.markIncomingProcessed(incoming.id,supplier);
  f.db.exec('DROP TABLE sdi_inbox_documents; PRAGMA user_version=4;');
  f.reopen();
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,5);
  assert.deepEqual(f.store.incomingDetail(incoming.id).supplierInvoiceIds,[imported.supplierInvoiceId]);
  assert.equal(f.store.original('incoming',incoming.id).bytes.toString(),'<FatturaElettronica/>');
  assert.equal(supplierInvoiceStore(f.db).detail(imported.supplierInvoiceId).totalCents,supplier.totalCents);
});

test('a changed original cannot silently replace a PEC invoice with the same fiscal identity or its payments', t => {
  const f = fixture(t), parsed = invoiceCallback();
  const created = importPecInvoice(f.db,{...supplier,sourceKey:'pec:original',filename:parsed.filename,originalBytes:Buffer.from(parsed.payloadBase64,'base64')},f.now);
  const ledger = supplierInvoiceStore(f.db,f.now), auth={id:1,username:'test'};
  ledger.edit(auth,created.item.id,{expectedVersion:1,totalCents:12500,verified:true});
  ledger.pay(auth,created.item.id,{mutationId:randomUUID(),amountCents:4000,paidAt:'2026-09-25'});
  const before = ledger.detail(created.item.id);
  const conflicting = f.store.acceptInvoice({...parsed,payloadBase64:Buffer.from('<Different/>').toString('base64')},rawSoap);
  assert.throws(()=>f.store.markIncomingProcessed(conflicting.id,supplier),{code:'SUPPLIER_SOURCE_CONFLICT'});
  f.store.reviewIncoming(conflicting.id,'Conflitto con l’originale già registrato.');
  assert.equal(f.store.incomingDetail(conflicting.id).state,'REVIEW');
  assert.deepEqual(ledger.detail(created.item.id),before);
  assert.equal(ledger.list().items.length,1);
  assert.equal(f.store.original('incoming',conflicting.id).bytes.toString(),'<Different/>');
});

test('a conflicting retransmission flags even an already imported delivery without modifying the ledger', t => {
  const f = fixture(t), parsed=invoiceCallback(), incoming=f.store.acceptInvoice(parsed,rawSoap);
  const imported=f.store.markIncomingProcessed(incoming.id,supplier), ledger=supplierInvoiceStore(f.db,f.now);
  const before=ledger.detail(imported.supplierInvoiceId);
  f.store.acceptInvoice({...parsed,payloadBase64:Buffer.from('<Different/>').toString('base64')},rawSoap);
  assert.equal(f.store.incomingDetail(incoming.id).state,'REVIEW');
  assert.equal(f.store.incomingDetail(incoming.id).conflict,true);
  assert.throws(()=>f.store.markIncomingProcessed(incoming.id,supplier),{code:'SDI_INCOMING_CONFLICT'});
  assert.deepEqual(ledger.detail(imported.supplierInvoiceId),before);
});

test('channel identity and environment are locked after first document; migration is version 5', t => {
  const f = fixture(t,'test');
  const identity = {shopVat:'IT01234567890',accreditationReference:'TEST-ONLY',endpointHost:'test.example.invalid'};
  f.store.bindIdentity(identity);
  f.store.enqueue(document());
  f.store.bindIdentity(identity);
  assert.throws(() => f.store.bindIdentity({...identity,shopVat:'IT99999999999'}),{code:'SDI_IDENTITY_LOCKED'});
  const production = createSdiStore(f.db,{environment:'production'});
  assert.throws(() => production.bindIdentity(identity),{code:'SDI_ENVIRONMENT_LOCKED'});
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,5);
});
