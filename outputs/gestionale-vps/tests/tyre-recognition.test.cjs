const assert = require('node:assert/strict');
const {test} = require('node:test');
const T = require('../tyre-recognition.js');
const item = (id, category, product = '155/65/14 75T FALKEN') => ({id, detail:T.stockDetails(product, category)});
const variants = [item('summer', 'Pneumatici estivi'), item('winter', 'Pneumatici invernali'), item('all', 'Pneumatici quattro stagioni')];

test('commercial tyres preserve both load indexes, optional speed code and explicit season', () => {
  for (const [stock, work, load, speed] of [
    ['vann11 195/75/16 110/108 FALKEN', '4 195/75/16 110/108 FALKEN AS', '110/108', ''],
    ['195/75/16 107/105T sumitomo', '2 gomme 195/75 R16 107 / 105 T SUMITOMO AS', '107/105', 'T'],
    ['195/75R16C 110/108R FALKEN', '4 195/75/16 C 110/108R FALKEN 4S', '110/108', 'R']
  ]) {
    const candidate = {detail:T.stockDetails(stock, 'Pneumatici quattro stagioni')};
    const detail = T.workDetails(work);
    assert.equal(detail?.loadIndex, load, work);
    assert.equal(detail?.speedCode, speed, work);
    assert.equal(detail?.season, 'all-season');
    assert.equal(T.resolve(detail, [candidate]).item, candidate);
  }
  assert.equal(T.workDetails('4 195/75/16 110/108 FALKEN').season, 'summer');
  assert.equal(T.workDetails('195/75/16 110/108 FALKEN AS'), null, 'load index is never a quantity');
  assert.equal(T.workDetails('4 195/75/16 110 FALKEN'), null, 'single index without speed remains invalid');
  assert.equal(T.workDetails('4 195/75/16 110/108/107 FALKEN'), null, 'do not accept partial malformed indexes');
  for (const invalid of ['4 2195/75/16 110/108 FALKEN', '4 195/75/16 110/108.5 FALKEN', '4 195/75/16 110/108,5 FALKEN']) {
    assert.equal(T.workDetails(invalid), null, 'malformed dimensions and fractional load indexes must not be truncated: ' + invalid);
  }
});

test('commercial match requires entire load pair, brand and season; omitted speed must be unambiguous', () => {
  const candidate = product => ({detail:T.stockDetails(product, 'Pneumatici estivi')});
  const noSpeed = T.workDetails('4 195/75/16 110/108 FALKEN');
  const known = candidate('195/75/16 110/108T FALKEN');
  assert.equal(T.resolve(noSpeed, [known]).item, known);
  for (const wrong of ['195/75/16 110/107T FALKEN', '195/75/16 108/110T FALKEN', '195/75/16 110T FALKEN', '195/75/16 110/108T SUMITOMO']) {
    assert.equal(T.resolve(noSpeed, [candidate(wrong)]).item, null, wrong);
  }
  assert.equal(T.resolve(noSpeed, [known, candidate('195/75/16 110/108R FALKEN')]).reason, 'ambiguous');
  assert.equal(T.resolve(noSpeed, [known, candidate('195/75/16 110/108 FALKEN')]).reason, 'ambiguous');
  assert.equal(T.resolve(T.workDetails('4 195/75/16 110/108R FALKEN'), [known]).item, null);
  assert.equal(T.resolve(T.workDetails('4 195/75/16 110/108 FALKEN AS'), [known]).item, null);
});
test('model codes match as exact text independently of the unchanged technical and brand fields', () => {
  const candidate = product => item(product, 'Pneumatici estivi', product);
  const as210 = candidate('AS210 155/65/14 75T FALKEN');
  const as220 = candidate('155/65/14 75T FALKEN AS220');
  const workBefore = T.workDetails('2 AS210 155/65/14 75T FALKEN');
  const workAfter = T.workDetails('2 155/65/14 75T FALKEN AS210');
  assert.equal(workBefore?.quantity, 2, 'a model before the measure does not hide the tyre count');
  assert.equal(workBefore?.modelTokens.includes('as210'), true);
  assert.equal(workBefore?.brand, 'falken');
  assert.equal(workBefore?.measure, '155/65/14');
  assert.equal(workBefore?.loadIndex, '75');
  assert.equal(workBefore?.speedCode, 'T');
  assert.equal(T.sameTechnical(workBefore, as220.detail), true, 'technical comparison remains independent of model text');
  assert.equal(T.resolve(workBefore, [as220, as210]).item, as210);
  assert.equal(T.resolve(workAfter, [as220, as210]).item, as210);
  assert.equal(T.resolve(workBefore, [candidate('155/65/14 75T FALKEN AS210A')]).reason, 'missing-model', 'model codes are whole tokens, not substrings');

  const fexm = candidate('175/65/14 82T FALKEN FEXM');
  const fexn = candidate('FEXN 175/65/14 82T FALKEN');
  const fexmWork = T.workDetails('3 FEXM 175/65/14 82T FALKEN');
  assert.equal(fexmWork?.quantity, 3);
  assert.equal(fexmWork?.modelTokens.includes('fexm'), true, 'letter-only model names are recognized too');
  assert.equal(T.resolve(fexmWork, [fexn, fexm]).item, fexm);
  const ziex310 = candidate('195/50/15 82V FALKEN Ziex 310');
  const ziex320 = candidate('195/50/15 82V FALKEN Ziex 320');
  const ziexWork = T.workDetails('1 195/50/15 82V FALKEN ziex 320');
  assert.deepEqual(ziexWork?.modelTokens, ['ziex', '320'], 'separate model numbers remain part of the full model text');
  assert.equal(T.resolve(ziexWork, [ziex310, ziex320]).item, ziex320);
  assert.equal(T.resolve(T.workDetails('1 Ziex 310 195/50/15 82V FALKEN'), [ziex310, ziex320]).item, ziex310);
  assert.equal(T.resolve(T.workDetails('2 155/65/14 75T FALKEN'), [as210]).item, as210, 'legacy descriptions without a model still match as before');
});
test('season aliases, singular adjectives and season before brand retain tyre identity and count', () => {
  for (const [text, season] of [
    ['4 155/65/14 75T FALKEN 4 stagioni', 'all-season'],
    ['montaggio 4 gomme quattro stagioni 155/65 R14 75T FALKEN', 'all-season'],
    ['4 155/65/14 75T all-season FALKEN XL M+S', 'all-season'],
    ['4 155/65/14 75T all season FALKEN', 'all-season'],
    ['4 pneumatici estivi 155/65/14 75T FALKEN', 'summer'],
    ['4 155/65/14 75T estivo FALKEN', 'summer'],
    ['4 155/65/14 75T invernale FALKEN', 'winter'],
    ['4 155/65/14 75T FALKEN invernali', 'winter']
  ]) {
    const detail = T.workDetails(text);
    assert.equal(detail.quantity, 4, text); assert.equal(detail.brand, 'falken', text);
    assert.equal(detail.season, season, text);
    assert.equal(T.resolve(detail, variants).item.detail.season, season, text);
  }
});
test('explicit season cannot fall back to another category, unknown legacy category or duplicate rows', () => {
  const all = T.workDetails('4 155/65/14 75T FALKEN 4 stagioni');
  assert.equal(T.resolve(all, variants.slice(0,2)).reason, 'missing-season');
  assert.equal(T.resolve(all, []).reason, 'missing-season', 'an absent tyre still explains its declared season');
  assert.equal(T.resolve(all, [item('unknown', 'Pneumatici')]).item, null);
  assert.equal(T.resolve(all, [variants[2], {...variants[2], id:'duplicate'}]).reason, 'ambiguous');
});
test('all-season abbreviations are bounded, case insensitive and supply no tyre quantity', () => {
  for (const alias of ['AS', 'as', 'A/S', 'a / s', '4S', '4s', '4 S', 'quattro st.', 'quattro ST', '4 st.', '4st', '4 stag.']) {
    for (const text of ['2 gomme '+alias+' 155/65/14 75T FALKEN', '2 155/65/14 75T '+alias+' FALKEN', '2 155/65/14 75T FALKEN '+alias]) {
      const detail = T.workDetails(text);
      assert.equal(detail?.quantity, 2, text);
      assert.equal(detail?.brand, 'falken', text);
      assert.equal(detail?.season, 'all-season', text);
      assert.equal(T.resolve(detail, variants).item.id, 'all', text);
    }
    assert.equal(T.workDetails(alias+' 155/65/14 75T FALKEN'), null, alias+' must not supply a quantity');
    assert.equal(T.stockDetails('155/65/14 75T FALKEN '+alias).season, 'all-season', alias+' in stock product');
    assert.equal(T.stockDetails('155/65/14 75T FALKEN', 'Pneumatici '+alias).season, 'all-season', alias+' in category');
  }
  for (const text of ['basta', 'cassa', 'ASSET', '4SPORT', 'quattro stelle', '4 stock', 'FALKEN AS200']) {
    assert.equal(T.seasonInfo(text).season, '', text+' is not an abbreviation');
  }
});
test('omitted season defaults to summer without choosing winter, all-season or unclassified stock', () => {
  const generic = T.workDetails('4 155/65/14 75T FALKEN');
  assert.equal(generic.season, 'summer');
  assert.equal(generic.seasonExplicit, false);
  assert.equal(T.resolve(generic, variants).item.id, 'summer');
  assert.equal(T.resolve(generic, [variants[0]]).item.id, 'summer');
  for (const candidates of [[variants[1]], [variants[2]], [item('legacy', 'Pneumatici')], []]) {
    assert.equal(T.resolve(generic, candidates).item, null);
    assert.equal(T.resolve(generic, candidates).reason, 'missing-season');
  }
  assert.equal(T.resolve(generic, [variants[0], {...variants[0], id:'duplicate-summer'}]).reason, 'ambiguous');
  assert.equal(T.workDetails('4 155/65/14 75T FALKEN AS').seasonExplicit, true);
});
test('stock category identifies season and contradictions fail; technical markings do not imply winter', () => {
  const contradictory = item('incorrect', 'Pneumatici estivi', '155/65/14 75T FALKEN invernali');
  assert.equal(contradictory.detail.conflictingSeasons, true);
  assert.equal(T.resolve(T.workDetails('4 155/65/14 75T FALKEN estivi'), [contradictory]).item, null);
  assert.equal(T.stockDetails('155/65/14 75T FALKEN all-season', 'Pneumatici').season, 'all-season');
  assert.equal(T.workDetails('4 155/65/14 75T FALKEN M+S 3PMSF').season, 'summer');
  assert.equal(T.workDetails('4 155/65/14 75T FALKEN M+S 3PMSF').seasonExplicit, false);
  assert.equal(T.resolve(T.workDetails('4 155/65/14 75T FALKEN estivi 4 stagioni'), variants).reason, 'conflicting-seasons');
  assert.equal(T.workDetails('4 stagioni 155/65/14 75T FALKEN'), null, 'season alone supplies no quantity');
  assert.equal(T.workDetails('4 155/65/14 82T FALKEN').loadIndex, '82');
  assert.equal(T.resolve(T.workDetails('4 155/65/14 82T FALKEN'), variants).item, null);
});
