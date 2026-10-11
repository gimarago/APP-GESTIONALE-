(function(root){
  'use strict';
  async function createSheet(data,declaration,library=root.PDFLib){
    if(!library)throw new Error('Libreria PDF non disponibile. Ricarica la pagina.');
    const doc=await library.PDFDocument.create();
    const font=await doc.embedFont(library.StandardFonts.Helvetica);
    const bold=await doc.embedFont(library.StandardFonts.HelveticaBold);
    let page,y;
    const text=v=>Array.from(String(v??'').normalize('NFC')).map(c=>{try{font.encodeText(c);return c;}catch{return '?';}}).join('');
    const newPage=()=>{page=doc.addPage([595.28,841.89]);y=795;};
    const ensure=h=>{if(y-h<45)newPage();};
    const draw=(v,x,yy,size=10,f=font)=>page.drawText(text(v),{x,y:yy,size,font:f});
    const wrap=(v,width,size=10,f=font)=>{
      const result=[];let line='';
      for(const c of text(v)){if(c==='\n'){result.push(line);line='';continue;}if(f.widthOfTextAtSize(line+c,size)>width){const split=line.lastIndexOf(' ');if(split>0){result.push(line.slice(0,split));line=line.slice(split+1);}else{result.push(line);line='';}}line+=c;}
      result.push(line);return result;
    };
    const paragraph=(v,size=10,f=font)=>{for(const line of wrap(v,505,size,f)){ensure(size+5);draw(line,45,y,size,f);y-=size+5;}};
    newPage();
    let logo;
    if(data.logo){
      if(/^data:image\/png;base64,/.test(data.logo))logo=await doc.embedPng(data.logo);
      else if(/^data:image\/jpe?g;base64,/.test(data.logo))logo=await doc.embedJpg(data.logo);
      else if(/^data:image\//.test(data.logo)&&root.document){
        const img=new Image();img.src=data.logo;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext('2d').drawImage(img,0,0);logo=await doc.embedPng(canvas.toDataURL('image/png'));
      }
    }
    if(logo){const size=logo.scaleToFit(65,65);page.drawImage(logo,{x:45,y:y-60,width:size.width,height:size.height});}
    const left=logo?125:45;
    for(const line of wrap(data.shop||'Officina',550-left,18,bold)){draw(line,left,y-10,18,bold);y-=22;}
    draw(data.title||'Scheda di accettazione',left,y-15,12);y-=65;
    const fields=Object.entries(data.fields||{}).filter(([key])=>!['Stato','Fine prevista'].includes(key));
    for(let i=0;i<fields.length;i+=2){
      const pair=fields.slice(i,i+2).map(([key,value])=>({key,rows:wrap(value||'____________________',235)}));
      const height=22+Math.max(...pair.map(v=>v.rows.length))*14;ensure(height);
      pair.forEach((v,j)=>{draw(v.key,45+j*260,y,9,bold);v.rows.forEach((line,k)=>draw(line,45+j*260,y-15-k*14));});y-=height;
    }
    y-=8;
    const row=(description,amount,header=false)=>{
      const rows=wrap(description,390,10,header?bold:font);
      for(let offset=0;offset<rows.length;offset+=40){const part=rows.slice(offset,offset+40),height=Math.max(26,part.length*14+12);ensure(height);page.drawRectangle({x:45,y:y-height,width:505,height,borderWidth:.5,borderColor:library.rgb(.6,.6,.6)});page.drawLine({start:{x:455,y},end:{x:455,y:y-height},thickness:.5,color:library.rgb(.6,.6,.6)});part.forEach((line,k)=>draw(line,51,y-17-k*14,10,header?bold:font));if(offset===0)draw(amount,462,y-17,10,header?bold:font);y-=height;}
    };
    row('Lavorazioni richieste / da svolgere','Importo (€)',true);
    const money=n=>Number(n||0).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2});
    for(const line of data.lines||[])row(line.description,money(line.amount));
    for(let i=0;i<5;i++)row('','');
    y-=20;paragraph('Totale lavori indicati: € '+money((data.lines||[]).reduce((s,l)=>s+Math.round(Number(l.amount||0)*100),0)/100),11,bold);
    y-=10;paragraph('Le righe aggiunte a mano devono essere concordate con il cliente. La stampa non salva la scheda nel gestionale.',8);
    ensure(190);y-=12;paragraph('Dichiarazione su custodia, responsabilità e riconsegna',10,bold);paragraph(declaration,8);
    ensure(55);y-=30;
    ['Data e firma del cliente per presa visione','Firma del cliente al ritiro'].forEach((label,i)=>{const x=45+i*260;page.drawLine({start:{x,y},end:{x:x+245,y},thickness:.5});draw(label,x,y-14,8);});
    return doc.save();
  }
  if(typeof module!=='undefined'&&module.exports)module.exports=createSheet;else root.WorkshopSheetPDF=createSheet;
})(typeof window!=='undefined'?window:globalThis);
