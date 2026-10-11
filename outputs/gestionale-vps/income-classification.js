(function(root){
  const revisions=typeof module!=='undefined'&&module.exports?require('./revision-schedule.js'):root.WorkshopRevisionSchedule;
  function isServiceWork(value){
    if(/\btagliand[oi]\b|\bfiltr[oi]\s+(?:(?:dell?[ao]?|di)\s*['’]?\s*)?(?:aria|abitacolo|anti[\s-]*polline|olio|carburante|diesel|benzina)\b/.test(value))return true;
    const hasOil=/\bolio\b/.test(value);
    const hasLitres=/\b\d+(?:[.,]\d+)?\s*(?:litro|litri|lt|l)\b/.test(value);
    const hasOilGrade=/\b(?:\d{1,2}\s*w\s*[-/]?\s*\d{2,3}|\d{1,2}\s*-\s*\d{2,3}|sae\s*\d{1,3})(?:\s*[-/]?\s*ll(?:iv|-\d+|\d+)?)?\b/.test(value);
    const hasOilType=hasOilGrade||/\b(?:semi[\s-]*sintetic[oa]|sintetic[oa]|minerale)\b/.test(value);
    return hasLitres&&(hasOilGrade||(hasOil&&hasOilType));
  }
  function classify(text){
    const value=String(text||'').toLowerCase().replace(/(\d+(?:[.,]\d+)?\s*(?:litro|litri|lt|kg|ml|l))(?=\d)/g,'$1 ');
    if(revisions.isRevision(value))return 'revisioni';
    if(isServiceWork(value))return 'tagliandi';
    if(/car\s*rent|noleggio|rent/.test(value))return 'carRent';
    if(/pneumatic|gomma|convergenza|\bconv\.?\b|equilibratura|montagg|riparazion\w*|\brip\.?\b|\brip\.?\s*int(?:erna)?\.?|sensor[ei]|\bvalvol[ae]\b|\bcurv\w*|\bprolung\w*|\b\d+\s+\d{3}\/\d{2}/.test(value))return 'pneumatici';
    return 'meccanica';
  }
  if(typeof module!=='undefined'&&module.exports)module.exports=classify;else root.classifyIncomeDepartment=classify;
})(typeof window!=='undefined'?window:globalThis);
