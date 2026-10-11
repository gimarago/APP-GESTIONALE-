(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkshopQuoteSharing=api;})(typeof globalThis!=='undefined'?globalThis:this,()=>{
 'use strict';
 const money=n=>Number(n).toLocaleString('it-IT',{style:'currency',currency:'EUR'});
 function message(q){return ['Preventivo del '+q.date.split('-').reverse().join('/'),'Cliente: '+q.customer,q.vehicle?'Veicolo: '+q.vehicle:'','',...q.lines.map(l=>l.description+' — '+l.quantity+' × '+money(l.price)+' = '+money(l.quantity*l.price)),'','Totale IVA inclusa: '+money(Math.round(q.lines.reduce((n,l)=>n+l.quantity*l.price,0)*100)/100),q.notes?'Note: '+q.notes:''].filter((v,i,a)=>v!==''||a[i-1]!=='').join('\n').trim();}
 function email(address,subject,body){address=address.trim();if(!/^[^\s@<>?,;:]+@[^\s@<>?,;:]+\.[^\s@<>?,;:]+$/.test(address))throw Error('Inserisci un indirizzo email valido.');return 'mailto:'+encodeURIComponent(address)+'?subject='+encodeURIComponent(subject)+'&body='+encodeURIComponent(body);}
 function phone(value){let n=value.trim().replace(/[\s().-]/g,'');if(n.startsWith('00'))n='+'+n.slice(2);if(!/^\+[1-9]\d{6,14}$/.test(n))throw Error('Inserisci il numero con prefisso internazionale, ad esempio +39 333 1234567.');return n.slice(1);}
 function whatsapp(number,body){return 'https://wa.me/'+phone(number)+'?text='+encodeURIComponent(body);}
 function compose(provider,sender,to,subject,body){email(to,subject,body);const url=new URL(provider==='outlook'?'https://outlook.live.com/mail/0/deeplink/compose':'https://mail.google.com/mail/');url.search=new URLSearchParams(provider==='outlook'?{to,subject,body}:{view:'cm',fs:'1',authuser:sender||'',to,su:subject,body});return url.href;}
 return {message,email,phone,whatsapp,compose};
});
