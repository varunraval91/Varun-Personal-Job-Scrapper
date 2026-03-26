const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { GoogleGenAI } = require("@google/genai");

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
  "/humanize":     { windowMs: 60000, max: 10 },
  "/apply-style":  { windowMs: 60000, max: 15 },
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
  genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
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
    console.log(`[OK] Vector store ready: ${skillBank.skill_chunks.length} skills, ${skillBank.projects.length} technical projects, ${(skillBank.media_projects?.sap_media_projects?.length||0)+(skillBank.media_projects?.creative_media_projects?.length||0)} media projects`);
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
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      const result = await genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config: { systemInstruction: systemPrompt }
      });
      return result.text;
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

    // Post-filter MUST HAVE — only strip obvious employer branding, keep everything else
    const cleanedMust = Array.isArray(summary.must_have) ? summary.must_have.filter(b => {
      if (!b || typeof b !== "string") return false;
      const trimmed = b.trim();
      if (!trimmed) return false;
      // Drop pure branding sentences that start with "We " or company slogans
      if (/^(We |At SAP|SAP helps|Our company)/i.test(trimmed)) return false;
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

function buildClSystemPromptRAG(matchedSkills, matchedProjects, matchedWork, pinnedWeIds, pinnedProjectIds, selectedCerts, selectedResearch) {
  const skillText = matchedSkills.map(s =>
    `[${s.id}] ${s.metadata.skill_name} [${s.metadata.type || 'skill'}] (${s.metadata.level}): ${s.document}`
  ).join("\n");

  const projectText = matchedProjects.map(p =>
    `${p.metadata.name} (${p.metadata.tech}): ${p.document}`
  ).join("\n");

  const workText = matchedWork.map(w => {
    const meta = w.metadata || {};
    const skills = meta.skills_used?.length
      ? `\n  Tools/Skills used: ${Array.isArray(meta.skills_used) ? meta.skills_used.join(", ") : meta.skills_used}`
      : "";
    return `${meta.title} at ${meta.company} (${meta.period}):${skills}\n  ${w.document}`;
  }).join("\n\n");

  const certText = (selectedCerts || []).map(c =>
    `${c.name}${c.date || c.date_range ? " (" + (c.date || c.date_range) + ")" : ""} — ${c.provider || ""}`
  ).join("\n");

  const researchText = (selectedResearch || []).map(r => {
    if (r.title && r.description) {
      const parts = [`[${r.id}] ${r.title}`];
      if (r.institution) parts.push(`Institution: ${r.institution}`);
      if (r.date || r.period) parts.push(`Date: ${r.date || r.period}`);
      parts.push(r.description);
      if (r.key_finding) parts.push(`Key finding: ${r.key_finding}`);
      if (r.references) parts.push(`References: ${r.references}`);
      return parts.join(" | ");
    }
    return null;
  }).filter(Boolean).join("\n");

  // Build highlight section when user selected specific WE/projects in CV selector
  let highlightSection = "";
  if (pinnedWeIds?.length || pinnedProjectIds?.length) {
    const highlightedWork = pinnedWeIds?.length
      ? matchedWork.filter(w => pinnedWeIds.includes(w.id)).map(w => `- ${w.metadata.title} at ${w.metadata.company}`).join("\n")
      : "";
    const highlightedProjects = pinnedProjectIds?.length
      ? matchedProjects.filter(p => pinnedProjectIds.includes(p.id)).map(p => `- ${p.metadata.name} (${p.metadata.tech})`).join("\n")
      : "";
    highlightSection = `\n=== USER-SELECTED EXPERIENCE TO PRIORITIZE ===\nThe user chose these items because they likely matter for this JD. Prefer these examples where they improve JD alignment, but keep the strongest evidence-first narrative from all matched data.\nExtract specific technical details (tools, languages, platforms, methods) from these entries and weave them naturally into the letter.\n${highlightedWork ? "Preferred work experience examples:\n" + highlightedWork : ""}\n${highlightedProjects ? "Preferred project examples:\n" + highlightedProjects : ""}\n`;
  }

  const style = styleProfile?.style_analysis || {};
  const styleSection = styleProfile ? `
=== WRITING STYLE (learned from Varun's real cover letters — ${styleProfile.total_samples} samples) ===
Tone: ${style.tone_description || "Professional but warm, specific not generic"}
Structure: ${style.structural_pattern || "Opening identity claim → career/SAP experience breadth → specific role evidence → soft skills → availability"}
Target length: 260-300 words (the style profile avg of 380 is from older, longer letters — use 280 as the current target)
Average sentence length: ${style.avg_sentence_length || 24} words
Sentence variety: ${style.sentence_variety_pattern || "Long compound sentences, rarely short punchy ones"}
Evidence style: ${style.evidence_style || "Flowing narrative prose, never bullets. Company names and roles inline."}
Self-presentation: ${style.self_presentation_style || "Confident achiever, practical breadth, leads with experience years"}
How he bridges academic to practical: ${style.how_i_bridge_academic_to_practical || "Brief degree mention then immediately pivots to professional experience"}
How he states availability: ${style.how_i_handle_availability || "Simple direct sentence near closing: 'I can join from [Month]'"}

⚠ UPDATED OPENING PATTERNS for SAP student applications (use one of THESE — the archived patterns in the style profile contain now-banned phrases):
  - "Please accept this letter as an expression of my interest in the [Position] at [Company]. Currently in my second semester of M.Sc. SAP Engineering & Analytics at Hochschule Fresenius, I bring 1.5+ years of hands-on experience at SAP Walldorf across [relevant area] — directly aligned with what [Team] is looking for."
  - "My current Master's studies in SAP Engineering & Analytics at Hochschule Fresenius, combined with [X] months of practical work at SAP's [Department], make [Position] at [Company] a natural next step in my trajectory."
  - "With 1.5 years at SAP Walldorf and ongoing M.Sc. studies in SAP Engineering & Analytics, I am applying for [Position] — a role where my background in [specific skill from JD] translates directly into day-one contribution for [Team]."

Phrases he naturally uses: ${(style.signature_phrases || []).filter(p => !p.includes("I am excited") && !p.includes("Throughout my career")).join(" | ")}
Connector words he favors: ${(style.connector_words || []).filter(c => c !== "Throughout my career").join(", ")}
Words/phrases he NEVER uses: ${(style.things_to_never_write_as_me || style.vocabulary_preferences?.avoids || []).join(" | ")}

CRITICAL RULES from his style:
- Uses bold: YES — use **double asterisks** around key technical terms (SAP modules, tool names, product names) — 2-3 per paragraph max
- Typical paragraph count: ${style.paragraph_count_typical || 5}
- Evidence = flowing prose narrative, NEVER bullet points inside the letter body
- Name employers inline with "At SAP IX Studio..." or "At SAP Non-Commercial Licensing..." style
- Never hedge accomplishments with qualifiers — state them directly` : "";

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
${certText ? `\n=== SELECTED CERTIFICATIONS ===\n${certText}\n` : ""}${researchText ? `\n=== RESEARCH PAPERS & ACTIVITIES ===\nThese are Varun's academic research outputs. Reference them in the Academic & Research paragraph when relevant to the JD.\n${researchText}\n` : ""}${highlightSection}${styleSection}

=== GENERATION RULES ===
1. Use ONLY skills and evidence from the matched data above. NEVER invent.
2. Pick a concise, relevant subset of evidence. Do not force every item.
3. Use quantified evidence when available (80% reduction, 1,000+ records, etc.)
4. Write in first person as Varun.
5. Structure: Opening hook → 3 focused evidence paragraphs → Closing with availability.
6. Length: 240-320 words. Keep sentences crisp.
7. Reference the specific team/product mentioned in the job posting.
8. Use **double asterisks** around key technical terms (SAP modules, tool names, product names) — 2-3 per paragraph max. No other markdown.
9. If job requires fluent German and candidate has B1, be honest about it.
10. HARD STOP — closing block: Do NOT write "Thank you", "Best regards", "Sincerely", email addresses, LinkedIn/GitHub links, or availability footer text in ANY paragraph. These are appended automatically. Paragraph 5 must end with a forward-looking contribution statement or direct availability sentence — never a sign-off. Output containing any closing phrase is invalid.
11. If user-selected entries exist, prioritize them when they strengthen JD alignment; otherwise use stronger matched evidence.
12. Prioritize evidence in this order when role is project/program operations: project planning/status tracking, meeting documentation/action tracking, presentations/enablement/SharePoint, cross-functional coordination.
13. EVIDENCE RULE: Every paragraph mentioning a role or project MUST include at least one specific tool name, deliverable name, or number from the matched data above. "Managed digital assets" fails — "managed 200+ reusable media assets in DaVinci Resolve for CONNECT 2024" passes. Extract specifics from the Tools/Skills used fields in the work data.
14. OPENING RULE: Paragraph 1 MUST start with one of the SAP-era patterns from the UPDATED OPENING PATTERNS section above. NEVER start with "I am writing to apply", "I am writing to express", or "I am excited to".

=== NEVER USE THESE PHRASES (any match = invalid output) ===
"I am writing to apply", "I am writing to express", "I am excited to apply",
"I am excited to submit", "I believe I would be a great fit", "leverage my skills",
"leverage my experience", "I am confident that", "throughout my career", "passion for",
"I am eager to", "I would welcome the opportunity", "I look forward to the opportunity",
"please find attached", "I am reaching out", "detail-oriented self-starter",
"perfect fit", "testament to", "landscape", "groundbreaking", "nestled", "tapestry",
"delve into", "in conclusion", "the future looks bright", "dynamic environment",
"fast-paced", "results-driven", "proven track record", "Thank you for considering"
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

function buildCvSystemPromptRAG(matchedSkills, matchedProjects, matchedWork, pinnedWeIds, pinnedProjectIds, selectedCerts, selectedResearch, bank) {
  const skillText = matchedSkills.map(s =>
    `[${s.id}] ${s.metadata.skill_name} [${s.metadata.type || 'skill'}] (${s.metadata.level}): ${s.document}`
  ).join("\n");

  const projectText = matchedProjects.map(p =>
    `${p.metadata.name} (${p.metadata.tech}): ${p.document}`
  ).join("\n");

  const workText = matchedWork.map(w => {
    const meta = w.metadata || {};
    const skills = meta.skills_used?.length
      ? `\n  Tools/Skills used: ${Array.isArray(meta.skills_used) ? meta.skills_used.join(", ") : meta.skills_used}`
      : "";
    return `${meta.title} at ${meta.company} (${meta.period}):${skills}\n  ${w.document}`;
  }).join("\n\n");

  const certText = (selectedCerts || []).map(c =>
    `${c.name}${c.date || c.date_range ? " (" + (c.date || c.date_range) + ")" : ""} — ${c.provider || ""}`
  ).join("\n");

  const researchText = (selectedResearch || []).map(r => {
    if (r.title && r.description) {
      const parts = [`[${r.id}] ${r.title}`];
      if (r.institution) parts.push(`Institution: ${r.institution}`);
      if (r.date || r.period) parts.push(`Date: ${r.date || r.period}`);
      parts.push(r.description);
      if (r.key_finding) parts.push(`Key finding: ${r.key_finding}`);
      return parts.join(" | ");
    }
    return null;
  }).filter(Boolean).join("\n");

  const educationBlock = (bank?.education || [])
    .filter(e => !e.degree?.toLowerCase().includes("bachelor"))
    .map(e => {
      let line = `${e.degree} | ${e.institution} | ${e.period}`;
      if (e.status) line += ` (${e.status})`;
      if (e.key_modules?.length) line += ` | Coursework: ${e.key_modules.join("; ")}`;
      if (e.relevance) line += ` | Relevance: ${e.relevance}`;
      return line;
    }).join("\n");

  return `You are a CV content extractor for Varun Raval. Use ONLY the matched skill data below.

=== MATCHED SKILLS (for THIS job) ===
${skillText}

=== RELEVANT PROJECTS ===
${projectText}

=== RELEVANT WORK EXPERIENCE ===
${workText}
${certText ? `\n=== SELECTED CERTIFICATIONS ===\n${certText}\n` : ""}${researchText ? `\n=== RESEARCH PAPERS & ACTIVITIES ===\n${researchText}\n` : ""}
RULES (non-negotiable):
- Every fact MUST come from the matched data above. NEVER invent anything.
- Reorder competencies and skills to match what the JD prioritizes.
- PROFILE must be EXACTLY 2 sentences, role-specific, and 35-55 words total.
- PROFILE sentence 1: who Varun is + target role fit; sentence 2: strongest 2 capability proofs for this JD.
- PROFILE must avoid generic adjectives and cliches.
- Write detailed professional description paragraphs for each entry. Lead with action/tool/outcome.
- For each work/project/research description, write 2-4 sentences (about 45-90 words) including tools, context, and measurable impact when available.
- NEVER use generic filler ("Results-driven", "Proven track record", etc.)
- CV section order MUST be exactly: HEADER, KEY COMPETENCIES, TECHNICAL SKILLS, EDUCATION, WORK EXPERIENCE, PROJECTS, RESEARCH & ACTIVITIES, CERTIFICATIONS.
- Return ONLY valid JSON. No markdown fences, no explanation, no extra text.

${pinnedWeIds?.length ? `WORK EXPERIENCE — USER-SELECTED (hard constraint):
The user has manually selected exactly these work experience entries. Include ALL of them in the experience section, in this order. Do not add or remove any entries:
${pinnedWeIds.map((id, i) => `${i + 1}. ${id}`).join("\n")}
These IDs match the entries in the RELEVANT WORK EXPERIENCE data above.` : `WORK EXPERIENCE RULES (important):
- DEFAULT (SAP / tech / student roles): include ONLY the 3 SAP roles (IX Studio, Non-Commercial Licensing, Services Sales DemGen) in the experience section.
  After those 3, add ONE compressed line as a single entry: { "title": "Earlier Experience", "company": "Media & EdTech (Byju's, Orange Sellers, Filmalaya, others)", "date": "2014 – 2024", "description": "Creative production, UX research, video direction and EdTech content roles across India, Netherlands and Germany — full detail available on request." }
- EXCEPTION (only if the JD explicitly targets media/film/video/EdTech/creative roles): include the relevant earlier media/EdTech roles in full.`}

${pinnedProjectIds?.length ? `PROJECTS — USER-SELECTED (hard constraint):
Include ONLY these projects (all of them, nothing else):
${pinnedProjectIds.map((id, i) => `${i + 1}. ${id}`).join("\n")}` : `PROJECTS: Select 2-3 most relevant from the matched data above.`}

EDUCATION (HARD CONSTRAINT — copy EVERY date, city, and institution EXACTLY as written, do NOT change any value):
${educationBlock || "M.Sc. SAP Engineering & Analytics | Hochschule Fresenius, Heidelberg, Germany | Oct 2025 – Sep 2027 (Currently Enrolled, 2nd semester)\nMaster of Design – Communication Design | MIT Institute of Design, Pune, India | 2015 – 2018"}
Do NOT include University of Bremen, B.Eng, or any unfinished course. Do NOT invent or alter any date, city, or institution name.

JSON SCHEMA (fill every field, use empty string "" if not applicable):
{
  "name": "VARUN RAVAL",
  "location": "Walldorf / Heidelberg / Mannheim, Germany",
  "phone": "(+49) 0172 754 6835",
  "email": "raval.varun@stud.hs-fresenius.de",
  "linkedin": "linkedin.com/in/varunraval",
  "github": "github.com/ravalvarun-SAP",
  "languages": "English (fluent), German (B1 -- actively improving)",
  "profile": "<EXACTLY 2 sentences, 35-55 words total, JD-specific role fit + strongest evidence>",
  "key_competencies": "<10-14 JD-relevant competencies separated by •>",
  "competencies": [{ "category": "<optional label>", "items": "<optional fallback format>" }],
  "technical_skills": [{ "category": "<Category>", "items": "<Tool; Tool; Tool; Tool>" }],
  "education": [{ "degree": "<Degree -- Field>", "institution": "<Institution, City, Country>", "date": "<Start -- End (status)>", "coursework": "<Module; Module> or empty string" }],
  "experience": [{ "title": "<Job Title>", "company": "<Company -- Department / Team>", "date": "<Month Year -- Month Year>", "description": "<detailed 2-4 sentence professional paragraph with tools + outcome>", "bullets": ["<optional fallback bullet>"] }],
  "projects": [{ "title": "<Project Title>", "date": "<Month Year or range>", "tech": "<Technologies / Tools Used>", "description": "<detailed 2-4 sentence professional paragraph with architecture + impact>", "bullets": ["<optional fallback bullet>"] }],
  "research_activities": [{ "title": "<Research paper or activity title>", "date": "<Month Year or range>", "organization": "<Organisation / Context>", "description": "<detailed 2-4 sentence research summary with method + finding + relevance>", "kind": "<paper|activity>" }],
  "certifications": [{ "name": "<Certification Name>", "date": "<Month Year>", "description": "<2-3 sentence scope + practical relevance to target role>" }]
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
    // Read latest bank from disk so selector reflects recent edits immediately
    let bank = skillBank || {};
    try {
      bank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
      skillBank = bank;
    } catch (_) {}

    const allWE = bank.work_experience || [];
    // Flatten media projects (sap_media + creative_media) into the project pool
    const mediaProjRaw = [
      ...(bank.media_projects?.sap_media_projects || []),
      ...(bank.media_projects?.creative_media_projects || [])
    ].map(p => ({ ...p, name: p.title }));  // media projects use 'title' — normalise to 'name'
    const allProjects = [...(bank.projects || []), ...mediaProjRaw];
    const allCerts = (bank.certifications_registry || []).map(c => ({ id: c.id, name: c.name, provider: c.provider || "", date: c.date || c.date_range || "" }));

    // Research papers + activities for selector
    const researchPapers = (bank.research_papers || []).map(rp => ({
      id: rp.id, title: rp.title, institution: rp.institution || "",
      date: rp.date || "", description: rp.description || "",
      key_finding: rp.key_finding || "", references: rp.references || "",
      kind: "paper"
    }));
    const researchActivities = (bank.research_activities || []).map(ra => ({
      id: ra.id, title: ra.title, context: ra.context || "",
      period: ra.period || "", description: ra.description || "",
      kind: "activity"
    }));
    const allResearch = [...researchPapers, ...researchActivities];

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
      bullets: we.bullets || [],
      description: we.description || (we.bullets || []).join(" "),
      score: scoreItem([we.title, we.company, (we.bullets || []).join(" "), (we.skills_used || []).join(" ")])
    })).sort((a, b) => b.score - a.score);

    const scoredProjects = allProjects.map(p => ({
      id: p.id,
      name: p.name,
      tech: p.tech,
      date: p.date,
      description: p.description || "",
      sub_category: p.sub_category || null,
      score: scoreItem([p.name, p.tech, p.description || ""])
    })).sort((a, b) => b.score - a.score);

    // Auto-tick top 3 WE + top 3 SAP Technical projects only (PJ prefix)
    const topWeIds = scoredWE.slice(0, 3).map(w => w.id);
    const sapTechProjects = scoredProjects.filter(p => p.id.startsWith("PJ"));
    const topProjectIds = sapTechProjects.slice(0, 3).map(p => p.id);

    return res.json({
      success: true,
      work_experience: scoredWE,
      projects: scoredProjects,
      certifications: allCerts,
      research: allResearch,
      aiPickWE: topWeIds,
      aiPickProjects: topProjectIds,
      aiPickCerts: allCerts.map(c => c.id)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /update-bank-item  — Permanently edit an item in skill_data_bank.json
// ═══════════════════════════════════════════════════════════════
app.post("/update-bank-item", (req, res) => {
  const { type, id, fields } = req.body || {};
  if (!type || !id || !fields) return res.status(400).json({ success: false, error: "Missing type, id or fields" });
  const bankPath = path.join(__dirname, "data", "skill_data_bank.json");
  try {
    const bank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));

    function applyFields(item) {
      Object.entries(fields).forEach(([k, v]) => { item[k] = v; });
    }
    function findAndUpdate(arr) {
      const item = (arr || []).find(x => x.id === id);
      if (item) { applyFields(item); return true; }
      return false;
    }

    let found = false;
    if (type === "we")       found = findAndUpdate(bank.work_experience);
    if (type === "projects") {
      found = findAndUpdate(bank.projects);
      if (!found) found = findAndUpdate(bank.media_projects?.sap_media_projects);
      if (!found) found = findAndUpdate(bank.media_projects?.creative_media_projects);
    }
    if (type === "certs")    found = findAndUpdate(bank.certifications_registry);
    if (type === "research") {
      found = findAndUpdate(bank.research_papers);
      if (!found) found = findAndUpdate(bank.research_activities);
    }

    if (!found) return res.status(404).json({ success: false, error: "Item not found" });

    fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2), "utf-8");
    skillBank = bank; // refresh in-memory cache
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// Robust JSON helpers for AI output
// ═══════════════════════════════════════════════════════════════

/**
 * Try multiple strategies to extract JSON from raw AI text.
 * 1. Strip markdown fences → JSON.parse
 * 2. Regex-match first ```json...``` block → JSON.parse
 * 3. Find first { … last } (or [ … ]) → JSON.parse
 */
function parseModelJson(raw) {
  if (!raw || typeof raw !== "string") return null;

  // Strategy 1 — strip common fences
  try {
    const s1 = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(s1);
  } catch (_) { /* continue */ }

  // Strategy 2 — regex fence match
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (_) { /* continue */ }
  }

  // Strategy 3 — first { to last }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) { /* continue */ }
  }

  return null;
}

/**
 * Check whether a parsed JSON object looks like a CV (not a cover letter).
 * CV signals: experience, projects, key_competencies, technical_skills
 * CL signals: paragraphs, position_title
 */
function looksLikeCvJson(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const cvSignals = ["experience", "projects", "key_competencies", "technical_skills", "education"].filter(k => obj[k]);
  const clSignals = ["paragraphs", "position_title"].filter(k => obj[k]);
  return cvSignals.length >= 2 && clSignals.length === 0;
}

// ═══════════════════════════════════════════════════════════════
// POST /generate
// ═══════════════════════════════════════════════════════════════

app.post("/generate", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured. Set ANTHROPIC_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY in .env" });

  const { jobDescription, documentType, humanizeText, pinnedWeIds, pinnedProjectIds, pinnedCertIds, pinnedResearchIds, jobTitle, jobReqId } = req.body;
  if (!jobDescription || !documentType) return res.status(400).json({ success: false, error: "Missing jobDescription or documentType." });

  const normalizeIdList = (value) => {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map(v => v.trim()).filter(Boolean);
    if (value && typeof value === "object") return Object.values(value).map(v => String(v).trim()).filter(Boolean);
    return [];
  };
  const pinnedWEList = normalizeIdList(pinnedWeIds);
  const pinnedProjectList = normalizeIdList(pinnedProjectIds);
  const pinnedCertList = normalizeIdList(pinnedCertIds);
  const pinnedResearchList = normalizeIdList(pinnedResearchIds);

  const now = Date.now();
  const wait = AI_MIN_GAP_MS - (now - lastAICall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastAICall = Date.now();

  try {
    // Always resolve pins against latest bank from disk (selector endpoint also does this)
    let latestBank = skillBank || {};
    try {
      latestBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
      skillBank = latestBank;
    } catch (_) {}

    let systemPrompt;
    let userPrompt;
    let ragContext = null;
    const pinTelemetry = {
      requested: {
        we: [...pinnedWEList],
        projects: [...pinnedProjectList],
        certs: [...pinnedCertList],
        research: [...pinnedResearchList]
      },
      applied: { we: [], projects: [] },
      cvProjectGuardrailEnforced: []
    };
    const docLabel = documentType === "cv" ? "CV" : "Cover Letter";
    const modelUsed = aiProvider === "claude" ? CLAUDE_MODEL : aiProvider === "groq" ? GROQ_MODEL : GEMINI_MODEL;
    console.log(`  /generate ${documentType.toUpperCase()} pins: WE=${pinnedWEList.length}, Projects=${pinnedProjectList.length}, Certs=${pinnedCertList.length}, Research=${pinnedResearchList.length}`);

    // ── RAG-based generation (primary path) ──
    if (vectorReady && retrieveContext) {
      ragContext = await retrieveContext(jobDescription, { topSkills: 12, topProjects: 3, topWork: 2 });
      console.log(`  RAG: ${ragContext.skills.length} skills, ${ragContext.projects.length} projects, ${ragContext.work.length} work`);

      // If user pinned specific WE/Project IDs, inject them from skill_data_bank
      if (pinnedWEList.length || pinnedProjectList.length) {
        const bank = latestBank;
        const mediaProjects = [
          ...(bank.media_projects?.sap_media_projects || []),
          ...(bank.media_projects?.creative_media_projects || [])
        ].map(p => ({
          id: p.id,
          name: p.name || p.title || "",
          tech: p.tech || (Array.isArray(p.tech_tools) ? p.tech_tools.join(", ") : ""),
          description: p.description || (Array.isArray(p.responsibilities) ? p.responsibilities.join(" ") : "")
        }));
        const projectPool = [...(bank.projects || []), ...mediaProjects];
        const projectById = new Map(projectPool.map(p => [p.id, p]));
        const workById = new Map((bank.work_experience || []).map(w => [w.id, w]));

        if (documentType === "cv") {
          // CV: full replacement (existing behavior)
          if (pinnedWEList.length) {
            const pinned = pinnedWEList.map(id => workById.get(id)).filter(Boolean);
            ragContext.work = pinned.map(w => ({
              id: w.id,
              document: `${w.title} at ${w.company} (${w.period}): ${(w.bullets||[]).join(' ')}`,
              metadata: { title: w.title, company: w.company, period: w.period, skills_used: w.skills_used || [] }
            }));
          }
          if (pinnedProjectList.length) {
            const pinned = pinnedProjectList.map(id => projectById.get(id)).filter(Boolean);
            ragContext.projects = pinned.map(p => ({
              id: p.id,
              document: p.description || p.name,
              metadata: { name: p.name, tech: p.tech }
            }));
          }
        } else {
          // CL: merge pinned at the front, then fill with RAG picks (deduplicated)
          if (pinnedWEList.length) {
            const pinned = pinnedWEList.map(id => workById.get(id)).filter(Boolean).map(w => ({
              id: w.id,
              document: `${w.title} at ${w.company} (${w.period}): ${(w.bullets||[]).join(' ')}`,
              metadata: { title: w.title, company: w.company, period: w.period, skills_used: w.skills_used || [] }
            }));
            const ragExtra = ragContext.work.filter(w => !pinnedWEList.includes(w.id));
            ragContext.work = [...pinned, ...ragExtra];
          }
          if (pinnedProjectList.length) {
            const pinned = pinnedProjectList.map(id => projectById.get(id)).filter(Boolean).map(p => ({
              id: p.id,
              document: `${p.name} (${p.tech}): ${p.description}`,
              metadata: { name: p.name, tech: p.tech }
            }));
            const ragExtra = ragContext.projects.filter(p => !pinnedProjectList.includes(p.id));
            ragContext.projects = [...pinned, ...ragExtra];
          }
        }
        console.log(`  Pinned overrides (${documentType}): ${ragContext.work.length} WE, ${ragContext.projects.length} projects`);
        console.log(`  Resolved IDs (${documentType}): WE=[${ragContext.work.map(w => w.id).join(", ")}], Projects=[${ragContext.projects.map(p => p.id).join(", ")}]`);
        pinTelemetry.applied.we = ragContext.work.map(w => w.id);
        pinTelemetry.applied.projects = ragContext.projects.map(p => p.id);
      }

      // Resolve selected certifications
      const bank2 = latestBank;
      const allCerts = bank2.certifications_registry || [];
      const selectedCerts = pinnedCertList.length
        ? allCerts.filter(c => pinnedCertList.includes(c.id))
        : allCerts;

      // Resolve selected research papers + activities
      const allRP = bank2.research_papers || [];
      const allRA = bank2.research_activities || [];
      const allResearch = [...allRP, ...allRA];
      const selectedResearch = pinnedResearchList.length
        ? allResearch.filter(r => pinnedResearchList.includes(r.id))
        : allResearch;

      systemPrompt = documentType === "cv"
        ? buildCvSystemPromptRAG(ragContext.skills, ragContext.projects, ragContext.work, pinnedWEList, pinnedProjectList, selectedCerts, selectedResearch, latestBank)
        : buildClSystemPromptRAG(ragContext.skills, ragContext.projects, ragContext.work, pinnedWEList, pinnedProjectList, selectedCerts, selectedResearch);

      const titleConstraint = jobTitle
        ? `\nHARD CONSTRAINT — copy these EXACTLY into the JSON, do NOT paraphrase:\nposition_title: ${jobTitle}\nreq_id: ${jobReqId || ""}\n`
        : "";
      userPrompt = `=== TARGET JOB DESCRIPTION ===\n${jobDescription}\n${titleConstraint}\n=== TASK ===\nGenerate a complete ${docLabel} tailored to the job above.\nUse ONLY facts from the matched skill data. Output ONLY the final JSON.\n`;
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
      contentJson = parseModelJson(rawContent);
      if (!contentJson) throw new Error("No JSON object found in AI response");

      // Guard: if we asked for a CV but got CL-shaped JSON, reject it
      if (documentType === "cv" && !looksLikeCvJson(contentJson)) {
        console.warn("AI returned CL-shaped JSON for a CV request — will attempt repair");
        throw new Error("Response has cover-letter shape, not CV shape");
      }

      if (documentType === "cv" && contentJson && typeof contentJson === "object") {
        const rawProfile = (contentJson.profile || contentJson.profile_summary || contentJson.professional_summary || "").toString();
        if (rawProfile.trim()) {
          const sanitized = rawProfile
            .replace(/\s+/g, " ")
            .replace(/\b(results-driven|proven track record|passionate|excited to apply|highly motivated)\b/gi, "")
            .replace(/\s{2,}/g, " ")
            .trim();
          // Improved: Split on sentence-ending punctuation NOT preceded by abbreviations (M.Sc., Dr., etc.)
          const sentences = sanitized.split(/(?<!\b[A-Z])(?<!\b[A-Z][a-z])(?<!\bSc)(?<!\bDr)(?<!\bMr)(?<!\bMs)(?<!\bvs)(?<!\betc)(?<!\be\.g)(?<!\bi\.e)\.\s+/)
            .map(s => s.trim()).filter(s => s.length > 5);
          let crispProfile = sentences.slice(0, 2).join(". ").trim();
          if (crispProfile && !crispProfile.endsWith(".")) crispProfile += ".";
          if (crispProfile.length > 350) crispProfile = `${crispProfile.slice(0, 347).trimEnd()}...`;
          contentJson.profile = crispProfile;
        }

        if (pinnedProjectList.length && Array.isArray(contentJson.projects)) {
          const bankNow = latestBank;
          const mediaNow = [
            ...(bankNow.media_projects?.sap_media_projects || []),
            ...(bankNow.media_projects?.creative_media_projects || [])
          ].map(p => ({
            id: p.id,
            name: p.name || p.title || "",
            tech: p.tech || (Array.isArray(p.tech_tools) ? p.tech_tools.join(", ") : ""),
            description: p.description || (Array.isArray(p.responsibilities) ? p.responsibilities.join(" ") : "")
          }));
          const projectPoolNow = [...(bankNow.projects || []), ...mediaNow];
          const byIdNow = new Map(projectPoolNow.map(p => [p.id, p]));
          const resolvedPinnedCvProjects = pinnedProjectList.map(id => byIdNow.get(id)).filter(Boolean).map(p => ({
            id: p.id,
            document: p.description || p.name,
            metadata: { name: p.name, tech: p.tech }
          }));
          if (resolvedPinnedCvProjects.length) {
            const existingProjects = contentJson.projects;
            const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
            const enforced = resolvedPinnedCvProjects.map((rp) => {
              const existing = existingProjects.find(ep => normalize(ep.title) === normalize(rp.metadata?.name));
              if (existing) return existing;
              return {
                title: rp.metadata?.name || "",
                date: "",
                tech: rp.metadata?.tech || "",
                description: rp.document || "",
                bullets: []
              };
            });
            contentJson.projects = enforced;
            pinTelemetry.cvProjectGuardrailEnforced = resolvedPinnedCvProjects.map(p => p.id);
          }
        }
      }

      // ── CL: auto-bold skill/tool names from matched DB entries ──
      if (documentType === "cl" && Array.isArray(contentJson?.paragraphs) && ragContext) {
        const boldTerms = new Set();
        (ragContext.skills || []).forEach(s => {
          const name = (s.metadata?.skill_name || "").trim();
          if (name.length >= 4) boldTerms.add(name);
        });
        (ragContext.projects || []).forEach(p => {
          (p.metadata?.tech || "").split(/[,/]/).forEach(t => {
            const term = t.trim();
            if (term.length >= 4) boldTerms.add(term);
          });
        });
        // Longest-first so multi-word terms match before their components
        const termList = [...boldTerms].sort((a, b) => b.length - a.length);
        contentJson.paragraphs = contentJson.paragraphs.map(para => {
          let result = para;
          for (const term of termList) {
            const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // Bold first occurrence per term per paragraph; skip if already wrapped
            result = result.replace(new RegExp(`(?<!\\*)\\b(${esc})\\b(?!\\*)`, "i"), "**$1**");
          }
          return result;
        });
      }

      content = documentType === "cv" ? jsonToDisplayCv(contentJson) : jsonToDisplayCl(contentJson);
      console.log(`JSON parsed OK. Display text: ${content.length} chars`);
    } catch (parseErr) {
      console.warn("JSON parse failed:", parseErr.message);

      // ── One repair attempt: ask AI to convert to valid JSON ──
      if (documentType === "cv") {
        try {
          console.log("Attempting AI repair for CV JSON...");
          const waitR = AI_MIN_GAP_MS - (Date.now() - lastAICall);
          if (waitR > 0) await new Promise(r => setTimeout(r, waitR));
          lastAICall = Date.now();
          const repairPrompt = `The following text was supposed to be a CV in JSON format but is malformed or is a cover letter.\nConvert it into a valid JSON object matching this schema: {"name","location","phone","email","linkedin","github","languages","profile","key_competencies","technical_skills":[],"education":[],"experience":[],"projects":[],"research_activities":[],"certifications":[]}.\nReturn ONLY the JSON, nothing else.\n\nOriginal text:\n${rawContent.slice(0, 6000)}`;
          const repairRaw = await callAI("You are a JSON repair assistant. Output ONLY valid JSON.", repairPrompt);
          const repairJson = parseModelJson(repairRaw);
          if (repairJson && looksLikeCvJson(repairJson)) {
            contentJson = repairJson;
            content = jsonToDisplayCv(contentJson);
            console.log("AI repair succeeded — CV JSON recovered.");
          } else {
            console.warn("AI repair did not produce valid CV JSON.");
            content = "[CV generation failed — the AI did not return a valid CV. Please click the refresh button to retry.]";
          }
        } catch (repairErr) {
          console.warn("AI repair call failed:", repairErr.message);
          content = "[CV generation failed — the AI did not return a valid CV. Please click the refresh button to retry.]";
        }
      }
      // For CL, raw text fallback is acceptable
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
        documentType,
        pinTelemetry
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

    // Ghostscript post-processing: strip all active/clickable content for portal compatibility
    const sanitizedPdf = path.join(tmpDir, `${safeName}_sanitized.pdf`);
    await runGhostscript(pdfFile, sanitizedPdf);
    const finalPdf = fs.existsSync(sanitizedPdf) ? sanitizedPdf : pdfFile;

    const pdfBuffer = fs.readFileSync(finalPdf);
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(finalPdf, path.join(outDir, `${safeName}.pdf`));

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

function runGhostscript(inputPdf, outputPdf) {
  const gsCmd = process.platform === "win32" ? "gswin64c" : "gs";
  return new Promise((resolve, reject) => {
    execFile(
      gsCmd,
      [
        "-sDEVICE=pdfwrite",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dFastWebView=false",
        "-dCompatibilityLevel=1.4",
        "-dPDFSETTINGS=/printer",
        `-sOutputFile=${outputPdf}`,
        inputPdf
      ],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn("Ghostscript sanitization failed (falling back to raw PDF):", err.message);
          return resolve(); // non-fatal — fall back to unsanitized PDF
        }
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
  if (j.languages) lines.push(`Languages: ${j.languages}`);
  lines.push("");

  const profileText = (j.profile || j.profile_summary || j.professional_summary || "").toString().trim();
  if (profileText) {
    lines.push("PROFILE");
    lines.push(profileText);
    lines.push("");
  }

  const keyComp = j.key_competencies || (j.competencies?.length
    ? j.competencies.map(c => c.items).filter(Boolean).join(" • ")
    : "");
  if (keyComp) {
    lines.push("KEY COMPETENCIES");
    lines.push(keyComp);
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
  if (j.experience?.length) {
    lines.push("WORK EXPERIENCE");
    j.experience.forEach((ex, i) => {
      lines.push(`${ex.title}   ${ex.date}`);
      lines.push(ex.company);
      if (ex.description) lines.push(ex.description);
      else (ex.bullets || []).forEach(b => lines.push(`- ${b}`));
      if (i < j.experience.length - 1) lines.push("");
    });
    lines.push("");
  }
  if (j.projects?.length) {
    lines.push("PROJECTS");
    j.projects.forEach((p, i) => {
      lines.push(`${p.title}   ${p.date}`);
      if (p.tech) lines.push(p.tech);
      if (p.description) lines.push(p.description);
      else (p.bullets || []).forEach(b => lines.push(`- ${b}`));
      if (i < j.projects.length - 1) lines.push("");
    });
    lines.push("");
  }
  if (j.research_activities?.length) {
    lines.push("RESEARCH & ACTIVITIES");
    j.research_activities.forEach((r, i) => {
      lines.push(`${r.title}   ${r.date || ""}`.trim());
      if (r.organization) lines.push(r.organization);
      if (r.description) lines.push(r.description);
      if (i < j.research_activities.length - 1) lines.push("");
    });
    lines.push("");
  }
  if (j.certifications?.length) {
    lines.push("CERTIFICATIONS");
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

const LATEX_CV_PREAMBLE = `\\pdfminorversion=4
\\documentclass[11pt,a4paper]{article}

%---------------------------------------------------------------
% BASIC PACKAGES
%---------------------------------------------------------------
\\usepackage[margin=1.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{enumitem}
\\usepackage{xcolor}
% No hyperref — portal-safe plain-text stubs (no active content in PDF)
\\newcommand{\\href}[2]{#2}
\\newcommand{\\url}[1]{\\texttt{#1}}
\\newcommand{\\hypersetup}[1]{}
\\usepackage{titlesec}

%---------------------------------------------------------------
% COLORS
%---------------------------------------------------------------
\\definecolor{heading}{HTML}{111111}
\\definecolor{body}{HTML}{333333}
\\definecolor{lighttext}{HTML}{666666}

%---------------------------------------------------------------
% GLOBAL TEXT SETTINGS
%---------------------------------------------------------------
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{1pt}
\\renewcommand{\\baselinestretch}{1.05}

\\setlist[itemize]{
  leftmargin=1.8em,
  itemsep=1pt,
  topsep=1pt
}

%---------------------------------------------------------------
% SECTION FORMATTING
%---------------------------------------------------------------
\\titleformat{\\section}{
  \\large\\bfseries\\color{heading}
}{}{0pt}{}

\\titlespacing*{\\section}{0pt}{6pt}{2pt}

%---------------------------------------------------------------
% REUSABLE COMMANDS
%---------------------------------------------------------------
\\newcommand{\\sectrule}{\\vspace{2pt}\\hrule\\vspace{3pt}}

\\newcommand{\\name}[1]{%
  {\\Huge\\bfseries\\color{heading} #1}\\par\\vspace{4pt}%
}

\\newcommand{\\cventry}[2]{{\\color{heading}\\textbf{#1}} \\hfill {\\color{lighttext}#2}\\par}
\\newcommand{\\cvsubtitle}[1]{{\\color{body}\\textit{#1}\\par}}
\\newcommand{\\cvbody}[1]{{\\color{body}#1\\par}}

\\begin{document}
\\pagestyle{empty}

`;

const LATEX_CL_PREAMBLE = `\\pdfminorversion=4
\\documentclass[11pt,a4paper]{article}
\\usepackage[top=2.5cm,bottom=2.5cm,left=2.8cm,right=2.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{parskip}
\\usepackage{xcolor}
% No hyperref — portal-safe plain-text stubs (no active content in PDF)
\\newcommand{\\href}[2]{#2}
\\newcommand{\\url}[1]{\\texttt{#1}}
\\newcommand{\\hypersetup}[1]{}

\\definecolor{lighttext}{HTML}{555555}
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
  if (j.languages) body += `\\textbf{Languages:} ${e(j.languages)}\\par\n`;
  body += `}\n\n\\vspace{3pt}\n\\sectrule\n\n`;

  // Profile summary
  const profileText = (j.profile || j.profile_summary || j.professional_summary || "").toString().trim();
  if (profileText) {
    body += `\\section*{PROFILE}\n\\cvbody{${e(profileText)}}\n\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Key Competencies — replace bullet • with LaTeX $\,\bullet\,$
  const keyComp = j.key_competencies || (j.competencies?.length
    ? j.competencies.map(c => c.items).filter(Boolean).join(" • ")
    : "");
  if (keyComp) {
    const keyCompTex = e(keyComp).replace(/•/g, "$\\,\\bullet\\,$");
    body += `\\section*{KEY COMPETENCIES}\n{\\color{body}\n${keyCompTex}\\par\n}\n\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Technical Skills — plain \cvbody{Category: items} matching reference
  if (j.technical_skills?.length) {
    body += `\\section*{TECHNICAL SKILLS}\n`;
    j.technical_skills.forEach(s => {
      body += `\\cvbody{${e(s.category)}: ${e(s.items)}}\n`;
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Education
  if (j.education?.length) {
    body += `\\section*{EDUCATION}\n`;
    j.education.forEach((ed, i) => {
      body += `\\cventry{${e(ed.degree)}}{${e(ed.date)}}\n`;
      body += `\\cvbody{${e(ed.institution)}}\n`;
      if (ed.coursework) body += `\\cvbody{Selected coursework: ${e(ed.coursework)}}\n`;
      body += i < j.education.length - 1 ? "\n\\vspace{2pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Work Experience
  if (j.experience?.length) {
    body += `\\section*{WORK EXPERIENCE}\n`;
    j.experience.forEach((ex, i) => {
      body += `\\cventry{${e(ex.title)}}{${e(ex.date)}}\n`;
      body += `\\cvsubtitle{${e(ex.company)}}\n`;
      const exDesc = ex.description || (ex.bullets || []).join(" ");
      if (exDesc) body += `\\cvbody{${e(exDesc)}}\n`;
      body += i < j.experience.length - 1 ? "\n\\vspace{3pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Projects — strictly same structure as Work Experience
  if (j.projects?.length) {
    body += `\\section*{PROJECTS}\n`;
    j.projects.forEach((p, i) => {
      body += `\\cventry{${e(p.title)}}{${e(p.date)}}\n`;
      body += `\\cvsubtitle{${e(p.tech)}}\n`;
      const pDesc = p.description || (p.bullets || []).join(" ");
      if (pDesc) body += `\\cvbody{${e(pDesc)}}\n`;
      body += i < j.projects.length - 1 ? "\n\\vspace{3pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }

  // Research & Activities — strictly same structure as Work Experience
  if (j.research_activities?.length) {
    body += `\\section*{RESEARCH \\& ACTIVITIES}\n`;
    j.research_activities.forEach((r, i) => {
      body += `\\cventry{${e(r.title)}}{${e(r.date || "")}}\n`;
      body += `\\cvsubtitle{${e(r.organization)}}\n`;
      if (r.description) body += `\\cvbody{${e(r.description)}}\n`;
      body += i < j.research_activities.length - 1 ? "\n\\vspace{3pt}\n\n" : "";
    });
    body += `\n\\vspace{2pt}\n\\sectrule\n\n`;
  }


  // Certifications
  if (j.certifications?.length) {
    body += `\\section*{CERTIFICATIONS}\n`;
    j.certifications.forEach((c, i) => {
      body += `\\cventry{${e(c.name)}}{${e(c.date || "")}}\n`;
      if (c.description) body += `\\cvbody{${e(c.description)}}\n`;
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

  return `\\pdfminorversion=4
\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{enumitem}
\\usepackage{xcolor}
% No hyperref — portal-safe plain-text stubs (no active content in PDF)
\\newcommand{\\href}[2]{#2}
\\newcommand{\\url}[1]{\\texttt{#1}}
\\newcommand{\\hypersetup}[1]{}
\\usepackage{titlesec}

\\definecolor{heading}{HTML}{111111}
\\definecolor{body}{HTML}{333333}
\\definecolor{lighttext}{HTML}{666666}

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

  return `\\pdfminorversion=4
\\documentclass[11pt,a4paper]{article}
\\usepackage[top=2.5cm,bottom=2.5cm,left=2.8cm,right=2.8cm]{geometry}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage{setspace}
\\usepackage{parskip}
\\usepackage{xcolor}
% No hyperref — portal-safe plain-text stubs (no active content in PDF)
\\newcommand{\\href}[2]{#2}
\\newcommand{\\url}[1]{\\texttt{#1}}
\\newcommand{\\hypersetup}[1]{}

\\definecolor{lighttext}{HTML}{555555}
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
  const { id, level, evidence, tools } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "Missing skill id" });
  try {
    const updates = {};
    if (level) updates.level = level;
    if (evidence) updates.evidence = evidence;
    if (tools) updates.tools = tools;
    const chunk = await skillBankManager.updateSkill(id, updates);
    skillBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
    res.json({ success: true, chunk });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ── Add tool tag to existing skill ──
app.post("/skill-bank/add-tool", async (req, res) => {
  if (!skillBankManager) return res.status(503).json({ success: false, error: "Skill bank not available" });
  const { id, tool } = req.body;
  if (!id || !tool) return res.status(400).json({ success: false, error: "Missing id or tool" });
  try {
    const bank = skillBankManager.loadBank();
    const chunk = bank.skill_chunks.find(c => c.id === id);
    if (!chunk) return res.status(404).json({ success: false, error: `Skill ${id} not found` });
    if (!chunk.tools) chunk.tools = [];
    const toolName = tool.trim();
    if (!chunk.tools.some(t => t.toLowerCase() === toolName.toLowerCase())) {
      chunk.tools.push(toolName);
    }
    skillBankManager.saveBank(bank);
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

// ── Search skill bank by keyword (text match on name + evidence) ──
app.get("/skill-bank/search", (req, res) => {
  if (!skillBank) return res.status(503).json({ success: false, error: "Skill bank not loaded" });
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ success: true, results: [] });
  const tokens = q.split(/\s+/).filter(Boolean);
  const results = (skillBank.skill_chunks || []).filter(s => {
    const name = (s.skill || "").toLowerCase();
    const ev = (s.evidence || "").toLowerCase();
    const cat = (s.category || "").toLowerCase();
    const toolTags = (s.tools || []).join(" ").toLowerCase();
    const hay = name + " " + ev + " " + cat + " " + toolTags;
    return tokens.every(t => hay.includes(t)) || name.includes(q) || q.includes(name);
  }).map(s => ({
    id: s.id, skill: s.skill, category: s.category, level: s.level, evidence: s.evidence, type: s.type, tools: s.tools || []
  })).slice(0, 15);
  res.json({ success: true, results });
});

// ── Synthesize merged evidence from selected skills ──
app.post("/skill-bank/synthesize", async (req, res) => {
  const { keyword, evidence, level } = req.body;
  if (!keyword) return res.status(400).json({ success: false, error: "Missing keyword" });
  try {
    const style = styleProfile?.style_analysis || {};
    const toneDesc = style.tone_description || "confident, specific, professional";
    const avoids = (style.things_to_never_write_as_me || style.vocabulary_preferences?.avoids || []).join(", ");
    const prompt = evidence && evidence.length
      ? `Keyword: ${keyword}\nLevel: ${level || "Intermediate"}\nRelated evidence from skill bank:\n${evidence.map((e, i) => `${i + 1}. ${e}`).join("\n")}\n\nSynthesize a single concise evidence statement (max 20 words) that demonstrates proficiency in "${keyword}". Draw from the provided evidence. No trailing period.`
      : `Keyword: ${keyword}\nLevel: ${level || "Intermediate"}\n\nWrite a single practical evidence statement (max 20 words) demonstrating experience with "${keyword}". No trailing period.`;
    const text = await callAI(
      `You write concise CV skill evidence. Tone: ${toneDesc}. Max 20 words, single sentence, no quotes, no trailing period.${avoids ? " NEVER use: " + avoids : ""}`,
      prompt
    );
    res.json({ success: true, evidence: text.trim().replace(/^"|"$/g, "").replace(/\.$/, "") });
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
    const validCategories = ["SAP_Technical","Engineering_Dev","Data_Analytics","Design_UX","Creative_Media","Tools_Platforms","Domain_Professional"];
    const text = await callAI(
      "You are a CV evidence writer. Reply with ONLY valid JSON, no markdown, no explanation. Keys: \"category\" (one of: SAP_Technical, Engineering_Dev, Data_Analytics, Design_UX, Creative_Media, Tools_Platforms, Domain_Professional) and \"evidence\" (a single practical sentence, max 20 words, no quotes, no trailing period).",
      `Skill/Tool: ${skill}\nLevel: ${level || "Intermediate"}\n${context ? "Candidate context: " + context : ""}\n\nReturn JSON with category and evidence.`
    );
    let suggestion = "", category = "Tools_Platforms";
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
// POST /apply-style  — rewrite pasted text in Varun's voice
// ═══════════════════════════════════════════════════════════════

app.post("/apply-style", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured" });
  const { text, mode } = req.body; // mode: "cl" | "cv"
  if (!text?.trim()) return res.status(400).json({ success: false, error: "Missing text" });

  const style   = styleProfile?.style_analysis || {};
  const tone    = style.tone_description    || "confident, assertive, specific — not generic";
  const evStyle = style.evidence_style      || "flowing narrative prose, company names inline";
  const phrases = (style.signature_phrases || []).slice(0, 4).join(" | ");
  const connectors = (style.connector_words || []).filter(c => c !== "Throughout my career").join(", ");
  const avoids  = [
    ...(style.things_to_never_write_as_me || []),
    ...(style.vocabulary_preferences?.avoids || []),
    "I am writing to apply", "I am excited to apply", "I am passionate about",
    "leverage my skills", "results-driven", "proven track record"
  ].join(", ");

  const systemPrompt = mode === "cv"
    ? `You rewrite CV text to match this person's CV style. Rules:
- Lead each bullet/sentence with action verb or tool name, then outcome
- Include specific tool names and numbers from the original — do NOT remove them
- Avoid first person ("I") — start directly with the action
- Keep each bullet under 22 words. Drop filler ("responsible for", "worked on", "helped")
- Tone: ${tone}
- NEVER use: ${avoids}
Return ONLY the rewritten text. No commentary.`
    : `You rewrite cover letter text to match this person's exact writing style. Rules:
- Tone: ${tone}
- Evidence style: ${evStyle}
${phrases ? `- Natural phrases this person uses: ${phrases}` : ""}
${connectors ? `- Connector words to use where natural: ${connectors}` : ""}
- NEVER use: ${avoids}
- No bold, no bullet points in the letter body. First person throughout.
- Name employers inline: "At SAP IX Studio..." / "At SAP Non-Commercial Licensing..."
- Keep ALL facts, dates, company names, metrics — only change style, not content
Return ONLY the rewritten text. No commentary.`;

  try {
    const wait = AI_MIN_GAP_MS - (Date.now() - lastAICall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAICall = Date.now();
    const styled = await callAI(systemPrompt, `Rewrite this in the style described above:\n\n${text.trim()}`);
    res.json({ success: true, styled: styled.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// OUTLOOK EMAIL INTEGRATION (OAuth2 + Microsoft Graph)
// ═══════════════════════════════════════════════════════════════

const OUTLOOK_CLIENT_ID = process.env.OUTLOOK_CLIENT_ID || "";
const OUTLOOK_TENANT = process.env.OUTLOOK_TENANT || "common";
const OUTLOOK_REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const OUTLOOK_SCOPES = "Mail.Read User.Read offline_access";

// In-memory token store (per session — not persisted)
let outlookTokens = null;

app.get("/auth/outlook", (req, res) => {
  if (!OUTLOOK_CLIENT_ID) return res.status(503).json({ error: "OUTLOOK_CLIENT_ID not set in .env" });
  // PKCE: generate code_verifier and code_challenge
  const crypto = require("crypto");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  // Store verifier in memory for callback
  outlookTokens = { codeVerifier };
  const authUrl = `https://login.microsoftonline.com/${OUTLOOK_TENANT}/oauth2/v2.0/authorize?` +
    `client_id=${encodeURIComponent(OUTLOOK_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(OUTLOOK_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(OUTLOOK_SCOPES)}` +
    `&response_mode=query` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code || !outlookTokens?.codeVerifier) {
    return res.status(400).send("<h3>Auth failed — no code received. <a href='/'>Go back</a></h3>");
  }
  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${OUTLOOK_TENANT}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OUTLOOK_CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: OUTLOOK_REDIRECT_URI,
        scope: OUTLOOK_SCOPES,
        code_verifier: outlookTokens.codeVerifier
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
    outlookTokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + (tokenData.expires_in * 1000)
    };
    console.log("[Outlook] Connected successfully");
    res.send(`<html><body style="font-family:system-ui;text-align:center;padding:60px">
      <h2 style="color:#22c55e">✓ Outlook Connected</h2>
      <p>You can close this tab and go back to the app.</p>
      <script>setTimeout(function(){window.close()},2000)</script>
    </body></html>`);
  } catch (err) {
    console.error("[Outlook] Auth error:", err.message);
    res.status(500).send(`<h3>Auth failed: ${err.message}. <a href='/'>Go back</a></h3>`);
  }
});

async function refreshOutlookToken() {
  if (!outlookTokens?.refreshToken) return false;
  try {
    const tokenRes = await fetch(`https://login.microsoftonline.com/${OUTLOOK_TENANT}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OUTLOOK_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: outlookTokens.refreshToken,
        scope: OUTLOOK_SCOPES
      })
    });
    const data = await tokenRes.json();
    if (data.error) throw new Error(data.error_description || data.error);
    outlookTokens.accessToken = data.access_token;
    if (data.refresh_token) outlookTokens.refreshToken = data.refresh_token;
    outlookTokens.expiresAt = Date.now() + (data.expires_in * 1000);
    return true;
  } catch { return false; }
}

async function getOutlookToken() {
  if (!outlookTokens?.accessToken) return null;
  if (Date.now() > outlookTokens.expiresAt - 60000) {
    const ok = await refreshOutlookToken();
    if (!ok) { outlookTokens = null; return null; }
  }
  return outlookTokens.accessToken;
}

app.get("/api/email/status", async (req, res) => {
  const token = await getOutlookToken();
  if (!token) return res.json({ connected: false });
  try {
    const me = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const user = await me.json();
    res.json({ connected: true, email: user.mail || user.userPrincipalName, name: user.displayName });
  } catch {
    res.json({ connected: false });
  }
});

// Rejection email patterns
const REJECTION_PATTERNS = [
  /unfortunately[,.]?\s.*(not|unable|cannot)/i,
  /regret to inform/i,
  /not (be )?mov(e|ing) forward/i,
  /will not be (proceeding|continuing)/i,
  /decided not to (proceed|continue|advance)/i,
  /not (been )?selected/i,
  /position has been filled/i,
  /pursue other candidates/i,
  /unable to offer/i,
  /not (a |the )?match/i,
  /your application.*(unsuccessful|not successful)/i,
  /after careful (consideration|review).*(not|unfortunately)/i,
  /we (have |will )?(chose|chosen|selected) (another|other|a different)/i,
  /Absage/i,
  /leider (nicht|kein)/i,
  /können wir Ihnen leider/i,
  /müssen wir Ihnen leider mitteilen/i
];

function isRejectionEmail(subject, bodyPreview) {
  const text = (subject + " " + bodyPreview).trim();
  return REJECTION_PATTERNS.some(p => p.test(text));
}

function extractMatchInfo(subject, bodyPreview, trackerApps) {
  const text = (subject + " " + bodyPreview).toLowerCase();
  const matches = [];
  for (const app of trackerApps) {
    let score = 0;
    // Match by Req ID (strongest signal)
    if (app.reqId && text.includes(app.reqId.toLowerCase())) score += 10;
    // Match by company name
    if (app.company && text.includes(app.company.toLowerCase())) score += 5;
    // Match by role/title keywords (2+ word match)
    if (app.role) {
      const words = app.role.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const wordHits = words.filter(w => text.includes(w)).length;
      if (wordHits >= 2) score += 3;
      else if (wordHits === 1) score += 1;
    }
    if (score >= 3) matches.push({ appId: app.id, company: app.company, role: app.role, reqId: app.reqId, score });
  }
  return matches.sort((a, b) => b.score - a.score);
}

app.post("/api/email/scan", async (req, res) => {
  const token = await getOutlookToken();
  if (!token) return res.status(401).json({ success: false, error: "Outlook not connected. Click 'Connect Outlook' first." });

  const { applications } = req.body; // Tracker apps from frontend
  if (!applications?.length) return res.json({ success: true, rejections: [], message: "No applications to match against." });

  try {
    // Fetch last 60 days of emails, max 100
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const filter = `receivedDateTime ge ${since}`;
    const select = "subject,bodyPreview,from,receivedDateTime";
    const graphUrl = `https://graph.microsoft.com/v1.0/me/messages?$filter=${encodeURIComponent(filter)}&$select=${select}&$top=100&$orderby=receivedDateTime desc`;

    const emailRes = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!emailRes.ok) {
      const err = await emailRes.json().catch(() => ({}));
      throw new Error(err.error?.message || `Graph API returned ${emailRes.status}`);
    }
    const emailData = await emailRes.json();
    const emails = emailData.value || [];
    console.log(`[Outlook] Scanned ${emails.length} emails from last 60 days`);

    // Filter only potential active applications (Applied, OA/Test, Interview)
    const activeApps = applications.filter(a => ["Applied", "OA/Test", "Interview"].includes(a.stage));

    const rejections = [];
    for (const email of emails) {
      if (!isRejectionEmail(email.subject || "", email.bodyPreview || "")) continue;
      const matched = extractMatchInfo(email.subject || "", email.bodyPreview || "", activeApps);
      if (matched.length > 0) {
        rejections.push({
          emailSubject: email.subject,
          emailFrom: email.from?.emailAddress?.address || "unknown",
          emailDate: email.receivedDateTime,
          emailPreview: (email.bodyPreview || "").slice(0, 200),
          matchedApp: matched[0] // Best match
        });
      }
    }

    console.log(`[Outlook] Found ${rejections.length} rejection emails matching tracked applications`);
    res.json({ success: true, rejections, totalScanned: emails.length });
  } catch (err) {
    console.error("[Outlook] Scan error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/auth/outlook/disconnect", (req, res) => {
  outlookTokens = null;
  console.log("[Outlook] Disconnected");
  res.json({ success: true });
});

if (OUTLOOK_CLIENT_ID) console.log("[OK] Outlook integration ready");

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n  SAP Job Automator`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  AI: ${aiProvider || "NONE (set API key in .env)"}\n`);
});
