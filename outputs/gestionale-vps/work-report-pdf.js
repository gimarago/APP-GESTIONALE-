(function(root){
 'use strict';
 const money=value=>Number(value).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
 const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?value.split('-').reverse().join('/'):String(value||'');
 async function create(report,seller={},lib=root.PDFLib){
  if(!lib?.PDFDocument||!root.WorkshopWorkReports?.validateReport)throw Error('Generatore PDF non disponibile. Ricarica l’app.');
  root.WorkshopWorkReports.validateReport(report);
  const pdf=await lib.PDFDocument.create(),font=await pdf.embedFont(lib.StandardFonts.Helvetica),bold=await pdf.embedFont(lib.StandardFonts.HelveticaBold),ink=lib.rgb(.12,.17,.19),muted=lib.rgb(.38,.44,.45),accent=lib.rgb(.13,.38,.36),line=lib.rgb(.78,.84,.83),pale=lib.rgb(.94,.96,.96);
  const left=40,right=555.28,width=right-left,bottom=64,number=root.WorkshopWorkReports.reportNumber(report);
  const clean=value=>Array.from(String(value??'').replace(/\r\n?/g,'\n').replace(/[\t\0-\x08\x0b\x0c\x0e-\x1f]/g,' ')).map(character=>{if(character==='\n')return character;try{font.encodeText(character);return character;}catch{return '?';}}).join('');
  function wrap(value,max,size=9,face=font){const result=[];for(const paragraph of clean(value).split('\n')){if(!paragraph){result.push('');continue;}let current='';for(const word of paragraph.split(/\s+/)){const candidate=current?current+' '+word:word;if(face.widthOfTextAtSize(candidate,size)<=max){current=candidate;continue;}if(current){result.push(current);current='';}for(const char of word){if(current&&face.widthOfTextAtSize(current+char,size)>max){result.push(current);current='';}current+=char;}}result.push(current);}return result;}
  let page,y,pages=[];
  const draw=(value,x,baseline,size=9,face=font,color=ink)=>page.drawText(clean(value),{x,y:baseline,size,font:face,color});
  function newPage(first=false){page=pdf.addPage([595.28,841.89]);pages.push(page);y=797;if(first){draw(seller.name||'Officina',left,y,12,bold,accent);y-=17;if(seller.address)for(const text of wrap(seller.address,width,9)) {draw(text,left,y,9,font,muted);y-=13;}if(seller.vat){draw('P. IVA '+seller.vat,left,y,9,font,muted);y-=13;}y-=8;draw('Rapporto di intervento '+number,left,y,19,bold,accent);y-=24;draw(String(report.customer),left,y,12,bold);y-=18;draw('Periodo: '+date(report.period.start)+' – '+date(report.period.end),left,y,9);draw('Data rapporto: '+date(report.date),left+285,y,9);y-=22;}else{draw('Rapporto di intervento '+number+' · '+report.customer,left,y,9,bold,accent);y-=18;}}
  const columns=[left,left+70,left+195,left+450],widths=[70,125,255,65];
  function tableHeader(){const labels=['DATA','VEICOLO / TARGA','LAVORAZIONI','IMPORTO'];const height=25;page.drawRectangle({x:left,y:y-height,width,height,color:pale});labels.forEach((label,index)=>draw(label,columns[index]+5,y-16,7,bold,accent));page.drawLine({start:{x:left,y:y-height},end:{x:right,y:y-height},thickness:.6,color:line});y-=height;}
  function startTable(first=false){newPage(first);tableHeader();}
  startTable(true);
  for(const work of report.works){
   const details=[...(work.lines||[]).map(item=>item.description+' · '+money(item.amount)),work.notes?'Note: '+work.notes:''].filter(Boolean).join('\n');
   const vehicle=[work.plate||'—',work.vehicle||''].filter(Boolean).join('\n');
   const lines=[date(work.date),vehicle,details,money(work.amount)].map((value,index)=>wrap(value,widths[index]-10,8,index===3?bold:font));
   const count=Math.max(1,...lines.map(items=>items.length));let offset=0;
   while(offset<count){
    let available=Math.floor((y-bottom-12)/12);
    if(available<1){startTable(false);available=Math.floor((y-bottom-12)/12);}
    const chunk=Math.min(count-offset,available),height=chunk*12+12;
    lines.forEach((items,index)=>items.slice(offset,offset+chunk).forEach((text,row)=>draw(text,columns[index]+5,y-10-row*12,8,index===3?bold:font,index===3?accent:ink)));
    page.drawLine({start:{x:left,y:y-height},end:{x:right,y:y-height},thickness:.5,color:line});y-=height;offset+=chunk;
   }
  }
  if(y-42<bottom)startTable(false);
  y-=15;draw('Interventi inclusi: '+report.works.length,left,y,9,font,muted);draw('TOTALE IVA INCLUSA: '+money(report.total),left+235,y,13,bold,accent);y-=24;
  for(const [index,sheet]of pages.entries()){sheet.drawLine({start:{x:left,y:45},end:{x:right,y:45},thickness:.5,color:line});sheet.drawText('Rapporto di intervento '+number,{x:left,y:30,font,size:8,color:muted});const label=(index+1)+' / '+pages.length;sheet.drawText(label,{x:right-font.widthOfTextAtSize(label,8),y:30,font,size:8,color:muted});}
  pdf.setTitle('Rapporto di intervento '+number);pdf.setAuthor(clean(seller.name||'Officina'));pdf.setSubject('Riepilogo non fiscale degli interventi eseguiti');
  return pdf.save();
 }
 function attachmentName(report){const number=root.WorkshopWorkReports.reportNumber(report);return 'Rapporto-'+number+'.pdf';}
 async function attachment(report,seller={}){const bytes=await create(report,seller);let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return {name:attachmentName(report),base64:btoa(binary)};}
 if(typeof module==='object'&&module.exports)module.exports={create,attachment,attachmentName};else root.WorkshopWorkReportPDF={create,attachment,attachmentName};
})(typeof window!=='undefined'?window:globalThis);
