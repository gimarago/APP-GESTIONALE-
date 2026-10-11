import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from './database.mjs';
import { createSdiRuntime } from './sdi-runtime.mjs';
import { prepareOutgoing, parseCallback, inspectIncoming, parseOutgoingResponse } from './sdi-protocol.mjs';

// All fixtures are synthetic and remain local. The signature below is only
// structurally valid: XSD validation must never be reported as signature proof.
const require = createRequire(import.meta.url);
const { xml: invoiceXml } = require('../fatturazione.js');
const VAT = '01114601006', SID = '123456789012';
const FILE = `IT${VAT}_00001.xml`, NOTIFICATION = `IT${VAT}_00001_RC_001.xml`;
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const OUT = 'http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types';
const IN = 'http://www.fatturapa.gov.it/sdi/ws/ricezione/v1.0/types';
const B2B = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fattura/messaggi/v1.0';
const PA = 'http://www.fatturapa.gov.it/sdi/messaggi/v1.0';
const XOP = 'http://www.w3.org/2004/08/xop/include';
const DATE = '2026-09-29T12:34:56+02:00';
const b64 = value => Buffer.from(value).toString('base64');
const digest = value => createHash('sha256').update(value).digest('hex');
const seller = { name:'Officina & prova',vat:VAT,address:'Via Roma 1',zip:'00100',city:'Roma',province:'RM' };
function invoice(overrides = {}) {
  return invoiceXml({type:'TD01',date:'2026-09-29',number:'1/2026',progressive:'00001',payment:'MP05',
    paymentDue:'2026-10-29',customer:{...seller,code:'0000000'},lines:[{description:'Riparazione',quantity:2,price:100,discount:0,vat:22}],...overrides},seller);
}
const envelope = child => `<soap:Envelope xmlns:soap="${SOAP}"><soap:Body>${child}</soap:Body></soap:Envelope>`;
const tag = (name,value) => `<${name}>${value}</${name}>`;
const signature = '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>'+
  '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>'+
  '<ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>'+
  '<ds:Reference URI=""><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>'+
  '<ds:DigestValue>AA==</ds:DigestValue></ds:Reference></ds:SignedInfo><ds:SignatureValue>AA==</ds:SignatureValue></ds:Signature>';
function receipt(operation, namespace = B2B, overrides = {}) {
  const names = namespace === B2B ? {NotificaScarto:'RicevutaScarto',NotificaMancataConsegna:'RicevutaImpossibilitaRecapito'} : {};
  const local = names[operation] || operation;
  let content = tag('IdentificativoSdI',overrides.sid || SID) + tag('NomeFile',overrides.filename || FILE);
  if(namespace === B2B) content += tag('Hash',overrides.hash ?? 'a'.repeat(64));
  if(!['NotificaEsito','NotificaDecorrenzaTermini'].includes(operation)) content += tag('DataOraRicezione',DATE);
  if(operation === 'RicevutaConsegna') content += tag('DataOraConsegna',DATE)+'<Destinatario><Codice>ABC1234</Codice><Descrizione>Cliente</Descrizione></Destinatario>';
  if(operation === 'NotificaScarto') content += '<ListaErrori><Errore><Codice>00400</Codice><Descrizione>Documento errato</Descrizione>'+
    (namespace === B2B ? '<Suggerimento>Correggere il documento</Suggerimento>' : '')+'</Errore></ListaErrori>';
  if(operation === 'NotificaMancataConsegna') content += (namespace === B2B ? '<DataMessaADisposizione>2026-09-29</DataMessaADisposizione>' : '')+'<Descrizione>Recapito non disponibile</Descrizione>';
  if(operation === 'NotificaEsito') content += '<EsitoCommittente versione="1.0">'+tag('IdentificativoSdI',overrides.recipientSid || SID)+'<Esito>EC01</Esito></EsitoCommittente>';
  if(operation === 'AttestazioneTrasmissioneFattura') content += '<Destinatario><Codice>ABC123</Codice><Descrizione>Ente</Descrizione></Destinatario>';
  content += '<MessageId>1234567890</MessageId>';
  if(operation === 'AttestazioneTrasmissioneFattura') content += tag('HashFileOriginale','b'.repeat(64));
  return `<m:${local} xmlns:m="${namespace}" versione="1.0">${content}${signature}</m:${local}>`;
}
function notification(operation='RicevutaConsegna', namespace=B2B, options={}) {
  const receiving = options.receiving === true;
  const element = receiving ? 'fileSdI' : operation[0].toLowerCase()+operation.slice(1);
  const payload = options.payload ?? receipt(operation,namespace,options);
  const child = `<t:${element} xmlns:t="${receiving ? IN : OUT}">`+
    tag('IdentificativoSdI',options.outerSid ?? SID)+tag('NomeFile',options.outerFilename ?? NOTIFICATION)+tag('File',b64(payload))+`</t:${element}>`;
  return {kind:receiving?'invoices':'notifications',xml:envelope(child),contentType:'text/xml; charset=utf-8',
    soapAction:`http://www.fatturapa.it/${receiving?'RicezioneFatture':'TrasmissioneFatture'}/${operation}`};
}
function received(options={}) {
  const payload=options.payload ?? invoice(), filename=options.filename ?? FILE;
  const namespace=options.namespace ?? B2B, local=namespace===B2B?'FileMetadati':'MetadatiInvioFile';
  const metadata=`<m:${local} xmlns:m="${namespace}" versione="1.0">`+tag('IdentificativoSdI',options.metaSid ?? SID)+
    tag('NomeFile',options.metaFilename ?? filename)+(namespace===B2B?tag('Hash',options.hash ?? digest(payload)):'')+
    '<CodiceDestinatario>ABC1234</CodiceDestinatario><Formato>FPR12</Formato><TentativiInvio>1</TentativiInvio><MessageId>1234567890</MessageId>'+`</m:${local}>`;
  const child=`<t:fileSdIConMetadati xmlns:t="${IN}">`+tag('IdentificativoSdI',SID)+tag('NomeFile',filename)+
    tag('File',b64(payload))+tag('NomeFileMetadati',`IT${VAT}_00001_MT_001.xml`)+tag('Metadati',b64(metadata))+'</t:fileSdIConMetadati>';
  return {kind:'invoices',xml:envelope(child),contentType:'text/xml',soapAction:'http://www.fatturapa.it/RicezioneFatture/RiceviFattureSdI'};
}
function multipart(request, options={}) {
  const boundary='local_test_boundary';
  const attachments=[];
  let xml=request.xml;
  for(const name of ['File','Metadati']) {
    xml=xml.replace(new RegExp(`<${name}>([^<]+)</${name}>`),(_,content)=>{
      attachments.push({cid:`${name.toLowerCase()}@test`,type:'application/octet-stream',data:Buffer.from(content,'base64')});
      return `<${name}><xop:Include xmlns:xop="${XOP}" href="cid:${name.toLowerCase()}%40test"/></${name}>`;
    });
  }
  let parts=[{cid:'soap@test',type:'application/xop+xml; charset=utf-8; type="text/xml"',data:Buffer.from(xml)},...attachments];
  if(options.rootLast) parts=[...parts.slice(1),parts[0]];
  const body=Buffer.concat(parts.map(p=>Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: ${p.type}\r\nContent-ID: <${p.cid}>\r\nContent-Transfer-Encoding: binary\r\n\r\n`),p.data,Buffer.from('\r\n')])).concat(Buffer.from(`--${boundary}--\r\n`)));
  return {...request,xml:undefined,bodyBase64:b64(body),contentType:`multipart/related; type="application/xop+xml"; start="<soap@test>"; boundary="${boundary}"`};
}
const mutateMime = (request, edit) => ({...request,bodyBase64:b64(edit(Buffer.from(request.bodyBase64,'base64').toString('utf8')))});
function outgoingReply(content=tag('IdentificativoSdI',SID)+tag('DataOraRicezione',DATE)) {
  return {status:200,contentType:'text/xml',xml:envelope(`<t:rispostaSdIRiceviFile xmlns:t="${OUT}">${content}</t:rispostaSdIRiceviFile>`)};
}

test('prepare validates generated FPR12 and emits lossless SOAP 1.1 MTOM with pinned action', async()=>{
  const xml=invoice(), result=await prepareOutgoing({xml,filename:FILE});
  assert.equal(result.action,'http://www.fatturapa.it/SdIRiceviFile/RiceviFile');
  assert.equal(result.invoice.seller.vat,VAT); assert.equal(result.invoice.documents[0].total,'244.00');
  assert.equal(result.invoice.xsdValidated,true); assert.equal(result.invoice.signatureVerification,'NOT_PERFORMED');
  assert.ok(result.xml.includes(`<File>${b64(xml)}</File>`));
  assert.match(result.contentType,/multipart\/related/);
  const body=Buffer.from(result.bodyBase64,'base64').toString('utf8');
  assert.ok(body.includes(xml)); assert.match(body,/href="cid:invoice@officina"/); assert.match(body,/Content-ID: <invoice@officina>/);
});
test('prepare rejects invalid schema, transport filename and transmitter mismatch', async()=>{
  await assert.rejects(prepareOutgoing({xml:'<invoice/>',filename:FILE}),/SDI_XSD_INVALID/);
  await assert.rejects(prepareOutgoing({xml:invoice(),filename:`IT${VAT}_123456.xml`}),/SDI_TRANSPORT_FILENAME/);
  await assert.rejects(prepareOutgoing({xml:invoice(),filename:'IT09876543210_00001.xml'}),/SDI_TRANSMITTER_FILENAME/);
});
test('invoice inspection keeps all document bodies and exact cents, marking credit notes for review', async()=>{
  const first=invoice(), second=invoice({number:'2/2026',type:'TD04',reference:'1/2026',referenceDate:'2026-09-29'});
  const secondBody=second.match(/<FatturaElettronicaBody>[\s\S]*<\/FatturaElettronicaBody>/)[0];
  const multi=first.replace('</p:FatturaElettronica>',secondBody+'</p:FatturaElettronica>');
  const result=await inspectIncoming({filename:FILE,base64:b64(multi),shopVat:VAT});
  assert.equal(result.length,2); assert.deepEqual(result.map(d=>d.bodyIndex),[0,1]);
  assert.equal(result[0].supplierName,'Officina & prova'); assert.equal(result[0].supplierTaxId,`IT${VAT}`);
  assert.equal(result[0].totalCents,24400); assert.equal(result[0].dueDate,'2026-10-29');
  assert.equal(result[1].documentType,'TD04'); assert.equal(result[1].totalCents,null);
});
test('inspection quarantines foreign recipient, opaque CAdES and unsupported file formats', async()=>{
  assert.match((await inspectIncoming({filename:FILE,base64:b64(invoice()),shopVat:'09876543210'})).quarantineReason,/Destinatario/);
  assert.match((await inspectIncoming({filename:FILE+'.p7m',base64:b64(Buffer.from([0,255,2,3])),shopVat:VAT})).quarantineReason,/CAdES/);
  assert.match((await inspectIncoming({filename:'archivio1.zip',base64:b64('opaque'),shopVat:VAT})).quarantineReason,/Formato non supportato/);
});
test('inspection avoids automatic amount/date assumptions for foreign currency, omitted totals or split payments', async()=>{
  const xml=invoice();
  for(const modified of [xml.replace('<Divisa>EUR</Divisa>','<Divisa>USD</Divisa>'),xml.replace('<ImportoTotaleDocumento>244.00</ImportoTotaleDocumento>','')]) {
    assert.equal((await inspectIncoming({filename:FILE,base64:b64(modified),shopVat:VAT}))[0].totalCents,null);
  }
  const detail=xml.match(/<DettaglioPagamento>[\s\S]*<\/DettaglioPagamento>/)[0];
  const split=xml.replace('</DatiPagamento>',detail+'</DatiPagamento>');
  assert.equal((await inspectIncoming({filename:FILE,base64:b64(split),shopVat:VAT}))[0].dueDate,null);
});

for(const [namespace,operations] of [[B2B,['RicevutaConsegna','NotificaScarto','NotificaMancataConsegna']],
  [PA,['RicevutaConsegna','NotificaScarto','NotificaMancataConsegna','NotificaEsito','NotificaDecorrenzaTermini','AttestazioneTrasmissioneFattura']]]) {
  for(const operation of operations) test(`${namespace===B2B?'B2B':'PA'} ${operation} matches pinned XSD and keeps notification/invoice filenames distinct`,async()=>{
    const input=notification(operation,namespace), result=await parseCallback({...input,bodyBase64:b64(input.xml),xml:'ignored'});
    assert.equal(result.operation,operation); assert.equal(result.identifier,SID); assert.equal(result.filename,NOTIFICATION);
    assert.equal(result.notification.invoiceFilename,FILE); assert.equal(result.notification.xsdValidated,true);
    assert.equal(result.notification.signatureVerification,'NOT_PERFORMED'); assert.equal(result.response.status,202);
    if(operation==='NotificaScarto') assert.deepEqual(result.notification.errors,[{code:'00400',description:'Documento errato'}]);
    if(operation==='NotificaEsito') assert.equal(result.notification.recipientOutcome,'EC01');
    if(operation==='AttestazioneTrasmissioneFattura') assert.equal(result.notification.fileHash,'b'.repeat(64));
  });
}
test('receiving endpoint supports the WSDL deadline notification with its separate action',async()=>{
  const result=await parseCallback(notification('NotificaDecorrenzaTermini',PA,{receiving:true}));
  assert.equal(result.kind,'notifications'); assert.equal(result.operation,'NotificaDecorrenzaTermini'); assert.equal(result.response.status,202);
});
test('incoming B2B and PA metadata are verified and acknowledged with ER01',async()=>{
  for(const namespace of [B2B,PA]) {
    const result=await parseCallback(received({namespace}));
    assert.equal(result.kind,'invoices'); assert.equal(result.identifier,SID); assert.equal(result.filename,FILE);
    assert.equal(Buffer.from(result.payloadBase64,'base64').toString(),invoice());
    assert.equal(result.response.status,200); assert.match(result.response.body,/<Esito>ER01<\/Esito>/);
    assert.match(result.response.body,/rispostaRiceviFatture/); assert.ok(result.metadataBase64);
  }
});
test('MTOM handles both binary invoice and metadata, percent-encoded CIDs and explicit root order',async()=>{
  const input=received();
  const expected=await parseCallback(input);
  assert.deepEqual(await parseCallback(multipart(input)),expected);
  assert.deepEqual(await parseCallback(multipart(input,{rootLast:true})),expected);
  const notify=notification();
  assert.deepEqual(await parseCallback(multipart(notify)),await parseCallback(notify));
});
test('notification rejects wrong operation, outer ID, nested recipient ID and invalid signature structure',async()=>{
  await assert.rejects(parseCallback(notification('NotificaScarto',B2B,{payload:receipt('RicevutaConsegna')})),/SDI_NOTIFICATION_MISMATCH/);
  await assert.rejects(parseCallback(notification('RicevutaConsegna',B2B,{sid:'999'})),/SDI_NOTIFICATION_MISMATCH/);
  await assert.rejects(parseCallback(notification('NotificaEsito',PA,{recipientSid:'999'})),/SDI_NOTIFICATION_MISMATCH/);
  await assert.rejects(parseCallback(notification('RicevutaConsegna',B2B,{payload:receipt('RicevutaConsegna').replace(signature,'')})),/SDI_XSD_INVALID/);
});
test('metadata rejects mismatched identifier, filename, hash and malformed hash without ACK',async()=>{
  for(const options of [{metaSid:'999'},{metaFilename:`IT${VAT}_00002.xml`}]) await assert.rejects(parseCallback(received(options)),/SDI_METADATA_MISMATCH/);
  for(const hash of ['b'.repeat(64),'not-a-sha256','']) await assert.rejects(parseCallback(received({hash})),/SDI_METADATA_HASH/);
  assert.equal((await parseCallback(received({hash:digest(invoice()).toUpperCase()}))).response.status,200);
});
test('SOAPAction is exact, supports standard quotes and cannot switch receiving/sending contract',async()=>{
  const input=notification();
  assert.equal((await parseCallback({...input,soapAction:`"${input.soapAction}"`})).operation,'RicevutaConsegna');
  for(const extra of [{soapAction:''},{soapAction:input.soapAction+'/other'},{soapAction:[input.soapAction]},{kind:'invoices'}]) {
    await assert.rejects(parseCallback({...input,...extra}),/SDI_SOAP_ACTION/);
  }
});
test('identifiers and filenames have canonical safe forms; duplicate identifier elements fail XSD',async()=>{
  for(const outerSid of ['0','-1','+12','00012','1234567890123']) await assert.rejects(parseCallback(notification('RicevutaConsegna',B2B,{outerSid})),/SDI_(IDENTIFIER|XSD_INVALID)/);
  for(const outerFilename of ['../invoice.xml','..invoice.xml','folder/invoice.xml','bad name.xml']) await assert.rejects(parseCallback(notification('RicevutaConsegna',B2B,{outerFilename})),/SDI_(FILENAME|XSD_INVALID)/);
  const input=notification();
  await assert.rejects(parseCallback({...input,xml:input.xml.replace(tag('IdentificativoSdI',SID),tag('IdentificativoSdI',SID).repeat(2))}),/SDI_XSD_INVALID/);
});
test('SOAP rejects unexpected headers, multiple bodies, encoded style, mixed text and SOAP 1.2',async()=>{
  const input=notification();
  const transforms=[
    xml=>xml.replace('<soap:Body>','<soap:Header><token>secret</token></soap:Header><soap:Body>'),
    xml=>xml.replace('</soap:Envelope>','<soap:Body><other/></soap:Body></soap:Envelope>'),
    xml=>xml.replace('<soap:Body>','<soap:Body soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'),
    xml=>xml.replace('<soap:Body>','unexpected<soap:Body>'),
    xml=>xml.replace('</soap:Body>','</soap:Body><soap:Header/>'),
    xml=>xml.replace('<soap:Body>','<soap:Body>unexpected'),
    xml=>xml.replace(SOAP,'http://www.w3.org/2003/05/soap-envelope')
  ];
  for(const transform of transforms) await assert.rejects(parseCallback({...input,xml:transform(input.xml)}),/SDI_SOAP_(HEADER|BODY|ENVELOPE)/);
});
test('external entities and DTDs are rejected in SOAP, UTF-16 SOAP and invoice attachments',async()=>{
  const input=notification(), attack='<!DOCTYPE x [<!ENTITY e SYSTEM "file:///C:/not-read.txt">]>';
  await assert.rejects(parseCallback({...input,xml:attack+input.xml}),/SDI_DTD_DISABLED/);
  const utf16=Buffer.from('\uFEFF<?xml version="1.0" encoding="UTF-16"?>'+attack+input.xml,'utf16le');
  await assert.rejects(parseCallback({...input,bodyBase64:b64(utf16),xml:undefined}),/SDI_DTD_DISABLED/);
  const maliciousInvoice=invoice().replace(/<\?xml[^?]+\?>/,attack);
  await assert.rejects(inspectIncoming({filename:FILE,base64:b64(maliciousInvoice),shopVat:VAT}),/SDI_DTD_DISABLED/);
});
test('MTOM rejects duplicate IDs, missing/replaced references, unused parts and ambiguous content types',async()=>{
  const input=multipart(received());
  const edits=[
    body=>body.replace('Content-ID: <metadati@test>','Content-ID: <file@test>'),
    body=>body.replace('cid:file%40test','cid:missing%40test'),
    body=>body.replace('cid:file%40test','https://example.invalid/file'),
    body=>body.replace(/<Metadati><xop:Include[^>]+\/><\/Metadati>/,'<Metadati>YQ==</Metadati>'),
    body=>body.replace('Content-Type: application/octet-stream','Content-Type: application/octet-stream\r\nContent-Type: text/xml'),
    body=>body.replace('Content-Transfer-Encoding: binary','Content-Transfer-Encoding: unsupported')
  ];
  for(const edit of edits) await assert.rejects(parseCallback(mutateMime(input,edit)),/SDI_(MIME|XOP)_/);
  await assert.rejects(parseCallback({...input,contentType:input.contentType.replace('start="<soap@test>"','start="<missing@test>"')}),/SDI_MIME_ROOT/);
});
test('SOAP media type, header injection, absent MTOM data and invalid base64 fail closed',async()=>{
  const input=notification();
  for(const contentType of ['application/soap+xml','application/json','text/xml\r\nX-Injected: 1']) await assert.rejects(parseCallback({...input,contentType}),/SDI_CONTENT_TYPE/);
  const xop=input.xml.replace(/<File>[^<]+<\/File>/,`<File><xop:Include xmlns:xop="${XOP}" href="cid:missing"/></File>`);
  await assert.rejects(parseCallback({...input,xml:xop}),/SDI_XOP_MISSING_PART/);
  await assert.rejects(parseCallback({...input,bodyBase64:'!!!'}),/SDI_XML_INVALID/);
  await assert.rejects(inspectIncoming({filename:FILE,base64:'',shopVat:VAT}),/SDI_ATTACHMENT_SIZE/);
});
test('outgoing responses separate SdI receipt, explicit transport rejection and uncertain outcomes',async()=>{
  assert.deepEqual(await parseOutgoingResponse(outgoingReply()),{kind:'SDI_RECEIVED',identifier:SID,receivedAt:DATE});
  for(const code of ['EI01','EI02','EI03']) {
    const result=await parseOutgoingResponse(outgoingReply('<IdentificativoSdI>0</IdentificativoSdI>'+tag('DataOraRicezione',DATE)+tag('Errore',code)));
    assert.deepEqual(result,{kind:'TRANSPORT_REJECTED',code});
  }
  for(const reply of [outgoingReply('<IdentificativoSdI>0</IdentificativoSdI>'+tag('DataOraRicezione',DATE)),
    outgoingReply(tag('IdentificativoSdI',SID)),{...outgoingReply(),status:500},{...outgoingReply(),xml:envelope('<soap:Fault/>')},
    {...outgoingReply(),xml:'not XML'}]) assert.equal((await parseOutgoingResponse(reply)).kind,'UNKNOWN');
});

test('real codec, runtime and SQLite exchange MTOM, reconcile receipts and import each incoming body exactly once',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'officina-sdi-protocol-test-')), db=openDatabase(dir);
  const token='G'.repeat(64), peer='a'.repeat(64), sent=[];
  // Synthetic production-mode archive only: both credentials and outbound
  // transport are local stubs, so this test cannot contact the SdI endpoint.
  const env={SDI_ENABLED:'true',SDI_ENVIRONMENT:'production',SDI_PRODUCTION_APPROVED:'true',
    SDI_ACCREDITATION_REFERENCE:'SYNTHETIC-LOCAL-TEST',SHOP_VAT:VAT,SDI_DOMAIN:'sdi.example.com',OFFICINA_DOMAIN:'app.example.com',
    SDI_ENDPOINT:'https://servizi.fatturapa.it/ricevi',SDI_ENDPOINT_HOST:'servizi.fatturapa.it',
    SDI_GATEWAY_TOKEN:token,SDI_PEER_FINGERPRINTS:peer,SDI_CLIENT_CERT_PATH:'unused-cert.pem',SDI_CLIENT_KEY_PATH:'unused-key.pem',SDI_REMOTE_CA_PATH:'unused-ca.pem'};
  const runtime=createSdiRuntime({db,env,credentialsLoader:()=>({}),transport:async(_config,_credentials,request)=>{
    sent.push(request);
    const reply=outgoingReply();
    return {status:reply.status,contentType:reply.contentType,body:Buffer.from(reply.xml)};
  }});
  const server=http.createServer(async(req,res)=>{if(!await runtime.callback(req,res)){res.writeHead(404);res.end();}});
  t.after(async()=>{
    await runtime.stop(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); db.close();
    const target=resolve(dir);
    assert.ok(target.startsWith(resolve(tmpdir())+sep) && basename(target).startsWith('officina-sdi-protocol-test-'));
    rmSync(target,{recursive:true,force:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  async function waitUntil(check){for(let i=0;i<200;i++){if(check()) return;await delay(25);} assert.fail('Runtime did not finish local fixture');}
  async function deliver(input,path){
    const response=await fetch(url+path,{method:'POST',headers:{'content-type':input.contentType,soapaction:input.soapAction,
      'x-sdi-gateway-token':token,'x-sdi-peer-fingerprint':peer,'x-sdi-gateway-host':'sdi.example.com'},
    body:input.bodyBase64?Buffer.from(input.bodyBase64,'base64'):input.xml});
    return {status:response.status,body:await response.text()};
  }
  const xml=invoice({progressive:'2026000001'}), queued=await runtime.enqueue({documentId:'local-document',
    fiscalKey:`IT${VAT}|TD01|2026|1`,filename:`IT${VAT}_2026000001.xml`,xml,metadata:{number:'1/2026'}});
  assert.match(queued.filename,new RegExp(`^IT${VAT}_[A-Za-z0-9]{5}\\.xml$`));
  runtime.start(); await waitUntil(()=>runtime.store.detail(queued.id).state==='SDI_RECEIVED'); await runtime.stop();
  assert.equal(sent.length,1); assert.match(sent[0].contentType,/multipart\/related/);
  const actual=Buffer.from(sent[0].bodyBase64,'base64').toString('utf8');
  assert.ok(actual.includes(tag('NomeFile',queued.filename))); assert.ok(actual.includes(xml));
  assert.equal(runtime.store.detail(queued.id).sdiId,SID);
  const receiptInput=multipart(notification('RicevutaConsegna',B2B,{filename:queued.filename,hash:digest(xml)}));
  assert.equal((await deliver(receiptInput,'/sdi/notifications')).status,202);
  assert.equal((await deliver(receiptInput,'/sdi/notifications')).status,202);
  const archived=runtime.store.detail(queued.id);
  assert.equal(archived.fiscalState,'CONSEGNA'); assert.equal(archived.conflict,false);
  assert.equal(archived.events.length,1); assert.equal(archived.events[0].state,'APPLIED');
  const first=invoice(), secondBody=invoice({number:'2/2026'}).match(/<FatturaElettronicaBody>[\s\S]*<\/FatturaElettronicaBody>/)[0];
  const multi=first.replace('</p:FatturaElettronica>',secondBody+'</p:FatturaElettronica>');
  const incomingInput=multipart(received({payload:multi}));
  const ack=await deliver(incomingInput,'/sdi/invoices'); assert.equal(ack.status,200); assert.match(ack.body,/<Esito>ER01<\/Esito>/);
  assert.equal((await deliver(incomingInput,'/sdi/invoices')).status,200);
  assert.equal(runtime.store.listIncoming().length,1); assert.equal(runtime.store.listIncoming()[0].state,'PENDING');
  runtime.start(); await waitUntil(()=>runtime.store.listIncoming()[0].state==='IMPORTED'); await runtime.stop();
  assert.equal(runtime.store.listIncoming()[0].supplierInvoiceIds.length,2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_invoices').get().count,2);
  assert.equal((await deliver(incomingInput,'/sdi/invoices')).status,200);
  runtime.start(); await delay(75); await runtime.stop();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_invoices').get().count,2);
  assert.equal(sent.length,1);
});
