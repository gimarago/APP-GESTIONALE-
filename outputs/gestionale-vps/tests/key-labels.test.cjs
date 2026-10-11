const test=require('node:test');
const assert=require('node:assert/strict');
const {buildLabel}=require('../print-sheets.js');

test('the key label contains only pending work and two handwriting lines',()=>{
  const html=buildLabel({shop:'M.A. GOMME SRL',customer:'Mario Rossi',plate:'AB 123 CD',lines:[
    {description:'Cambio gomme',done:true,amount:100},
    {description:'Controllo freni',done:false,amount:25},
    {description:'Revisione',amount:80}
  ]});
  assert.match(html,/M\.A\. GOMME SRL/);
  assert.match(html,/Mario Rossi/);
  assert.match(html,/AB 123 CD/);
  assert.match(html,/Controllo freni/);
  assert.match(html,/Revisione/);
  assert.doesNotMatch(html,/Cambio gomme|100|25|80/);
  assert.equal((html.match(/key-label-extra"><span><\/span><span><\/span>/g)||[]).length,1);
});

test('the key label escapes user data and rejects remote or malformed logos',()=>{
  const html=buildLabel({shop:'<Officina>',logo:'https://example.test/logo.png',customer:'<script>alert(1)</script>',plate:'A&B',lines:[{description:'"Controllo" <motore>'}]});
  assert.doesNotMatch(html,/<script|<motore>|src="https:/);
  assert.match(html,/&lt;Officina&gt;/);
  assert.match(html,/A&amp;B/);
  assert.match(html,/&quot;Controllo&quot; &lt;motore&gt;/);
});

test('a locally uploaded SVG logo is kept as a base64 image',()=>{
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>').toString('base64');
  const html=buildLabel({shop:'Officina',logo:'data:image/svg+xml;base64,'+svg,lines:[]});
  assert.match(html,/src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html,/key-label-monogram/);
});
