(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkshopTyreRecognition = api;
})(globalThis, () => {
  'use strict';
  const seasons = [
    ['all-season', /\b(?:(?:4|quattro)\s*(?:stagioni|stag\.?|st\.?)|4\s*s|a\s*\/\s*s|as|all[\s-]*seasons?|4\s*seasons?|four\s*seasons?)(?![a-z0-9])/gi],
    ['summer', /\b(?:estiv[oaie]|summer)\b/gi],
    ['winter', /\b(?:invernal[ei]|winter)\b/gi]
  ];
  // Commercial tyres may have two load indexes and no speed code in the label.
  // Keep the entire pair: 110/108 and 110/107 are different specifications.
  const technical = /(?<![a-z0-9])(\d{3}\s*\/\s*\d{2}(?:\s*R\s*\d{2}(?:[.,]\d)?|\s*\/\s*\d{2}(?:[.,]\d)?|\s+\d{2}(?:[.,]\d)?))\s*C?\s+(\d{2,3})(?:\s*\/\s*(\d{2,3}))?(?:\s*([a-z])\b)?(?![a-z0-9\/])(?![.,]\d)/i;
  const ignored = /^(?:XL|RF|REINFORCED|C|CP|TL|TT|MS|3PMSF|RFT|RUNFLAT|pneumatic[oi]|gomm[ae]|marca|nuov[oaie]|montaggio|montare|montati|sostituzione|fornitura|vendita|installazione|cambio|tipo|di|da|per|con|e)$/i;
  const ignoredModelText = /^(?:modello|pneumatic[oi]|gomm[ae]|marca|nuov[oaie]|montaggio|montare|montati|sostituzione|sostituire|fornitura|vendita|installazione|cambio|tipo|di|da|per|con|e|pz|pezzi|estiv[oaie]|invernal[ei]|summer|winter|all|season|seasons|stagione|stagioni|stag|quattro|anteriore|posterior[ei]|ruot[ae]|lato|sx|dx|inclus[oa]|compres[oa]|xl|rf|reinforced|c|cp|tl|tt|ms|3pmsf|rft|runflat)$/i;
  const clean = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const measure = value => String(value || '').replace(/\s+/g, '').replace(/R/i, '/').replace(/\/+/g, '/').replace(',', '.');
  function seasonInfo(value) {
    const source = clean(value), found = seasons.filter(([, pattern]) => new RegExp(pattern.source, 'i').test(source)).map(([key]) => key);
    return {season:found.length === 1 ? found[0] : '', conflictingSeasons:found.length > 1};
  }
  function withoutSeasons(value) {
    return seasons.reduce((source, [, pattern]) => source.replace(pattern, ' '), clean(value));
  }
  function brand(value) {
    return withoutSeasons(value).replace(/\bM\s*\+\s*S\b/gi, ' ').split(/[·,;]/)[0].split(/\s+/)
      .find(token => /^[a-z][a-z0-9-]*$/i.test(token) && !ignored.test(token))?.toLowerCase() || '';
  }
  function descriptiveTokens(value, tyreBrand) {
    const residual = withoutSeasons(clean(value)).replace(/\bM\s*\+\s*S\b/gi, ' ');
    const brands = new Set(String(tyreBrand || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return (residual.toLowerCase().match(/[a-z0-9]+/g) || []).filter(token =>
      !ignoredModelText.test(token) && !ignored.test(token) && !brands.has(token)
      && (/^[0-9]+$/.test(token) || /[a-z]/.test(token) && (/[0-9]/.test(token) || token.length >= 3))
    );
  }
  function workQuantity(prefix, tyreBrand) {
    const tokens = descriptiveTokens(prefix, tyreBrand);
    const explicitUnit = withoutSeasons(prefix).trim().match(/(?:^|\s)(\d+)\s*(?:pneumatic[oi]|gomm[ae]|pz|pezzi)\s*$/i);
    const index = explicitUnit ? tokens.lastIndexOf(String(Number(explicitUnit[1]))) : /^\d+$/.test(tokens[0] || '') ? 0 : -1;
    const quantity = index >= 0 ? Number(tokens[index]) : 0;
    return quantity > 0 && Number.isSafeInteger(quantity) ? {quantity, index} : null;
  }
  function modelTokens(value, match, tyreBrand, count) {
    const source = clean(value), prefix = source.slice(0, match.index), suffix = source.slice(match.index + match[0].length);
    const before = descriptiveTokens(prefix, tyreBrand);
    if (count) before.splice(count.index, 1);
    return [...before, ...descriptiveTokens(suffix, tyreBrand)];
  }
  function details(value, category, work) {
    const source = clean(value), match = source.match(technical);
    if (!match) return null;
    if (!match[3] && !match[4]) return null;
    const prefix = source.slice(0, match.index), suffix = source.slice(match.index + match[0].length);
    const tyreBrand = brand(suffix) || (!work ? brand(prefix) : '');
    if (!tyreBrand) return null;
    const count = work ? workQuantity(prefix, tyreBrand) : null;
    const models = modelTokens(source, match, tyreBrand, count);
    // Remove season tokens before looking for a count: the 4 in "4S" or "4 st." is not four tyres.
    if (work && !count) return null;
    const declared = seasonInfo(category), product = seasonInfo(source);
    const seasonExplicit = !!(declared.season || product.season);
    const season = declared.season || product.season || (work ? 'summer' : '');
    const conflictingSeasons = declared.conflictingSeasons || product.conflictingSeasons || !!(declared.season && product.season && declared.season !== product.season);
    const tyreMeasure = measure(match[1]), loadIndex = match[2] + (match[3] ? '/' + match[3] : ''), speedCode = (match[4] || '').toUpperCase();
    const technicalKey = [tyreMeasure, loadIndex, speedCode, tyreBrand].join('|');
    return {measure:tyreMeasure, loadIndex, speedCode, brand:tyreBrand, modelTokens:models, season, seasonExplicit, conflictingSeasons,
      technicalKey, key:[technicalKey, season].join('|'), specification:match[1].replace(/\s+/g, ' ') + ' ' + loadIndex + speedCode,
      ...(work ? {quantity:count.quantity} : {})};
  }
  const workDetails = value => details(value, '', true);
  const stockDetails = (value, category = '') => details(value, category, false);
  const sameTechnical = (a, b) => !!a && !!b && a.measure === b.measure && a.loadIndex === b.loadIndex && a.brand === b.brand
    && (!a.speedCode || !b.speedCode || a.speedCode === b.speedCode);
  const sameModelText = (a, b) => a.length === b.length && a.every((token, index) => token === b[index]);
  function resolve(detail, candidates) {
    if (!detail || detail.conflictingSeasons) return {item:null, reason:detail?.conflictingSeasons ? 'conflicting-seasons' : 'invalid'};
    const matching = candidates.filter(item => item.detail && !item.detail.conflictingSeasons && sameTechnical(item.detail, detail));
    let seasonal = detail.season ? matching.filter(item => item.detail.season === detail.season) : matching;
    if (detail.modelTokens?.length) {
      const modelMatches = seasonal.filter(item => sameModelText(item.detail.modelTokens || [], detail.modelTokens));
      if (!modelMatches.length) return {item:null, reason:seasonal.length ? 'missing-model' : detail.season ? 'missing-season' : 'missing'};
      seasonal = modelMatches;
    }
    if (seasonal.length === 1) return {item:seasonal[0], reason:''};
    return {item:null, reason:seasonal.length > 1 ? 'ambiguous' : detail.season ? 'missing-season' : 'missing'};
  }
  const segments = value => String(value || '').split(/[;·]|\+(?!\s*s\b)/i).map(part => part.trim()).filter(Boolean);
  return {seasonInfo, brand, measure, workDetails, stockDetails, sameTechnical, resolve, segments};
});
