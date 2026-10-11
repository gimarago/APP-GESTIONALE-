const fs=require('fs'),vm=require('vm'),assert=require('assert'),parts=require('./parts-recognition');
const html=fs.readFileSync(require('path').join(__dirname,'officina-fatturazione.html'),'utf8');
const start=html.indexOf('  const requestForSegment = segment => {'),end=html.indexOf('  window.workshopProductRequests',start);
let stocks=[];const mk=(name,id)=>({name,dataset:{consumableStockId:id},cells:[{}, {textContent:'Batterie'}]});
const ctx={serviceKind:parts.kind,explicitQuantity:parts.quantity,signatures:parts.tokens,consumableRows:()=>stocks,kindForStock:r=>parts.kind(r.name),inventory:{productName:r=>r.name,unitFor:()=> 'pz',quantize:n=>n},convertQuantity:(n,a,b)=>a===b?n:null};vm.createContext(ctx);vm.runInContext(html.slice(start,end)+'this.request=requestForSegment',ctx);
const work='Sostituzione 1 batteria Varta AGM 12V 70Ah 760A';stocks=[mk('Batteria Exide AGM 12V 70Ah 760A','wrong')];assert.equal(ctx.request(work),null);
stocks.push(mk('Batteria Varta AGM 12V 70Ah 760A','right'));assert.equal(ctx.request(work).stockId,'right');assert.equal(ctx.request(work).requested,1);
assert.equal(ctx.request('Test batteria Varta AGM 70Ah'),null);assert.equal(ctx.request('Ricarica batteria Varta AGM 70Ah'),null);assert.equal(ctx.request('Batteria 70Ah'),null);assert.equal(ctx.request('1 batteria'),null);
assert.equal(ctx.request('2 batterie Varta AGM 12V 70Ah 760A').requested,2);assert.equal(ctx.request('Batteria Varta EFB 70Ah'),null);assert.equal(ctx.request('Batteria Varta AGM 60Ah'),null);assert.equal(ctx.request('Batteria Varta AGM 70Ah positivo sinistra'),null);
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);console.log('11 controlli sul collegamento al magazzino superati.');

