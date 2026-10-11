const {test}=require('node:test'),assert=require('node:assert/strict');
const {exactProduct,aggregate}=require('./stock-reservations.js');
const tyre={row:'tyre',name:'Michelin Primacy 4 205/55 R16'};
test('Quantità esplicita, prodotto esatto e nessuna assegnazione ambigua',()=>{
 assert.equal(exactProduct('4 Michelin Primacy 4 205/55 R16',[tyre]).quantity,4);
 assert.equal(exactProduct('4 gomme 205/55 R16',[tyre]),null);
 assert.equal(exactProduct('4 Michelin Primacy 4 205/55 R16',[tyre,{...tyre,row:'other'}]),null);
 assert.equal(exactProduct('Controllo Michelin Primacy 4 205/55 R16',[tyre]),null);
});
test('Prenotato somma righe e lavori aperti, esclude completati e segue riaperture',()=>{
 const works=[{status:'IN LAVORAZIONE',lines:[{description:'2 Michelin Primacy 4 205/55 R16'}]},{status:'PROGRAMMATO',lines:[{description:'4 Michelin Primacy 4 205/55 R16'}]},{status:'COMPLETATO',lines:[{description:'1 Michelin Primacy 4 205/55 R16'}]}];
 const match=d=>[exactProduct(d,[tyre])].filter(Boolean);
 assert.equal(aggregate(works,match).get('tyre'),6);works[0].status='COMPLETATO';assert.equal(aggregate(works,match).get('tyre'),4);works[0].status='IN ATTESA';assert.equal(aggregate(works,match).get('tyre'),6);
});
