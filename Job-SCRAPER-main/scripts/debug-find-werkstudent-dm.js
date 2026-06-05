// Find "Werkstudent Digital Marketing" on BASF — show it regardless of language tag
const { chromium } = require('playwright');

const STUDENT_RE = /working student|internship|\bintern\b|thesis|student worker|werkstudent/i;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  async function dismissCookies() {
    const btns = ['#onetrust-accept-btn-handler','#truste-consent-button','button:has-text("Accept All")'];
    for (const s of btns) {
      const b = await page.$(s).catch(() => null);
      if (b) { await b.click().catch(() => {}); await page.waitForTimeout(600); return; }
    }
  }

  async function scrapePage(startRow) {
    const url = new URL('https://basf.jobs/search/');
    url.searchParams.set('locale', 'en_US');
    url.searchParams.set('sortColumn', 'referencedate');
    url.searchParams.set('sortDirection', 'desc');
    if (startRow > 0) url.searchParams.set('startrow', String(startRow));
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    if (startRow === 0) await dismissCookies();
    await Promise.race([
      page.waitForSelector('a.jobTitle-link', { timeout: 60000 }),
      page.waitForSelector('.no-results',     { timeout: 60000 }),
    ]).catch(() => {});
    return page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr.data-row')).filter(r => r.querySelector('a'));
      return rows.map(row => {
        const link  = row.querySelector('a.jobTitle-link[href], a[href]');
        const locEl = row.querySelector('.colLocation .jobLocation, .jobLocation');
        const dateEl= row.querySelector('td.colDate span.jobDate, span.jobDate');
        return {
          title: link?.textContent.trim() || '',
          url:   link?.href || '',
          loc:   locEl?.textContent?.replace(/\s+/g,' ').trim() || 'N/A',
          date:  dateEl?.textContent?.trim() || 'N/A',
        };
      }).filter(j => j.url);
    });
  }

  const seenUrls = new Set();
  let startRow = 0;
  const found = [];

  for (let p = 0; p < 30; p++) {
    process.stdout.write(`startrow=${startRow}... `);
    const jobs = await scrapePage(startRow);
    process.stdout.write(`${jobs.length} jobs\n`);
    if (jobs.length === 0) break;

    let newCount = 0;
    for (const j of jobs) {
      const key = j.url.split('?')[0].replace(/\/+$/,'');
      if (seenUrls.has(key)) continue;
      seenUrls.add(key); newCount++;
      if (/digital.?marketing|marketing.*digital/i.test(j.title) || /werkstudent/i.test(j.title)) {
        found.push(j);
      }
    }
    if (newCount === 0 || jobs.length < 25) break;
    startRow += 25;
  }

  console.log(`\n=== Werkstudent / Digital Marketing hits (${found.length}) ===`);
  found.forEach(j => {
    const isGerman = /\(m\/w\/d\)|\(w\/m\/d\)/i.test(j.title);
    const tag = isGerman ? '[DE m/w/d]' : '[EN m/f/d]';
    console.log(`${tag} ${j.title}`);
    console.log(`     loc="${j.loc}"  date="${j.date}"`);
    console.log(`     url=${j.url}`);
  });

  await browser.close();
})();
