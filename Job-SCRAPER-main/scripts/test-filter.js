const { chromium } = require("playwright");

(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  await p.goto("https://basf.jobs/search/?locale=en_US&q=data", { waitUntil: "domcontentloaded", timeout: 60000 });
  try { await p.click("button:has-text('Allow All')", { timeout: 5000 }); } catch {}
  await p.waitForTimeout(1500);

  const before = await p.evaluate(() => document.querySelectorAll("a.jobTitle-link").length);

  await p.fill("input#location", "Hyderabad");
  await p.waitForTimeout(500);
  await p.click("#searchfilter-submit");
  await p.waitForTimeout(2500);

  const after = await p.evaluate(() => document.querySelectorAll("a.jobTitle-link").length);
  const titles = await p.evaluate(() =>
    Array.from(document.querySelectorAll("a.jobTitle-link")).slice(0, 5).map(e => e.textContent.trim())
  );

  console.log("before:", before, "  after Hyderabad filter:", after);
  titles.forEach(t => console.log(" -", t));
  await b.close();
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
