const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// ═══════════════════════════════════════════════════════════════
// CORS — restrict in production, open in dev
// ═══════════════════════════════════════════════════════════════
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null;
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : undefined));

app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════════════════
// REQUEST LOGGING MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY RATE LIMITER (lightweight abuse guard)
// ═══════════════════════════════════════════════════════════════
const rateLimitStore = new Map();
const RATE_LIMITS = {
  "/generate":   { windowMs: 60000, max: 10 },
  "/export-pdf": { windowMs: 60000, max: 15 },
  "/dach-fix":   { windowMs: 60000, max: 10 },
  "/dach-check": { windowMs: 60000, max: 15 },
  "/humanize":   { windowMs: 60000, max: 10 },
};

function rateLimiter(req, res, next) {
  const rule = RATE_LIMITS[req.path];
  if (!rule) return next();
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const key = `${ip}::${req.path}`;
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.windowStart > rule.windowMs) {
    entry = { windowStart: now, count: 0 };
    rateLimitStore.set(key, entry);
  }
  entry.count++;
  if (entry.count > rule.max) {
    return res.status(429).json({ success: false, error: "Too many requests. Please wait before retrying." });
  }
  next();
}
app.use(rateLimiter);

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > 120000) rateLimitStore.delete(key);
  }
}, 300000);

// ═══════════════════════════════════════════════════════════════
// SAFE ERROR RESPONSES — hide internals in production
// ═══════════════════════════════════════════════════════════════
const IS_PROD = process.env.NODE_ENV === "production";
function safeError(err) {
  if (IS_PROD) return "An internal error occurred. Please try again.";
  return err?.message || String(err);
}

const PORT = process.env.PORT || 3000;
const BASE_ACTION_TIMEOUT_MS = 60000;
const BASE_NAV_TIMEOUT_MS = 90000;
const SAP_BASE_URL = "https://jobs.sap.com";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

// ═══════════════════════════════════════════════════════════════
// DYNAMIC AVAILABILITY (start = next month, duration = 18 months)
// ═══════════════════════════════════════════════════════════════

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Graduation / programme end — change this when your end date changes
const AVAIL_END_MONTH = 9;  // 0-indexed: 9 = October
const AVAIL_END_YEAR  = 2027;

function getAvailability() {
  const now = new Date();
  let sM = now.getMonth() + 1; // next month (0-indexed + 1)
  let sY = now.getFullYear();
  if (sM > 11) { sM = 0; sY++; }
  const startShort = `${MONTH_NAMES[sM]} ${sY}`;
  const endShort   = `${MONTH_NAMES[AVAIL_END_MONTH]} ${AVAIL_END_YEAR}`;
  const startLong  = `${MONTH_FULL[sM]} ${sY}`;
  const endLong    = `${MONTH_FULL[AVAIL_END_MONTH]} ${AVAIL_END_YEAR}`;
  return {
    cv:    `${startShort} -- ${endShort} as working student, internship and thesis`,
    cl:    `${startLong} – ${endLong}`,
    range: `${startShort}-${endShort}`,
    prose: `${startLong} through ${endLong} (20 hrs/week semester, full-time breaks)`
  };
}

// ═══════════════════════════════════════════════════════════════
// AI CLIENT (Claude > Groq > Gemini)
// ═══════════════════════════════════════════════════════════════

let aiProvider = null;
let genAI = null;

if (process.env.ANTHROPIC_API_KEY) {
  aiProvider = "claude";
  console.log(`[OK] Claude AI ready (${CLAUDE_MODEL})`);
} else if (process.env.GROQ_API_KEY) {
  aiProvider = "groq";
  console.log(`[OK] Groq AI ready (${GROQ_MODEL})`);
} else if (process.env.GEMINI_API_KEY) {
  aiProvider = "gemini";
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  console.log(`[OK] Gemini AI ready (${GEMINI_MODEL})`);
} else {
  console.warn("[!!] No AI key found — set ANTHROPIC_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY in .env");
}

let lastAICall = 0;
const AI_MIN_GAP_MS = aiProvider === "groq" ? 2000 : aiProvider === "claude" ? 1000 : 4000;

// ═══════════════════════════════════════════════════════════════
// VECTOR STORE + STYLE PROFILE
// ═══════════════════════════════════════════════════════════════

let vectorReady = false;
let styleProfile = null;
let skillBank = null;

try {
  skillBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
  const stylePath = path.join(__dirname, "data", "writing_style_profile.json");
  if (fs.existsSync(stylePath)) {
    styleProfile = JSON.parse(fs.readFileSync(stylePath, "utf-8"));
    console.log(`[OK] Writing style loaded (${styleProfile.total_samples} samples)`);
  } else {
    console.warn("[!!] No writing style profile — run: node extract_style.js");
  }
  // Vector store is ready if collections exist in vector_store.json
  const vsPath = path.join(__dirname, "data", "vector_store.json");
  if (fs.existsSync(vsPath)) {
    vectorReady = true;
    console.log(`[OK] Vector store ready: ${skillBank.skill_chunks.length} skills, ${skillBank.projects.length} projects`);
  } else {
    console.warn("[!!] Vector store not initialized — run setup first");
  }
} catch (err) {
  console.warn(`[!!] Vector store failed: ${err.message} — RAG features disabled`);
}

const { retrieveContext, addSkillToVector, updateSkillInVector } = vectorReady ? require("./src/rag_engine") : { retrieveContext: null, addSkillToVector: null, updateSkillInVector: null };
const skillBankManager = vectorReady ? require("./src/skill_bank_manager") : null;
const { humanize } = vectorReady ? require("./src/humanizer") : { humanize: null };

async function callGroq(systemPrompt, userPrompt) {
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.4, max_tokens: 4096 })
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); const e = new Error(err.error?.message || `Groq ${res.status}`); e.status = res.status; throw e; }
  return (await res.json()).choices[0].message.content;
}

async function callClaude(systemPrompt, userPrompt) {
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 4096, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] })
  });
  if (!res.ok) { const err = await res.json().catch(() => ({})); const e = new Error(err.error?.message || `Claude ${res.status}`); e.status = res.status; throw e; }
  return (await res.json()).content[0].text;
}

async function callGemini(systemPrompt, userPrompt) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: userPrompt }] }], systemInstruction: { parts: [{ text: systemPrompt }] } });
      return result.response.text();
    } catch (err) {
      const is429 = err.status === 429 || err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED");
      if (!is429 || attempt === 1) throw err;
      const m = err.message?.match(/retry in ([\d.]+)s/i);
      const wait = Math.min((m ? Math.ceil(parseFloat(m[1])) : 60) * 1000, 120000);
      console.log(`Gemini 429 — waiting ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
      lastAICall = Date.now();
    }
  }
}

async function callAI(systemPrompt, userPrompt) {
  if (aiProvider === "claude") return callClaude(systemPrompt, userPrompt);
  if (aiProvider === "groq") return callGroq(systemPrompt, userPrompt);
  if (aiProvider === "gemini") return callGemini(systemPrompt, userPrompt);
  throw new Error("No AI provider configured");
}

// ═══════════════════════════════════════════════════════════════
// PLAYWRIGHT BROWSER
// ═══════════════════════════════════════════════════════════════

let sharedBrowser = null;
async function getSharedBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({ headless: process.env.PW_HEADLESS !== "false" });
  }
  return sharedBrowser;
}
process.on("SIGINT", async () => { if (sharedBrowser) await sharedBrowser.close(); process.exit(0); });
process.on("SIGTERM", async () => { if (sharedBrowser) await sharedBrowser.close(); process.exit(0); });

// ═══════════════════════════════════════════════════════════════
// LIBRARY INDEX
// ═══════════════════════════════════════════════════════════════

let libraryIndex = [];

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function normalizeSapJobUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${SAP_BASE_URL}${url}`;
  return `${SAP_BASE_URL}/${url}`;
}

function looksLikeDate(value) {
  if (!value || value === "N/A") return false;
  return /[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}/.test(value);
}

function extractRequisitionIdFromUrl(url) {
  const abs = normalizeSapJobUrl(url);
  const match = abs.match(/\/(\d+)\/?$/);
  return match ? match[1] : "N/A";
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function dismissCookieBanner(page) {
  for (const sel of ["#truste-consent-button", "#truste-consent-required", "#truste-show-consent"]) {
    const btn = await page.$(sel);
    if (btn) try { await btn.click({ timeout: 1500 }); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════
// SMART SELECTOR — Full-text TF-IDF scoring
// ═══════════════════════════════════════════════════════════════

const STOPWORDS = new Set(["the","and","for","are","but","not","you","all","can","was","one","our","out","had","has","his","how","its","may","new","now","see","way","who","did","get","let","say","she","too","use","with","this","that","from","they","been","have","many","some","them","than","will","each","make","like","over","such","into","year","also","back","your","work","about","would","there","their","which","could","other","after","first","well","just","where","what","when","being","should","through","these","experience","working","including","within","across","role","team","ability","strong","knowledge","skills","understanding","responsible","support","required","preferred","position","company","organization","varun","raval","application","candidate"]);

const TECH_TERMS = new Set(["sap","btp","fiori","hana","s4hana","abap","python","sql","javascript","analytics","datasphere","tableau","power","azure","aws","gcp","kubernetes","docker","machine","learning","data","cloud","api","rest","agile","scrum","erp","crm","ui5","odata","react","node","tensorflow","pandas","matplotlib","cap","rac","successfactors","ariba","concur","integration","migration"]);

function scoreDoc(jdText, docText, docFilename) {
  const jdTokens = jdText.toLowerCase().replace(/[^a-z0-9#+.\s]/g, " ").split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
  const docLower = (docText || "").toLowerCase();
  const docTokenSet = new Set(docLower.replace(/[^a-z0-9#+.\s]/g, " ").split(/\s+/));

  const jdFreq = {};
  for (const t of jdTokens) jdFreq[t] = (jdFreq[t] || 0) + 1;

  let score = 0;
  for (const [term, freq] of Object.entries(jdFreq)) {
    if (docTokenSet.has(term)) score += freq * (TECH_TERMS.has(term) ? 3 : 1);
  }

  // Bigram bonus
  for (let i = 0; i < jdTokens.length - 1; i++) {
    const bg = jdTokens[i] + " " + jdTokens[i + 1];
    if (docLower.includes(bg)) score += 5;
  }

  // Filename relevance
  const fnLower = (docFilename || "").toLowerCase();
  for (const term of Object.keys(jdFreq)) { if (fnLower.includes(term)) score += 2; }

  return score;
}

function smartSelectServer(jdText, docType, allDocs) {
  const filtered = allDocs.filter(d => docType === "cv" ? d.type === "cv" : d.type === "cover_letter");
  if (!filtered.length) return [];

  const scored = filtered.map(doc => ({ doc, score: scoreDoc(jdText, doc.text, doc.filename) }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, Math.min(3, scored.length));
  console.log(`  Smart Select [${docType}]: ${top.map(s => `${s.doc.filename}(${s.score})`).join(", ")}`);
  return top.map(s => s.doc);
}

// ═══════════════════════════════════════════════════════════════
// SCRAPING
// ═══════════════════════════════════════════════════════════════

async function fetchJobDetail(browser, absoluteUrl) {
  const page = await browser.newPage();
  page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);
  try {
    await page.goto(absoluteUrl, { waitUntil: "domcontentloaded", timeout: BASE_NAV_TIMEOUT_MS });
    const extracted = await page.evaluate(() => {
      const direct = document.querySelector('[data-careersite-propertyid="date"]');
      const dateValue = direct?.textContent?.trim() || "N/A";
      const locDirect = document.querySelector('[data-careersite-propertyid="location"]');
      const locFallback = document.querySelector(".jobLocation");
      const locEl = locDirect || locFallback;
      if (locEl) locEl.querySelectorAll("style, script").forEach(s => s.remove());
      const locationValue = locEl?.textContent?.replace(/\s+/g, " ").trim() || "N/A";
      const facilityEl = document.querySelector('[data-careersite-propertyid="facility"]');
      const reqValue = facilityEl?.textContent?.trim() || "N/A";
      const dateLike = Array.from(document.querySelectorAll("span,div,li,p,dd,dt,strong"))
        .map(el => (el.textContent || "").replace(/\s+/g, " ").trim())
        .find(text => /[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2}/.test(text));
      return { date: dateValue !== "N/A" ? dateValue : (dateLike || "N/A"), location: locationValue, requisitionId: reqValue };
    });
    return extracted;
  } catch (error) {
    console.warn(`Date lookup failed for ${absoluteUrl}: ${error.message}`);
    return { date: "N/A", location: "N/A", requisitionId: "N/A" };
  } finally {
    await page.close();
  }
}

async function enrichJobsWithPostedDates(browser, jobs) {
  if (!jobs.length) return jobs;
  const CONCURRENCY = 4;
  const dateByUrl = new Map();

  // Deduplicate URLs that need visiting
  const uniqueUrls = [];
  for (const job of jobs) {
    const absoluteUrl = normalizeSapJobUrl(job.url);
    const urlBasedReqId = extractRequisitionIdFromUrl(absoluteUrl) || "N/A";
    const needsVisit = !looksLikeDate(job.date) || !job.location || job.location === "N/A" || job.requisitionId === urlBasedReqId;
    if (needsVisit && !dateByUrl.has(absoluteUrl)) {
      dateByUrl.set(absoluteUrl, null); // placeholder
      uniqueUrls.push(absoluteUrl);
    }
  }

  // Fetch all detail pages with limited concurrency
  for (let i = 0; i < uniqueUrls.length; i += CONCURRENCY) {
    const batch = uniqueUrls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(url => fetchJobDetail(browser, url)));
    batch.forEach((url, idx) => dateByUrl.set(url, results[idx]));
  }

  // Build enriched list
  return jobs.map(job => {
    const absoluteUrl = normalizeSapJobUrl(job.url);
    let location = String(job.location || "").replace(/\s+/g, " ").replace(/#[^{]*\{[^}]*\}/g, "").trim() || "N/A";
    let requisitionId = String(job.requisitionId || "").trim() || extractRequisitionIdFromUrl(absoluteUrl) || "N/A";
    let postedDate = looksLikeDate(job.date) ? job.date : "N/A";

    const cached = dateByUrl.get(absoluteUrl);
    if (cached) {
      if (looksLikeDate(cached.date)) postedDate = cached.date;
      if (location === "N/A" && cached.location !== "N/A") location = cached.location;
      if (cached.requisitionId !== "N/A") requisitionId = cached.requisitionId;
    }

    const cleanLocation = location !== "N/A" ? location.split(",")[0].trim() : "N/A";
    let displayDate = postedDate;
    if (postedDate !== "N/A") {
      const d = parseJobDate(postedDate);
      if (d) displayDate = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    }
    return { ...job, url: absoluteUrl, date: displayDate, rawDate: postedDate, location: cleanLocation, requisitionId };
  });
}

function parseJobDate(raw) {
  if (!raw || raw === "N/A") return null;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;
  // Handle abbreviated month with or without comma: "Mar 18 2026" or "Mar 18, 2026"
  const m = raw.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
    const mo = months[m[1]];
    if (mo !== undefined) return new Date(+m[3], mo, +m[2]);
  }
  return null;
}

function filterByPeriod(jobs, period) {
  if (period === "any") return jobs;
  const now = new Date();
  return jobs.filter(job => {
    const raw = job.rawDate || job.date;
    const posted = parseJobDate(raw);
    // Exclude jobs with no parseable date when a specific period is selected
    if (!posted) return false;
    const days = (now - posted) / 86400000;
    if (period === "today") return days >= 0 && days < 1;
    if (period === "1week") return days >= 0 && days <= 7;
    if (period === "2weeks") return days >= 0 && days <= 14;
    if (period === "3weeks") return days >= 0 && days <= 21;
    if (period === "1month") return days >= 0 && days <= 30;
    return true;
  });
}

async function scrapeOnePage(page, keyword, location, country, statusValue) {
  await page.goto("https://jobs.sap.com/search/", { waitUntil: "domcontentloaded", timeout: BASE_NAV_TIMEOUT_MS });
  // Use 'q' (keyword search) instead of 'title' (full-text) for curated, relevant results
  await dismissCookieBanner(page);
  let keywordInputName = "q";
  try {
    await page.waitForSelector('input[name="q"][type="text"]', { timeout: 8000 });
  } catch {
    try {
      await page.waitForSelector('input[name="title"]', { timeout: 8000 });
      keywordInputName = "title";
    } catch {
      throw new Error("Could not find keyword search input on SAP careers page");
    }
  }
  await page.fill(`input[name="${keywordInputName}"]`, keyword || "");
  if (location) await page.fill('input[name="locationsearch"]', location);
  await page.waitForSelector("#optionsFacetsDD_customfield3", { timeout: 25000 });
  await page.selectOption("#optionsFacetsDD_customfield3", statusValue);
  await page.selectOption("#optionsFacetsDD_country", country);
  await page.evaluate(() => { const btn = document.querySelector('input[type="submit"]'); if (btn) btn.click(); });
  await Promise.race([
    page.waitForSelector("a.jobTitle-link, .jobTitle-link, .jobTitle, .jobTitle a", { timeout: BASE_ACTION_TIMEOUT_MS }),
    page.waitForSelector(".no-results, .jobs-search-no-result", { timeout: BASE_ACTION_TIMEOUT_MS })
  ]);
  return page.evaluate(() => {
    const results = [], seen = new Set();
    // Try multiple selectors for job rows
    const jobRows = Array.from(document.querySelectorAll("#searchresults tbody tr.data-row, #searchresults tbody tr, tr.data-row, .job-listing-row, .job-row")).filter(row => row.querySelector("a"));
    jobRows.forEach(row => {
      let link = row.querySelector("a.jobTitle-link[href], .jobTitle-link[href], .jobTitle a[href], a[href]");
      if (!link) link = row.querySelector("a");
      if (!link) return;
      const url = link.href, key = (url || "").split("?")[0].replace(/\/+$/, "");
      if (!url || seen.has(key)) return;
      seen.add(key);
      results.push({
        title: link.textContent.trim(), url,
        date: row.querySelector('span[data-careersite-propertyid="date"], .job-date, .date, td.date')?.textContent?.trim() || "N/A",
        location: (() => { const el = row.querySelector(".colLocation .jobLocation, .jobLocation, td.location"); if (el) el.querySelectorAll("style, script").forEach(s => s.remove()); return el?.textContent?.replace(/\s+/g, " ").trim() || "N/A"; })(),
        requisitionId: (url.match(/\/(\d+)\/?$/) || [])[1] || "N/A",
        status: "Not Started"
      });
    });
    // Fallback: try all job links
    if (results.length === 0) {
      document.querySelectorAll("a.jobTitle-link[href], .jobTitle-link[href], .jobTitle a[href], a[href]").forEach(link => {
        const url = link.href, key = (url || "").split("?")[0].replace(/\/+$/, "");
        if (!url || seen.has(key)) return;
        seen.add(key);
        const row = link.closest("tr") || link.parentElement;
        results.push({
          title: link.textContent.trim(),
          url,
          date: row?.querySelector('span[data-careersite-propertyid="date"], .job-date, .date, td.date')?.textContent?.trim() || "N/A",
          location: (() => { const el = row?.querySelector(".colLocation .jobLocation, .jobLocation, td.location"); if (el) el.querySelectorAll("style, script").forEach(s => s.remove()); return el?.textContent?.replace(/\s+/g, " ").trim() || "N/A"; })(),
          requisitionId: (url.match(/\/(\d+)\/?$/) || [])[1] || "N/A",
          status: "Not Started"
        });
      });
    }
    return results;
  });
}

// ═══════════════════════════════════════════════════════════════
// POST /scrape
// ═══════════════════════════════════════════════════════════════

app.post("/scrape", async (req, res) => {
  const { keyword, location, country, careerStatus, period } = req.body;
  if (!country || !careerStatus || !period) return res.status(400).json({ success: false, error: "Missing required fields." });
  if (!keyword && !location) return res.status(400).json({ success: false, error: "Enter a keyword or location." });
  console.log(`Scraping: "${keyword}" in ${location || "all"}, ${country} (${careerStatus})`);
  try {
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);
    const allJobs = [], seenUrls = new Set();
    try {
      const jobs = await scrapeOnePage(page, keyword, location, country, careerStatus);
      for (const job of jobs) { const key = (job.url || "").split("?")[0].replace(/\/+$/, ""); if (!seenUrls.has(key)) { seenUrls.add(key); allJobs.push(job); } }
    } catch (err) {
      console.error(`Search failed: ${err.message}`);
      await page.close();
      return res.status(500).json({ success: false, error: `Search failed: ${safeError(err)}` });
    }
    await page.close();
    const jobsWithDates = await enrichJobsWithPostedDates(browser, allJobs);
    const filtered = filterByPeriod(jobsWithDates, period);

    // Add vector match scores if available
    const kw = keyword.toLowerCase();
    if (vectorReady && retrieveContext) {
      for (const job of filtered) {
        try {
          const result = await retrieveContext(job.title, { topSkills: 5, topProjects: 0, topWork: 0 });
          const avgRelevance = result.skills.length > 0
            ? result.skills.reduce((sum, s) => sum + (1 - s.distance) * 100, 0) / result.skills.length
            : 0;
          const vectorScore = Math.min(100, avgRelevance * 2);

          // Keyword-in-title boost: whole-word match = +30, substring = +15
          const titleLower = job.title.toLowerCase();
          const titleWordMatch = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(titleLower);
          const titleMatch = titleWordMatch || titleLower.includes(kw);
          const titleBonus = titleWordMatch ? 30 : titleLower.includes(kw) ? 15 : 0;

          // Recency bonus: up to +10 pts, fades linearly over 20 days
          let recencyBonus = 0;
          const postedD = parseJobDate(job.rawDate);
          if (postedD) {
            const daysSince = (Date.now() - postedD) / 86400000;
            recencyBonus = Math.max(0, 10 - daysSince * 0.5);
          }

          job.matchScore = Math.round(Math.min(100, vectorScore * 0.75 + titleBonus + recencyBonus));
          job.titleMatch = titleMatch;
          job.topMatchedSkills = result.skills.slice(0, 3).map(s => s.metadata.skill_name);
        } catch {
          job.matchScore = 0;
          job.titleMatch = false;
          job.topMatchedSkills = [];
        }
      }
      // Sort: title matches first, then by composite score descending
      filtered.sort((a, b) => {
        if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
        return (b.matchScore || 0) - (a.matchScore || 0);
      });
    } else {
      // No vector store: still sort title matches first
      filtered.forEach(job => {
        const titleLower = job.title.toLowerCase();
        job.titleMatch = titleLower.includes(kw);
      });
      filtered.sort((a, b) => (a.titleMatch === b.titleMatch ? 0 : a.titleMatch ? -1 : 1));
    }

    console.log(`Found ${filtered.length} jobs`);
    return res.json({ success: true, jobs: filtered });
  } catch (err) {
    console.error("Scrape error:", err.message);
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /fetch-jd
// ═══════════════════════════════════════════════════════════════

app.post("/fetch-jd", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "Missing url." });
  console.log(`Fetching JD: ${url}`);
  try {
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: BASE_NAV_TIMEOUT_MS });
    await dismissCookieBanner(page);
    const jd = await page.evaluate(() => {
      const title = document.querySelector('[data-careersite-propertyid="title"]')?.textContent?.trim() || document.querySelector("h1")?.textContent?.trim() || "Unknown";
      const locEl2 = document.querySelector('[data-careersite-propertyid="location"]') || document.querySelector(".jobLocation");
      if (locEl2) locEl2.querySelectorAll("style, script").forEach(s => s.remove());
      const location = locEl2?.textContent?.replace(/\s+/g, " ").trim() || "";
      const postedDate = document.querySelector('[data-careersite-propertyid="date"]')?.textContent?.trim() || "";
      const reqId = document.querySelector('[data-careersite-propertyid="facility"]')?.textContent?.trim() || "";
      const textSections = [];
      const jobContent = document.querySelector(".jdp-job-description-card, .job-description, [data-careersite-propertyid='description']");
      if (jobContent) textSections.push(jobContent.innerText.trim());
      if (!textSections.length) { const main = document.querySelector("main, .job-details, .jdp-job-description"); if (main) textSections.push(main.innerText.trim()); }

      // Extract structured sections from DOM headings
      const parsedSections = {};
      const container = jobContent || document.querySelector("main, .job-details, .jdp-job-description");
      if (container) {
        const headings = container.querySelectorAll("h1, h2, h3, h4, h5, strong, b");
        headings.forEach(h => {
          const label = h.textContent.trim();
          if (!label || label.length > 80 || label.length < 3) return;
          const content = [];
          let sibling = h.tagName === "STRONG" || h.tagName === "B" ? h.parentElement?.nextElementSibling : h.nextElementSibling;
          while (sibling && !["H1","H2","H3","H4","H5"].includes(sibling.tagName)) {
            const txt = sibling.innerText?.trim();
            if (txt) content.push(txt);
            if (sibling.querySelector("h1,h2,h3,h4,h5")) break;
            sibling = sibling.nextElementSibling;
          }
          if (content.length) parsedSections[label] = content.join("\n");
        });
      }
      return { title, location, postedDate, requisitionId: reqId, fullText: textSections.join("\n\n"), sections: parsedSections };
    });
    await page.close();
    console.log(`JD fetched: "${jd.title}" (${jd.fullText.length} chars)`);
    return res.json({ success: true, jd });
  } catch (err) {
    console.error("Fetch JD error:", err.message);
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /jd-summary — AI-compressed JD summary for UX panels
// ═══════════════════════════════════════════════════════════════

app.post("/jd-summary", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured" });
  const { jdText, title, location, requisitionId, postedDate } = req.body || {};
  if (!jdText || typeof jdText !== "string" || jdText.length < 50) {
    return res.status(400).json({ success: false, error: "Missing or too-short jdText" });
  }

  try {
    const systemPrompt = `You are a senior career strategist summarising SAP-style job descriptions for a job search dashboard.

You MUST return STRICT JSON only, no comments, no explanations, no markdown.

Your job:
- Read the full JD text.
- Produce a compact, honest overview sentence.
- Extract MUST HAVE vs NICE TO HAVE requirements in clear bullets.
- Summarise what the person will actually do in the role.
- Separately identify candidate SKILLS and TOOLS required.
- Keep all wording concise and concrete (no fluff).

IMPORTANT DISTINCTION:
- "skills" = professional competencies, soft skills, domain knowledge, methodologies (e.g. "Stakeholder management", "Business administration", "Data analysis")
- "tools" = specific named software, platforms, or technical instruments (e.g. "MS Excel", "SAP BTP", "Python", "Camtasia", "Jira")

Output schema (do not change keys):
{
  "snapshot": {
    "one_liner": "<1 sentence describing level, domain, and focus>",
    "work_area": "<short phrase or empty string>",
    "career_status": "<Student / Graduate / Professional / Unknown>",
    "employment_type": "<Working Student / Internship / Full-time / Unknown>"
  },
  "what_you_do_summary": [
    "<bullet 1>",
    "<bullet 2>"
  ],
  "what_you_bring_summary": [
    "<bullet 1>",
    "<bullet 2>"
  ],
  "must_have": [
    "<bullet 1>",
    "<bullet 2>"
  ],
  "nice_to_have": [
    "<bullet 1>",
    "<bullet 2>"
  ],
  "skills": [
    "<competency or domain knowledge phrase>",
    "<competency or domain knowledge phrase>"
  ],
  "tools": [
    "<tool name only, no descriptions>",
    "<tool name only, no descriptions>"
  ]
}

Rules:
- Max 5 items in must_have, max 4 items in nice_to_have.
- Max 7 items in skills, max 8 items in tools.
- For tools: use the shortest recognisable name (e.g. "Excel" not "proficiency in Excel"). Mark optional tools with a trailing "+" suffix (e.g. "Camtasia+").
- Use the exact competence wording from the JD when possible.
- Prefer content under headings like “What you’ll do / build / your tasks / your responsibilities” and “What you bring / your profile / requirements”.
- Ignore employer branding text and company slogans (for example: "We help the world run better", "At SAP, we keep it simple", "We win with inclusion").
- Only include bullets that describe the candidate’s skills, experience, education, tools, or languages.
- If something is clearly optional ("nice to have", "preferred", "bonus", "advantage"), put it under nice_to_have, and mark any tools as optional with "+" suffix.
- If you are unsure about work_area or employment_type, leave them as "" or "Unknown".`;

    const userPrompt = `JOB CONTEXT
Title: ${title || "Unknown"}
Location: ${location || "Unknown"}
Req ID: ${requisitionId || "Unknown"}
Posted: ${postedDate || "Unknown"}

FULL JOB DESCRIPTION
--------------------
${jdText}

Return ONLY valid JSON conforming to the schema above.`;

    const raw = await callAI(systemPrompt, userPrompt);
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const summary = JSON.parse(jsonStr);

    // Post-filter MUST HAVE to strip obvious non-requirement branding lines
    const requirementKeywords = ["experience", "knowledge", "skills", "degree", "background", "proficiency", "familiarity", "education"];
    const cleanedMust = Array.isArray(summary.must_have) ? summary.must_have.filter(b => {
      if (!b || typeof b !== "string") return false;
      const trimmed = b.trim();
      const lower = trimmed.toLowerCase();
      if (trimmed.startsWith("We ") || trimmed.startsWith("At SAP")) return false;
      if (!requirementKeywords.some(k => lower.includes(k))) return false;
      return true;
    }) : [];
    if (cleanedMust.length) summary.must_have = cleanedMust;

    return res.json({ success: true, summary });
  } catch (err) {
    console.error("JD summary error:", err.message);
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROMPT ENGINEERING — The Heart of Quality Generation
// ═══════════════════════════════════════════════════════════════

function buildCvSystemPrompt() {
  return `You are a CV content extractor for Varun Raval. Study the foundation documents carefully, then fill the JSON schema below.

RULES (non-negotiable):
- Every fact MUST come from the provided foundation documents. NEVER invent anything.
- Select 2-3 most relevant projects and experiences for THIS specific job.
- Reorder competencies and skills to match what the JD prioritizes.
- Write bullets that lead with action/tool/outcome — match Varun's voice from the samples.
- NEVER use generic filler ("Results-driven", "Proven track record", etc.)
- Return ONLY valid JSON. No markdown fences, no explanation, no extra text.

JSON SCHEMA (fill every field, use empty string "" if not applicable):
{
  "name": "VARUN RAVAL",
  "location": "<from samples>",
  "phone": "<from samples>",
  "email": "raval.varun@stud.hs-fresenius.de",
  "linkedin": "linkedin.com/in/varunraval",
  "github": "github.com/ravalvarun-SAP",
  "availability": "${getAvailability().cv}",
  "work_authorization": "Eligible to work as student in Germany",
  "languages": "English (fluent), German (B1 -- actively improving)",
  "profile": "<2-3 sentences: programme + what he brings for THIS job>",
  "competencies": [
    { "category": "<label>", "items": "<skill, skill, skill>" }
  ],
  "technical_skills": [
    { "category": "<label>", "items": "<Tool; Tool; Tool>" }
  ],
  "education": [
    {
      "degree": "<Degree -- Field>",
      "institution": "<Institution, City, Country>",
      "date": "<Start -- End (status)>",
      "coursework": "<Module; Module> or empty string"
    }
  ],
  "projects": [
    {
      "title": "<Project Title>",
      "date": "<Month Year or range>",
      "tech": "<Tech stack>",
      "bullets": ["<bullet>", "<bullet>"]
    }
  ],
  "experience": [
    {
      "title": "<Job Title>",
      "company": "<Company -- Department, City>",
      "date": "<Month Year -- Month Year>",
      "bullets": ["<bullet>", "<bullet>"]
    }
  ],
  "certifications": [
    {
      "name": "<Certification Name>",
      "date": "<Month Year>",
      "description": "<1-2 sentences>"
    }
  ]
}`;
}

function buildClSystemPromptLegacy() {
  return `You are a cover letter content extractor for Varun Raval. Study the foundation documents carefully, then fill the JSON schema below.

RULES (non-negotiable):
- Write as Varun Raval in first person. Every claim must be backed by foundation documents.
- NEVER invent experiences, metrics, or skills.
- NEVER use recruiter-speak ("I am excited to apply", "I believe I would be a great fit").
- Study how Varun actually opens his letters in the samples and replicate that energy.
- Use **double asterisks** around key technical terms to bold them (2-3 per paragraph max).
- Each paragraph: 3-5 sentences. Total word count 350-450 (fits 1 page).
- DO NOT include the closing "Thank you..." sentence — it is added automatically.
- Return ONLY valid JSON. No markdown fences, no explanation, no extra text.

JSON SCHEMA:
{
  "position_title": "<Job Title from JD>",
  "req_id": "<Req ID from JD or empty string>",
  "location": "<Job Location from JD>",
  "paragraphs": [
    "<Paragraph 1 — Opening: connect master programme + specific role + why it interests him>",
    "<Paragraph 2 — Academic & Research: coursework, research papers connecting to job requirements>",
    "<Paragraph 3 — Technical & Hands-on: projects, tools, SAP modules used — show direct JD relevance>",
    "<Paragraph 4 — Soft skills & Fit: collaboration, communication, specific situations>",
    "<Paragraph 5 — Closing availability: ${getAvailability().range} working student/internship/thesis>"
  ]
}`;
}

function buildClSystemPromptRAG(matchedSkills, matchedProjects, matchedWork) {
  const skillText = matchedSkills.map(s =>
    `[${s.id}] ${s.metadata.skill_name} (${s.metadata.level}): ${s.document}`
  ).join("\n");

  const projectText = matchedProjects.map(p =>
    `${p.metadata.name} (${p.metadata.tech}): ${p.document}`
  ).join("\n");

  const workText = matchedWork.map(w =>
    `${w.metadata.title} at ${w.metadata.company} (${w.metadata.period}): ${w.document}`
  ).join("\n");

  const style = styleProfile?.style_analysis || {};
  const styleSection = styleProfile ? `
=== WRITING STYLE (learned from Varun's real cover letters — ${styleProfile.total_samples} samples) ===
Tone: ${style.tone_description || "Professional but warm, specific not generic"}
Structure: ${style.structural_pattern || "Opening hook → academic evidence → project evidence → soft skills → availability"}
Average letter length: ${style.avg_cover_letter_words || 380} words
Average sentence length: ${style.avg_sentence_length || 24} words
Sentence variety: ${style.sentence_variety_pattern || "Long compound sentences, rarely short punchy ones"}
Evidence style: ${style.evidence_style || "Flowing narrative prose, never bullets. Company names and roles inline."}
Self-presentation: ${style.self_presentation_style || "Confident achiever, practical breadth, leads with experience years"}
How he bridges academic to practical: ${style.how_i_bridge_academic_to_practical || "Brief degree mention then immediately pivots to professional experience"}
How he states availability: ${style.how_i_handle_availability || "Simple direct sentence near closing: 'I can join from [Month]'"}

Opening patterns he actually uses (use one of these as the basis):
${(style.opening_patterns || []).slice(0, 4).map(p => `  - "${p}"`).join("\n")}

Closing patterns he uses:
${(style.closing_patterns || []).slice(0, 2).map(p => `  - "${p}"`).join("\n")}

Best opening example (study this carefully):
"${(styleProfile.best_opening_examples || [])[0] || ""}"

Phrases he naturally uses: ${(style.signature_phrases || []).join(" | ")}
Connector words he favors: ${(style.connector_words || []).join(", ")}
Words/phrases he NEVER uses: ${(style.things_to_never_write_as_me || style.vocabulary_preferences?.avoids || []).join(" | ")}

CRITICAL RULES from his style:
- Uses bold: ${style.uses_bold === false ? "NO — never use **bold** in cover letters" : "yes"}
- Typical paragraph count: ${style.paragraph_count_typical || 5}
- Evidence = flowing prose narrative, NEVER bullet points inside the letter body
- Name employers and years of experience explicitly ("At Byju's...", "12 years of experience...")
- Do NOT write "I am excited", "I am passionate", "please find attached", "I look forward to"` : "";

  return `You are writing a cover letter AS Varun Raval for an SAP-related student position in Germany.

=== CANDIDATE PROFILE ===
Name: Varun Raval
Email: raval.varun@stud.hs-fresenius.de | Phone: (+49) 01727546835
Location: Walldorf / Heidelberg / Mannheim (open to hybrid)
Languages: English (fluent), German (B1)
Availability: ${getAvailability().prose}
Education: M.Sc. SAP Engineering & Analytics, Hochschule Fresenius (Oct 2025–present) → M.Des Communication Design, MIT Institute of Design (2015-2018) → B.Eng Computer Engineering (2010-2013)
SAP Experience: 1.5+ years at SAP Walldorf across 3 departments

=== MATCHED SKILLS (retrieved by semantic similarity to THIS job) ===
These are the ONLY facts you may use. Do not invent anything.
${skillText}

=== RELEVANT PROJECTS ===
${projectText}

=== RELEVANT WORK EXPERIENCE ===
${workText}
${styleSection}

=== GENERATION RULES ===
1. Use ONLY skills and evidence from the matched data above. NEVER invent.
2. Pick the 4-6 MOST relevant items. Not all of them.
3. Use quantified evidence when available (80% reduction, 1,000+ records, etc.)
4. Write in first person as Varun.
5. Structure: Opening hook → 2-3 evidence paragraphs → Closing with availability.
6. Length: 300-400 words. Concise.
7. Reference the specific team/product mentioned in the job posting.
8. Use **bold** around 2-3 key technical terms per paragraph.
9. If job requires fluent German and candidate has B1, be honest about it.
10. DO NOT include the closing "Thank you..." sentence — it is added automatically.

=== NEVER USE THESE PHRASES ===
"I am excited to apply", "I believe I would be a great fit", "leverage my skills",
"I am confident that", "throughout my career", "passion for", "I am eager to",
"testament to", "landscape", "groundbreaking", "nestled", "tapestry",
"delve into", "in conclusion", "the future looks bright"
${styleProfile ? `Also never write (Varun's personal no-go phrases): ${(styleProfile.style_analysis?.things_to_never_write_as_me || []).join(" | ")}` : ""}

=== OUTPUT FORMAT ===
Return ONLY valid JSON. No markdown fences, no explanation, no extra text.
{
  "position_title": "<from JD>",
  "req_id": "<from JD or empty>",
  "location": "<from JD>",
  "paragraphs": [
    "<Opening: connect programme + specific role + genuine interest>",
    "<Academic & Research: coursework, papers connecting to JD requirements>",
    "<Technical & Hands-on: projects, tools, SAP modules — direct JD relevance>",
    "<Soft skills & Fit: collaboration, communication, specific situations>",
    "<Closing: availability ${getAvailability().range}, working student/internship/thesis>"
  ]
}`;
}

function buildCvSystemPromptRAG(matchedSkills, matchedProjects, matchedWork, pinnedWeIds, pinnedProjectIds) {
  const skillText = matchedSkills.map(s =>
    `[${s.id}] ${s.metadata.skill_name} (${s.metadata.level}): ${s.document}`
  ).join("\n");

  const projectText = matchedProjects.map(p =>
    `${p.metadata.name} (${p.metadata.tech}): ${p.document}`
  ).join("\n");

  const workText = matchedWork.map(w =>
    `${w.metadata.title} at ${w.metadata.company} (${w.metadata.period}): ${w.document}`
  ).join("\n");

  return `You are a CV content extractor for Varun Raval. Use ONLY the matched skill data below.

=== MATCHED SKILLS (for THIS job) ===
${skillText}

=== RELEVANT PROJECTS ===
${projectText}

=== RELEVANT WORK EXPERIENCE ===
${workText}

RULES (non-negotiable):
- Every fact MUST come from the matched data above. NEVER invent anything.
- Reorder competencies and skills to match what the JD prioritizes.
- Write bullets that lead with action/tool/outcome.
- NEVER use generic filler ("Results-driven", "Proven track record", etc.)
- Return ONLY valid JSON. No markdown fences, no explanation, no extra text.

${pinnedWeIds?.length ? `WORK EXPERIENCE — USER-SELECTED (hard constraint):
The user has manually selected exactly these work experience entries. Include ALL of them in the experience section, in this order. Do not add or remove any entries:
${pinnedWeIds.map((id, i) => `${i + 1}. ${id}`).join("\n")}
These IDs match the entries in the RELEVANT WORK EXPERIENCE data above.` : `WORK EXPERIENCE RULES (important):
- DEFAULT (SAP / tech / student roles): include ONLY the 3 SAP roles (IX Studio, Non-Commercial Licensing, Services Sales DemGen) in the experience section.
  After those 3, add ONE compressed line as a single entry: { "title": "Earlier Experience", "company": "Media & EdTech (Byju's, Orange Sellers, Filmalaya, others)", "date": "2014 – 2024", "bullets": ["Creative production, UX research, video direction and EdTech content roles across India, Netherlands and Germany — full detail available on request."] }
- EXCEPTION (only if the JD explicitly targets media/film/video/EdTech/creative roles): include the relevant earlier media/EdTech roles in full.`}

${pinnedProjectIds?.length ? `PROJECTS — USER-SELECTED (hard constraint):
Include ONLY these projects (all of them, nothing else):
${pinnedProjectIds.map((id, i) => `${i + 1}. ${id}`).join("\n")}` : `PROJECTS: Select 2-3 most relevant from the matched data above.`}

EDUCATION: Include ONLY M.Sc. SAP Engineering & Analytics (Hochschule Fresenius) and M.Des Communication Design (MIT Institute of Design). Do NOT include University of Bremen or any unfinished course.

JSON SCHEMA (fill every field, use empty string "" if not applicable):
{
  "name": "VARUN RAVAL",
  "location": "Walldorf / Heidelberg / Mannheim, Germany",
  "phone": "(+49) 0172 754 6835",
  "email": "raval.varun@stud.hs-fresenius.de",
  "linkedin": "linkedin.com/in/varunraval",
  "github": "github.com/ravalvarun-SAP",
  "availability": "${getAvailability().cv}",
  "work_authorization": "Eligible to work as student in Germany",
  "languages": "English (fluent), German (B1 -- actively improving)",
  "profile": "<2-3 sentences: programme + what he brings for THIS job>",
  "competencies": [{ "category": "<label>", "items": "<skill, skill, skill>" }],
  "technical_skills": [{ "category": "<label>", "items": "<Tool; Tool; Tool>" }],
  "education": [{ "degree": "<Degree -- Field>", "institution": "<Institution, City, Country>", "date": "<Start -- End (status)>", "coursework": "<Module; Module> or empty string" }],
  "projects": [{ "title": "<Project Title>", "date": "<Month Year or range>", "tech": "<Tech stack>", "bullets": ["<bullet>", "<bullet>"] }],
  "experience": [{ "title": "<Job Title>", "company": "<Company -- Department, City>", "date": "<Month Year -- Month Year>", "bullets": ["<bullet>", "<bullet>"] }],
  "certifications": [{ "name": "<Certification Name>", "date": "<Month Year>", "description": "<1-2 sentences>" }]
}`;
}

function buildGenerationPrompt(jobDescription, selectedSamples, domainInsights, docType) {
  let prompt = `=== TARGET JOB DESCRIPTION ===\n${jobDescription}\n\n`;

  if (selectedSamples && selectedSamples.length > 0) {
    prompt += `=== VARUN'S REAL ${docType.toUpperCase()}S (study these carefully) ===\n`;
    prompt += `Learn his exact writing style, vocabulary, and sentence patterns.\n`;
    prompt += `ONLY use facts that appear in these documents.\n\n`;
    for (const sample of selectedSamples) {
      prompt += `--- ${sample.filename || sample.id || "Document"} ---\n${sample.text}\n\n`;
    }
  }

  if (domainInsights && (domainInsights.bestPerformingSkills || domainInsights.avoidPatterns)) {
    prompt += `=== INSIGHTS FROM PAST APPLICATIONS ===\n`;
    if (domainInsights.bestPerformingSkills) prompt += `Skills that got interviews: ${domainInsights.bestPerformingSkills.join(", ")}\n`;
    if (domainInsights.avoidPatterns) prompt += `Avoid: ${domainInsights.avoidPatterns.join(", ")}\n`;
    prompt += "\n";
  }

  prompt += `=== TASK ===\nGenerate a complete ${docType} tailored to the job above.\nUse ONLY facts from the foundation documents. Reorganize and emphasize what matches this job.\nMatch Varun's voice exactly. Output ONLY the final text, no commentary.\n`;
  return prompt;
}

// ═══════════════════════════════════════════════════════════════
// GET /cv-selector-data  — Returns WE + Projects with match scores
// ═══════════════════════════════════════════════════════════════

app.post("/cv-selector-data", async (req, res) => {
  const { jdText } = req.body || {};
  if (!jdText) return res.status(400).json({ success: false, error: "Missing jdText" });

  try {
    const bank = skillBank || {};
    const allWE = bank.work_experience || [];
    const allProjects = bank.projects || [];

    // Score each WE + project against JD using TF-IDF (reuse existing STOPWORDS + scoreDoc)
    const jdLower = jdText.toLowerCase();
    const jdTokens = jdLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
    const jdFreq = {};
    for (const t of jdTokens) jdFreq[t] = (jdFreq[t] || 0) + 1;

    function scoreItem(textParts) {
      const combined = textParts.join(" ").toLowerCase();
      let hits = 0;
      for (const t in jdFreq) {
        if (combined.includes(t)) hits += jdFreq[t];
      }
      const maxPossible = Object.values(jdFreq).reduce((s, v) => s + v, 0) || 1;
      return Math.min(100, Math.round((hits / maxPossible) * 300));
    }

    const scoredWE = allWE.map(we => ({
      id: we.id,
      title: we.title,
      company: we.company,
      period: we.period,
      location: we.location || "",
      skills_used: we.skills_used || [],
      score: scoreItem([we.title, we.company, (we.bullets || []).join(" "), (we.skills_used || []).join(" ")])
    })).sort((a, b) => b.score - a.score);

    const scoredProjects = allProjects.map(p => ({
      id: p.id,
      name: p.name,
      tech: p.tech,
      date: p.date,
      score: scoreItem([p.name, p.tech, p.description || ""])
    })).sort((a, b) => b.score - a.score);

    // Auto-tick top 3 WE + top 3 Projects
    const topWeIds = scoredWE.slice(0, 3).map(w => w.id);
    const topProjectIds = scoredProjects.slice(0, 3).map(p => p.id);

    return res.json({
      success: true,
      work_experience: scoredWE,
      projects: scoredProjects,
      aiPickWE: topWeIds,
      aiPickProjects: topProjectIds
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /generate
// ═══════════════════════════════════════════════════════════════

app.post("/generate", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured. Set ANTHROPIC_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY in .env" });

  const { jobDescription, documentType, humanizeText, pinnedWeIds, pinnedProjectIds } = req.body;
  if (!jobDescription || !documentType) return res.status(400).json({ success: false, error: "Missing jobDescription or documentType." });

  const now = Date.now();
  const wait = AI_MIN_GAP_MS - (now - lastAICall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastAICall = Date.now();

  try {
    let systemPrompt;
    let userPrompt;
    let ragContext = null;
    const docLabel = documentType === "cv" ? "CV" : "Cover Letter";
    const modelUsed = aiProvider === "claude" ? CLAUDE_MODEL : aiProvider === "groq" ? GROQ_MODEL : GEMINI_MODEL;

    // ── RAG-based generation (primary path) ──
    if (vectorReady && retrieveContext) {
      ragContext = await retrieveContext(jobDescription, { topSkills: 12, topProjects: 3, topWork: 2 });
      console.log(`  RAG: ${ragContext.skills.length} skills, ${ragContext.projects.length} projects, ${ragContext.work.length} work`);

      // If user pinned specific WE/Project IDs, inject them from skill_data_bank
      if (pinnedWeIds?.length || pinnedProjectIds?.length) {
        const bank = skillBank || {};
        if (pinnedWeIds?.length) {
          const pinned = (bank.work_experience || []).filter(w => pinnedWeIds.includes(w.id));
          ragContext.work = pinned.map(w => ({
            id: w.id,
            document: `${w.title} at ${w.company} (${w.period}): ${(w.bullets||[]).join(' ')}`,
            metadata: { title: w.title, company: w.company, period: w.period }
          }));
        }
        if (pinnedProjectIds?.length) {
          const pinned = (bank.projects || []).filter(p => pinnedProjectIds.includes(p.id));
          ragContext.projects = pinned.map(p => ({
            id: p.id,
            document: p.description || p.name,
            metadata: { name: p.name, tech: p.tech }
          }));
        }
        console.log(`  Pinned overrides: ${ragContext.work.length} WE, ${ragContext.projects.length} projects`);
      }

      systemPrompt = documentType === "cv"
        ? buildCvSystemPromptRAG(ragContext.skills, ragContext.projects, ragContext.work, pinnedWeIds, pinnedProjectIds)
        : buildClSystemPromptRAG(ragContext.skills, ragContext.projects, ragContext.work);

      userPrompt = `=== TARGET JOB DESCRIPTION ===\n${jobDescription}\n\n=== TASK ===\nGenerate a complete ${docLabel} tailored to the job above.\nUse ONLY facts from the matched skill data. Output ONLY the final JSON.\n`;
    } else {
      return res.status(503).json({ success: false, error: "Vector store not initialized. Ensure skill_data_bank.json and vector_store.json exist and restart the server." });
    }

    console.log(`Generating ${docLabel} via ${aiProvider} (${ragContext ? "RAG" : "legacy"})...`);
    const rawContent = await callAI(systemPrompt, userPrompt);
    console.log(`Done: ${rawContent.length} chars`);

    // Parse JSON from AI response
    let contentJson = null;
    let content = rawContent;
    try {
      const jsonStr = rawContent.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      contentJson = JSON.parse(jsonStr);
      content = documentType === "cv" ? jsonToDisplayCv(contentJson) : jsonToDisplayCl(contentJson);
      console.log(`JSON parsed OK. Display text: ${content.length} chars`);
    } catch (parseErr) {
      console.warn("JSON parse failed, using raw text:", parseErr.message);
    }

    // ── Humanizer pass (if requested and available) ──
    let humanizedContent = null;
    if (humanizeText !== false && humanize) {
      try {
        const waitH = AI_MIN_GAP_MS - (Date.now() - lastAICall);
        if (waitH > 0) await new Promise(r => setTimeout(r, waitH));
        lastAICall = Date.now();
        const result = await humanize(content, callAI);
        if (result.changes_made) {
          humanizedContent = result.humanized;
          console.log(`Humanizer: ${result.changes_made ? "changes applied" : "no changes needed"}`);
        }
      } catch (hErr) {
        console.warn("Humanizer failed:", hErr.message);
      }
    }

    // ── Application tracking ──
    let appEntry = null;
    if (ragContext && skillBankManager) {
      try {
        const reqIdMatch = jobDescription.match(/(?:Req(?:uisition)?\s*(?:ID)?[:\s#]*|#)(\d{5,7})/i);
        const titleMatch = jobDescription.match(/(?:Working Student|Intern|Werkstudent)[^.\n]*/i);
        appEntry = skillBankManager.logApplication({
          company: "SAP",
          role: titleMatch ? titleMatch[0].trim() : "Unknown Role",
          requisition_id: reqIdMatch ? reqIdMatch[1] : null,
          chunks_used: ragContext.skills.map(s => s.id),
          document_type: documentType,
          status: "generated"
        });
        console.log(`  Tracked: ${appEntry.id}`);
      } catch (trackErr) {
        console.warn("Application tracking failed:", trackErr.message);
      }
    }

    return res.json({
      success: true,
      content: humanizedContent || content,
      contentJson,
      humanized: !!humanizedContent,
      decisions: {
        model: modelUsed,
        provider: aiProvider,
        mode: ragContext ? "RAG" : "legacy",
        chunksUsed: ragContext ? ragContext.skills.map(s => ({ id: s.id, skill: s.metadata.skill_name, relevance: s.relevance })) : [],
        documentType
      },
      applicationId: appEntry?.id || null
    });
  } catch (err) {
    console.error("Generate error:", err.message);
    const is429 = err.status === 429 || err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED");
    if (is429) {
      let sec = 60; const m = err.message?.match(/retry in ([\d.]+)s/i); if (m) sec = Math.ceil(parseFloat(m[1]));
      return res.status(429).json({ success: false, error: `Rate limit. Wait ~${sec}s.`, retryAfter: sec });
    }
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /export-pdf  — Real LaTeX → PDF via pdflatex (MiKTeX)
// ═══════════════════════════════════════════════════════════════

app.post("/export-pdf", async (req, res) => {
  const { content, contentJson, type, filename } = req.body || {};
  if ((!content && !contentJson) || !type) return res.status(400).json({ success: false, error: "Missing content or type." });

  const safeName = (filename || `${type}_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sap-pdf-"));
  const texFile = path.join(tmpDir, `${safeName}.tex`);
  const pdfFile = path.join(tmpDir, `${safeName}.pdf`);
  const outDir = path.join(__dirname, "generated");

  try {
    // Prefer JSON-based LaTeX (clean template injection); fall back to text parsing
    const texSrc = contentJson
      ? (type === "cv" ? buildCvLatexFromJson(contentJson) : buildClLatexFromJson(contentJson))
      : (type === "cv" ? buildCvLatex(content) : buildClLatex(content));
    fs.writeFileSync(texFile, texSrc, "utf-8");

    // Run pdflatex twice so references/spacing settle
    await runPdflatex(texFile, tmpDir);
    await runPdflatex(texFile, tmpDir);

    if (!fs.existsSync(pdfFile)) throw new Error("pdflatex did not produce a PDF. Check .tex syntax.");

    const pdfBuffer = fs.readFileSync(pdfFile);
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(pdfFile, path.join(outDir, `${safeName}.pdf`));

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF export error:", err.message);
    // On failure, try to return the log for debugging
    const logFile = path.join(tmpDir, `${safeName}.log`);
    let logSnippet = "";
    try { logSnippet = fs.readFileSync(logFile, "utf-8").slice(-1500); } catch {}
    return res.status(500).json({ success: false, error: safeError(err), log: IS_PROD ? undefined : logSnippet });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

function runPdflatex(texFile, outDir) {
  return new Promise((resolve, reject) => {
    execFile(
      "pdflatex",
      ["-interaction=nonstopmode", `-output-directory=${outDir}`, texFile],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        // pdflatex returns non-zero on warnings too — only fail if no PDF produced
        if (err && err.code !== 1) return reject(new Error(stderr || err.message));
        resolve();
      }
    );
  });
}

// ═══════════════════════════════════════════════════════════════
// LaTeX SOURCE BUILDERS — strict match to user's .tex templates
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// JSON → DISPLAY TEXT (for textarea preview)
// ═══════════════════════════════════════════════════════════════

function jsonToDisplayCv(j) {
  const lines = [];
  lines.push(j.name || "VARUN RAVAL");
  if (j.location) lines.push(j.location);
  const ph = [j.phone && `Phone: ${j.phone}`, j.email && `Email: ${j.email}`].filter(Boolean).join(" | ");
  if (ph) lines.push(ph);
  const lnk = [j.linkedin && `LinkedIn: ${j.linkedin}`, j.github && `GitHub: ${j.github}`].filter(Boolean).join(" | ");
  if (lnk) lines.push(lnk);
  if (j.availability) lines.push(`Availability: ${j.availability}`);
  if (j.work_authorization) lines.push(`Work authorization: ${j.work_authorization}`);
  if (j.languages) lines.push(`Languages: ${j.languages}`);
  lines.push("");

  if (j.profile) {
    lines.push("PROFILE"); lines.push(j.profile); lines.push("");
  }
  if (j.competencies?.length) {
    lines.push("KEY COMPETENCIES");
    j.competencies.forEach(c => lines.push(`${c.category}: ${c.items}`));
    lines.push("");
  }
  if (j.technical_skills?.length) {
    lines.push("TECHNICAL SKILLS");
    j.technical_skills.forEach(s => lines.push(`${s.category}: ${s.items}`));
    lines.push("");
  }
  if (j.education?.length) {
    lines.push("EDUCATION");
    j.education.forEach((ed, i) => {
      lines.push(`${ed.degree}   ${ed.date}`);
      lines.push(ed.institution);
      if (ed.coursework) lines.push(`Selected coursework: ${ed.coursework}`);
      if (i < j.education.length - 1) lines.push("");
    });
    lines.push("");
  }
  if (j.projects?.length) {
    lines.push("PROJECTS (MOST RELEVANT)");
    j.projects.forEach((p, i) => {
      lines.push(`${p.title}   ${p.date}`);
      lines.push(p.tech);
      (p.bullets || []).forEach(b => lines.push(`- ${b}`));
      if (i < j.projects.length - 1) lines.push("");
    });
    lines.push("");
  }
  if (j.experience?.length) {
    lines.push("WORK EXPERIENCE");
    j.experience.forEach((ex, i) => {
      lines.push(`${ex.title}   ${ex.date}`);
      lines.push(ex.company);
      (ex.bullets || []).forEach(b => lines.push(`- ${b}`));
      if (ex.description) lines.push(ex.description);
      if (i < j.experience.length - 1) lines.push("");
    });
    lines.push("");
  }
  if (j.certifications?.length) {
    lines.push("CERTIFICATIONS / TRAINING");
    j.certifications.forEach((c, i) => {
      lines.push(`${c.name}   ${c.date}`);
      lines.push(c.description);
      if (i < j.certifications.length - 1) lines.push("");
    });
  }
  return lines.join("\n");
}

function jsonToDisplayCl(j) {
  const lines = [];
  const pos = [j.position_title && `Position: ${j.position_title}`, j.req_id && `Req ID: ${j.req_id}`, j.location && `Location: ${j.location}`].filter(Boolean).join(" | ");
  if (pos) { lines.push(pos); lines.push(""); }
  lines.push("Dear Hiring Manager,"); lines.push("");
  (j.paragraphs || []).forEach(p => { lines.push(p); lines.push(""); });
  lines.push("Thank you very much for considering my application. I would be pleased to discuss how my SAP-aligned studies, analytics journey, and SAP project experience can support your team's objectives.");
  lines.push(""); lines.push("Best regards,"); lines.push(""); lines.push("Varun Raval");
  lines.push(""); lines.push("raval.varun@stud.hs-fresenius.de | linkedin.com/in/varunraval | github.com/ravalvarun-SAP");
  lines.push(""); lines.push("I am open to a full-time internship or a working student position (80 hours/month) in Germany.");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// JSON → LaTeX BUILDERS (clean template injection — no parsing)
// ═══════════════════════════════════════════════════════════════

const LATEX_CV_PREAMBLE = `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{enumitem}
\\usepackage{xcolor}
\\usepackage{hyperref}
\\usepackage{titlesec}

\\definecolor{heading}{HTML}{111111}
\\definecolor{body}{HTML}{333333}
\\definecolor{lighttext}{HTML}{666666}
\\definecolor{linkcolor}{HTML}{003366}

\\hypersetup{colorlinks=true,urlcolor=linkcolor,linkcolor=linkcolor}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{1pt}
\\renewcommand{\\baselinestretch}{1.05}
\\setlist[itemize]{leftmargin=1.8em,itemsep=1pt,topsep=1pt}
\\titleformat{\\section}{\\large\\bfseries\\color{heading}}{}{0pt}{}
\\titlespacing*{\\section}{0pt}{6pt}{2pt}
\\newcommand{\\sectrule}{\\vspace{2pt}\\hrule\\vspace{3pt}}
\\newcommand{\\name}[1]{{\\Huge\\bfseries\\color{heading} #1}\\par\\vspace{4pt}}

\\begin{document}
\\pagestyle{empty}

`;

const LATEX_CL_PREAMBLE = `\\documentclass[11pt,a4paper]{article}
\\usepackage[top=2.5cm,bottom=2.5cm,left=2.8cm,right=2.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{parskip}
\\usepackage{xcolor}
\\usepackage{hyperref}

\\definecolor{lighttext}{HTML}{555555}
\\hypersetup{colorlinks=true,urlcolor=black,linkcolor=black}
\\setstretch{1.15}
\\setlength{\\parskip}{0.75em}
\\setlength{\\parindent}{0pt}
\\pagestyle{empty}

\\begin{document}
`;

function buildCvLatexFromJson(j) {
  const e = escapeTex;
  let body = "";

  // Name
  body += `\\name{${e(j.name || "VARUN RAVAL")}}\n\n`;

  // Header contact block
  body += `{\\small\n`;
  if (j.location) body += `\\color{lighttext}${e(j.location)}\\par\n\\color{body}\n`;
  const contactParts = [];
  if (j.phone) contactParts.push(`\\textbf{Phone:} ${e(j.phone)}`);
  if (j.email) contactParts.push(`\\textbf{Email:} \\href{mailto:${j.email}}{${e(j.email)}}`);
  if (contactParts.length) body += contactParts.join(" \\quad ") + "\\par\n";
  const linkParts = [];
  if (j.linkedin) linkParts.push(`\\textbf{LinkedIn:} \\href{https://${j.linkedin}}{${e(j.linkedin)}}`);
  if (j.github) linkParts.push(`\\textbf{GitHub:} \\href{https://${j.github}}{${e(j.github)}}`);
  if (linkParts.length) body += linkParts.join(" \\quad ") + "\\par\n";
  if (j.availability) body += `\\textbf{Availability:} ${e(j.availability)}\\par\n`;
  if (j.work_authorization) body += `\\textbf{Work authorization:} ${e(j.work_authorization)}\\par\n`;
  if (j.languages) body += `\\textbf{Languages:} ${e(j.languages)}\\par\n`;
  body += `}\n\n\\vspace{3pt}\n\\sectrule\n\n`;

  // Profile
  if (j.profile) {
    body += `\\section*{PROFILE}\n{\\color{body}\n${e(j.profile)}\n}\n\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Key Competencies
  if (j.competencies?.length) {
    body += `\\section*{KEY COMPETENCIES}\n{\\color{body}\n`;
    j.competencies.forEach((c, i) => {
      body += `{\\color{heading}\\textbf{${e(c.category)}:}} ${e(c.items)}`;
      body += i < j.competencies.length - 1 ? "\\par\n" : "\n";
    });
    body += `}\n\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Technical Skills
  if (j.technical_skills?.length) {
    body += `\\section*{TECHNICAL SKILLS}\n`;
    j.technical_skills.forEach(s => {
      body += `{\\color{heading}\\textbf{${e(s.category)}:}} {\\color{body}${e(s.items)}}\\par\n`;
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Education
  if (j.education?.length) {
    body += `\\section*{EDUCATION}\n`;
    j.education.forEach((ed, i) => {
      body += `{\\color{heading}\\textbf{${e(ed.degree)}}} \\hfill\n{\\color{lighttext}${e(ed.date)}}\\par\n`;
      body += `{\\color{body}${e(ed.institution)}}\\par\n`;
      if (ed.coursework) body += `{\\color{body}\\textit{Selected coursework:} ${e(ed.coursework)}}\\par\n`;
      body += i < j.education.length - 1 ? "\n\\vspace{2pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Projects
  if (j.projects?.length) {
    body += `\\section*{PROJECTS (MOST RELEVANT)}\n`;
    j.projects.forEach((p, i) => {
      body += `{\\color{heading}\\textbf{${e(p.title)}}} \\hfill\n{\\color{lighttext}${e(p.date)}}\\par\n`;
      body += `{\\color{body}\\textit{${e(p.tech)}}}\\par\n`;
      if (p.bullets?.length) {
        body += `\\begin{itemize}\n`;
        p.bullets.forEach(b => body += `  \\item ${e(b)}\n`);
        body += `\\end{itemize}\n`;
      }
      body += i < j.projects.length - 1 ? "\n\\vspace{3pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Work Experience
  if (j.experience?.length) {
    body += `\\section*{WORK EXPERIENCE}\n`;
    j.experience.forEach((ex, i) => {
      body += `{\\color{heading}\\textbf{${e(ex.title)}}} \\hfill\n{\\color{lighttext}${e(ex.date)}}\\par\n`;
      body += `{\\color{body}\\textit{${e(ex.company)}}}\\par\n`;
      if (ex.bullets?.length) {
        body += `\\begin{itemize}\n`;
        ex.bullets.forEach(b => body += `  \\item ${e(b)}\n`);
        body += `\\end{itemize}\n`;
      } else if (ex.description) {
        body += `{\\color{body}\n${e(ex.description)}\n}\n`;
      }
      body += i < j.experience.length - 1 ? "\n\\vspace{3pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Certifications
  if (j.certifications?.length) {
    body += `\\section*{CERTIFICATIONS / TRAINING}\n`;
    j.certifications.forEach((c, i) => {
      body += `{\\color{heading}\\textbf{${e(c.name)}}} \\hfill\n{\\color{lighttext}${e(c.date)}}\\par\n`;
      body += `{\\color{body}\n${e(c.description)}\n}\n`;
      body += i < j.certifications.length - 1 ? "\n\\vspace{3pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  return LATEX_CV_PREAMBLE + body + `\n\\end{document}\n`;
}

function buildClLatexFromJson(j) {
  const e = escapeTex;
  let body = "";

  // Title
  body += `\\begin{center}\n  {\\large \\textbf{\\textsc{Cover Letter}}}\n\\end{center}\n\\vspace{1.2em}\n\n`;

  // Position info line
  const posLineParts = [];
  if (j.position_title) posLineParts.push(`Position: ${j.position_title}`);
  if (j.req_id) posLineParts.push(`Req ID: ${j.req_id}`);
  if (j.location) posLineParts.push(`Location: ${j.location}`);
  if (posLineParts.length) {
    body += `\\begin{center}\n  {\\small\\color{lighttext} ${e(posLineParts.join(" | "))}}\n\\end{center}\n\\vspace{0.4em}\n\n`;
  }

  // Salutation
  body += `Dear Hiring Manager,\n\n`;

  // Body paragraphs (with **bold** → \textbf{})
  (j.paragraphs || []).forEach(para => {
    const escaped = e(para);
    const withBold = escaped.replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}");
    body += `${withBold}\n\n`;
  });

  // Fixed closing sentence + sign-off (from template)
  body += `Thank you very much for considering my application. I would be pleased to discuss how my SAP\\nobreakdash-aligned studies, analytics journey, and SAP project experience can support your team's objectives.\n\n`;
  body += `\\vspace{1.6em}\nBest regards,\n\n\\vspace{0.3em}\n\\textbf{Varun Raval}\n\n\\vspace{0.2em}\n`;
  body += `{\\small\n\\href{mailto:raval.varun@stud.hs-fresenius.de}{raval.varun@stud.hs-fresenius.de}\n`;
  body += `\\enspace\\textbar\\enspace\n\\href{https://linkedin.com/in/varunraval}{linkedin.com/in/varunraval}\n`;
  body += `\\enspace\\textbar\\enspace\n\\href{https://github.com/ravalvarun-SAP}{github.com/ravalvarun-SAP}\n}\n\n`;
  body += `\\vspace{0.4em}\n{\\small\\textit{I am open to a full-time internship or a working student position (80\\,hours/month) in Germany.}}\n`;

  return LATEX_CL_PREAMBLE + body + `\n\\end{document}\n`;
}

/** Escape special LaTeX characters in plain text */
function escapeTex(s) {
  if (!s) return "";
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/</g, "\\textless{}")
    .replace(/>/g, "\\textgreater{}")
    .replace(/\|/g, "\\textbar{}");
}

/** Detect if a line ends with a date-like string (year, Month Year, range) */
function splitTitleDate(line) {
  // Match: "Title    Date" where Date contains a 4-digit year
  const m = line.match(/^(.+?)\s{3,}(.+\d{4}.*)$/);
  if (m) return [m[1].trim(), m[2].trim()];
  // Tab-separated fallback
  const t = line.split("\t");
  if (t.length >= 2 && /\d{4}/.test(t[t.length - 1])) return [t[0].trim(), t[t.length - 1].trim()];
  return null;
}

/** Detect ALL-CAPS section headers (letters + spaces + & + / + - + parens) */
function isSectionHeader(line) {
  return /^[A-Z][A-Z\s&/()\-]{2,}$/.test(line.trim()) && line.trim().length < 70;
}

function buildCvLatex(content) {
  const lines = content.split("\n");
  let i = 0;
  let body = "";

  // ── 1. NAME (first non-empty line) ──────────────────────────
  while (i < lines.length && !lines[i].trim()) i++;
  const nameRaw = lines[i] ? lines[i].trim() : "VARUN RAVAL";
  i++;
  body += `\\name{${escapeTex(nameRaw)}}\n\n`;

  // ── 2. HEADER CONTACT BLOCK ──────────────────────────────────
  // Collect lines until first blank after name
  const headerLines = [];
  while (i < lines.length) {
    const l = lines[i].trim();
    if (!l) { i++; break; }
    headerLines.push(l);
    i++;
  }

  body += `{\\small\n`;
  let firstHeader = true;
  for (const hl of headerLines) {
    const e = escapeTex(hl);
    // Location line (no label prefix)
    if (firstHeader && !/^(Phone|Email|LinkedIn|GitHub|Availability|Work|Languages)/i.test(hl)) {
      body += `\\color{lighttext}${e}\\par\n\\color{body}\n`;
      firstHeader = false;
      continue;
    }
    firstHeader = false;
    // Lines with known labels → bold labels + pipe-separated on same line
    // Handle "Phone: X | Email: Y" or "LinkedIn: X | GitHub: Y" combos
    const segments = hl.split("|").map(s => s.trim());
    const parts = segments.map(seg => {
      const ci = seg.indexOf(":");
      if (ci === -1) return escapeTex(seg);
      const label = seg.substring(0, ci).trim();
      const val = seg.substring(ci + 1).trim();
      const eVal = escapeTex(val);
      // Wrap emails and URLs as \href
      const fVal = eVal.replace(
        /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g,
        (m2) => `\\href{mailto:${m2}}{${m2}}`
      ).replace(
        /(linkedin\.com\/[^\s,;]+|github\.com\/[^\s,;]+)/gi,
        (m2) => `\\href{https://${m2}}{${m2}}`
      );
      return `\\textbf{${escapeTex(label)}:} ${fVal}`;
    });
    body += parts.join(" \\quad ") + "\\par\n";
  }
  body += `}\n\n\\vspace{3pt}\n\\sectrule\n\n`;

  // ── 3. SECTIONS ──────────────────────────────────────────────
  const INLINE_SECTIONS = new Set(["KEY COMPETENCIES", "TECHNICAL SKILLS"]);
  const ENTRY_SECTIONS = new Set(["EDUCATION", "PROJECTS", "PROJECTS (MOST RELEVANT)", "WORK EXPERIENCE", "CERTIFICATIONS", "CERTIFICATIONS / TRAINING"]);

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    if (isSectionHeader(line)) {
      const sectionName = line;
      i++;
      body += `\\section*{${escapeTex(sectionName)}}\n`;

      // Collect section content lines
      const sLines = [];
      while (i < lines.length && !isSectionHeader(lines[i].trim())) {
        sLines.push(lines[i]);
        i++;
      }

      const normSection = sectionName.toUpperCase().trim();

      if (normSection === "PROFILE" || normSection === "PROFILE / TARGET FOCUS") {
        // Plain paragraph
        const text = sLines.map(l => l.trim()).filter(Boolean).join(" ");
        body += `{\\color{body}\n${escapeTex(text)}\n}\n\n\\vspace{2pt}\n\\sectrule\n\n`;

      } else if (INLINE_SECTIONS.has(normSection)) {
        // "Label: value, value." lines
        body += `{\\color{body}\n`;
        const nonEmpty = sLines.map(l => l.trim()).filter(Boolean);
        nonEmpty.forEach((l, idx) => {
          const ci = l.indexOf(":");
          if (ci !== -1) {
            const lbl = escapeTex(l.substring(0, ci).trim());
            const val = escapeTex(l.substring(ci + 1).trim());
            body += `{\\color{heading}\\textbf{${lbl}:}} ${val}`;
          } else {
            body += escapeTex(l);
          }
          body += idx < nonEmpty.length - 1 ? "\\par\n" : "\n";
        });
        body += `}\n\n\\vspace{2pt}\n\\sectrule\n\n`;

      } else if (ENTRY_SECTIONS.has(normSection) || normSection.startsWith("WORK EXPERIENCE") || normSection.startsWith("PROJECTS")) {
        // Entries: Title + Date / Subtitle / bullets or prose
        const entryLines = sLines.map(l => l.trimEnd());
        let j = 0;
        let entryCount = 0;

        while (j < entryLines.length) {
          const el = entryLines[j].trim();
          if (!el) { j++; continue; }

          // Try title+date split
          const td = splitTitleDate(el);
          if (td) {
            if (entryCount > 0) body += `\\vspace{3pt}\n\n`;
            entryCount++;
            const [title, date] = td;
            body += `{\\color{heading}\\textbf{${escapeTex(title)}}} \\hfill\n{\\color{lighttext}${escapeTex(date)}}\\par\n`;
            j++;

            // Next non-empty line = subtitle/tech stack (italic)
            while (j < entryLines.length && !entryLines[j].trim()) j++;
            if (j < entryLines.length) {
              const sub = entryLines[j].trim();
              const isBullet = /^[-\u2013\u2022]\s/.test(sub);
              const isNextEntry = splitTitleDate(sub) !== null || isSectionHeader(sub);
              if (!isBullet && !isNextEntry) {
                if (/^(Selected [Cc]oursework|Relevant [Cc]oursework)\s*:/.test(sub)) {
                  const ci = sub.indexOf(":");
                  body += `{\\color{body}\\textit{${escapeTex(sub.substring(0, ci).trim())}:} ${escapeTex(sub.substring(ci + 1).trim())}}\\par\n`;
                } else {
                  body += `{\\color{body}\\textit{${escapeTex(sub)}}}\\par\n`;
                }
                j++;
              }
            }

            // Bullets or prose
            const bullets = [];
            const proseLines = [];
            while (j < entryLines.length) {
              const bl = entryLines[j].trim();
              if (!bl) { j++; break; }
              if (splitTitleDate(bl) || isSectionHeader(bl)) break;
              if (/^[-\u2013\u2022]\s/.test(bl)) {
                bullets.push(bl.replace(/^[-\u2013\u2022]\s*/, ""));
              } else {
                proseLines.push(bl);
              }
              j++;
            }

            if (bullets.length > 0) {
              body += `\\begin{itemize}\n`;
              for (const b of bullets) body += `  \\item ${escapeTex(b)}\n`;
              body += `\\end{itemize}\n`;
            }
            if (proseLines.length > 0) {
              body += `{\\color{body}\n${escapeTex(proseLines.join(" "))}\n}\n`;
            }
          } else {
            // Orphan line not part of a recognized entry — print as body text
            body += `{\\color{body}${escapeTex(el)}}\\par\n`;
            j++;
          }
        }
        body += `\n\\vspace{2pt}\n\\sectrule\n\n`;

      } else {
        // Unknown section — treat as plain paragraph
        const text = sLines.map(l => l.trim()).filter(Boolean).join(" ");
        body += `{\\color{body}\n${escapeTex(text)}\n}\n\n\\vspace{2pt}\n\\sectrule\n\n`;
      }
    } else {
      i++;
    }
  }

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{enumitem}
\\usepackage{xcolor}
\\usepackage{hyperref}
\\usepackage{titlesec}

\\definecolor{heading}{HTML}{111111}
\\definecolor{body}{HTML}{333333}
\\definecolor{lighttext}{HTML}{666666}
\\definecolor{linkcolor}{HTML}{003366}

\\hypersetup{colorlinks=true,urlcolor=linkcolor,linkcolor=linkcolor}

\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{1pt}
\\renewcommand{\\baselinestretch}{1.05}

\\setlist[itemize]{leftmargin=1.8em,itemsep=1pt,topsep=1pt}

\\titleformat{\\section}{\\large\\bfseries\\color{heading}}{}{0pt}{}
\\titlespacing*{\\section}{0pt}{6pt}{2pt}

\\newcommand{\\sectrule}{\\vspace{2pt}\\hrule\\vspace{3pt}}
\\newcommand{\\name}[1]{{\\Huge\\bfseries\\color{heading} #1}\\par\\vspace{4pt}}

\\begin{document}
\\pagestyle{empty}

${body}
\\end{document}
`;
}

function buildClLatex(content) {
  const lines = content.split("\n");
  let i = 0;
  let body = "";

  // ── Title (centered) ────────────────────────────────────────
  body += `\\begin{center}\n  {\\large \\textbf{\\textsc{Cover Letter}}}\n\\end{center}\n\\vspace{1.2em}\n\n`;

  // ── Position info line ───────────────────────────────────────
  // Find and consume "Position: ... | Req ID: ... | Location: ..."
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^Position\s*:/i.test(lines[i].trim())) {
    // Parse out parts cleanly
    const posLine = lines[i].trim();
    const posEsc = escapeTex(posLine);
    body += `\\begin{center}\n  {\\small\\color{lighttext} ${posEsc}}\n\\end{center}\n\\vspace{0.4em}\n\n`;
    i++;
  }

  // ── Salutation ───────────────────────────────────────────────
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^Dear /i.test(lines[i].trim())) {
    body += `${escapeTex(lines[i].trim())},\n\n`;
    i++;
  }

  // ── Body paragraphs ──────────────────────────────────────────
  // Collect remaining content as paragraphs (split by blank lines)
  const remaining = lines.slice(i).join("\n");
  const paragraphs = remaining.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  for (const para of paragraphs) {
    const t = para.replace(/\n/g, " ").trim();

    if (/^(Best regards|Kind regards|Sincerely)/i.test(t)) {
      body += `\\vspace{0.4em}\n${escapeTex(t)},\n\n`;
    } else if (/^Varun Raval$/i.test(t)) {
      body += `\\vspace{0.3em}\n\\textbf{${escapeTex(t)}}\n\n`;
    } else if (/raval\.varun@|linkedin\.com\/in\/|github\.com\/ravalvarun/i.test(t)) {
      // Contact footer line
      const parts = t.split(/\s*\|\s*/);
      const formatted = parts.map(p2 => {
        const ep = escapeTex(p2.trim());
        if (/@/.test(p2)) return `\\href{mailto:${p2.trim()}}{${ep}}`;
        if (/linkedin\.com/i.test(p2)) return `\\href{https://${p2.trim()}}{${ep}}`;
        if (/github\.com/i.test(p2)) return `\\href{https://${p2.trim()}}{${ep}}`;
        return ep;
      });
      body += `{\\small ${formatted.join(" \\enspace\\textbar\\enspace ")}}\n\n`;
    } else if (/^I am open to/i.test(t)) {
      body += `\\vspace{0.4em}\n{\\small\\textit{${escapeTex(t)}}}\n\n`;
    } else {
      // Regular paragraph — convert **bold** → \textbf{}
      const escaped = escapeTex(t);
      // After escaping, ** markers are safe (not LaTeX-special); convert them
      const withBold = escaped.replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}");
      body += `${withBold}\n\n`;
    }
  }

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[top=2.5cm,bottom=2.5cm,left=2.8cm,right=2.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{parskip}
\\usepackage{xcolor}
\\usepackage{hyperref}

\\definecolor{lighttext}{HTML}{555555}
\\hypersetup{colorlinks=true,urlcolor=black,linkcolor=black}

\\setstretch{1.15}
\\setlength{\\parskip}{0.75em}
\\setlength{\\parindent}{0pt}
\\pagestyle{empty}

\\begin{document}
${body}
\\end{document}
`;
}

// ═══════════════════════════════════════════════════════════════
// POST /index-library
// ═══════════════════════════════════════════════════════════════

app.post("/index-library", async (req, res) => {
  const pdfParse = require("pdf-parse");
  const Tesseract = require("tesseract.js");
  const foundationDir = path.join(__dirname, "library", "foundation");
  const cvDir = path.join(foundationDir, "cvs");
  const clDir = path.join(foundationDir, "cover_letters");
  const cacheFile = path.join(__dirname, "library", "ocr-cache.json");
  const results = [], errors = [];

  // Load OCR cache from disk
  let ocrCache = {};
  try {
    if (fs.existsSync(cacheFile)) ocrCache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  } catch { ocrCache = {}; }

  // OCR fallback: convert PDF pages to images, then OCR each page
  async function ocrPdf(filePath, filename) {
    // Check cache first (keyed by filename + file size)
    const stat = fs.statSync(filePath);
    const cacheKey = `${filename}__${stat.size}`;
    if (ocrCache[cacheKey] && ocrCache[cacheKey].length >= 50) {
      console.log(`  OCR cache hit for "${filename}" (${ocrCache[cacheKey].length} chars)`);
      return ocrCache[cacheKey];
    }

    const { pdf } = await import("pdf-to-img");
    const doc = await pdf(filePath, { scale: 2 });
    let fullText = "";
    for await (const image of doc) {
      const { data: { text } } = await Tesseract.recognize(image, "eng");
      fullText += text + "\n";
    }
    const trimmed = fullText.trim();

    // Save to cache
    ocrCache[cacheKey] = trimmed;
    try { fs.writeFileSync(cacheFile, JSON.stringify(ocrCache, null, 2)); } catch {}

    return trimmed;
  }

  async function indexDir(dir, type) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".pdf"));

    // First pass: pdf-parse (fast) for all files
    const needsOcr = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const data = await pdfParse(fs.readFileSync(filePath));
        const text = data.text.trim();
        if (text.length >= 50) {
          results.push({ id: file.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase(), filename: file, type, text, charCount: text.length });
        } else {
          needsOcr.push({ file, filePath });
        }
      } catch (err) {
        needsOcr.push({ file, filePath });
      }
    }

    // Second pass: OCR in parallel batches of 3 for files that need it
    if (needsOcr.length > 0) {
      console.log(`  ${needsOcr.length} files in ${type} need OCR...`);
      const BATCH = 3;
      for (let i = 0; i < needsOcr.length; i += BATCH) {
        const batch = needsOcr.slice(i, i + BATCH);
        const ocrResults = await Promise.allSettled(
          batch.map(async ({ file, filePath }) => {
            console.log(`  OCR: "${file}"...`);
            const text = await ocrPdf(filePath, file);
            return { file, filePath, text };
          })
        );
        for (const result of ocrResults) {
          if (result.status === "fulfilled" && result.value.text.length >= 50) {
            const { file, text } = result.value;
            console.log(`  OCR success: ${text.length} chars for "${file}"`);
            results.push({ id: file.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase(), filename: file, type, text, charCount: text.length });
          } else {
            const file = result.status === "fulfilled" ? result.value.file : batch[ocrResults.indexOf(result)]?.file || "unknown";
            const errMsg = result.status === "rejected" ? result.reason?.message : "Too short after OCR";
            console.warn(`  OCR failed for "${file}": ${errMsg}`);
            errors.push({ filename: file, error: errMsg });
          }
        }
      }
    }
  }

  try {
    console.log("Indexing library (with OCR fallback + cache for scanned PDFs)...");
    await indexDir(cvDir, "cv");
    await indexDir(clDir, "cover_letter");
    libraryIndex = results;
    console.log(`Library: ${results.length} docs indexed, ${errors.length} errors`);
    return res.json({ success: true, indexed: results.map(d => ({ id: d.id, filename: d.filename, type: d.type, charCount: d.charCount, preview: d.text.substring(0, 300) })), errors });
  } catch (err) {
    console.error("Index error:", err.message);
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.get("/library-index", (req, res) => res.json({ success: true, documents: libraryIndex }));

// ═══════════════════════════════════════════════════════════════
// GET /health
// ═══════════════════════════════════════════════════════════════

app.get("/health", (req, res) => res.json({
  status: "ok",
  aiProvider: aiProvider || "none",
  model: aiProvider === "claude" ? CLAUDE_MODEL : aiProvider === "groq" ? GROQ_MODEL : aiProvider === "gemini" ? GEMINI_MODEL : "none",
  browserUp: sharedBrowser?.isConnected() || false,
  vectorStore: vectorReady,
  skillChunks: skillBank?.skill_chunks?.length || 0,
  styleProfile: styleProfile ? `${styleProfile.total_samples} samples` : "not loaded",
  // Note: libraryDocs removed — PDFs are no longer used in the generation pipeline
}));

// ═══════════════════════════════════════════════════════════════
// SKILL DATA BANK ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/skill-bank", (req, res) => {
  if (!skillBank) return res.status(503).json({ success: false, error: "Skill bank not loaded" });
  res.json({
    success: true,
    profile: skillBank.profile,
    skill_chunks: skillBank.skill_chunks,
    projects: skillBank.projects,
    work_experience: skillBank.work_experience,
    education: skillBank.education,
    certifications: skillBank.certifications,
    vectorReady
  });
});

app.post("/skill-bank/add", async (req, res) => {
  if (!skillBankManager) return res.status(503).json({ success: false, error: "Skill bank not available" });
  const { category, skill, level, evidence, phase } = req.body;
  if (!category || !skill || !level || !evidence) return res.status(400).json({ success: false, error: "Missing required fields: category, skill, level, evidence" });
  try {
    const chunk = await skillBankManager.addSkill({ category, skill, level, evidence, phase });
    // Reload skillBank in memory
    skillBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
    res.json({ success: true, chunk });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.post("/skill-bank/update", async (req, res) => {
  if (!skillBankManager) return res.status(503).json({ success: false, error: "Skill bank not available" });
  const { id, level, evidence } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "Missing skill id" });
  try {
    const updates = {};
    if (level) updates.level = level;
    if (evidence) updates.evidence = evidence;
    const chunk = await skillBankManager.updateSkill(id, updates);
    skillBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
    res.json({ success: true, chunk });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.post("/skill-bank/delete", (req, res) => {
  if (!skillBankManager) return res.status(503).json({ success: false, error: "Skill bank not available" });
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "Missing skill id" });
  try {
    const removed = skillBankManager.deleteSkill(id);
    skillBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.post("/skill-bank/rephrase", async (req, res) => {
  const { text, skill } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Missing text" });
  try {
    const style = styleProfile?.style_analysis || {};
    const sigPhrases   = (style.signature_phrases || []).join(", ");
    const connectors   = (style.connector_words   || []).join(", ");
    const avoids       = (style.things_to_never_write_as_me || style.vocabulary_preferences?.avoids || []).join(", ");
    const toneDesc     = style.tone_description || "confident, specific, professional";
    const evidStyle    = style.evidence_style   || "direct and concise, no fluff";
    const rephrased = await callAI(
      `You rephrase CV skill-bank evidence sentences to match a specific person's writing style. Rules:\n- Keep the SAME meaning and facts — only improve clarity and style\n- Max 20 words, single sentence, no trailing punctuation\n- Tone: ${toneDesc}\n- Evidence style: ${evidStyle}\n${sigPhrases ? `- Favour these natural phrases: ${sigPhrases}` : ""}\n${connectors ? `- Use these connector words when natural: ${connectors}` : ""}\n${avoids ? `- NEVER use: ${avoids}` : ""}\n- No quotes, no bold, no bullet points in output — just the plain sentence`,
      `Skill: ${skill || "(unknown)"}\nOriginal sentence: ${text}\n\nRephrase it in the same style described above.`
    );
    res.json({ success: true, rephrased: rephrased.trim().replace(/^"|"$/g, "").replace(/\.$/, "") });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.post("/skill-bank/suggest", async (req, res) => {
  const { skill, level } = req.body;
  if (!skill) return res.status(400).json({ success: false, error: "Missing skill" });
  try {
    const profile = skillBank?.profile || {};
    const context = [
      profile.name ? `Name: ${profile.name}` : "",
      profile.current_role ? `Current role: ${profile.current_role}` : "",
      profile.target_roles ? `Target roles: ${profile.target_roles.join(", ")}` : ""
    ].filter(Boolean).join(". ");
    const validCategories = ["Tools","Software","Design","Digital_Marketing","Programming","SAP_Technical","SAP_Functional","Analytics","Other"];
    const text = await callAI(
      "You are a CV evidence writer. Reply with ONLY valid JSON, no markdown, no explanation. Keys: \"category\" (one of: Tools, Software, Design, Digital_Marketing, Programming, SAP_Technical, SAP_Functional, Analytics, Other) and \"evidence\" (a single practical sentence, max 20 words, no quotes, no trailing period).",
      `Skill/Tool: ${skill}\nLevel: ${level || "Intermediate"}\n${context ? "Candidate context: " + context : ""}\n\nReturn JSON with category and evidence.`
    );
    let suggestion = "", category = "Tools";
    try {
      const parsed = JSON.parse(text.trim());
      suggestion = (parsed.evidence || "").replace(/^"|"$/g, "").replace(/\.$/, "");
      category   = validCategories.includes(parsed.category) ? parsed.category : "Tools";
    } catch {
      // fallback: treat whole response as evidence
      suggestion = text.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
    }
    res.json({ success: true, suggestion, category });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.post("/skill-bank/query", async (req, res) => {
  if (!retrieveContext) return res.status(503).json({ success: false, error: "Vector store not available" });
  const { jobText, topN } = req.body;
  if (!jobText) return res.status(400).json({ success: false, error: "Missing jobText" });
  try {
    const result = await retrieveContext(jobText, { topSkills: topN || 10 });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.get("/skill-bank/stats", (req, res) => {
  if (!skillBankManager) return res.status(503).json({ success: false, error: "Skill bank not available" });
  try {
    res.json({ success: true, ...skillBankManager.getStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /dach-check  — lightweight German-recruiter compliance scan
// ═══════════════════════════════════════════════════════════════

const DACH_CHECK_SYSTEM = `You are a senior German recruiter reviewing application documents for the DACH job market.

Check the text below against these criteria:
1. Tone: formal but not stiff — no American-style hype ("I'm thrilled", "game-changer").
2. Honesty: no exaggerated claims or unverifiable superlatives.
3. Length: cover letters should fit 1 page (~350-450 words). CVs should be concise.
4. Structure: clear sections, logical flow, no rambling.
5. Language: if written in English, fine — but no slang or overly casual phrasing.
6. German-specific: if the candidate mentions a German-language level (e.g. B1), it should be stated honestly, not overpromised.
7. Availability: should be stated simply and clearly, not buried.

Return a JSON array of 1-5 issues. Each issue: {"issue": "short description", "severity": "high"|"medium"|"low", "suggestion": "concrete fix"}.
If the document is already excellent, return an empty array [].
Return ONLY the JSON array. No markdown fences, no commentary.`;

app.post("/dach-check", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured" });
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Missing text" });
  try {
    const waitH = AI_MIN_GAP_MS - (Date.now() - lastAICall);
    if (waitH > 0) await new Promise(r => setTimeout(r, waitH));
    lastAICall = Date.now();
    const raw = await callAI(DACH_CHECK_SYSTEM, `Review this application document:\n\n${text}`);
    let issues = [];
    try {
      issues = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim());
    } catch { issues = [{ issue: raw.trim(), severity: "medium", suggestion: "" }]; }
    res.json({ success: true, issues });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /dach-fix  — auto-fix DACH compliance issues in CV / CL
// ═══════════════════════════════════════════════════════════════

const DACH_FIX_SYSTEM = `You are an expert editor for the DACH (Germany/Austria/Switzerland) job market.
You will receive a document (CV or Cover Letter) together with a list of compliance issues found by a recruiter review.
Your task: rewrite the document so that every listed issue is resolved, while keeping the rest of the content intact.
Rules:
- Maintain the same overall structure and LaTeX formatting if present.
- Preserve all factual information (dates, titles, company names, skills).
- Fix tone, length, phrasing, and structure issues as described in the issue list.
- If an issue mentions the cover letter is too long, trim it to ~350-400 words.
- If an issue mentions exaggerated language, replace with measured, professional German-market-appropriate phrasing.
- Return ONLY the corrected document text. No commentary, no markdown fences.`;

app.post("/dach-fix", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured" });
  const { documentText, documentType, issues } = req.body;
  if (!documentText || !issues?.length) return res.status(400).json({ success: false, error: "Missing documentText or issues" });
  try {
    const waitH = AI_MIN_GAP_MS - (Date.now() - lastAICall);
    if (waitH > 0) await new Promise(r => setTimeout(r, waitH));
    lastAICall = Date.now();
    const issueList = issues.map((iss, idx) => `${idx + 1}. [${iss.severity}] ${iss.issue}${iss.suggestion ? " — Fix: " + iss.suggestion : ""}`).join("\n");
    const prompt = `Document type: ${documentType === "cv" ? "CV" : "Cover Letter"}\n\nIssues to fix:\n${issueList}\n\nDocument:\n${documentText}`;
    const fixed = await callAI(DACH_FIX_SYSTEM, prompt);
    res.json({ success: true, content: fixed.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /humanize
// ═══════════════════════════════════════════════════════════════

app.post("/humanize", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured" });
  if (!humanize) return res.status(503).json({ success: false, error: "Humanizer not available" });
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Missing text" });
  try {
    const waitH = AI_MIN_GAP_MS - (Date.now() - lastAICall);
    if (waitH > 0) await new Promise(r => setTimeout(r, waitH));
    lastAICall = Date.now();
    const result = await humanize(text, callAI);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n  SAP Job Automator`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  AI: ${aiProvider || "NONE (set API key in .env)"}\n`);
});
