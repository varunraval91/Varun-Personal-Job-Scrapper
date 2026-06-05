// Dumps BASF search page HTML so we can find date selectors
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  const url = 'https://basf.jobs/search/?locale=en_US&currentPage=1&pageSize=25&keyword=internship';
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // Dismiss cookie banner if present
  try {
    await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
    await page.click('#onetrust-accept-btn-handler');
    await page.waitForTimeout(1000);
  } catch { /* no banner */ }

  // Wait for job links
  await page.waitForSelector('a.jobTitle-link, .jobTitle-link, tr.data-row', { timeout: 60000 });
  await page.waitForTimeout(2000); // let JS finish rendering

  // Dump first row HTML
  const firstRowHtml = await page.$eval(
    '#searchresults tbody tr, tr.data-row, .job-row',
    el => el.outerHTML
  ).catch(() => 'no row found');

  console.log('\n=== FIRST ROW HTML ===\n', firstRowHtml.slice(0, 3000));

  // Try specific date selectors
  const dateSelectors = [
    'span.jobDate',
    'td.colDate',
    'td.colDate span',
    '[data-careersite-propertyid="date"]',
    '.job-date',
    'td.date',
    'span[class*="date"]',
    'td[class*="date"]',
    '[class*="Date"]',
    'time',
  ];

  console.log('\n=== DATE SELECTOR SCAN ===');
  for (const sel of dateSelectors) {
    try {
      const texts = await page.$$eval(sel, els => els.slice(0, 3).map(e => e.textContent.trim()));
      if (texts.length) console.log(`  ${sel}: [${texts.join(', ')}]`);
    } catch { /* skip */ }
  }

  // Dump all text that looks like a date (MM/DD/YYYY or Month Day, Year)
  const dateTexts = await page.evaluate(() => {
    const allText = Array.from(document.querySelectorAll('*'))
      .filter(el => el.children.length === 0) // leaf nodes only
      .map(el => ({ tag: el.tagName + (el.className ? '.'+el.className.split(' ').join('.') : ''), text: el.textContent.trim() }))
      .filter(({ text }) => /\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(text) && text.length < 30);
    return allText.slice(0, 20);
  });
  console.log('\n=== LEAF NODES WITH DATE-LIKE TEXT ===');
  dateTexts.forEach(({ tag, text }) => console.log(`  <${tag}>: "${text}"`));

  await browser.close();
})();
