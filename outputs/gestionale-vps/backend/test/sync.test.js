import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {InvoiceSync} from '../src/sync/invoice-sync.js';
import {PortalProvider} from '../src/sync/portal-provider.js';
import {sampleInvoice} from '../fixtures/invoice.js';
import {XmlGenerator} from '../src/fatture/xml-generator.js';
import {xmlEngine} from '../src/xml/engine.js';
const generator=new XmlGenerator();
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'officina-sync-'));const input=join(dir,'input');await mkdir(input);
  const path=join(dir,'received.sqlite');const service=await InvoiceSync.open(path,{vat:'12345678903'});
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});return {dir,input,path,service};
}
test('importazione storica, originali identici e sincronizzazione ripetibile dopo riapertura',async t=>{
  const s=await setup(t);const xml=await generator.generate(sampleInvoice());await writeFile(join(s.input,'one.xml'),xml);
  let result=await s.service.syncLocal(s.input);assert.equal(result.imported,1);assert.equal(result.documents,1);assert.equal(result.portalConnected,false);
  const row=s.service.list()[0];assert.equal(Buffer.from(s.service.original(row.file_digest)).toString(),xml);assert.equal(row.metadata.paymentStatus,'UNKNOWN');assert.equal(row.metadata.sdiIdentifier,null);
  const reopened=await InvoiceSync.open(s.path,{vat:'12345678903'});
  try {result=await reopened.syncLocal(s.input);assert.equal(result.duplicates,1);assert.equal(reopened.list().length,1);} finally{reopened.close();}
});
test('identità aziendale, conflitti e nessuna sovrascrittura degli originali',async t=>{
  const s=await setup(t);const d=sampleInvoice();const xml=await generator.generate(d);const file=join(s.input,'one.xml');await writeFile(file,xml);await s.service.syncLocal(s.input);
  d.lines[0].unitPrice='200';await writeFile(file,await generator.generate(d));let result=await s.service.syncLocal(s.input);assert.equal(result.conflicts,1);assert.equal(s.service.list().length,1);
  assert.equal(Buffer.from(s.service.original(s.service.list()[0].file_digest)).toString(),xml);
  d.number='TEST-2';d.customer.vat='11111111115';await writeFile(file,await generator.generate(d));result=await s.service.syncLocal(s.input);assert.equal(result.issues,1);assert.equal(s.service.list().length,1);
  await assert.rejects(InvoiceSync.open(s.path,{vat:'11111111115'}),/COMPANY_ARCHIVE_MISMATCH/);
});
test('lotto multi-documento atomico e XML non valido segnalato',async t=>{
  const s=await setup(t);const xml=await generator.generate(sampleInvoice());const body=xml.match(/<FatturaElettronicaBody>[\s\S]*<\/FatturaElettronicaBody>/)[0];
  const batch=xml.replace('</p:FatturaElettronica>',body.replace('<Numero>TEST-1</Numero>','<Numero>TEST-2</Numero>')+'</p:FatturaElettronica>');
  await writeFile(join(s.input,'batch.xml'),batch);let result=await s.service.syncLocal(s.input);assert.equal(result.documents,2);
  await writeFile(join(s.input,'bad.xml'),'<!DOCTYPE a [<!ENTITY e SYSTEM "file:///secret">]><a>&e;</a>');
  result=await s.service.syncLocal(s.input);assert.equal(result.issues,1);assert.equal(result.duplicates,1);assert.equal(result.state,'COMPLETED_WITH_ISSUES');assert.equal(s.service.list().length,2);
});
test('run concorrente bloccata e recupero interruzione esplicito',async t=>{
  const s=await setup(t);
  s.service.db.prepare("INSERT INTO sync_runs VALUES('interrupted','RUNNING','2026-09-12',NULL,NULL)").run();
  await assert.rejects(s.service.syncLocal(s.input),/UNIQUE/);s.service.recoverInterrupted();
  assert.equal((await s.service.syncLocal(s.input)).state,'COMPLETED');
});
test('archivio del simulatore non riutilizzabile per le ricevute',async t=>{
  const s=await setup(t);const path=join(s.dir,'other.sqlite');const db=new DatabaseSync(path);db.exec('CREATE TABLE invoices(id TEXT)');db.close();
  await assert.rejects(InvoiceSync.open(path,{vat:'12345678903'}),/SEPARATE_SYNC_DATABASE_REQUIRED/);
});
async function zip(entries){
  const code='import io,zipfile,json,base64,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED); [(z.writestr(n,c)) for n,c in json.loads(sys.argv[1])]; z.close(); print(base64.b64encode(b.getvalue()).decode())';
  const {stdout}=await promisify(execFile)(process.env.OFFICINA_PYTHON||'python',[ '-c',code,JSON.stringify(entries)],{windowsHide:true,maxBuffer:4000000});return stdout.trim();
}
test('ZIP di export, percorsi ostili, duplicati e archivi espansivi',async t=>{
  const s=await setup(t);const xml=await generator.generate(sampleInvoice());
  await writeFile(join(s.input,'export.zip'),Buffer.from(await zip([['received/one.xml',xml]]),'base64'));
  assert.equal((await s.service.syncLocal(s.input)).imported,1);
  for(const entries of [[['../escape.xml',xml]],[['one.xml',xml],['ONE.xml',xml]],[['bomb.xml','x'.repeat(10000)]],[['C:/outside.xml',xml]]]) await assert.rejects(xmlEngine({mode:'unpack-export',base64:await zip(entries)}));
});
test('formati firmati non supportati sono segnalati, connettore remoto non finge una connessione',async t=>{
  const s=await setup(t);await writeFile(join(s.input,'invoice.xml.p7m'),'placeholder');
  const result=await s.service.syncLocal(s.input);assert.equal(result.issues,1);assert.equal(s.service.list().length,0);
  const provider=new PortalProvider();for(const m of ['requestDownload','pollDownload','download'])await assert.rejects(provider[m](),/PORTAL_SYNC_NOT_CONFIGURED/);
});
