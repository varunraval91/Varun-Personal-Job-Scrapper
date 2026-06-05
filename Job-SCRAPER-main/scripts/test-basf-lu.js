const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const page    = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  page.on('request',  r => { if (r.url().includes('/scrape')) console.log('[NET] POST /scrape:', r.postData()); });
  page.on('response', async r => {
    if (r.url().includes('/scrape')) {
      const b = await r.text().catch(() => '?');
      console.log('[NET] /scrape response', r.status(), '— jobs:', JSON.parse(b)?.jobs?.length ?? 'parse-err');
    }
  });

  await page.addInitScript(() => { window.__DEV_NO_AUTH__ = true; });

  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app-layout:not(.hidden)', { timeout: 15000 });
  await page.waitForTimeout(800);

  // Select BASF
  await page.selectOption('#scrape-portal', 'basf');
  await page.waitForTimeout(600);

  // Inspect dropdown immediately after BASF selected
  const ddVal = await page.$eval('#scrape-location-dropdown', el => el.value);
  const ddOpts = await page.$$eval('#scrape-location-dropdown option', opts => opts.map(o => `${o.value}=${o.text}`));
  console.log('Dropdown default value:', ddVal);
  console.log('Dropdown options:', ddOpts.slice(0, 5).join(', '));

  // Select Ludwigshafen
  await page.selectOption('#scrape-location-dropdown', 'ludwigshafen');
  await page.waitForTimeout(300);

  const ddValAfter = await page.$eval('#scrape-location-dropdown', el => el.value);
  console.log('Dropdown value after select:', ddValAfter);

  // Any Time
  await page.selectOption('#scrape-period', 'any');
  await page.waitForTimeout(300);

  await page.screenshot({ path: 'scripts/basf-02-before-search.png' });

  const btnDisabled = await page.$eval('#scrape-search-btn', el => el.disabled);
  console.log('Button disabled?', btnDisabled);

  // Click
  console.log('Clicking search...');
  await page.click('#scrape-search-btn');
  console.log('Search clicked — waiting 120s for scrape to finish...');
  await page.waitForTimeout(120000);

  // Inspect DOM state after scrape
  const count = await page.$eval('#scrape-result-count', el => el.textContent).catch(() => 'N/A');
  const ddValNow = await page.$eval('#scrape-location-dropdown', el => el.value).catch(() => '?');
  const portalNow = await page.$eval('#scrape-portal', el => el.value).catch(() => '?');

  console.log('\n=== After scrape ===');
  console.log('Result count:', count);
  console.log('Portal value now:', portalNow);
  console.log('Dropdown value now:', ddValNow);

  // Inspect scrapeState.jobs via page evaluate
  const stateInfo = await page.evaluate(() => {
    // Find scrapeState (it's in the IIFE closure, so need indirect access)
    const countEl = document.getElementById('scrape-result-count');
    const tbodyRows = document.querySelectorAll('#scrape-results-body tr');
    const firstRow = tbodyRows[0]?.innerText?.replace(/\n/g, ' | ') || 'none';
    const ddEl = document.getElementById('scrape-location-dropdown');
    return {
      resultCount: countEl?.textContent,
      tableRows: tbodyRows.length,
      firstRow,
      ddValue: ddEl?.value,
      ddSelectedText: ddEl?.options?.[ddEl?.selectedIndex]?.text
    };
  });
  console.log('DOM state:', JSON.stringify(stateInfo, null, 2));

  await page.screenshot({ path: 'scripts/basf-03-results.png', fullPage: true });
  console.log('Screenshot: basf-03-results.png');

  await browser.close();
})();
