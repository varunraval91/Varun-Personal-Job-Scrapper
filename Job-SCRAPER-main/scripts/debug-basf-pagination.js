// Checks BASF pagination: what URL params work, where is the next-page button,
// and how many English student jobs exist across multiple pages.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  async function dismissCookies() {
    const btns = ['#onetrust-accept-btn-handler','#truste-consent-button','button:has-text("Accept All")','button:has-text("Accept")'];
    for (const s of btns) {
      const b = await page.$(s).catch(() => null);
      if (b) { await b.click().catch(() => {}); await page.waitForTimeout(800); return; }
    }
  }

  async function getJobsOnPage() {
    return page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr.data-row')).filter(r => r.querySelector('a.jobTitle-link'));
      return rows.map(row => {
        const link  = row.querySelector('a.jobTitle-link');
        const locEl = row.querySelector('.jobLocation');
        const dateEl = row.querySelector('td.colDate span.jobDate, span.jobDate:not(.visible-phone)');
        return {
          title: link?.textContent.trim(),
          url:   link?.href,
          loc:   locEl?.textContent.trim(),
          date:  dateEl?.textContent.trim(),
        };
      });
    });
  }

  // ── TEST 1: Does currentPage param do anything? ──
  console.log('\n=== TEST 1: currentPage param behaviour ===');
  await page.goto('https://basf.jobs/search/?locale=en_US&currentPage=1&pageSize=25', { waitUntil: 'domcontentloaded' });
  await dismissCookies();
  await page.waitForSelector('a.jobTitle-link', { timeout: 60000 });
  const page1Jobs = await getJobsOnPage();
  console.log(`Page 1: ${page1Jobs.length} jobs`);
  console.log('  First:', page1Jobs[0]?.title, '|', page1Jobs[0]?.url?.slice(-12));
  console.log('  Last: ', page1Jobs.at(-1)?.title, '|', page1Jobs.at(-1)?.url?.slice(-12));

  await page.goto('https://basf.jobs/search/?locale=en_US&currentPage=2&pageSize=25', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.jobTitle-link', { timeout: 60000 });
  const page2Jobs = await getJobsOnPage();
  console.log(`Page 2: ${page2Jobs.length} jobs`);
  console.log('  First:', page2Jobs[0]?.title, '|', page2Jobs[0]?.url?.slice(-12));
  const sameFirst = page1Jobs[0]?.url === page2Jobs[0]?.url;
  console.log(`  Same first URL as page 1? ${sameFirst} → currentPage param ${sameFirst ? 'IGNORED' : 'WORKS'}`);

  // ── TEST 2: Find pagination controls in DOM ──
  console.log('\n=== TEST 2: Pagination controls in DOM ===');
  await page.goto('https://basf.jobs/search/?locale=en_US', { waitUntil: 'domcontentloaded' });
  await dismissCookies();
  await page.waitForSelector('a.jobTitle-link', { timeout: 60000 });

  const paginationInfo = await page.evaluate(() => {
    // Look for total count, next button, page numbers
    const totalEl   = document.querySelector('.result-count, .resultCount, #resultCount, [class*="result"] span, .jobs-count');
    const nextBtn   = document.querySelector('a[class*="next"], button[class*="next"], .pagination a:last-child, a[aria-label="Next"], a[rel="next"]');
    const pageLinks = Array.from(document.querySelectorAll('.pagination a, [class*="pagination"] a, .pager a')).map(a => a.textContent.trim() + ' → ' + a.href.slice(-30));
    const bodyText  = document.body.innerText.slice(0, 2000);
    // Find any text with number of results
    const countMatch = bodyText.match(/(\d+)\s*(?:results?|jobs?|positions?|Stellen|Ergebnisse)/i);
    return {
      totalEl:   totalEl?.textContent?.trim(),
      nextBtn:   nextBtn ? nextBtn.outerHTML.slice(0, 200) : null,
      pageLinks: pageLinks.slice(0, 10),
      countMatch: countMatch ? countMatch[0] : null,
    };
  });
  console.log('Total text:', paginationInfo.totalEl || paginationInfo.countMatch || 'not found');
  console.log('Next button:', paginationInfo.nextBtn || 'not found');
  console.log('Page links:', paginationInfo.pageLinks.length ? paginationInfo.pageLinks : 'none');

  // ── TEST 3: Try clicking next page ──
  console.log('\n=== TEST 3: Try next-page click ──');
  const nextSelectors = [
    'a[aria-label="Next page"]', 'a[aria-label="Next"]', 'button[aria-label="Next"]',
    '.next-page', '.pagination-next', 'a.next', '[class*="paginat"] a:last-child',
    'a[title="Next page"]', 'a[title="Next"]',
  ];
  let nextFound = false;
  for (const sel of nextSelectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      console.log('  Found next button:', sel);
      await el.click();
      await page.waitForTimeout(2000);
      const afterJobs = await getJobsOnPage();
      const sameAfter = afterJobs[0]?.url === (await getJobsOnPage())[0]?.url;
      console.log(`  After click: ${afterJobs.length} jobs, first: ${afterJobs[0]?.title}`);
      nextFound = true;
      break;
    }
  }
  if (!nextFound) console.log('  No next button found via any selector');

  // ── TEST 4: Count English student jobs on page 1, all locations ──
  console.log('\n=== TEST 4: English student jobs on page 1 (all locations) ===');
  await page.goto('https://basf.jobs/search/?locale=en_US&currentPage=1&pageSize=25', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a.jobTitle-link', { timeout: 60000 });
  const allP1 = await getJobsOnPage();
  const STUDENT_RE = /working student|internship|\bintern\b|thesis|student worker/i;
  const engStudent = allP1.filter(j => STUDENT_RE.test(j.title));
  console.log(`Total on page 1: ${allP1.length}, English student: ${engStudent.length}`);
  engStudent.forEach(j => console.log(`  [${j.loc}] ${j.title}`));

  await browser.close();
  console.log('\nDone.');
})();
