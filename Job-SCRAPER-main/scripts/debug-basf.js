const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const OUT = path.join(__dirname, "../debug-screenshots");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const shot = async (page, name) => {
  const f = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: f, fullPage: false });
  console.log(`[screenshot] ${f}`);
};

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 400 });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  console.log("\n=== STEP 1: Navigate to BASF search with keyword via URL param ===");
  await page.goto("https://basf.jobs/search/?locale=en_US&q=data", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2000);
  await shot(page, "01-page-load");

  console.log("\n=== STEP 2: Check cookie banner ===");
  const cookieSels = ['#truste-consent-button','#truste-consent-required','#onetrust-accept-btn-handler','button:has-text("Allow All")','button:has-text("Accept All")','button:has-text("Alle akzeptieren")','button:has-text("Accept")'];
  let dismissed = false;
  for (const sel of cookieSels) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click({ timeout: 2000 }); dismissed = true; console.log(`  Cookie dismissed via: ${sel}`); break; }
    } catch {}
  }
  if (!dismissed) console.log("  No cookie banner found");
  await page.waitForTimeout(1000);
  await shot(page, "02-after-cookie");

  console.log("\n=== STEP 3: keyword was passed via URL param — no form fill needed ===");

  console.log("\n=== STEP 5: Check ALL form inputs ===");
  const inputs = await page.$$eval("input, select", els => els.map(e => ({
    tag: e.tagName, name: e.getAttribute("name"), id: e.getAttribute("id"),
    type: e.getAttribute("type"), value: e.value, visible: e.offsetParent !== null
  })));
  console.log("  Form fields:");
  inputs.filter(i => i.name && !["robots","viewport","alertId","createNewAlert","description","searchfilter"].includes(i.name))
    .forEach(i => console.log(`    <${i.tag}> name="${i.name}" id="${i.id}" type="${i.type}" value="${i.value}" visible=${i.visible}`));

  // URL param already loaded results — no submit needed
  await page.waitForTimeout(2000);
  await shot(page, "04-results");

  console.log("\n=== STEP 9: Count results ===");
  const count = await page.evaluate(() => {
    const rows = document.querySelectorAll("#searchresults tbody tr.data-row, tr.data-row, .job-listing-row");
    const links = document.querySelectorAll("a.jobTitle-link, .jobTitle-link");
    const noRes = document.querySelector(".no-results, .jobs-search-no-result");
    return {
      dataRows: rows.length,
      titleLinks: links.length,
      noResultsVisible: !!noRes,
      pageTitle: document.title,
      url: window.location.href,
      bodySnippet: document.body.innerText.slice(0, 500)
    };
  });
  console.log("  data-rows:", count.dataRows);
  console.log("  jobTitle-links:", count.titleLinks);
  console.log("  no-results element:", count.noResultsVisible);
  console.log("  URL:", count.url);
  console.log("  Page title:", count.pageTitle);
  console.log("  Body snippet:\n", count.bodySnippet);

  console.log("\n=== STEP 10: Scrape job titles if any ===");
  const jobs = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll("a.jobTitle-link, .jobTitle a, .jobTitle-link").forEach(a => {
      results.push({ title: a.textContent.trim(), href: a.href });
    });
    return results.slice(0, 10);
  });
  if (jobs.length) {
    console.log("  Jobs found:");
    jobs.forEach(j => console.log(`    - ${j.title} → ${j.href}`));
  } else {
    console.log("  NO JOBS EXTRACTED");
    // Dump full #searchresults HTML
    const html = await page.$eval("#searchresults", el => el.innerHTML.slice(0, 2000)).catch(() => "no #searchresults element");
    console.log("  #searchresults HTML:\n", html);
  }

  await shot(page, "06-final");
  console.log("\nDone. Screenshots in:", OUT);
  await browser.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
