const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../officina-fatturazione.html'),'utf8');
const source=html.match(/function parseAmount\(value\)\{[\s\S]*?^\}/m)?.[0];
assert.ok(source,'the shared amount parser is present');
const parse=vm.runInNewContext(source+';parseAmount');

test('saved numeric amounts keep their decimal places and sign',()=>{
  for(const value of [100.75,1234.56,-10.25,0])assert.equal(parse(value),value);
});
test('displayed amounts and decimal inputs parse consistently',()=>{
  for(const [value,expected] of [
    ['100.75',100.75],['100,75',100.75],['€ 100,75',100.75],
    ['1.234,56 €',1234.56],['1234.56',1234.56],['1,234.56',1234.56],
    ['€ 1.000',1000],['12.345.678,90',12345678.9],['-10,25',-10.25],['€ -1.234,56',-1234.56]
  ])assert.equal(parse(value),expected,value);
});
test('missing or nonfinite amounts do not introduce invalid report values',()=>{
  for(const value of ['',null,undefined,NaN,Infinity,'—','not an amount'])assert.equal(parse(value),0,String(value));
});
