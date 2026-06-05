// Tests the language detection on 3 known BASF jobs:
//   1. English internship (should KEEP)
//   2. German werkstudent m/w/d (should DROP)
//   3. Werkstudent Digital Marketing m/w/d (the disputed 9th — see which way it goes)
const { chromium } = require('playwright');

const GERMAN_STOPWORDS = new Set([
  "und","mit","für","die","der","das","wird","werden","sie","ihre","ihnen",
  "bei","auch","ist","des","dem","einen","einer","einem","oder","nicht",
  "sowie","als","zum","zur","wir","uns","haben","sein","im","am","nach",
  "über","durch","unsere","unser","können","sind","bieten",
  "suchen","sucht","bietet","stellen","stellt",
]);

const TEST_JOBS = [
  {
    label: "English internship (EXPECT: KEEP)",
    url: "https://basf.jobs/dark_blue_EMEA/job/Ludwigshafen-am-Rhein-Internship-Counterparty-Risk-Management-%28mfd%29/1394028633/",
  },
  {
    label: "German Werkstudent:in Pension (EXPECT: DROP)",
    url: "https://basf.jobs/dark_blue_EMEA/job/Ludwigshafen-am-Rhein-Werkstudentin-Pension-Asset-Management-%28mwd%29/1382676533/",
  },
  {
    label: "Werkstudent Digital Marketing m/w/d (DISPUTED 9th)",
    url: "https://basf.jobs/dark_blue_EMEA/job/Ludwigshafen-am-Rhein-Werkstudent-Digital-Marketing-&-Content-%28mwd%29/1387850733/",
  },
];

async function checkLanguage(browser, label, url) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Try our selector; also dump which selector matched
    const result = await page.evaluate(() => {
      const selectors = [
        ".jobad-details",
        ".job-description",
        "#job-description",
        "[class*='jobDescription']",
        "[class*='job-detail']",
        "main",
        "article",
      ];
      let matched = null, matchedSel = null;
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el) { matched = el; matchedSel = s; break; }
      }
      const el = matched || document.body;
      const text = el.innerText.slice(0, 900);
      return { text, selector: matchedSel || 'body' };
    });

    const words = result.text.toLowerCase().match(/\b[a-züäöß]{2,}\b/g) || [];
    const germanCount = words.filter(w => GERMAN_STOPWORDS.has(w)).length;
    const ratio = words.length > 0 ? germanCount / words.length : 0;
    const decision = ratio < 0.12 ? 'KEEP (English)' : 'DROP (German)';

    console.log(`\n[${decision}] ${label}`);
    console.log(`  selector  : ${result.selector}`);
    console.log(`  words     : ${words.length}  german: ${germanCount}  ratio: ${ratio.toFixed(3)}`);
    console.log(`  text snip : ${result.text.slice(0, 200).replace(/\n/g, ' ')}`);
  } catch (e) {
    console.log(`\n[ERROR] ${label}: ${e.message}`);
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const job of TEST_JOBS) {
    await checkLanguage(browser, job.label, job.url);
  }
  await browser.close();
  console.log('\nDone.');
})();
