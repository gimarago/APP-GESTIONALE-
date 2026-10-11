'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const reports=require('../work-reports.js'),invoices=require('../fatturazione.js');
const seller={name:'Officina esempio',vat:'12345678903',address:'Via Roma 1',zip:'00100',city:'Roma',province:'RM',regime:'RF01'};
const customer={name:'Azienda esempio',vat:'12345678903',address:'Via Cliente 2',zip:'00100',city:'Roma',province:'RM',code:'0000000'};
const work=(id,amount=.03)=>({id:'cash-'+id,cashId:'cash-'+id,source:'archive',sourceSelector:'',rowId:'',date:'2026-05-12',plate:'AB123CD',vehicle:'Fiat Panda',km:'12000',notes:'',amount,lines:[{description:'Controllo freni',amount}]});
const report=()=>({id:'12345678-1234-4234-8234-123456789abc',date:'2026-05-12',number:'RI-12345678123442348',customer:customer.name,customerKey:reports.customerKey(customer.name),period:{start:'2026-05-01',end:'2026-05-31'},works:[work('one'),work('two')],total:.06});
function doc(snapshot){const lines=reports.reportLines(snapshot);return {id:'invoice-one',status:'draft',type:'TD24',date:snapshot.works.at(-1).date,deferredServiceMonth:'2026-05',sourceWorkReportNumber:reports.reportNumber(snapshot),sourceWorkReportDate:snapshot.date,notes:`Rif. rapporto ${reports.reportNumber(snapshot)} del ${snapshot.date}`,paymentDue:snapshot.works.at(-1).date,payment:'MP05',customer,lines,rounding:invoices.invoiceRounding(lines),sourceWorkReportId:snapshot.id,sourceWorkIds:snapshot.works.map(item=>item.id),cashLink:'',paid:false};}

test('report snapshots deduplicate stable cash identities, preserve rounded gross amounts and archived works',()=>{
  const entries=[{cashId:'cash-one',date:'2026-05-12',customer:'Azienda esempio',vehicle:'AB123CD · Fiat Panda',amount:.67,work:'Controlli',lines:[{description:'Controllo A',amount:.333},{description:'Controllo B',amount:.333}],notes:'Nota'}, {cashId:'cash-one',date:'2026-05-12',customer:'Azienda esempio',vehicle:'AB123CD',amount:.67,lines:[]},{cashId:'cash-invalid',date:'2026-02-31',customer:'Azienda esempio',amount:2}];
  const works=reports.fromEntries(entries);assert.equal(works.length,1);assert.equal(works[0].source,'archive');assert.equal(works[0].sourceSelector,'');assert.equal(works[0].rowId,'');assert.deepEqual(works[0].lines.map(item=>item.amount),[.33,.34]);assert.equal(works[0].amount,.67);assert.equal(reports.customerKey('Àzienda Esempio S.r.l.'),'aziendaesempiosrl');
});

test('TD24 report invoice lines carry dates and plates; VAT rounding preserves exact source gross total',()=>{
  const snapshot=report(),invoice=doc(snapshot);assert.match(invoice.lines[0].description,/12\/05\/2026.*AB123CD.*Controllo freni/);
  assert.equal(invoice.type,'TD24');assert.equal(invoice.date,'2026-05-12');assert.equal(invoice.deferredServiceMonth,'2026-05');assert.match(invoice.notes,/RI-[A-Z0-9]+ del 2026-05-12/);
  assert.equal(invoices.documentTotals(invoice).net,.04);assert.equal(invoices.documentTotals(invoice).tax,.01);assert.equal(invoice.rounding,.01);assert.equal(invoices.documentTotals(invoice).total,.06);
  const prepared=invoices.prepare(invoice,{seller,documents:[]});assert.match(prepared.xml,/<TipoDocumento>TD24<\/TipoDocumento>/);assert.match(prepared.xml,/<Causale>Rif\. rapporto RI-/);assert.match(prepared.xml,/<ImportoTotaleDocumento>0.06<\/ImportoTotaleDocumento><Arrotondamento>0.01<\/Arrotondamento>/);assert.match(prepared.xml,/<ImponibileImporto>0.04<\/ImponibileImporto><Imposta>0.01<\/Imposta>/);
  invoice.lines[0].grossPrice=.04;invoice.lines[0].price=.04/1.22;invoice.rounding=invoices.invoiceRounding(invoice.lines);assert.equal(invoices.documentTotals(invoice).total,.07,'edited gross line recomputes rounding');
  const credit={...invoice,id:'credit-one',type:'TD04',reference:'1/2026',referenceDate:'2026-05-01'};delete credit.sourceWorkReportId;delete credit.sourceWorkIds;assert.equal(invoices.documentTotals(credit).total,.07);assert.deepEqual(invoices.validate(credit,seller),[]);
});

test('reports survive invoice backup merge, remain immutable and reject overlapping invoiced works',()=>{
  const snapshot=report(),invoice=doc(snapshot),empty={version:1,seller:{},documents:[],workReports:[]};
  const next=invoices.mergeBackup(empty,{version:1,seller,documents:[invoice],workReports:[snapshot]});assert.equal(next.workReports.length,1);assert.equal(next.documents.length,1);assert.deepEqual(invoices.mergeBackup(next,next),next);
  const changed=structuredClone(snapshot);changed.works[0].notes='Modificata';assert.throws(()=>invoices.mergeBackup(next,{version:1,seller,documents:[],workReports:[changed]}),/Conflitto nel rapporto/);
  const overlap={...snapshot,id:'22345678-1234-4234-8234-123456789abc'},duplicate={...invoice,id:'invoice-two',sourceWorkReportId:overlap.id,sourceWorkReportNumber:reports.reportNumber(overlap),notes:`Rif. rapporto ${reports.reportNumber(overlap)} del ${overlap.date}`};assert.throws(()=>invoices.mergeBackup(next,{version:1,seller,documents:[duplicate],workReports:[overlap]}),/già presente/);
  const linked={...invoice,id:'invoice-three',type:'TD01',cashLink:snapshot.works[0].id};for(const key of ['sourceWorkIds','sourceWorkReportId','deferredServiceMonth','sourceWorkReportNumber','sourceWorkReportDate'])delete linked[key];assert.throws(()=>invoices.mergeBackup(next,{version:1,seller,documents:[linked]}),/già presente/);
  const legacy={...linked,id:'legacy-one',cashLink:'legacy-cash'},legacyDuplicate={...legacy,id:'legacy-two'};assert.equal(invoices.mergeBackup(empty,{version:1,seller,documents:[legacy,legacyDuplicate]}).documents.length,2,'ordinary legacy duplicate cash links remain importable');
  assert.equal(empty.documents.length,0);assert.equal(empty.workReports.length,0);
});

test('printable report escapes content, keeps individual work amounts and rejects invalid totals',()=>{
  const snapshot=report();snapshot.works[0].notes='<script>alert(1)</script>';const html=reports.printHTML(snapshot,seller);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.match(html,/Documento riepilogativo non fiscale/);assert.match(html,/12\/05\/2026/);assert.match(html,/AB123CD/);assert.match(html,/0,06/);
  assert.throws(()=>reports.validateReport({...snapshot,total:.07}),/Totale/);assert.throws(()=>reports.validateReport({...snapshot,works:[snapshot.works[0],snapshot.works[0]]}),/Interventi/);
});

test('individual intervention sheets and prefilled email, PEC and WhatsApp links keep contact details out of the report body',()=>{
  const item=work('share',12.5);item.customer='Cliente & Figli';item.plate='AB123CD';item.vehicle='Fiat <Panda>';item.notes='<freno>';const html=reports.singleWorkHTML(item,seller);
  assert.match(html,/Cliente &amp; Figli/);assert.match(html,/Fiat &lt;Panda&gt;/);assert.match(html,/&lt;freno&gt;/);assert.match(html,/non è una fattura/);
  const links=reports.shareLinks(item,{email:'cliente@example.it',pec:'cliente@pec.example.it',phone:'333 1234567'},'Officina Alfa');
  assert.match(links.email,/^mailto:cliente@example\.it\?/);assert.match(links.pec,/^mailto:cliente@pec\.example\.it\?/);assert.match(links.whatsapp,/^https:\/\/wa\.me\/393331234567\?/);
  assert.match(decodeURIComponent(links.whatsapp),/Fiat <Panda>/);assert.match(decodeURIComponent(links.email),/Totale intervento: 12,50/);
  assert.equal(reports.shareLinks(item,{},'Officina').email,'');assert.equal(reports.shareLinks(item,{phone:'123'},'Officina').whatsapp,'');
  assert.ok(reports.workMessage({...item,notes:'x'.repeat(10000)},'Officina').length<=3000);
});

test('saved report send links include the report reference, selected period, work details and total',()=>{
  const snapshot=report(),message=reports.reportMessage(snapshot,'Officina Alfa'),links=reports.reportShareLinks(snapshot,{email:'cliente@example.it',pec:'cliente@pec.example.it',phone:'333 1234567'},'Officina Alfa');
  assert.match(message.subject,/Rapporto interventi RI-/);assert.match(message.body,/Azienda esempio/);assert.match(message.body,/01\/05\/2026 – 31\/05\/2026/);assert.match(message.body,/AB123CD/);assert.match(message.body,/Controllo freni/);assert.match(message.body,/Totale interventi: 0,06/);assert.ok(message.body.length<=3000);
  assert.match(links.email,/^mailto:cliente@example\.it\?/);assert.match(links.pec,/^mailto:cliente@pec\.example\.it\?/);assert.match(links.whatsapp,/^https:\/\/wa\.me\/393331234567\?/);assert.match(decodeURIComponent(links.email),/RI-[A-Z0-9]+/);assert.equal(reports.reportShareLinks(snapshot,{},'Officina').email,'');
});
