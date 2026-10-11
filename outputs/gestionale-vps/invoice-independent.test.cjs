'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {resolve}=require('node:path');
const core=require('./fatturazione.js');
const seller={name:'Officina & collaudo',vat:'01114601006',address:'Via Prova 1',zip:'00155',city:'Roma',province:'RM',regime:'RF01'};
const base=()=>({id:'synthetic-invoice',status:'draft',type:'TD01',date:'2026-09-21',payment:'MP05',customer:{...seller,name:'Cliente <prova>',code:'0000000'},lines:[{description:'Pneumatici & montaggio',quantity:4,price:160/1.22,grossPrice:160,discount:0,vat:22}],notes:'Documento sintetico'});
const state=()=>({version:1,seller:{...seller},documents:[],numbering:{'2026':47}});
const xsd=xml=>{
 const executable=process.env.OFFICINA_PYTHON||'python';
 const result=spawnSync(executable,[resolve(__dirname,'backend/src/xml/engine.py')],{input:JSON.stringify({mode:'validate',xml}),encoding:'utf8',windowsHide:true,timeout:20000});
 if(result.error)throw result.error;
 const data=JSON.parse(result.stdout);
 assert.equal(data.ok,true,data.error);assert.equal(data.result.xsdValidated,true);
};
test('report gross totals retain positive and negative rounding in schema-valid XML',()=>{
 for(const gross of [.03,.02]){
  const invoice=base();invoice.lines=[1,2].map(i=>({description:'Intervento '+i,quantity:1,price:gross/1.22,grossPrice:gross,discount:0,vat:22}));
  invoice.rounding=core.invoiceRounding(invoice.lines);
  assert.equal(invoice.rounding,gross===.03?.01:-.01);
  const prepared=core.prepare(invoice,state());
  assert.equal(core.documentTotals(prepared).total,gross*2);
  assert.match(prepared.xml,new RegExp('<Arrotondamento>'+invoice.rounding.toFixed(2).replace('.', '\\.')+'</Arrotondamento>'));
  xsd(prepared.xml);
 }
});
test('Numerazione: floor annuale, progressione, nuovo anno, TD04 nella sequenza',()=>{
 const s=state(),a=core.prepare(base(),s);assert.equal(a.number,'47/2026');assert.equal(a.progressive,'2026000047');
 s.documents.push(a);const b=core.prepare({...base(),id:'b',type:'TD04',reference:a.number,referenceDate:a.date},s);assert.equal(b.number,'48/2026');
 s.documents.push(b);assert.equal(core.nextSequence(s.documents,'2026',1),49);assert.equal(core.nextSequence(s.documents,'2027'),1);
 assert.equal(core.nextSequence([{status:'prepared',date:'2026-01-02',number:'101/2026'}],'2026'),102);
 for(const floor of [0,-1,1.5,1000000,NaN])assert.throws(()=>core.nextSequence([],'2026',floor));
 assert.throws(()=>core.nextSequence([{status:'prepared',date:'2026-01-01',sequence:999999}],'2026'));
});
test('Preparazione atomica lato dati: non muta bozza/stato, snapshot venditore, XML stabile',()=>{
 const d=base(),s=state(),before=JSON.stringify({d,s}),p=core.prepare(d,s);
 assert.equal(JSON.stringify({d,s}),before);assert.equal(p.status,'prepared');assert.ok(p.filename.endsWith('.xml'));
 s.seller.name='Altro';assert.equal(p.seller.name,seller.name);assert.equal(core.xml(p,p.seller),p.xml);
 assert.throws(()=>core.prepare(p,s),/definitivo/);
 assert.throws(()=>core.prepare({...d,date:'2026-09-20'},{...s,documents:[p]}),/data precede/);
});
test('Prezzi lordi, sconto, aliquote miste e arrotondamento',()=>{
 const d=base();assert.deepEqual([core.totals(d.lines).net,core.totals(d.lines).tax,core.totals(d.lines).total],[524.59,115.41,640]);
 assert.equal(core.totals([{...d.lines[0],discount:10}]).total,576);
 assert.equal(core.totals([{description:'A',quantity:2,price:100,discount:10,vat:22},{description:'B',quantity:1,price:20,discount:0,vat:10}]).total,241.6);
 assert.equal(core.totals([{description:'Minimo',quantity:1,price:.005,discount:0,vat:22}]).net,.01);
});
test('IVA zero, natura, riferimento, bollo e RF19',()=>{
 const d=base();d.lines=[{description:'Prestazione',quantity:1,price:100,grossPrice:100,discount:0,vat:0,nature:'N2.2',taxReference:'Riferimento normativo di prova'}];d.stampDuty=2;
 assert.deepEqual(core.validate(d,{...seller,regime:'RF19'}),[]);assert.equal(core.documentTotals(d).total,102);
 assert.match(core.xml(core.prepare(d,{...state(),seller:{...seller,regime:'RF19'}}),{...seller,regime:'RF19'}),/<Natura>N2.2<\/Natura>/);
 assert.ok(core.validate({...d,stampDuty:1},seller).length);
 for(const patch of [{nature:''},{taxReference:''},{nature:'N2'},{vat:22}])assert.ok(core.validate({...d,lines:[{...d.lines[0],...patch}]},seller).length);
});
test('Dati invalidi usuali bloccati prima della preparazione',()=>{
 for(const patch of [{date:'2026-02-30'},{payment:'MP99'},{paymentDue:'2026-09-01'},{type:'TD04'},{iban:'nonvalido'},{notes:'x'.repeat(201)},{lines:[]}])assert.throws(()=>core.prepare({...base(),...patch},state()));
 for(const patch of [{quantity:0},{quantity:-1},{price:-1},{grossPrice:-1},{discount:101},{vat:6},{description:''}])assert.throws(()=>core.prepare({...base(),lines:[{...base().lines[0],...patch}]},state()));
});
test('XSD locale: TD01/TD04, tutte le nature, bollo, scadenza, IBAN, RF19',()=>{
 const variants=[base(),{...base(),type:'TD04',reference:'15/2026',referenceDate:'2026-09-01'}, {...base(),paymentDue:'2026-10-21',iban:'IT60X0542811101000000123456'}];
 for(const nature of core.natureCodes)variants.push({...base(),stampDuty:2,lines:[{description:'Prova natura '+nature,quantity:1,price:100,discount:0,vat:0,nature,taxReference:'Riferimento normativo di prova'}]});
 for(const d of variants)xsd(core.prepare(d,state()).xml);
 const d=variants.find(d=>d.lines[0].nature==='N2.2');xsd(core.prepare(d,{...state(),seller:{...seller,regime:'RF19'}}).xml);
});
test('TD04: data fattura collegata non può essere successiva alla nota',()=>{
 assert.throws(()=>core.prepare({...base(),type:'TD04',reference:'1/2027',referenceDate:'2027-01-01'},state()));
});
test('Controlli XML: caratteri di controllo nei dati vengono respinti',()=>{
 const d=base();d.lines[0].description='Carattere\u0001non ammesso';assert.throws(()=>core.prepare(d,state()));
});
test('Controlli XML: quantità oltre la precisione serializzata viene respinta',()=>{
 const d=base();d.lines[0].quantity=0.000000001;assert.throws(()=>core.prepare(d,state()));
});
test('Controlli XML: prezzo numericamente enorme viene respinto',()=>{
 const d=base();delete d.lines[0].grossPrice;d.lines[0].price=1e25;assert.throws(()=>core.prepare(d,state()));
});


test('Backup: round trip, conflitti, documenti incompleti e nessuna mutazione',()=>{
 const s=state(),p=core.prepare(base(),s);s.documents.push(p);
 const restored=core.mergeBackup({version:1,seller:{},documents:[]},JSON.parse(JSON.stringify(s)));
 assert.deepEqual(restored,s);assert.deepEqual(core.mergeBackup(s,s),s);
 const bad=structuredClone(s);bad.documents[0].paid=true;
 const before=JSON.stringify(s);assert.throws(()=>core.mergeBackup(s,bad),/Conflitto/);assert.equal(JSON.stringify(s),before);
 for(const change of [d=>delete d.xml,d=>delete d.seller,d=>d.date='no',d=>d.lines[0].price='no',d=>d.number='999/2026']){
  const b=structuredClone(s);change(b.documents[0]);assert.throws(()=>core.mergeBackup({version:1,seller:{},documents:[]},b));
 }
 const duplicates=structuredClone(s);duplicates.documents.push({...p,id:'other'});assert.throws(()=>core.mergeBackup({version:1,seller:{},documents:[]},duplicates),/duplicato/);
});

test('Natura uguale, riferimenti diversi: conservati entrambi nel riepilogo XML',()=>{
 const d=base();d.lines=['Articolo prova A','Articolo prova B'].map(ref=>({description:'Esente',price:100,quantity:1,vat:0,nature:'N4',taxReference:ref}));
 const prepared=core.prepare(d,state());assert.equal(core.totals(d.lines).summaries.length,2);assert.match(prepared.xml,/Articolo prova A/);assert.match(prepared.xml,/Articolo prova B/);xsd(prepared.xml);
});
