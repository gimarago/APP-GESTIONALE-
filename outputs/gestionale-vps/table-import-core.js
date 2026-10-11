(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkshopImport=api;})(globalThis,()=>{
 function parse(text){text=String(text).replace(/^\uFEFF/,'');const first=text.split(/\r?\n/)[0];const delimiter=first.includes('\t')?'\t':first.split(';').length>first.split(',').length?';':',';let rows=[],row=[],value='',quoted=false;for(let i=0;i<text.length;i++){let c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(v=>v.trim()))rows.push(row);row=[];value='';}else value+=c;}if(quoted)throw Error('Virgolette non chiuse nel file.');row.push(value);if(row.some(v=>v.trim()))rows.push(row);return rows;}
 const normalize=s=>String(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
 const plateKey=value=>String(value??'').toUpperCase().replace(/[\s-]/g,'');
 function validPlate(value){
  const raw=String(value??'').trim().toUpperCase();
  const compact=plateKey(raw);
  // Targhe italiane, estere, moto e storiche possono avere formati diversi.
  // Escludiamo soltanto descrizioni o abbinamenti di colonna chiaramente errati.
  return raw.length<=18 && /^[A-Z0-9 -]+$/.test(raw) && /^[A-Z0-9]{2,12}$/.test(compact)
    && (/[0-9]/.test(compact)||compact.length<=8) && !/(?:TAGLIAND|PNEUMATIC|GOMME|OLIO|LAVORAZION|INTERVENTO)/.test(compact);
 }
 function number(value){if(value===undefined||String(value).trim()==='')return 0;if(typeof value==='number'){if(!Number.isFinite(value)||value<0)throw Error('Valore numerico non valido');return value;}let s=String(value).replace(/[€\s]/g,'');if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');if(!/^\d+(?:\.\d+)?$/.test(s))throw Error('Importo o quantità non valido: '+value);return Number(s);}
 function date(value){if(!value)return '';if(typeof value==='number'||/^\d{5}(?:\.\d+)?$/.test(value)){const n=Number(value);return new Date(Date.UTC(1899,11,30)+Math.floor(n)*86400000).toISOString().slice(0,10);}let s=String(value).trim();const m=s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);if(m)s=m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw Error('Data non valida: '+value);return s;}
 function enabled(value){const v=normalize(value);if(v==='')return true;if(['si','true','1','attivo','attivato','abilitato','yes','on'].includes(v))return true;if(['no','false','0','disattivo','disattivato','disabilitato','off'].includes(v))return false;throw Error('Avviso riordino non valido: usa sì/no, true/false oppure 1/0.');}
 function convert(rows,map,type){return rows.map((row,i)=>{const get=k=>map[k]>=0?row[map[k]]??'':'';try{if(type==='stock'){const item={product:String(get('product')).trim(),quantity:number(get('quantity')),unit:String(get('unit')||'pz').trim().toLowerCase(),category:String(get('category')||'Ricambi'),price:number(get('price')),position:String(get('position')||''),profit:number(get('profit')),minimum:String(get('minimum')).trim()===''?5:number(get('minimum')),reorderEnabled:enabled(get('reorderEnabled'))};item.unit=({l:'lt',litri:'lt',pezzi:'pz'})[item.unit]||item.unit;if(!item.product)throw Error('Prodotto obbligatorio');if(!['pz','lt','ml','kg','g','m'].includes(item.unit))throw Error('Unità non riconosciuta');return {item,line:i+2};}const tyreRaw=String(get('tyreQuantity')).trim();const tyreQuantity=tyreRaw===''?null:number(tyreRaw);const item={customer:String(get('customer')).trim(),plate:String(get('plate')).trim().toUpperCase(),vehicle:String(get('vehicle')),phone:String(get('phone')),email:String(get('email')),date:date(get('date')),work:String(get('work')).trim(),amount:number(get('amount')),notes:String(get('notes')),km:String(get('km')),tyreQuantity,tyreMeasure:String(get('tyreMeasure')).trim().toUpperCase()};if(!item.customer||!item.plate)throw Error('Cliente e targa obbligatori');if(!validPlate(item.plate))throw Error('Targa non riconosciuta: controlla l’abbinamento della colonna Targa');if(item.work&&!item.date)throw Error('Data obbligatoria per lo storico');if(tyreQuantity!==null&&(!Number.isInteger(tyreQuantity)||tyreQuantity>1000))throw Error('Quantità pneumatici non valida');return {item,line:i+2};}catch(e){return {error:e.message,line:i+2};}});}
 const moneyCents=value=>{
  const raw=String(value??0).replace(/[€\s]/g,'');
  const decimal=raw.includes(',')?raw.replace(/\./g,'').replace(',','.'):raw;
  return Math.round((Number(decimal)||0)*100);
 };
 const workKey=item=>JSON.stringify([plateKey(item?.plate),String(item?.date||''),normalize(item?.work),moneyCents(item?.amount)]);
 const historyKey=item=>JSON.stringify([workKey(item),normalize(item?.customer),normalize(item?.vehicle),normalize(item?.notes),String(item?.km??'').trim(),String(item?.tyreQuantity??''),normalize(item?.tyreMeasure)]);
 function tyreInfo(item){
  const text=String(item?.work||'');
  const match=text.match(/(?:^|[^0-9])([0-9]{1,3})\s+(?:(?:pneumatic[oi]|gomm[ae]|coperture?)\s+)?([0-9]{3}\/[0-9]{2}(?:\s*R?[0-9]{1,2}(?:[.,][0-9])?|\/[0-9]{2}(?:[.,][0-9])?)?)/i);
  const explicit=item?.tyreQuantity===null||item?.tyreQuantity===undefined||item?.tyreQuantity===''?null:Number(item.tyreQuantity);
  const quantity=explicit!==null&&Number.isInteger(explicit)&&explicit>=0&&explicit<=1000?explicit:match?Number(match[1]):0;
  const measure=String(item?.tyreMeasure||match?.[2]||'').replace(/\s+/g,' ').toUpperCase();
  return quantity>0?{quantity,measure}:null;
 }
 function historyFacts(history,existing=[]){
  const liveCounts=new Map();
  for(const item of Array.isArray(existing)?existing:[]){
   if(!item?.plate)continue;
   const key=workKey(item);
   liveCounts.set(key,(liveCounts.get(key)||0)+1);
  }
  const seen=new Set();
  const facts=[];
  for(const item of Array.isArray(history)?history:[]){
   if(!item||!validPlate(item.plate)||!String(item.work||'').trim()||!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date||'')))continue;
   const amount=Number(item.amount);
   if(!Number.isFinite(amount)||amount<0)continue;
   const key=historyKey(item);
   if(seen.has(key))continue;
   seen.add(key);
   const matching=workKey(item),remaining=liveCounts.get(matching)||0;
   if(remaining){liveCounts.set(matching,remaining-1);continue;}
   facts.push({key,date:item.date,customer:String(item.customer||'').trim(),plate:String(item.plate||'').trim().toUpperCase(),work:String(item.work).trim(),amount:Math.round(amount*100)/100,tyre:tyreInfo(item),source:'import'});
  }
  return facts;
 }
 function table(data,names,hasHeader){
  data=data.filter(row=>row.some(v=>String(v??'').trim()));
  if(!data.length)throw Error('Incolla almeno una riga di dati.');
  const width=Math.max(...data.map(r=>r.length));
  if(width<2)throw Error('È stata letta una sola colonna. Copia le celle direttamente da Excel / Google Fogli, oppure usa un file CSV con separatore punto e virgola.');
  if(hasHeader===undefined)hasHeader=data[0].filter(v=>names.includes(normalize(v))).length>=2;
  const body=hasHeader?data.slice(1):data;
  if(!body.length)throw Error('Sono presenti solo intestazioni: aggiungi almeno una riga di dati.');
  if(body.length>10000)throw Error('Massimo 10.000 righe per importazione.');
  return {hasHeader,body,headers:Array.from({length:width},(_,i)=>hasHeader?String(data[0][i]||'Colonna '+(i+1)):'Colonna '+(i+1)),samples:Array.from({length:width},(_,i)=>body.slice(0,20).map(r=>String(r[i]??'').trim()).find(Boolean)||'(vuota)')};
 }
 return {parse,normalize,number,date,convert,table,validPlate,plateKey,workKey,historyKey,tyreInfo,historyFacts};
});
