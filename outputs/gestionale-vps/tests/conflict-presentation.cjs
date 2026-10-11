'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const details = require('../cloud-conflict-details.js');

const key = (...parts) => JSON.stringify(parts);
const node = (tag, children = [], attributes = {}) => ({ t: tag, a: attributes, c: children });
const cell = (...children) => node('td', children);
const shown = description => description.fields.map(field => `${field.label}: ${field.value}`).join('\n');
const changed = difference => difference.map(field => `${field.label}: ${field.before} → ${field.after}`).join('\n');

function stock(quantity = 4, category = 'Pneumatici estivi', product = '175/65/14 88T Falken') {
  return node('tr', [
    cell(product), cell(category), cell(node('button', ['−']), node('strong', [String(quantity)]), ' pz ', node('button', ['+'])),
    cell('€ 65,00'), cell('Scaffale A'), cell('DISPONIBILE'), cell('0 pz')
  ], { 'data-cloud-id': 'stock-test', 'data-quantity': String(quantity), 'data-unit': 'pz', 'data-minimum': '4' });
}

function appointment(status = 'ACCETTATO') {
  return node('tr', [
    cell('09:30'), cell('Cliente Test'), cell('AB 123 CD', node('small', ['15.000 km'])), cell('Tagliando'),
    cell('€ 125,50'), cell('0,00 €', node('button', ['+ Acconto'])),
    cell(node('div', [node('label', [node('input', [], { type: 'checkbox' }), 'In cassa'])], { class: 'cash-destination' })),
    cell(node('select', ['ACCETTATO', 'IN LAVORAZIONE', 'COMPLETATO'].map(value => node('option', [value], { value, ...(value === status ? { selected: '' } : {}) })), { class: 'status-select', 'data-current-status': status })),
    cell(node('button', ['×']))
  ], { 'data-cloud-id': 'appointment-test', 'data-date': '2026-10-04', 'data-customer': 'Cliente Test', 'data-plate': 'AB123CD' });
}

test('the stock conflict identifies the product and presents only meaningful quantity changes', () => {
  const record = key('row', '#stockRows', 'stock-test');
  const description = details.describe(record, stock());
  assert.match(description.title, /175\/65\/14 88T Falken/);
  assert.match(shown(description), /Pneumatici estivi/);
  const difference = details.difference(record, stock(4), stock(2));
  assert.equal(difference.length, 1);
  assert.match(difference[0].label, /quantit|disponibil|scorta/i);
  assert.match(String(difference[0].before), /\b4\b/);
  assert.match(String(difference[0].after), /\b2\b/);
});

test('a category change distinguishes summer tyres from four-season tyres', () => {
  const difference = details.difference(key('row', '#stockRows', 'stock-test'), stock(4), stock(4, 'Pneumatici 4 stagioni'));
  assert.equal(difference.length, 1);
  assert.match(difference[0].label, /categoria/i);
  assert.equal(difference[0].before, 'Pneumatici estivi');
  assert.equal(difference[0].after, 'Pneumatici 4 stagioni');
});

test('readonly decorations do not become changes to business records', () => {
  const before = appointment(), after = structuredClone(before);
  after.c[5].c[1].a.disabled = '';
  after.c[6].c[0].a.class = 'cash-destination is-locked';
  after.c[7].c[0].a.disabled = '';
  assert.deepEqual(details.difference(key('row', '#agendaRows', 'appointment-test'), before, after), []);
});

test('selected appointment status is compared rather than all available options', () => {
  const difference = details.difference(key('row', '#agendaRows', 'appointment-test'), appointment(), appointment('COMPLETATO'));
  assert.equal(difference.length, 1);
  assert.match(difference[0].label, /stato/i);
  assert.equal(difference[0].before, 'ACCETTATO');
  assert.equal(difference[0].after, 'COMPLETATO');
});

test('missing records and deletions give a useful comparison without throwing', () => {
  const record = key('row', '#stockRows', 'stock-test');
  const missing = details.describe(record, null);
  assert.equal(typeof missing.title, 'string');
  assert.ok(missing.title.length > 0);
  assert.ok(Array.isArray(missing.fields));
  assert.equal(missing.fields.find(field => field.key === 'record').value, 'Eliminata');
  assert.equal(details.describe(record, undefined).fields.find(field => field.key === 'record').value, 'Non presente');
  const removed = details.difference(record, stock(), null);
  const added = details.difference(record, null, stock());
  assert.ok(removed.length > 0);
  assert.ok(added.length > 0);
  assert.match(changed(removed), /eliminat|assente|non presente/i);
  assert.match(changed(added), /eliminat|assente|non presente/i);
});

test('markup in saved text remains literal text instead of executable output', () => {
  const markup = '<img src=x onerror="globalThis.conflictAttack=true">';
  const description = details.describe(key('row', '#stockRows', 'stock-test'), stock(4, 'Ricambi', markup));
  assert.equal(globalThis.conflictAttack, undefined);
  assert.equal(typeof description.title, 'string');
  assert.ok(description.title.includes(markup));
  assert.ok(description.fields.every(field => typeof field.value === 'string'));
});

test('very long saved text is bounded so a conflict remains readable', () => {
  const text = 'Nota '.repeat(20000);
  const description = details.describe(key('item', 'officina-postit', 'note-test'), { id: 'note-test', text, done: false });
  assert.ok(description.title.length <= 1000);
  assert.ok(description.fields.every(field => String(field.value).length <= 1000));
  const difference = details.difference(key('item', 'officina-postit', 'note-test'), { id: 'note-test', text: 'Prima', done: false }, { id: 'note-test', text, done: false });
  assert.ok(difference.length > 0);
  assert.ok(difference.every(field => String(field.before).length <= 1000 && String(field.after).length <= 1000));
});

test('cash payments show euros instead of raw integer cents', () => {
  const record = key('cash', 'payments', 'payment-test');
  const before = { id: 'payment-test', accountId: 'cash-test', date: '2026-10-04', time: '09:30', cents: 12550, kind: 'deposit' };
  const after = { ...before, cents: 13050 };
  assert.match(shown(details.describe(record, before)), /125[,.]50/);
  assert.doesNotMatch(shown(details.describe(record, before)), /\b12550\b/);
  const difference = details.difference(record, before, after);
  assert.equal(difference.length, 1);
  assert.match(changed(difference), /125[,.]50/);
  assert.match(changed(difference), /130[,.]50/);
});

test('quote comparisons show changed work and the resulting total', () => {
  const record = key('item', 'officina-quotes-v1', 'quote-test');
  const before = { id: 'quote-test', customer: 'Cliente Test', vehicle: 'AB 123 CD', date: '2026-10-04', status: 'Bozza', vat: 22, lines: [{ description: 'Pneumatici', quantity: 4, price: 145 }], notes: '' };
  const after = { ...before, lines: [{ description: 'Pneumatici 4 stagioni', quantity: 4, price: 150 }] };
  assert.match(shown(details.describe(record, before)), /580[,.]00/);
  const difference = changed(details.difference(record, before, after));
  assert.match(difference, /Pneumatici 4 stagioni/);
  assert.match(difference, /580[,.]00/);
  assert.match(difference, /600[,.]00/);
});

test('saved work notes compare the previous and newly written text', () => {
  const record = key('entry', 'officina-work-notes', 'appointment-test');
  const description = details.describe(record, 'Chiamare prima di iniziare');
  assert.match(shown(description), /Chiamare prima di iniziare/);
  const difference = details.difference(record, 'Chiamare prima di iniziare', 'Il cliente autorizza il lavoro');
  assert.equal(difference.length, 1);
  assert.equal(difference[0].before, 'Chiamare prima di iniziare');
  assert.equal(difference[0].after, 'Il cliente autorizza il lavoro');
});

test('customer fiscal data presents changed fields without dumping nested history', () => {
  const record = key('entry', 'officina.customerFiscal.v1', 'customer-test');
  const before = { id: 'customer-test', address: 'Via Uno 1', history: [{ address: 'Vecchio indirizzo' }] };
  const after = { ...before, address: 'Via Due 2', history: [...before.history, { address: 'Via Uno 1' }] };
  const description = details.describe(record, after);
  assert.doesNotMatch(shown(description), /\[object Object\]|Vecchio indirizzo|customer-test/);
  const difference = details.difference(record, before, after);
  assert.equal(difference.length, 1);
  assert.equal(difference[0].before, 'Via Uno 1');
  assert.equal(difference[0].after, 'Via Due 2');
});

test('email settings never copy credentials into either side of a conflict', () => {
 const record=key('storage','officina-email-settings-v1');
 const before=JSON.stringify({email:'prima@example.test',accessToken:'sensitive-before',password:'private-password'});
 const after=JSON.stringify({email:'dopo@example.test',accessToken:'sensitive-after',password:'next-password'});
 const content=JSON.stringify([details.describe(record,before),details.describe(record,after),details.difference(record,before,after)]);
 assert.doesNotMatch(content,/sensitive|private-password|next-password/);
 assert.match(content,/prima@example.test/);assert.match(content,/dopo@example.test/);
});

test('invoice changes beyond the first page are found even with the same document count', () => {
 const record=key('storage','officina.invoices.v1');
 const documents=Array.from({length:35},(_,i)=>({id:'doc-'+i,number:i+1,customer:{name:'Cliente '+i},date:'2026-10-05',paid:false,lines:[{description:'Tagliando',quantity:1,grossPrice:100,vat:22}]}));
 const before=JSON.stringify({documents,numbering:{2026:36}});documents[34].paid=true;documents[34].paidDate='2026-10-05';documents[34].lines[0].grossPrice=150;
 const changes=details.difference(record,before,JSON.stringify({documents,numbering:{2026:36}}));
 assert.equal(changes.length,1);assert.match(changes[0].label,/35/);
 assert.match(changes[0].before,/Da saldare|100/);assert.match(changes[0].after,/Saldata/);assert.match(changes[0].after,/150/);
});

test('document numbering and DDT line quantities appear as business changes', () => {
 const invoice=key('storage','officina.invoices.v1');
 assert.equal(details.difference(invoice,JSON.stringify({numbering:{2026:5}}),JSON.stringify({numbering:{2026:6}}))[0].after,'6');
 const ddt=key('storage','officina.deliveryLoads.v1');
 const before={journal:[{identity:'fornitore|7',number:'7',supplier:'Fornitore test',date:'2026-10-05',lines:[{description:'Filtro',quantity:2,unit:'pz'}]}]};
 const after=structuredClone(before);after.journal[0].lines[0].quantity=3;
 const changes=details.difference(ddt,JSON.stringify(before),JSON.stringify(after));assert.equal(changes.length,1);assert.match(changes[0].before,/2/);assert.match(changes[0].after,/3/);
});

test('signed modules use actual capitalized fields and omit the signature image', () => {
 const record=key('item','officina-moduli-v1','signed-test');
 const before={Customer:'Cliente Modulo',Date:'2026-10-05',Details:'Filtro',Signature:'data:image/png;base64,private-image'};
 const after={...before,Details:'Filtro e olio'};
 assert.match(details.describe(record,after).title,/Cliente Modulo/);
 const changes=details.difference(record,before,after);assert.equal(changes.length,1);assert.equal(changes[0].before,'Filtro');assert.equal(changes[0].after,'Filtro e olio');
 assert.doesNotMatch(JSON.stringify(details.describe(record,after)),/private-image|data:image/);
});
