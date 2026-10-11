import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/storage.js';
import {InvoiceService} from '../src/service.js';
import {SimulatorSdiClient,SdiClient} from '../src/sdi/sdi-client.js';
import {NotificationHandler} from '../src/sdi/notification-handler.js';
import {SimulatorReceiver,SdiReceiver} from '../src/sdi/sdi-receiver.js';
import {XmlGenerator,SimulatorXmlGenerator} from '../src/fatture/xml-generator.js';
import {XsdValidator,SimulatorXmlValidator} from '../src/fatture/xml-validator.js';
const draft={simulation:true,label:'Dati sintetici'};
async function setup(t,client) {
  const dir=await mkdtemp(join(tmpdir(),'officina-test-')); const path=join(dir,'test.sqlite');
  const store=await Store.open(path);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  return {store,path,service:new InvoiceService(store,client)};
}
test('archivio e coda persistono, idempotenza e pagamento separato',async t=>{
  const {store,path,service:s}=await setup(t);
  const id=await s.createDraft('one',draft);
  assert.equal(await s.createDraft('one',draft),id);
  await assert.rejects(s.createDraft('one',{...draft,label:'Diversa'}),/CONFLICT/);
  await s.enqueue(id); assert.equal(await s.enqueue(id),false);
  const reopened=await Store.open(path);
  try {assert.equal((await new InvoiceService(reopened).get(id)).status,'DA_INVIARE');} finally {reopened.close();}
  await s.setPayment(id,'SALDATA'); await s.runOne();
  assert.equal((await s.get(id)).status,'INVIATA');assert.equal((await s.get(id)).payment,'SALDATA');
  assert.equal(await s.runOne(),null);
  assert.equal(store.db.prepare('SELECT count(*) n FROM attempts').get().n,1);
});
test('timeout non reinviato, notifica anticipata riconciliata',async t=>{
  const {store,service:s}=await setup(t,new SimulatorSdiClient({uncertain:true}));
  const id=await s.createDraft('one',draft);await s.enqueue(id);const a=await s.runOne();
  assert.equal(await s.runOne(),null);
  assert.equal(store.db.prepare('SELECT state FROM attempts').get().state,'ESITO_INCERTO');
  const h=new NotificationHandler(store);const n={simulation:true,id:'n1',correlation:`SIM-${a}`,outcome:'CONSEGNATA'};
  assert.equal(await h.handle(n),'UNMATCHED');await s.reconcileSimulatedAck(a,'Riferimento prova sintetica');
  assert.deepEqual(await h.reconcileUnmatched(),['APPLIED']);assert.equal((await s.get(id)).status,'CONSEGNATA');
  assert.equal(await h.handle(n),'APPLIED');
  await assert.rejects(h.handle({...n,outcome:'SCARTATA'}),/CONFLICT/);
  assert.equal(await h.handle({...n,id:'n2',outcome:'SCARTATA'}),'CONFLICT');
  assert.equal((await s.get(id)).status,'CONSEGNATA');
});
test('due worker reclamano una sola volta; crash recuperato senza reinvio',async t=>{
  let release;const gate=new Promise(r=>release=r);
  const {store,path,service:s}=await setup(t,{async send({attemptId}){await gate;return {simulation:true,correlation:`SIM-${attemptId}`};}});
  const id=await s.createDraft('one',draft);await s.enqueue(id);
  const running=s.runOne();
  const other=await Store.open(path);
  try {
    const worker=new InvoiceService(other);assert.equal(await worker.runOne(),null);
    // Riproduce il recupero di un processo interrotto; ACK tardivo non sblocca l'incertezza.
    await worker.recoverInterrupted();release();await running;
    assert.equal(store.db.prepare('SELECT state FROM attempts').get().state,'ESITO_INCERTO');
    assert.equal(await worker.runOne(),null);
  } finally {release();other.close();}
});
test('notifiche fuori ordine e duplicati semantici',async t=>{
  const {store,service:s}=await setup(t);const id=await s.createDraft('x',draft);await s.enqueue(id);const a=await s.runOne();
  const h=new NotificationHandler(store);const n={simulation:true,id:'1',correlation:`SIM-${a}`,outcome:'MANCATA_CONSEGNA'};
  assert.equal(await h.handle(n),'APPLIED');assert.equal(await h.handle({...n,id:'2'}),'DUPLICATE_OUTCOME');
  assert.equal(await h.handle({...n,id:'3',outcome:'CONSEGNATA'}),'APPLIED');
  assert.equal(await h.handle({...n,id:'4'}),'CONFLICT');assert.equal((await s.get(id)).status,'CONSEGNATA');
});
test('interfacce reali falliscono, XML ostile e payload eccessivi rifiutati',async t=>{
  const {store,service:s}=await setup(t);
  for(const [obj,method] of [[new SdiClient(),'reconcile'],[new SdiReceiver(),'receive']]) await assert.rejects(obj[method](),/NOT_IMPLEMENTED/);
  await assert.rejects(new SdiClient().send({}),/PRODUCTION_DISABLED/);
  await assert.rejects(new XmlGenerator().generate(),/INVALID/);
  await assert.rejects(new XsdValidator().validate(),/INVALID/);
  const v=new SimulatorXmlValidator();assert.equal((await v.validate(await new SimulatorXmlGenerator().generate(draft))).xsdValidated,false);
  await assert.rejects(v.validate('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><x>&x;</x>'));
  const r=new SimulatorReceiver(new NotificationHandler(store));await assert.rejects(r.receive('x'.repeat(4097)),/SIZE/);
  await assert.rejects(r.receive('{broken'));
  await assert.rejects(s.createDraft('fiscal',{...draft,number:'1'}),/DISABLED/);
  await assert.rejects(s.createDraft('large',{...draft,label:'a'.repeat(70000)}),/LARGE/);
});
test('produzione bloccata',async()=>{
  const previous=process.env.APP_ENV;process.env.APP_ENV='production';
  try {assert.throws(()=>new Store(':memory:'),/PRODUCTION_DISABLED/);await assert.rejects(new SimulatorSdiClient().send({}),/PRODUCTION_DISABLED/);}
  finally {if(previous===undefined) delete process.env.APP_ENV;else process.env.APP_ENV=previous;}
});
