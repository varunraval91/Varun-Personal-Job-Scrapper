// Dumps all English student jobs from BASF with raw location strings
// to find which job isn't matching the ludwigshafen aliasMap
const { chromium } = require('playwright');

const BASF_BASE_URL = 'https://basf.jobs';
const STUDENT_KEYWORD_RE = /working student|internship|\bintern\b|thesis|student worker|werkstudent/i;
const GERMAN_GENDER_TAG  = /\(m\/w\/d\)|\(w\/m\/d\)/i;
const PAGE_SIZE = 25;
const MAX_PAGES = 30;

const aliasMap = {
  "ludwigshafen": ["ludwigshafen am rhein", "ludwigshafen a.rh.", "ludwigshafen"],
};

function locationMatches(jobLoc, sel) {
  if (!sel) return true;
  const job = (jobLoc || '').toLowerCase().trim();
  const s   = sel.toLowerCase().trim();
  return (aliasMap[s] || [s]).some(a => job.includes(a));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  async function dismissCookies() {
    const btns = ['#onetrust-accept-btn-handler', '#truste-consent-button', 'button:has-text("Accept All")', 'button:has-text("Accept")'];
    for (const s of btns) {
      const b = await page.$(s).catch(() => null);
      if (b) { await b.click().catch(() => {}); await page.waitForTimeout(800); return; }
    }
  }

  async function scrapePage(startRow) {
    const url = new URL(`${BASF_BASE_URL}/search/`);
    url.searchParams.set('locale', 'en_US');
    url.searchParams.set('sortColumn', 'referencedate');
    url.searchParams.set('sortDirection', 'desc');
    if (startRow > 0) url.searchParams.set('startrow', String(startRow));
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 90000 });
    if (startRow === 0) await dismissCookies();
    await Promise.race([
      page.waitForSelector('a.jobTitle-link', { timeout: 60000 }),
      page.waitForSelector('.no-results', { timeout: 60000 }),
    ]).catch(() => {});

    return page.evaluate(() => {
      const results = [], seen = new Set();
      const rows = Array.from(document.querySelectorAll('tr.data-row')).filter(r => r.querySelector('a'));
      rows.forEach(row => {
        const link = row.querySelector('a.jobTitle-link[href], a[href]');
        if (!link) return;
        const url = link.href;
        const key = (url || '').split('?')[0].replace(/\/+$/, '');
        if (!url || seen.has(key)) return;
        seen.add(key);
        const dateEl = row.querySelector('td.colDate span.jobDate, span.jobDate');
        const locEl  = row.querySelector('.colLocation .jobLocation, .jobLocation');
        results.push({
          title: link.textContent.trim(),
          url,
          location: locEl?.textContent?.replace(/\s+/g, ' ').trim() || 'N/A',
          date: dateEl?.textContent?.trim() || 'N/A',
        });
      });
      return results;
    });
  }

  const allJobs = [], seenUrls = new Set();
  let startRow = 0, pagesScraped = 0;

  while (pagesScraped < MAX_PAGES) {
    process.stdout.write(`Scraping startrow=${startRow}... `);
    const jobs = await scrapePage(startRow);
    process.stdout.write(`${jobs.length} raw jobs\n`);
    if (jobs.length === 0) break;

    let newThisPage = 0;
    for (const job of jobs) {
      const key = (job.url || '').split('?')[0].replace(/\/+$/, '');
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      newThisPage++;
      const isStudent = STUDENT_KEYWORD_RE.test(job.title);
      const isGerman  = GERMAN_GENDER_TAG.test(job.title);
      if (isStudent && !isGerman) allJobs.push(job);
    }
    pagesScraped++;
    if (newThisPage === 0 || jobs.length < PAGE_SIZE) break;
    startRow += PAGE_SIZE;
  }

  console.log(`\n=== ${allJobs.length} English Student Jobs (Global) ===\n`);
  const luJobs = [], nonLuJobs = [];
  for (const job of allJobs) {
    const matchesLu = locationMatches(job.location, 'ludwigshafen');
    (matchesLu ? luJobs : nonLuJobs).push(job);
    const mark = matchesLu ? '[LU ✓]' : '[    ]';
    console.log(`${mark} ${job.title}`);
    console.log(`       loc="${job.location}"  date="${job.date}"`);
  }

  console.log(`\n=== Ludwigshafen matches: ${luJobs.length} ===`);
  luJobs.forEach(j => console.log(`  ✓ ${j.title} | ${j.location}`));

  console.log(`\n=== Non-Ludwigshafen (${nonLuJobs.length}) ===`);
  nonLuJobs.forEach(j => console.log(`  - ${j.title} | ${j.location}`));

  await browser.close();
})();
