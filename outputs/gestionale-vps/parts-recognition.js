(function(root){
  'use strict';
  // Categories and nominal lengths checked against Bosch and OSRAM catalogues.
  // Recognition identifies inventory entries, not compatibility with a vehicle.
  const bulb=/\b(?:h(?:[1-9]|1[0-9]|2[017])|hb[1-5]a?|hir[12]|d[1-8][sr]|(?:py?|wy?|ry?|hy?)\d+(?:\s*\/\s*\d+)?w|c(?:5|10|21)w|t4w)\b/gi;
  const normal=v=>String(v||'').toLowerCase().replace(/\bbosh\b/g,'bosch').replace(/\b(h|hb|hir|d)\s+(\d)/g,'$1$2');
  const types=v=>[...normal(v).matchAll(bulb)].map(m=>m[0].replace(/\s/g,''));
  function kind(v){const t=normal(v);if(/\bbatteri[ae]\b|\bbatter(?:y|ies)\b|\baccumulator[ei]\b/.test(t))return 'battery';if(/tergi|spazzol|wiper/.test(t))return 'wiper';if(/lampad|bulb/.test(t)||types(t).length)return 'bulb';return '';}
  function tokens(v,k){const t=normal(v),out=[];
    if(k==='battery'){
      for(const m of t.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(ah|v|a)(?![a-z])/g))out.push(m[2]+':'+Number(m[1].replace(',','.')));
      for(const tech of ['agm','efb','gel','lifepo4'])if(new RegExp('\\b'+tech+'\\b').test(t))out.push('tech:'+tech);
      if(/\bsli\b|\bclassica\b|\bflooded\b|piombo[ -]acido|\btradizional|\bstandard\b|\bconvenzional/.test(t))out.push('tech:flooded');
      if(/li[ -]?ion|\blitio\b/.test(t)&&!out.includes('tech:lifepo4'))out.push('tech:lithium');
      if(!out.some(token=>token.startsWith('tech:')))out.push('tech:flooded');
      for(const m of t.matchAll(/\b(?:cod(?:ice)?\.?|modello|sku)\s*[:=]?\s*([a-z0-9-]+)/g))out.push('code:'+m[1]);
      for(const m of t.matchAll(/\b(\d{3})\s*[x×]\s*(\d{3})\s*[x×]\s*(\d{3})\b/g))out.push('size:'+m.slice(1).join('x'));
      if(/(?:positivo|polo|polarita|polarità)\s*(?:a\s*)?(?:dx|destra)/.test(t))out.push('pole:right');
      if(/(?:positivo|polo|polarita|polarità)\s*(?:a\s*)?(?:sx|sinistra)/.test(t))out.push('pole:left');
    }
    if(k==='bulb'){out.push(...types(t));for(const m of t.matchAll(/\b(12|24)\s*v\b/g))out.push(m[1]+'v');if(/\bled\b/.test(t))out.push('led');}
    if(k==='wiper'){
      for(const m of t.matchAll(/\b(\d{2,3})\s*(mm|cm|pollici|inch|inches|["″])?(?!\w)/g)){let n=Number(m[1]);if(m[2]==='cm')n*=10;else if(m[2]&&m[2]!=='mm'){const inches={10:250,11:280,12:300,13:325,14:350,15:380,16:400,17:425,18:450,19:475,20:500,21:530,22:550,23:575,24:600,25:625,26:650,27:675,28:700,30:750,32:800};n=inches[n]||0;}else if(!m[2]&&n>=20&&n<=80)n*=10;if(n>=200&&n<=1000)out.push(n+'mm');}
      for(const word of ['posteriore','anteriore','flat','aerotwin','universale'])if(t.includes(word))out.push(word);
    }
    // Brand is a required matching token, including common spelling variants.
    const brands=[['points',/\bpoint[\s-]*s\b/],['omnicraft',/\bomni[\s-]*craft\b/],...['bosch','valeo','osram','philips','denso','champion','varta','exide','fiamm','yuasa','tudor','banner','fulmen','magneti marelli'].map(b=>[b,new RegExp('\\b'+b+'\\b')])];
    for(const [brand,pattern] of brands)if(pattern.test(t))out.push('brand:'+brand);
    return [...new Set(out)];
  }
  function quantity(v,k){const t=normal(v);if(k==='battery'&&/\b(?:test|controllo|diagnosi|ricarica|ricaricare|verifica|smaltimento)\b/.test(t)&&! /sostituzion|vendita|montaggio|installazion/.test(t))return null;const matches=[...t.matchAll(/\b(\d+)\s*(?:pz|pezzi|pezzo|batteri[ae]|battery|accumulator[ei]|lampadin\w*|lampad\w*|tergicristall\w*|tergi\b|spazzol\w*|wiper\w*)/g)];if(matches.length===1)return Number(matches[0][1])>0?{quantity:Number(matches[0][1]),unit:'pz'}:null;
    const prefix=t.match(/(?:^|\s)(\d+)\s*[x×]\s*/);if(prefix)return Number(prefix[1])>0?{quantity:Number(prefix[1]),unit:'pz'}:null;
    if(/\bcoppia\b/.test(t))return {quantity:2,unit:'pz'};
    if(matches.length>1)return null;
    if(k==='battery')return tokens(t,k).some(x=>x.startsWith('ah:')||x.startsWith('code:'))?{quantity:1,unit:'pz'}:null;
    const ids=tokens(t,k).filter(x=>k==='wiper'?/mm$/.test(x):types(x).length);
    return ids.length===1?{quantity:1,unit:'pz'}:null;
  }
  const api={kind,tokens,quantity};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WorkshopParts=api;
})(typeof window!=='undefined'?window:globalThis);
