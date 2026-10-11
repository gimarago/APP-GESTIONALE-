// Profilo esplicito e ristretto: fatture domestiche ordinarie, IVA positiva.
export function onlyKeys(o, keys, label) {
  if(!o || typeof o!=='object' || Array.isArray(o)) throw Error(`INVALID_${label}`);
  for(const k of Object.keys(o)) if(!keys.includes(k)) throw Error(`UNSUPPORTED_FIELD:${label}.${k}`);
}
export function text(v,max,label) {
  if(typeof v!=='string' || !v.trim() || v.length>max || /[\u0000-\u001f\u007f]/u.test(v)) throw Error(`INVALID_${label}`);
  return v;
}
export function decimal(v,places,label) {
  if(typeof v!=='string' || !new RegExp(`^\\d{1,10}(?:\\.\\d{1,${places}})?$`).test(v)) throw Error(`INVALID_DECIMAL:${label}`);
  const [a,b='']=v.split('.');return BigInt(a)*10n**BigInt(places)+BigInt(b.padEnd(places,'0'));
}
export const halfUp=(n,d)=>(n+d/2n)/d;
export const money=n=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
function vatValid(v) {
  if(!/^\d{11}$/.test(v) || /^0+$/.test(v)) return false;
  let s=0;for(let i=0;i<10;i++){let n=+v[i];if(i%2){n*=2;if(n>9)n-=9;}s+=n;}
  return (10-s%10)%10===+v[10];
}
function date(v) {return typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;}
function party(p,seller=false) {
  onlyKeys(p,['name','vat','cf','address','zip','city','province','country',...(seller?['regime']:[])],seller?'SELLER':'CUSTOMER');
  for(const [k,max] of [['name',80],['address',60],['city',60]]) text(p[k],max,k);
  if(p.country!=='IT' || !/^\d{5}$/.test(p.zip) || !/^[A-Z]{2}$/.test(p.province)) throw Error('UNSUPPORTED_ADDRESS');
  if(p.vat!==undefined && !vatValid(p.vat)) throw Error('INVALID_VAT');
  if(p.cf!==undefined && !/^(?:[A-Z0-9]{16}|\d{11})$/.test(p.cf)) throw Error('INVALID_CF_FORMAT');
  if(!p.vat && !p.cf) throw Error('MISSING_TAX_ID');
  if(seller && (!p.vat || p.regime!=='RF01')) throw Error('UNSUPPORTED_SELLER');
}
export function validateFiscalApplication(d) {
  onlyKeys(d,['seller','customer','transmission','type','currency','date','number','numberSource','lines','payment','reference','notes'],'INVOICE');
  party(d.seller,true);party(d.customer);
  if(d.numberSource!=='external') throw Error('EXTERNAL_NUMBER_REQUIRED');
  text(d.number,20,'NUMBER');if(!/\d/.test(d.number)) throw Error('INVALID_NUMBER');
  if(!date(d.date) || !['TD01','TD04','TD24'].includes(d.type) || d.currency!=='EUR') throw Error('UNSUPPORTED_DOCUMENT');
  onlyKeys(d.transmission,['country','id','progressive','recipientCode','pec'],'TRANSMISSION');
  const t=d.transmission;
  if(t.country!=='IT' || !/^(?:\d{11}|[A-Z0-9]{16})$/.test(t.id) || !/^[A-Za-z0-9]{1,10}$/.test(t.progressive) || !/^[A-Z0-9]{7}$/.test(t.recipientCode) || t.recipientCode==='XXXXXXX') throw Error('INVALID_TRANSMISSION');
  if(t.pec!==undefined && (t.recipientCode!=='0000000' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.pec))) throw Error('INVALID_RECIPIENT_PEC');
  if(d.notes!==undefined) text(d.notes,200,'NOTES');
  if(d.type==='TD04' && !d.reference) throw Error('CREDIT_NOTE_REFERENCE_REQUIRED');
  if(d.type==='TD24' && !d.notes) throw Error('DEFERRED_REFERENCE_REQUIRED');
  if(d.reference!==undefined) {onlyKeys(d.reference,['number','date'],'REFERENCE');text(d.reference.number,20,'REFERENCE');if(!date(d.reference.date)||d.reference.date>d.date) throw Error('INVALID_REFERENCE_DATE');}
  if(!Array.isArray(d.lines) || d.lines.length<1 || d.lines.length>1000) throw Error('INVALID_LINES');
  const groups=new Map();
  const rows=d.lines.map(l=>{
    onlyKeys(l,['description','quantity','unitPrice','vat','discount'],'LINE');text(l.description,1000,'DESCRIPTION');
    const q=decimal(l.quantity,4,'quantity'),p=decimal(l.unitPrice,8,'unitPrice'),r=decimal(l.vat,2,'vat'),discount=decimal(l.discount??'0',2,'discount');
    if(!q || ![400n,500n,1000n,2200n].includes(r) || discount>10000n) throw Error('UNSUPPORTED_LINE');
    const cents=halfUp(q*p*(10000n-discount),100000000000000n);
    groups.set(r,(groups.get(r)||0n)+cents);return {...l,cents,discount,rate:r};
  });
  const summaries=[...groups].sort((a,b)=>Number(a[0]-b[0])).map(([rate,net])=>({rate,net,tax:halfUp(net*rate,10000n)}));
  const total=summaries.reduce((s,g)=>s+g.net+g.tax,0n);
  if(d.payment!==undefined) {
    onlyKeys(d.payment,['method','dueDate','iban'],'PAYMENT');
    if(!['MP01','MP05','MP08'].includes(d.payment.method)) throw Error('UNSUPPORTED_PAYMENT');
    if(d.payment.dueDate!==undefined && !date(d.payment.dueDate)) throw Error('INVALID_DUE_DATE');
    if(d.payment.iban!==undefined && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(d.payment.iban)) throw Error('INVALID_IBAN_FORMAT');
  }
  return {rows,summaries,total};
}
