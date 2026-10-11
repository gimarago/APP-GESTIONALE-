(function(root){
 'use strict';
 async function create(q,shop={},lib=root.PDFLib){
  const doc=await lib.PDFDocument.create(),font=await doc.embedFont(lib.StandardFonts.Helvetica),bold=await doc.embedFont(lib.StandardFonts.HelveticaBold),green=lib.rgb(.25,.34,.16),line=lib.rgb(.8,.77,.65);
  let logo=null;
  if(shop.logo){
   try{
    if(/^data:image\/png;base64,/i.test(shop.logo))logo=await doc.embedPng(shop.logo);
    else if(/^data:image\/jpe?g;base64,/i.test(shop.logo))logo=await doc.embedJpg(shop.logo);
    else if(/^data:image\/(svg\+xml|webp)[;,]/i.test(shop.logo)&&root.document){
     const img=new root.Image();img.src=shop.logo;await img.decode();
     const scale=Math.min(1,1200/Math.max(img.naturalWidth,img.naturalHeight));
     const canvas=root.document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);logo=await doc.embedPng(canvas.toDataURL('image/png'));
    }else throw Error('Formato non supportato');
   }catch{throw Error('Impossibile inserire il logo nel PDF. Caricalo nuovamente nelle Impostazioni in formato PNG o JPG.');}
  }
  const clean=v=>Array.from(String(v??'')).map(c=>{if(c==='\n')return c;try{font.encodeText(c);return c;}catch{return '?';}}).join('');
  const wrap=(value,width,size=10)=>{let out=[],s='';for(const c of clean(value)){if(c==='\n'){out.push(s);s='';continue;}if(font.widthOfTextAtSize(s+c,size)>width){out.push(s);s='';}s+=c;}out.push(s);return out;};
  let page,y;const draw=(v,x,yy,size=10,f=font,color=lib.rgb(.12,.14,.12))=>page.drawText(clean(v),{x,y:yy,size,font:f,color});
  const rule=()=>page.drawLine({start:{x:40,y},end:{x:555,y},thickness:.6,color:line});
  const fresh=()=>{page=doc.addPage([595.28,841.89]);y=795;draw('PREVENTIVO',40,y,23,bold,green);if(logo){const size=logo.scaleToFit(110,65);page.drawImage(logo,{x:555-size.width,y:810-size.height,width:size.width,height:size.height});draw(q.date.split('-').reverse().join('/'),40,y-23,11);y-=65;}else{draw(q.date.split('-').reverse().join('/'),455,y,11);y-=32;}rule();y-=24;};
  const ensure=h=>{if(y-h<65)fresh();};
  const paragraph=(v,size=10,f=font)=>{for(const s of wrap(v,515,size)){ensure(size+6);draw(s,40,y,size,f);y-=size+6;}};
  fresh();paragraph(shop.name||'Officina',16,bold);
  if(shop.address?.trim())paragraph('Sede legale: '+shop.address.trim());
  if(shop.operatingAddress?.trim())paragraph('Sede operativa: '+shop.operatingAddress.trim());
  if(shop.vat)paragraph('P.IVA / C.F.: '+shop.vat);if(shop.email||shop.phone)paragraph([shop.email,shop.phone].filter(Boolean).join(' - '));
  y-=22;paragraph('CLIENTE',10,bold);rule();y-=18;paragraph(q.customer,13,bold);if(q.vehicle)paragraph('Veicolo / targa: '+q.vehicle);if(q.validUntil)paragraph('Valido fino al: '+q.validUntil.split('-').reverse().join('/'));y-=25;
  const xs=[40,310,363,425,495],widths=[270,53,62,70,60];
  function row(values,heading=false){const rows=values.map((v,i)=>wrap(v,widths[i]-12,heading?8:9));let offset=0;const count=Math.max(...rows.map(v=>v.length));while(offset<count){const length=Math.min(35,count-offset),height=length*13+16;ensure(height);page.drawRectangle({x:40,y:y-height,width:515,height,borderWidth:.6,borderColor:line});rows.forEach((lines,i)=>{lines.slice(offset,offset+length).forEach((s,j)=>draw(s,xs[i]+6,y-15-j*13,heading?8:9,heading?bold:font));if(i)page.drawLine({start:{x:xs[i],y},end:{x:xs[i],y:y-height},thickness:.4,color:line});});y-=height;offset+=length;}}
  const money=n=>Number(n).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
  row(['DESCRIZIONE','QUANTITÀ','PREZZO €','SUBTOTALE €','IVA'],true);
  let gross=0;const vat=Number(q.vat??22);
  for(const l of q.lines){const total=Math.round(l.quantity*l.price*100)/100;gross+=total;row([l.description,String(l.quantity),money(l.price/(1+vat/100)),money(total/(1+vat/100)),vat+'%']);}
  gross=Math.round(gross*100)/100;const net=Math.round(gross/(1+vat/100)*100)/100;
  ensure(125);y-=30;for(const [label,value] of [['Imponibile',net],['IVA '+vat+'%',gross-net],['Totale IVA inclusa',gross]]){draw(label,310,y,11,bold,green);draw(money(value)+' €',465,y,11,bold,green);y-=24;}
  if(q.notes){y-=12;paragraph('NOTE',10,bold);paragraph(q.notes);}
  for(const [i,p] of doc.getPages().entries()){p.drawLine({start:{x:40,y:44},end:{x:555,y:44},thickness:.6,color:line});p.drawText('Preventivo - '+(i+1)+' / '+doc.getPageCount(),{x:40,y:28,font,size:8,color:green});}
  return doc.save();
 }
 if(typeof module!=='undefined'&&module.exports)module.exports=create;else root.WorkshopQuotePDF=create;
})(typeof window!=='undefined'?window:globalThis);
