const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-ranked-lists-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'rank-admin', 'test-password-1234', 'admin');
  await addUser(app.db, 'rank-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const page = await browser.newPage({viewport:{width:1278,height:1252}}), errors=[];
  page.on('pageerror', error => errors.push(error.stack));
  const frame = p => p.frames().find(f => f.url().endsWith('/legacy'));
  const ready = p => p.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  async function login(p, username) {
    await p.goto(origin); await p.locator('#username').fill(username); await p.locator('#password').fill('test-password-1234');
    await p.locator('#loginForm button[type="submit"]').click(); await ready(p);
  }
  const year = Number(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',year:'numeric'}).format(new Date()));
  try {
    await login(page, 'rank-admin'); let f=frame(page);
    assert.deepEqual(await f.locator('#moduli .form-choice').evaluateAll(cards=>cards.map(card=>card.dataset.template)), ['privacy','refusal','parts']);
    await f.evaluate(year => {
      const history=[];
      for (const y of [year-1,year]) for(let month=1;month<=12;month++) history.push({
        customer:`Cliente ${y}-${month}`,plate:`TEST${y}${month}`,date:`${y}-${String(month).padStart(2,'0')}-15`,
        work:`${month} pneumatici ${175+month*10}/65 R15`,amount:month*(y===year?1000:100)
      });
      localStorage.setItem('officina-table-import-v1',JSON.stringify({history,stocks:null}));
    }, year);
    await page.evaluate(() => WorkshopCloudHost.flush());
    const importedHistory = await f.evaluate(() => localStorage.getItem('officina-table-import-v1'));
    await f.locator('.nav [data-view="analysis"]').click();
    assert.equal(await f.locator('#analysisMetricsPeriod').inputValue(),'year');
    assert.equal(Number(await f.locator('#analysisTyreCount').innerText()),78);
    await f.locator('#analysisMetricsPeriod').selectOption('all');
    assert.equal(Number(await f.locator('#analysisTyreCount').innerText()),156);
    await f.locator('#analysisTyresPeriod').selectOption('all');
    const measures=await f.locator('#analysisTyreMeasures li').allTextContents();
    assert.equal(measures.length,10); assert.match(measures[0], /295\/65.*24 pneumatici/); assert.match(measures[9], /205\/65.*6 pneumatici/);
    const columns=await f.locator('#analysisTyreMeasures li').evaluateAll(rows=>rows.map(row=>({x:row.getBoundingClientRect().x,y:row.getBoundingClientRect().y,textY:row.querySelector('b').getBoundingClientRect().y,quantityY:row.querySelector('span').getBoundingClientRect().y})));
    assert.ok(columns[5].x>columns[0].x); assert.ok(Math.abs(columns[5].y-columns[0].y)<2);
    for (let index=0;index<5;index++) {
      assert.ok(Math.abs(columns[index].textY-columns[index+5].textY)<1, 'paired tyre measures align on row '+index);
      assert.ok(Math.abs(columns[index].quantityY-columns[index+5].quantityY)<1, 'paired quantities align on row '+index);
    }
    console.log('PASS metrics default to this year and the ten top tyre measures fill two columns of five');

    const ranked = selector => f.locator(selector+' .analysis-period-bar').evaluateAll(rows=>rows.map(row=>({month:row.dataset.month,amount:Number(row.dataset.amount)})));
    const descending = rows => rows.every((row,index)=>!index || rows[index-1].amount>=row.amount);
    await f.locator('#analysisTrendPeriod').selectOption('year');
    let annual=await ranked('#analysisTrendContent'); assert.equal(annual.length,12); assert.ok(descending(annual));
    assert.equal(annual[0].month,year+'-12'); assert.equal(annual[11].month,year+'-01');
    await f.locator('#analysisTrendPeriod').selectOption('all');
    const high=await ranked('.analysis-period-high'), low=await ranked('.analysis-period-low');
    assert.equal(high.length,10);assert.equal(low.length,10); assert.ok(descending(high)&&descending(low));
    assert.equal(high[0].amount,12000);assert.equal(low[0].amount,1000);assert.equal(low[9].amount,100);
    const colors=await f.evaluate(()=>['.analysis-period-high','.analysis-period-low'].map(selector=>getComputedStyle(document.querySelector(selector+' .analysis-period-bar i')).backgroundColor));
    assert.notEqual(colors[0],colors[1]);
    await f.locator('#analysisTrendPeriod').selectOption('custom');
    await f.locator('#analysisTrendStart').fill((year-1)+'-01-01'); await f.locator('#analysisTrendEnd').fill((year-1)+'-03-31');
    assert.equal((await ranked('.analysis-period-high')).length,3);assert.equal((await ranked('.analysis-period-low'))[0].amount,300);
    await f.locator('#analysisTrendStart').fill((year+1)+'-01-01');
    assert.match(await f.locator('#analysisTrendContent').innerText(),/intervallo.*valido/);
    // A year with no work still displays all twelve months at zero.
    await f.evaluate(()=>localStorage.setItem('officina-table-import-v1',JSON.stringify({history:[],stocks:null})));
    await f.locator('#analysisTrendPeriod').selectOption('year');
    annual=await ranked('#analysisTrendContent');assert.equal(annual.length,12);assert.ok(annual.every(row=>row.amount===0));
    await f.evaluate(history=>localStorage.setItem('officina-table-import-v1',history),importedHistory);
    await page.evaluate(() => WorkshopCloudHost.flush());
    await page.reload();await ready(page);f=frame(page);
    assert.equal(await f.locator('#analysisMetricsPeriod').inputValue(),'year');
    console.log('PASS annual ranking includes twelve months and other ranges show descending green/red extremes');

    await f.locator('#tyreSalesSummary').click();await f.locator('#salesRange').selectOption('year');
    const count = () => f.locator('#salesList .sales-item').count();
    assert.equal(await count(),5);assert.match(await f.locator('#salesDayTotal').innerText(),/^78 pneumatici/);
    await f.locator('#salesShowMore').click();assert.equal(await count(),10);
    await f.locator('#salesShowMore').click();assert.equal(await count(),12);assert.equal(await f.locator('#salesShowMore').isVisible(),false);
    assert.match(await f.locator('#salesDayTotal').innerText(),/^78 pneumatici/);
    await f.locator('#salesRange').selectOption('month');await f.locator('#salesMonth').selectOption('1');
    assert.equal(await count(),1);assert.equal(await f.locator('#salesShowMore').isVisible(),false);
    await f.locator('#salesRange').selectOption('year');assert.equal(await count(),5);
    await f.locator('#salesShowMore').click();await f.locator('#tyreSalesModal [data-cloud-close]').click();
    await f.locator('#tyreSalesSummary').click();await f.locator('#salesRange').selectOption('year');assert.equal(await count(),5);
    await f.locator('#tyreSalesModal [data-cloud-close]').click();
    console.log('PASS sales load five rows at a time, retain full totals and reset when the period changes or the modal reopens');

    await f.locator('.nav [data-view="analysis"]').click();await f.locator('#analysisTrendPeriod').selectOption('all');
    for(const width of [1278,390]) {
      await page.setViewportSize({width,height:width===390?844:1252});
      const bounds=await f.evaluate(()=>['#analysisTyreMeasures','.analysis-ranked-periods'].map(selector=>{
        const el=document.querySelector(selector),r=el.getBoundingClientRect();return {selector,left:r.left,right:r.right,width:innerWidth,overflow:el.scrollWidth-el.clientWidth};
      }));
      assert.ok(bounds.every(r=>r.left>=0&&r.right<=r.width+1&&r.overflow<=1),JSON.stringify(bounds));
      if(process.env.RANKED_LIST_SCREENSHOT_DIR)await f.locator('.analysis-grid').screenshot({path:path.join(process.env.RANKED_LIST_SCREENSHOT_DIR,`ranked-measures-${width}.png`)});
    }
    const viewer=await (await browser.newContext()).newPage();viewer.on('pageerror',error=>errors.push(error.stack));
    await login(viewer,'rank-viewer');const v=frame(viewer);
    await v.locator('#tyreSalesSummary').click();await v.locator('#salesRange').selectOption('year');await v.locator('#salesShowMore').click();
    assert.equal(await v.locator('#salesList .sales-item').count(),10);
    assert.deepEqual(errors,[]);
    console.log('PASS mobile lists fit the viewport, viewer pagination works and no browser errors occur');
  } finally {await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
