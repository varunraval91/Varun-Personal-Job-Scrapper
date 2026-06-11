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
app.use("/firebase-config", require("./routes/firebaseConfig"));
// Never cache index.html — ensures version-busted JS/CSS changes reach the browser immediately
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "index.html"));
});
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
  "/search-intelligence": { windowMs: 60000, max: 20 },
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
const BASF_BASE_URL = "https://basf.jobs";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ═══════════════════════════════════════════════════════════════
// PORTAL DETECTION — identify career site platform from URL
// ═══════════════════════════════════════════════════════════════

const PORTAL_SELECTORS = {
  successfactors: {
    title: '[data-careersite-propertyid="title"]',
    location: '[data-careersite-propertyid="location"], .jobLocation',
    date: '[data-careersite-propertyid="date"]',
    reqId: '[data-careersite-propertyid="facility"]',
    description: '.jdp-job-description-card, .job-description, [data-careersite-propertyid="description"]',
    fallback: 'main, .job-details, .jdp-job-description',
    cookie: ['#truste-consent-button', '#truste-consent-required', '#truste-show-consent']
  },
  workday: {
    title: '[data-automation-id="jobPostingHeader"], h2[data-automation-id="jobTitle"], [data-automation-id="jobPostingTitle"]',
    location: '[data-automation-id="locations"], [data-automation-id="jobPostingLocation"]',
    date: '[data-automation-id="postedOn"], [data-automation-id="jobPostingDate"]',
    reqId: '[data-automation-id="requisitionId"]',
    description: '[data-automation-id="jobPostingDescription"]',
    fallback: '.job-posting-content, main, [role="main"]',
    cookie: ['button[data-automation-id="legalNoticeAccept"]']
  },
  greenhouse: {
    title: '.app-title, h1.posting-headline, h1',
    location: '.location, .posting-categories .sort-by-commitment',
    date: '',
    reqId: '',
    description: '#content .postings-content, .posting-page .content, #content',
    fallback: '#main, .posting-page',
    cookie: []
  },
  lever: {
    title: '.posting-headline h2, .posting-header .posting-title, h2',
    location: '.posting-categories .sort-by-team, .location',
    date: '',
    reqId: '',
    description: '.posting-page .section-wrapper, .posting-content',
    fallback: '.posting-page, main',
    cookie: []
  },
  smartrecruiters: {
    title: 'h1.job-title, .job-title h1, h1',
    location: '.job-location, .location',
    date: '.job-date, .posted-date',
    reqId: '.job-id, .reference-id',
    description: '.job-description, .job-sections',
    fallback: '.job-details, main',
    cookie: ['#onetrust-accept-btn-handler']
  },
  icims: {
    title: '.iCIMS_Header h1, .header-title, h1',
    location: '.iCIMS_JobHeaderLocation, .header-location',
    date: '.iCIMS_JobHeaderField, .header-date',
    reqId: '.iCIMS_JobHeaderID, .header-id',
    description: '.iCIMS_JobContent, .job-description',
    fallback: '.iCIMS_MainWrapper, main',
    cookie: []
  }
};

function detectPortalType(url) {
  if (!url) return { type: "generic", company: "Unknown", domain: "" };
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    // Extract company name from domain
    const extractCompany = (h) => {
      // jobs.infineon.com → Infineon, careers-bosch.icims.com → Bosch
      const parts = h.replace(/^www\./, "").split(".");
      for (const p of parts) {
        const clean = p.replace(/^(jobs|careers|career|recruiting|recruit|hire)-?/i, "");
        if (clean && !["com","org","net","de","io","co","wd1","wd2","wd3","wd4","wd5","myworkdayjobs","myworkdaysite","greenhouse","lever","smartrecruiters","icims","phenom"].includes(clean)) {
          return clean.charAt(0).toUpperCase() + clean.slice(1);
        }
      }
      return parts[0]?.charAt(0).toUpperCase() + parts[0]?.slice(1) || "Unknown";
    };

    // Platform detection by URL patterns
    if (host.includes("jobs.sap.com") || host.includes("careers.sap.com")) {
      return { type: "successfactors", company: "SAP", domain: host };
    }
    if (host.includes("basf.jobs") || host.includes("careers.basf.com")) {
      return { type: "successfactors", company: "BASF", domain: host };
    }
    if (host.includes("myworkdayjobs.com") || host.includes("myworkdaysite.com") || host.includes("wd1.") || host.includes("wd2.") || host.includes("wd3.") || host.includes("wd4.") || host.includes("wd5.")) {
      return { type: "workday", company: extractCompany(host), domain: host };
    }
    if (host.includes("greenhouse.io")) {
      const co = path.split("/")[1] || extractCompany(host);
      return { type: "greenhouse", company: co.charAt(0).toUpperCase() + co.slice(1), domain: host };
    }
    if (host.includes("lever.co")) {
      const co = path.split("/")[1] || extractCompany(host);
      return { type: "lever", company: co.charAt(0).toUpperCase() + co.slice(1), domain: host };
    }
    if (host.includes("smartrecruiters.com")) {
      const co = path.split("/")[1] || extractCompany(host);
      return { type: "smartrecruiters", company: co.charAt(0).toUpperCase() + co.slice(1), domain: host };
    }
    if (host.includes("icims.com")) {
      return { type: "icims", company: extractCompany(host), domain: host };
    }
    // Some companies use SuccessFactors on their own domain (check DOM later)
    return { type: "generic", company: extractCompany(host), domain: host };
  } catch {
    return { type: "generic", company: "Unknown", domain: "" };
  }
}
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
const AI_MIN_GAP_MS = aiProvider === "groq" ? 2000 : aiProvider === "claude" ? 1000 : 6500; // gemini-2.5-flash free = 10 RPM → 6s min gap

// ═══════════════════════════════════════════════════════════════
// SAP JOB DETAIL CACHE
// ═══════════════════════════════════════════════════════════════
// Caches date + location + requisitionId per job URL so we only visit
// each detail page once. First scrape is slow; every repeat is instant.

const SAP_CACHE_PATH = path.join(__dirname, "data", "sap_detail_cache.json");
const SAP_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
let sapDetailCache = {};
try {
  if (fs.existsSync(SAP_CACHE_PATH)) {
    sapDetailCache = JSON.parse(fs.readFileSync(SAP_CACHE_PATH, "utf-8"));
    console.log(`[OK] SAP detail cache loaded (${Object.keys(sapDetailCache).length} entries)`);
  }
} catch { sapDetailCache = {}; }

function saveSapDetailCache() {
  try {
    const tmp = SAP_CACHE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sapDetailCache));
    try { fs.renameSync(tmp, SAP_CACHE_PATH); } catch { fs.writeFileSync(SAP_CACHE_PATH, JSON.stringify(sapDetailCache)); }
  } catch (e) { console.warn(`[!!] SAP cache save failed: ${e.message}`); }
}

// VECTOR STORE + STYLE PROFILE
// ═══════════════════════════════════════════════════════════════

function loadBank() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
}

let vectorReady = false;
let styleProfile = null;
let skillBank = null;

try {
  skillBank = loadBank();
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
    const nSkills = (skillBank.user_skills || []).length;
    const nProj   = (skillBank.user_projects || []).length;
    console.log(`[OK] Vector store ready (v${skillBank.version || "3.x"}): ${nSkills} skills, ${nProj} projects`);
  } else {
    console.warn("[!!] Vector store not initialized — call POST /rebuild-vector-store");
  }
} catch (err) {
  console.warn(`[!!] Vector store failed: ${err.message} — RAG features disabled`);
}

const { retrieveContext, rebuildVectorStore, addSkillToVector, updateSkillInVector } = vectorReady ? require("./src/rag_engine") : { retrieveContext: null, rebuildVectorStore: null, addSkillToVector: null, updateSkillInVector: null };
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
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config: { systemInstruction: systemPrompt }
      });
      return result.text;
    } catch (err) {
      const is429 = err.status === 429 || err.message?.includes("429") || err.message?.includes("RESOURCE_EXHAUSTED");
      if (!is429 || attempt === MAX_ATTEMPTS - 1) throw err;
      const m = err.message?.match(/retry in ([\d.]+)s/i);
      const base = m ? Math.ceil(parseFloat(m[1])) * 1000 : 15000 * Math.pow(2, attempt);
      const wait = Math.min(base, 120000);
      console.log(`Gemini 429 (attempt ${attempt + 1}/${MAX_ATTEMPTS}) — waiting ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
      lastAICall = Date.now();
    }
  }
}

async function callAI(systemPrompt, userPrompt) {
  // Global throttle — enforced for every call regardless of which route triggers it
  const gap = AI_MIN_GAP_MS - (Date.now() - lastAICall);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  lastAICall = Date.now();
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
    sharedBrowser = await chromium.launch({
      headless: process.env.PW_HEADLESS !== "false",
      args: process.env.NODE_ENV === "production" ? ["--no-sandbox", "--disable-setuid-sandbox"] : []
    });
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

// Atomic write with retry — avoids EPERM on Windows when file is briefly locked
function atomicWriteSync(filePath, data) {
  const tmpPath = filePath + ".tmp";
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(tmpPath, data);
      try { fs.renameSync(tmpPath, filePath); } catch {
        fs.writeFileSync(filePath, data);
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      return;
    } catch (err) {
      if (i < maxRetries - 1 && (err.code === "EPERM" || err.code === "EBUSY")) {
        const waitMs = 100 * (i + 1);
        const start = Date.now();
        while (Date.now() - start < waitMs) {}
        continue;
      }
      throw err;
    }
  }
}

function normalizeSapJobUrl(url) {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${SAP_BASE_URL}${url}`;
  return `${SAP_BASE_URL}/${url}`;
}

function looksLikeDate(value) {
  return parseJobDate(value) !== null;
}

function parseJobDate(raw) {
  if (!raw || raw === "N/A") return null;
  let text = String(raw).trim();
  text = text.replace(/^[Pp]osted\s*(?:on\s*)?:?\s*/i, "").replace(/^on\s+/i, "");
  const lower = text.toLowerCase();
  if (lower === "today" || lower === "just posted" || lower === "just now") return new Date();
  if (lower === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }
  let match = lower.match(/^(\d+)\s+days?\s+ago$/);
  if (match) {
    const d = new Date();
    d.setDate(d.getDate() - Number(match[1]));
    return d;
  }
  match = lower.match(/^(\d+)\s+hours?\s+ago$/);
  if (match) {
    const d = new Date();
    d.setHours(d.getHours() - Number(match[1]));
    return d;
  }
  match = lower.match(/^(\d+)\s+weeks?\s+ago$/);
  if (match) {
    const d = new Date();
    d.setDate(d.getDate() - Number(match[1]) * 7);
    return d;
  }

  // Try native parsing first.
  let d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d;

  const monthNames = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const mo = monthNames[match[1].slice(0, 3).toLowerCase()];
    if (mo !== undefined) return new Date(Number(match[3]), mo, Number(match[2]));
  }

  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
  if (match) {
    const mo = monthNames[match[2].slice(0, 3).toLowerCase()];
    if (mo !== undefined) return new Date(Number(match[3]), mo, Number(match[1]));
  }

  match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (match) {
    const part1 = Number(match[1]);
    const part2 = Number(match[2]);
    const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
    // Assume day/month/year for European-style dates like 06.07.2024.
    const day = part1;
    const month = part2 - 1;
    d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
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

async function dismissCookieBanner(page, portalType) {
  const portalSpecific = PORTAL_SELECTORS[portalType]?.cookie || [];
  const common = [
    '#truste-consent-button', '#truste-consent-required', '#truste-show-consent',
    '#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button[data-cookieconsent="accept"]', '.cookie-accept', '.accept-cookies',
    '#accept-cookies', '.cc-btn.cc-dismiss', '.consent-accept'
  ];
  const allSels = [...new Set([...portalSpecific, ...common])];
  for (const sel of allSels) {
    const btn = await page.$(sel);
    if (btn) try { await btn.click({ timeout: 1500 }); return; } catch {}
  }
  // Try text-based accept buttons as last resort
  for (const txt of ["Allow All", "Accept All", "Accept all cookies", "Alle akzeptieren", "Akzeptieren", "Accept"]) {
    try {
      const btn = await page.$(`button:has-text("${txt}")`);
      if (btn) { await btn.click({ timeout: 1500 }); return; }
    } catch {}
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
        .filter(text => text.length < 80)
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
  const now = Date.now();
  const dateByUrl = new Map();
  const urlsToFetch = [];

  for (const job of jobs) {
    const absoluteUrl = normalizeSapJobUrl(job.url);
    if (dateByUrl.has(absoluteUrl)) continue;
    const urlBasedReqId = extractRequisitionIdFromUrl(absoluteUrl) || "N/A";
    const needsVisit = !looksLikeDate(job.date) || !job.location || job.location === "N/A" || job.requisitionId === urlBasedReqId;
    if (!needsVisit) continue;

    const cached = sapDetailCache[absoluteUrl];
    if (cached && (now - (cached.cachedAt || 0)) < SAP_CACHE_TTL_MS) {
      dateByUrl.set(absoluteUrl, cached);
    } else {
      dateByUrl.set(absoluteUrl, null);
      urlsToFetch.push(absoluteUrl);
    }
  }

  if (urlsToFetch.length > 0) {
    const cached = Object.keys(dateByUrl).length - urlsToFetch.length;
    console.log(`[Enrichment] ${urlsToFetch.length} detail pages to fetch, ${cached} from cache`);
    for (const url of urlsToFetch) {
      const result = await fetchJobDetail(browser, url);
      dateByUrl.set(url, result);
      sapDetailCache[url] = { ...result, cachedAt: Date.now() };
      await new Promise(r => setTimeout(r, 800));
    }
    saveSapDetailCache();
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

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeQuickMatchFromSkills(job, keyword, skills, options = {}) {
  const { includeRecency = true } = options;
  const kw = String(keyword || "").trim().toLowerCase();
  const hasKeyword = kw.length > 0;
  const titleLower = String(job?.title || "").toLowerCase();

  const titleWordMatch = hasKeyword ? new RegExp(`\\b${escapeRegex(kw)}\\b`).test(titleLower) : false;
  const titleContains = hasKeyword ? titleLower.includes(kw) : false;
  const titleMatch = titleWordMatch || titleContains;

  const avgRelevance = (skills || []).length
    ? (skills.reduce((sum, s) => {
      const dist = Number.isFinite(s?.distance) ? s.distance : 1;
      const clampedDist = Math.max(0, Math.min(1, dist));
      return sum + (1 - clampedDist) * 100;
    }, 0) / skills.length)
    : 0;

  const skillScore = Math.max(0, Math.min(100, avgRelevance));
  const titleBonus = !hasKeyword ? 0 : titleWordMatch ? 12 : titleContains ? 6 : 0;

  let recencyBonus = 0;
  if (includeRecency) {
    const postedD = parseJobDate(job?.rawDate);
    if (postedD) {
      const daysSince = (Date.now() - postedD) / 86400000;
      recencyBonus = Math.max(0, 8 - daysSince * 0.5);
    }
  }

  const matchScore = Math.round(Math.min(100, skillScore * 0.86 + titleBonus + recencyBonus));
  const topMatchedSkills = (skills || []).map(s => s?.metadata?.skill_name).filter(Boolean).slice(0, 3);

  return {
    matchScore,
    titleMatch,
    topMatchedSkills,
    matchMeta: {
      method: "quick-fit-v2",
      skillScore: Math.round(skillScore),
      titleBonus: Math.round(titleBonus),
      recencyBonus: Math.round(recencyBonus),
      keywordUsed: hasKeyword
    }
  };
}

function filterByPeriod(jobs, period) {
  if (period === "any") return jobs;
  const now = new Date();
  return jobs.filter(job => {
    const raw = job.rawDate || job.date;
    const posted = parseJobDate(raw);
    // Keep jobs with unknown dates — they're still valid, just missing metadata
    if (!posted) return true;
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
  // Navigate directly to the search URL — avoids fragile form interaction and
  // allows reliable startrow-based pagination (same params as the browser URL bar shows)
  const buildSapUrl = (startRow) => {
    const u = new URL("https://jobs.sap.com/search/");
    u.searchParams.set("q", keyword || "");
    if (location) u.searchParams.set("locationsearch", location);
    if (statusValue) u.searchParams.set("optionsFacetsDD_customfield3", statusValue);
    if (country) u.searchParams.set("optionsFacetsDD_country", country);
    if (startRow > 0) u.searchParams.set("startrow", String(startRow));
    return u.toString();
  };

  const results = [];
  const seen = new Set();
  const rowSelector = "#searchresults tbody tr.data-row, #searchresults tbody tr, tr.data-row, .job-listing-row, .job-row";
  const entrySelector = "a.jobTitle-link[href], .jobTitle-link[href], .jobTitle a[href], a[href]";
  const PAGE_SIZE = 25;
  const MAX_PAGES = 12; // safety cap: 12 × 25 = 300 jobs

  for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
    const pageUrl = buildSapUrl(pageIdx * PAGE_SIZE);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: BASE_NAV_TIMEOUT_MS });
    await dismissCookieBanner(page, "successfactors");
    await Promise.race([
      page.waitForSelector(entrySelector, { timeout: BASE_ACTION_TIMEOUT_MS }),
      page.waitForSelector(".no-results, .jobs-search-no-result", { timeout: BASE_ACTION_TIMEOUT_MS })
    ]).catch(() => null);

    const pageJobs = await page.evaluate(({ rowSelector, entrySelector }) => {
      const rows = Array.from(document.querySelectorAll(rowSelector)).filter(row => row.querySelector(entrySelector));
      const jobs = [];
      rows.forEach(row => {
        let link = row.querySelector(entrySelector);
        if (!link) link = row.querySelector("a");
        if (!link) return;
        const url = link.href;
        jobs.push({
          title: link.textContent.trim(),
          url,
          date: row.querySelector('span[data-careersite-propertyid="date"], .job-date, .date, td.date, span.jobDate, [data-automation-id="postedOn"], [data-automation-id="jobPostingDate"], time')?.textContent?.trim() || "N/A",
          location: row.querySelector(".colLocation .jobLocation, .jobLocation, td.location, .job-location, .location")?.textContent?.replace(/\s+/g, " ").trim() || "N/A",
          requisitionId: (url.match(/\/(\d+)\/?$/) || [])[1] || "N/A",
          status: "Not Started"
        });
      });
      return jobs;
    }, { rowSelector, entrySelector });

    if (pageJobs.length === 0) break;

    for (const job of pageJobs) {
      const key = (job.url || "").split("?")[0].replace(/\/+$/, "");
      if (!job.url || seen.has(key)) continue;
      seen.add(key);
      results.push(job);
    }

    console.log(`SAP page ${pageIdx + 1}: scraped ${pageJobs.length} jobs (total so far: ${results.length})`);

    // Last page has fewer than a full page of results
    if (pageJobs.length < PAGE_SIZE) break;
  }

  return results;
}

function getBasfCityInfo(locationValue) {
  const map = {
    "ludwigshafen": { city: "Ludwigshafen am Rhein", state: "Rheinland-Pfalz"       },
    "mannheim":     { city: "Mannheim",              state: "Baden-Württemberg"      },
    "limburgerhof": { city: "Limburgerhof",          state: "Rheinland-Pfalz"       },
    "lampertheim":  { city: "Lampertheim",           state: "Hessen"                },
    "frankenthal":  { city: "Frankenthal",           state: "Rheinland-Pfalz"       },
    "freiburg":     { city: "Freiburg im Breisgau",  state: "Baden-Württemberg"     },
    "düsseldorf":   { city: "Düsseldorf",            state: "Nordrhein-Westfalen"   },
    "grenzach":     { city: "Grenzach-Wyhlen",       state: "Baden-Württemberg"     },
    "münster":      { city: "Münster",               state: "Nordrhein-Westfalen"   },
    "rudolstadt":   { city: "Rudolstadt",            state: "Thüringen"             },
    "hannover":     { city: "Hannover",              state: "Niedersachsen"         },
    "trostberg":    { city: "Trostberg",             state: "Bayern"                },
    "nienburg":     { city: "Nienburg",              state: "Niedersachsen"         },
    "berlin":       { city: "Berlin",                state: "Berlin"                },
    "lemförde":     { city: "Lemförde",              state: "Niedersachsen"         },
    "schwarzheide": { city: "Schwarzheide",          state: "Brandenburg"           },
  };
  return map[locationValue] || null;
}

// ── BASF server-side location matching ──────────────────────────
const BASF_ALIAS_MAP = {
  "ludwigshafen": ["ludwigshafen am rhein", "ludwigshafen a.rh.", "ludwigshafen"],
  "mannheim":     ["mannheim"],
  "limburgerhof": ["limburgerhof"],
  "lampertheim":  ["lampertheim"],
  "frankenthal":  ["frankenthal"],
  "freiburg":     ["freiburg"],
  "düsseldorf":   ["düsseldorf", "dusseldorf", "duesseldorf"],
  "grenzach":     ["grenzach"],
  "münster":      ["münster", "muenster", "munster"],
  "rudolstadt":   ["rudolstadt"],
  "hannover":     ["hannover", "hanover"],
  "trostberg":    ["trostberg"],
  "nienburg":     ["nienburg"],
  "berlin":       ["berlin"],
  "lemförde":     ["lemförde", "lemfoerde"],
  "schwarzheide": ["schwarzheide"],
};

function basfLocationMatches(jobLoc, sel) {
  if (!sel) return true;
  const job = (jobLoc || "").toLowerCase().trim();
  const s   = sel.toLowerCase().trim();
  // Multi-location jobs show "+N more…" — can't filter what we can't read → include
  if (/\+\d+\s*more/i.test(job)) return true;
  return (BASF_ALIAS_MAP[s] || [s]).some(a => job.includes(a));
}

// ── BASF JD language detection ───────────────────────────────────
// German function words that don't appear in English text
const GERMAN_STOPWORDS = new Set([
  "und","mit","für","die","der","das","wird","werden","sie","ihre","ihnen",
  "bei","auch","ist","des","dem","einen","einer","einem","oder","nicht",
  "sowie","als","zum","zur","wir","uns","haben","sein","im","am","nach",
  "über","durch","einer","unsere","unser","werden","können","sind","bieten",
  "suchen","sucht","bietet","stellen","stellt",
]);

async function detectBasfJobLanguage(browser, jobUrl) {
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const text = await page.evaluate(() => {
      const sel = ".jobad-details, .job-description, #job-description, [class*='jobDescription'], [class*='job-detail'], main, article";
      const el  = document.querySelector(sel);
      return (el || document.body).innerText.slice(0, 900);
    });
    const words = text.toLowerCase().match(/\b[a-züäöß]{2,}\b/g) || [];
    if (words.length < 15) return true; // too short to judge → keep
    const germanCount = words.filter(w => GERMAN_STOPWORDS.has(w)).length;
    const ratio = germanCount / words.length;
    console.log(`[BASF lang] ${ratio.toFixed(2)} German ratio → ${ratio < 0.12 ? "EN" : "DE"} : ${jobUrl.split("/").slice(-2).join("/")}`);
    return ratio < 0.12; // true = English
  } catch {
    return true; // on error → keep job
  } finally {
    await page.close();
  }
}

async function filterBasfByLanguage(browser, jobs, concurrency = 3) {
  if (!jobs.length) return jobs;
  const results = [];
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const checks = await Promise.allSettled(
      batch.map(job => detectBasfJobLanguage(browser, job.url))
    );
    for (let j = 0; j < batch.length; j++) {
      const isEnglish = checks[j].status === "fulfilled" ? checks[j].value : true;
      if (isEnglish) results.push(batch[j]);
    }
  }
  return results;
}

async function scrapeOnePageBasf(page, keyword, locationValue, _country, _statusValue, startRow = 0) {
  const url = new URL(`${BASF_BASE_URL}/search/`);
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("sortColumn", "referencedate");
  url.searchParams.set("sortDirection", "desc");
  if (startRow > 0) url.searchParams.set("startrow", String(startRow));
  if (keyword) url.searchParams.set("keyword", keyword);
  console.log(`[BASF] navigating to: ${url.toString()}`);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: BASE_NAV_TIMEOUT_MS });
  await dismissCookieBanner(page, "successfactors");
  await Promise.race([
    page.waitForSelector("a.jobTitle-link, .jobTitle-link", { timeout: BASE_ACTION_TIMEOUT_MS }),
    page.waitForSelector(".no-results, .jobs-search-no-result", { timeout: BASE_ACTION_TIMEOUT_MS })
  ]);
  return page.evaluate(() => {
    const results = [], seen = new Set();
    const jobRows = Array.from(document.querySelectorAll("#searchresults tbody tr.data-row, #searchresults tbody tr, tr.data-row, .job-listing-row, .job-row")).filter(row => row.querySelector("a"));
    jobRows.forEach(row => {
      let link = row.querySelector("a.jobTitle-link[href], .jobTitle-link[href], .jobTitle a[href], a[href]");
      if (!link) link = row.querySelector("a");
      if (!link) return;
      const url = link.href, key = (url || "").split("?")[0].replace(/\/+$/, "");
      if (!url || seen.has(key)) return;
      seen.add(key);
      // BASF uses span.jobDate inside td.colDate (SAP uses td.date / data-careersite-propertyid="date")
      const dateEl = row.querySelector('td.colDate span.jobDate, span.jobDate:not(.visible-phone), span[data-careersite-propertyid="date"], .job-date, td.date');
      const locEl  = row.querySelector(".colLocation .jobLocation, .jobLocation, td.location");
      if (locEl) locEl.querySelectorAll("style, script").forEach(s => s.remove());
      results.push({
        title: link.textContent.trim(), url,
        date: dateEl?.textContent?.trim() || "N/A",
        location: locEl?.textContent?.replace(/\s+/g, " ").trim() || "N/A",
        requisitionId: (url.match(/\/(\d+)\/?$/) || [])[1] || "N/A",
        status: "Not Started"
      });
    });
    if (results.length === 0) {
      document.querySelectorAll("a.jobTitle-link[href], .jobTitle-link[href], .jobTitle a[href], a[href]").forEach(link => {
        const url = link.href, key = (url || "").split("?")[0].replace(/\/+$/, "");
        if (!url || seen.has(key)) return;
        seen.add(key);
        const row = link.closest("tr") || link.parentElement;
        const dateEl = row?.querySelector('td.colDate span.jobDate, span.jobDate:not(.visible-phone), span[data-careersite-propertyid="date"], .job-date, td.date');
        const locEl  = row?.querySelector(".colLocation .jobLocation, .jobLocation, td.location");
        if (locEl) locEl?.querySelectorAll("style, script").forEach(s => s.remove());
        results.push({
          title: link.textContent.trim(),
          url,
          date: dateEl?.textContent?.trim() || "N/A",
          location: locEl?.textContent?.replace(/\s+/g, " ").trim() || "N/A",
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
  const { keyword, location, state, city, country, careerStatus, period, portal = "sap" } = req.body;
  // SAP/BASF: keyword optional — location filtered client-side. Other portals need at least one.
  if (!keyword && !location && portal !== "sap" && portal !== "basf" && portal !== "siemens") return res.status(400).json({ success: false, error: "Enter a keyword or location." });

  // ── SAP portal — existing optimized scraper ──
  if (portal === "sap") {
    if (!country || !careerStatus || !period) return res.status(400).json({ success: false, error: "Missing required fields." });
    console.log(`Scraping SAP: "${keyword}" in ${location || "all"}, ${country} (${careerStatus})`);
  try {
    const browser = await getSharedBrowser();
    // Fresh context per scrape — isolated cookies so SAP bot-block from one session
    // doesn't carry into the next
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);
    const allJobs = [], seenUrls = new Set();
    try {
      const jobs = await scrapeOnePage(page, keyword, location, country, careerStatus);
      for (const job of jobs) { const key = (job.url || "").split("?")[0].replace(/\/+$/, ""); if (!seenUrls.has(key)) { seenUrls.add(key); allJobs.push(job); } }
    } catch (err) {
      console.error(`Search failed: ${err.message}`);
      await context.close();
      return res.status(500).json({ success: false, error: `Search failed: ${safeError(err)}` });
    }
    await context.close();
    const jobsWithDates = await enrichJobsWithPostedDates(browser, allJobs);
    const filtered = filterByPeriod(jobsWithDates, period);

    // Add vector match scores if available
    const kw = String(keyword || "").trim().toLowerCase();
    const hasKeyword = kw.length > 0;
    if (vectorReady && retrieveContext) {
      for (const job of filtered) {
        try {
          const fitQuery = [job.title, hasKeyword ? kw : "", job.location].filter(Boolean).join(" ");
          const result = await retrieveContext(fitQuery, { topSkills: 5, topProjects: 0, topWork: 0 });
          Object.assign(job, computeQuickMatchFromSkills(job, keyword, result.skills, { includeRecency: true }));
        } catch {
          job.matchScore = 0;
          job.titleMatch = false;
          job.topMatchedSkills = [];
          job.matchMeta = null;
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
        const titleLower = String(job.title || "").toLowerCase();
        job.titleMatch = hasKeyword ? titleLower.includes(kw) : false;
      });
      filtered.sort((a, b) => (a.titleMatch === b.titleMatch ? 0 : a.titleMatch ? -1 : 1));
    }

    console.log(`Found ${filtered.length} jobs`);
    return res.json({ success: true, jobs: filtered });
  } catch (err) {
    console.error("Scrape error:", err.message);
    return res.status(500).json({ success: false, error: safeError(err) });
  }
  } // end SAP portal
  // ── BASF portal — SuccessFactors (same platform as SAP) ──
  else if (portal === "basf") {
    if (!country || !careerStatus || !period) return res.status(400).json({ success: false, error: "Missing required fields." });
    console.log(`Scraping BASF: "${keyword}" in ${location || "all"}, ${country} (${careerStatus})`);
    try {
      const browser = await getSharedBrowser();
      const page = await browser.newPage();
      page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);
      // ── Step 1: paginate all BASF pages, collect student-role titles ──
      const allStudentJobs = [], seenUrls = new Set();
      const STUDENT_KEYWORD_RE = /working student|internship|\bintern\b|thesis|student worker|werkstudent/i;
      const PAGE_SIZE = 25;
      const MAX_PAGES = 30;   // safety cap: 30 × 25 = 750 jobs max
      try {
        let startRow = 0, pagesScraped = 0;
        while (pagesScraped < MAX_PAGES) {
          const jobs = await scrapeOnePageBasf(page, keyword, location, country, careerStatus, startRow);
          if (jobs.length === 0) break;
          let newUrlsThisPage = 0;
          for (const job of jobs) {
            const key = (job.url || "").split("?")[0].replace(/\/+$/, "");
            if (seenUrls.has(key)) continue;
            seenUrls.add(key);
            newUrlsThisPage++;
            if (STUDENT_KEYWORD_RE.test(job.title)) allStudentJobs.push(job);
          }
          pagesScraped++;
          if (newUrlsThisPage === 0) break;
          if (jobs.length < PAGE_SIZE) break;
          startRow += PAGE_SIZE;
        }
        console.log(`[BASF] scraped ${pagesScraped} page(s) (startrow 0–${startRow}), ${allStudentJobs.length} student titles found`);
      } catch (err) {
        console.error(`BASF search failed: ${err.message}`);
        await page.close();
        return res.status(500).json({ success: false, error: `Search failed: ${safeError(err)}` });
      }
      await page.close();

      // ── Step 2: server-side location filter (fast, no page visits) ──
      const locationFiltered = allStudentJobs.filter(job => basfLocationMatches(job.location, location));
      console.log(`[BASF] ${locationFiltered.length} jobs after location filter ("${location || "all"}")`);

      // ── Step 3: visit each matched job's detail page to detect language ──
      console.log(`[BASF] checking language of ${locationFiltered.length} job descriptions (3 parallel)…`);
      const englishJobs = await filterBasfByLanguage(browser, locationFiltered, 3);
      console.log(`[BASF] ${englishJobs.length} English jobs after JD language check`);

      // ── Step 4: normalise dates (already extracted from search list) ──
      const jobsWithDates = englishJobs.map(job => {
        const rawDate     = looksLikeDate(job.date) ? job.date : "N/A";
        let   displayDate = rawDate;
        if (rawDate !== "N/A") {
          const d = parseJobDate(rawDate);
          if (d) displayDate = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
        }
        const cleanLocation = (job.location && job.location !== "N/A")
          ? job.location.split(",")[0].trim()
          : "N/A";
        return { ...job, date: displayDate, rawDate, location: cleanLocation };
      });

      // ── Step 5: period filter ──
      const now = new Date();
      const filtered = period === "any" ? jobsWithDates : jobsWithDates.filter(job => {
        const posted = parseJobDate(job.rawDate || job.date);
        if (!posted) return true; // keep if date unknown
        const days = (now - posted) / 86400000;
        if (period === "today")  return days >= 0 && days < 1;
        if (period === "1week")  return days >= 0 && days <= 7;
        if (period === "2weeks") return days >= 0 && days <= 14;
        if (period === "3weeks") return days >= 0 && days <= 21;
        if (period === "1month") return days >= 0 && days <= 30;
        return true;
      });

      const kw = String(keyword || "").trim().toLowerCase();
      const hasKeyword = kw.length > 0;
      if (vectorReady && retrieveContext) {
        for (const job of filtered) {
          try {
            const fitQuery = [job.title, hasKeyword ? kw : "", job.location].filter(Boolean).join(" ");
            const result = await retrieveContext(fitQuery, { topSkills: 5, topProjects: 0, topWork: 0 });
            Object.assign(job, computeQuickMatchFromSkills(job, keyword, result.skills, { includeRecency: true }));
          } catch {
            job.matchScore = 0;
            job.titleMatch = false;
            job.topMatchedSkills = [];
            job.matchMeta = null;
          }
        }
        filtered.sort((a, b) => {
          if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
          return (b.matchScore || 0) - (a.matchScore || 0);
        });
      } else {
        filtered.forEach(job => {
          const titleLower = String(job.title || "").toLowerCase();
          job.titleMatch = hasKeyword ? titleLower.includes(kw) : false;
        });
        filtered.sort((a, b) => (a.titleMatch === b.titleMatch ? 0 : a.titleMatch ? -1 : 1));
      }

      console.log(`Found ${filtered.length} jobs on BASF`);
      return res.json({ success: true, jobs: filtered });
    } catch (err) {
      console.error("BASF scrape error:", err.message);
      return res.status(500).json({ success: false, error: safeError(err) });
    }
  } // end BASF portal
  // ── Siemens portal — Phenom People platform ──
  else if (portal === "siemens") {
    console.log(`Scraping Siemens: "${keyword}" in ${location || "all"} (${careerStatus})`);

    // Map UI career status → Siemens exact experience level label (Phenom People)
    const siemensTypeMap = {
      "Student":      "Student (Not Yet Graduated)",
      "Graduate":     "Graduate",
      "Professional": "Experienced Professional"
    };
    const siemensType = siemensTypeMap[careerStatus] || "";

    // Map country code → full name for Phenom facet
    const countryMap = { DE: "Germany", AT: "Austria", CH: "Switzerland" };
    const countryName = countryMap[country] || country || "";

    // Build Siemens search URL — Phenom facets: query, country, state, city, experience
    const searchUrl = new URL("https://jobs.siemens.com/careers");
    if (keyword)      searchUrl.searchParams.set("query", keyword);
    // Location hierarchy: city → state → country (most specific wins for relevance)
    if (city)         searchUrl.searchParams.set("city", city);
    if (state)        searchUrl.searchParams.set("state", state);
    if (countryName)  searchUrl.searchParams.set("country", countryName);
    // Broad location text for the search bar (optional, improves results on some Phenom configs)
    const locationText = city || state || location || countryName;
    if (locationText) searchUrl.searchParams.set("location", locationText);
    // Experience level facet — exact label as shown in Siemens filter UI
    if (siemensType)  searchUrl.searchParams.set("experience", siemensType);

    try {
      const browser = await getSharedBrowser();
      const page = await browser.newPage();
      page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);

      // networkidle waits for all XHR/fetch API calls to finish — critical for Phenom People SPA
      await page.goto(searchUrl.toString(), { waitUntil: "networkidle", timeout: 45000 });
      await dismissCookieBanner(page, "generic");

      // Extra wait for React render after network idle
      await page.waitForTimeout(3000);

      // Wait for job list container — Phenom People renders a list/grid of results
      try {
        await page.waitForSelector(
          '[class*="job"] a[href*="/jobs/"], [class*="Job"] a[href*="/jobs/"], [class*="result"] a[href*="/jobs/"], a[href*="/jobs/"]',
          { timeout: 15000 }
        );
      } catch { /* proceed anyway — evaluate will collect whatever rendered */ }

      // Extract job cards — Phenom People platform selectors
      const jobs = await page.evaluate((company) => {
        const results = [];
        const seen = new Set();

        // Collect ALL links that point to /jobs/ paths — Phenom job URLs are /jobs/<id>-<slug>
        const allLinks = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));

        for (const a of allLinks) {
          const href = a.href;
          if (!href) continue;
          const key = href.split("?")[0];
          if (seen.has(key)) continue;
          // Skip nav/header/footer links
          if (a.closest('nav, header, footer')) continue;
          // Skip links without meaningful text
          const rawText = a.textContent.trim().replace(/\s+/g, " ");
          if (!rawText || rawText.length < 4 || rawText.length > 300) continue;
          // Heuristic: job links usually have a numeric segment or contain "job" in path
          const path = new URL(href).pathname;
          if (path === "/jobs/" || path === "/en_US/externaljobs" || path.endsWith("/externaljobs")) continue;
          seen.add(key);

          // Walk up to find the card container
          const card = a.closest('li, article, [class*="card"], [class*="result"], [class*="item"]') || a.parentElement;

          // Try to get title from a heading inside the card, fall back to link text
          const titleEl = card?.querySelector('h1, h2, h3, h4, [class*="title"], [class*="Title"]');
          const title = (titleEl || a).textContent.trim().replace(/\s+/g, " ");
          if (!title || title.length < 4) continue;

          const locEl  = card?.querySelector('[class*="location"], [class*="Location"], [class*="city"], [class*="country"]');
          const dateEl = card?.querySelector('time, [class*="date"], [class*="Date"], [class*="post"]');

          results.push({
            title,
            url: href,
            location: locEl?.textContent?.replace(/\s+/g, " ").trim() || "",
            rawDate: dateEl?.getAttribute("datetime") || dateEl?.textContent?.trim() || "",
            requisitionId: href.match(/\/(\d{5,})\/?/)?.[1] || "",
            company
          });
        }
        return results.slice(0, 50);
      }, "Siemens");

      await page.close();

      // Period filter (client-side, same as SAP)
      const filtered = filterByPeriod(jobs, period || "any");

      // Match scores
      const kw = (keyword || "").toLowerCase();
      const hasKeyword = String(kw).trim().length > 0;
      if (vectorReady && retrieveContext) {
        for (const job of filtered) {
          try {
            const fitQuery = [job.title, hasKeyword ? kw : "", job.location].filter(Boolean).join(" ");
            const result = await retrieveContext(fitQuery, { topSkills: 5, topProjects: 0, topWork: 0 });
            Object.assign(job, computeQuickMatchFromSkills(job, keyword, result.skills, { includeRecency: true }));
          } catch {
            job.matchScore = 0;
            job.titleMatch = false;
            job.topMatchedSkills = [];
            job.matchMeta = null;
          }
        }
        filtered.sort((a, b) => {
          if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
          return (b.matchScore || 0) - (a.matchScore || 0);
        });
      } else {
        filtered.forEach(job => {
          const titleLower = String(job.title || "").toLowerCase();
          job.titleMatch = hasKeyword ? titleLower.includes(kw) : false;
        });
        filtered.sort((a, b) => (a.titleMatch === b.titleMatch ? 0 : a.titleMatch ? -1 : 1));
      }

      console.log(`Found ${filtered.length} jobs on Siemens`);
      return res.json({ success: true, jobs: filtered });
    } catch (err) {
      console.error("Siemens scrape error:", err.message);
      return res.status(500).json({ success: false, error: safeError(err) });
    }
  }
  // ── Other portals (Infineon, Bosch) — generic ──
  else {
    const PORTAL_SEARCH_URLS = {
      infineon: "https://jobs.infineon.com/careers",
      bosch: "https://www.bosch.com/careers/job-search/"
    };
    const portalUrl = PORTAL_SEARCH_URLS[portal];
    if (!portalUrl) return res.status(400).json({ success: false, error: `Unknown portal: ${portal}` });

    const portalNames = { infineon: "Infineon", bosch: "Bosch" };
    const companyName = portalNames[portal] || portal;
    console.log(`Scraping ${companyName}: "${keyword}" in ${location || "all"}`);

    try {
      const browser = await getSharedBrowser();
      const page = await browser.newPage();
      page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);

      const searchUrl = new URL(portalUrl);
      if (keyword) searchUrl.searchParams.set("query", keyword);
      if (location) searchUrl.searchParams.set("location", location);

      await page.goto(searchUrl.toString(), { waitUntil: "domcontentloaded", timeout: BASE_NAV_TIMEOUT_MS });
      await dismissCookieBanner(page, detectPortalType(portalUrl).type);
      await page.waitForTimeout(4000);

      const jobs = await page.evaluate((company) => {
        const results = [], seen = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href, text = a.textContent.trim();
          const key = href.split("?")[0];
          if (!text || text.length < 5 || text.length > 200 || seen.has(key)) return;
          const isJobLink = /\/(job|position|career|opening|vacancy|requisition|posting)\b/i.test(href) || /\/\d{4,}/.test(href)
            || a.closest('[class*="job"],[class*="Job"],[class*="position"],[class*="listing"],[class*="result"]');
          if (!isJobLink || a.closest('nav,footer,header')) return;
          seen.add(key);
          const card = a.closest('[class*="job"],[class*="card"],li,article') || a.parentElement;
          const locEl = card?.querySelector('[class*="location"],[class*="Location"]');
          const dateEl = card?.querySelector('[class*="date"],[class*="Date"],time');
          results.push({ title: text.replace(/\s+/g, " ").trim(), url: href, location: locEl?.textContent?.trim() || "", rawDate: dateEl?.textContent?.trim() || "", requisitionId: "", company });
        });
        return results.slice(0, 50);
      }, companyName);

      await page.close();

      console.log(`Found ${jobs.length} jobs on ${companyName}`);
      return res.json({ success: true, jobs });
    } catch (err) {
      console.error(`${portal} scrape error:`, err.message);
      return res.status(500).json({ success: false, error: safeError(err) });
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /search-intelligence — AI-powered keyword expansion
// ═══════════════════════════════════════════════════════════════

app.post("/search-intelligence", async (req, res) => {
  const { keyword, portal } = req.body;
  if (!keyword) return res.json({ success: true, expanded: "", suggestions: [] });
  if (!aiProvider) return res.json({ success: true, expanded: keyword, suggestions: [], isAbbreviation: false });

  try {
    const raw = await callAI(
      `You are a job search assistant for tech careers in Germany, especially SAP ecosystem roles.
Return STRICT JSON only, no markdown, no explanations.`,
      `Given the search keyword "${keyword}" for ${portal || "any"} company careers portal:
1. If it's an abbreviation, expand it (e.g. "SAC" = "SAP Analytics Cloud", "BTP" = "SAP Business Technology Platform", "ML" = "Machine Learning", "DS" = "Data Science" or "Datasphere")
2. Suggest the best 2-3 search terms to use on a careers portal
3. Suggest 2-3 related job titles or keywords

Return JSON:
{
  "expanded": "<full expansion if abbreviation, else original keyword>",
  "searchTerms": ["<best search term>", "<alternative>"],
  "suggestions": ["<related keyword>", "<another>"],
  "isAbbreviation": true/false
}`
    );
    const jsonStr = raw.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim();
    const result = JSON.parse(jsonStr);
    return res.json({ success: true, ...result });
  } catch {
    return res.json({ success: true, expanded: keyword, suggestions: [], isAbbreviation: false });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /fetch-jd
// ═══════════════════════════════════════════════════════════════

app.post("/fetch-jd", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: "Missing url." });
  const portal = detectPortalType(url);
  console.log(`Fetching JD: ${url} [portal: ${portal.type}, company: ${portal.company}]`);
  try {
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(BASE_ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BASE_NAV_TIMEOUT_MS);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: BASE_NAV_TIMEOUT_MS });
    await dismissCookieBanner(page, portal.type);

    // Wait briefly for JS-rendered content (Workday and other SPAs)
    await page.waitForTimeout(2000);

    const sels = PORTAL_SELECTORS[portal.type] || {};
    let jd;

    // ── Strategy 1: Platform-specific selectors ──
    if (portal.type !== "generic") {
      jd = await page.evaluate((s) => {
        const q = (sel) => { if (!sel) return null; for (const cs of sel.split(",")) { const el = document.querySelector(cs.trim()); if (el) return el; } return null; };
        const txt = (sel) => { const el = q(sel); return el ? el.textContent.replace(/\s+/g, " ").trim() : ""; };

        const titleEl = q(s.title);
        const title = titleEl?.textContent?.trim() || document.querySelector("h1")?.textContent?.trim() || "Unknown";
        const locEl = q(s.location);
        if (locEl) locEl.querySelectorAll("style, script").forEach(el => el.remove());
        const location = locEl?.textContent?.replace(/\s+/g, " ").trim() || "";
        const postedDate = txt(s.date);
        const requisitionId = txt(s.reqId);

        const textSections = [];
        const jobContent = q(s.description);
        if (jobContent) textSections.push(jobContent.innerText.trim());
        if (!textSections.length) { const fb = q(s.fallback); if (fb) textSections.push(fb.innerText.trim()); }

        // Extract structured sections from DOM headings
        const parsedSections = {};
        const container = jobContent || q(s.fallback);
        if (container) {
          const headings = container.querySelectorAll("h1, h2, h3, h4, h5, strong, b");
          headings.forEach(h => {
            const label = h.textContent.trim();
            if (!label || label.length > 80 || label.length < 3) return;
            const content = [];
            let sibling = h.tagName === "STRONG" || h.tagName === "B" ? h.parentElement?.nextElementSibling : h.nextElementSibling;
            while (sibling && !["H1","H2","H3","H4","H5"].includes(sibling.tagName)) {
              const t = sibling.innerText?.trim();
              if (t) content.push(t);
              if (sibling.querySelector("h1,h2,h3,h4,h5")) break;
              sibling = sibling.nextElementSibling;
            }
            if (content.length) parsedSections[label] = content.join("\n");
          });
        }
        return { title, location, postedDate, requisitionId, fullText: textSections.join("\n\n"), sections: parsedSections };
      }, sels);
    }

    // ── Strategy 2: Generic DOM extraction (if platform selectors failed or type is generic) ──
    if (!jd || !jd.fullText || jd.fullText.length < 150) {
      console.log(`  Platform selectors yielded ${jd?.fullText?.length || 0} chars, trying generic DOM extraction...`);
      const genericJd = await page.evaluate(() => {
        const title = document.querySelector('meta[property="og:title"]')?.content
          || document.querySelector("h1")?.textContent?.trim()
          || document.title?.split(/[|–—-]/)[0]?.trim()
          || "Unknown";

        // Try multiple common description containers
        const descSelectors = [
          '.job-description', '.job-content', '.job-details', '.posting-content',
          '.jd-description', '.vacancy-description', '.opportunity-description',
          '[class*="jobDescription"]', '[class*="job-description"]', '[class*="jobContent"]',
          '[id*="jobDescription"]', '[id*="job-description"]',
          'article', '[role="main"] article', '[role="main"]', 'main', '#content'
        ];
        let descEl = null;
        for (const sel of descSelectors) {
          descEl = document.querySelector(sel);
          if (descEl && descEl.innerText.trim().length > 100) break;
          descEl = null;
        }
        const fullText = descEl?.innerText?.trim() || document.querySelector("main")?.innerText?.trim() || document.body?.innerText?.substring(0, 12000)?.trim() || "";

        // Location from meta or common elements
        const location = document.querySelector('meta[property="og:locale"]')?.content
          || document.querySelector('.job-location, .location, [class*="location"], [class*="Location"]')?.textContent?.replace(/\s+/g, " ").trim()
          || "";

        const postedDate = document.querySelector('.job-date, .posted-date, [class*="postedDate"], [class*="posted-date"], time')?.textContent?.trim() || "";
        const requisitionId = document.querySelector('.job-id, .reference-id, [class*="requisition"], [class*="jobId"], [class*="job-id"]')?.textContent?.replace(/[^a-zA-Z0-9-]/g, "").trim() || "";

        // Structured sections from headings
        const parsedSections = {};
        const container = descEl || document.querySelector("main");
        if (container) {
          container.querySelectorAll("h1, h2, h3, h4, h5, strong, b").forEach(h => {
            const label = h.textContent.trim();
            if (!label || label.length > 80 || label.length < 3) return;
            const content = [];
            let sib = h.tagName === "STRONG" || h.tagName === "B" ? h.parentElement?.nextElementSibling : h.nextElementSibling;
            while (sib && !["H1","H2","H3","H4","H5"].includes(sib.tagName)) {
              const t = sib.innerText?.trim();
              if (t) content.push(t);
              if (sib.querySelector("h1,h2,h3,h4,h5")) break;
              sib = sib.nextElementSibling;
            }
            if (content.length) parsedSections[label] = content.join("\n");
          });
        }
        return { title, location, postedDate, requisitionId, fullText, sections: parsedSections };
      });

      // Merge: prefer whichever has more content
      if (!jd || (genericJd.fullText.length > (jd.fullText?.length || 0))) {
        jd = genericJd;
      }
    }

    // ── Strategy 3: AI-powered extraction (last resort) ──
    if ((!jd.fullText || jd.fullText.length < 100) && aiProvider) {
      console.log(`  DOM extraction yielded ${jd?.fullText?.length || 0} chars, trying AI extraction...`);
      const rawText = await page.evaluate(() => document.body?.innerText?.substring(0, 8000) || "");
      if (rawText.length > 50) {
        try {
          const aiResult = await callAI(
            `You are a job description parser. Given raw page text from a careers website, extract structured data.
Return STRICT JSON only, no markdown, no explanations.
Schema: { "title": "", "company": "", "location": "", "postedDate": "", "requisitionId": "", "fullText": "<the complete job description text including responsibilities, requirements, qualifications>", "sections": {} }
If a field cannot be found, use empty string.`,
            `RAW PAGE TEXT:\n${rawText}`
          );
          const parsed = JSON.parse(aiResult.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim());
          jd = {
            title: parsed.title || jd.title || "Unknown",
            location: parsed.location || jd.location || "",
            postedDate: parsed.postedDate || jd.postedDate || "",
            requisitionId: parsed.requisitionId || jd.requisitionId || "",
            fullText: parsed.fullText || jd.fullText || "",
            sections: parsed.sections || jd.sections || {}
          };
          if (parsed.company) portal.company = parsed.company;
        } catch (aiErr) {
          console.warn("  AI extraction failed:", aiErr.message);
        }
      }
    }

    // Auto-detect requisition ID from URL if still empty
    if (!jd.requisitionId) {
      const idMatch = url.match(/[\/-](\d{5,12})(?:[?/#]|$)/);
      if (idMatch) jd.requisitionId = idMatch[1];
    }

    jd.company = portal.company;
    await page.close();
    console.log(`JD fetched: "${jd.title}" @ ${jd.company} (${jd.fullText.length} chars, strategy: ${jd.fullText.length > 150 ? 'ok' : 'thin'})`);
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
    const systemPrompt = `You are a senior career strategist summarising job descriptions for a job search dashboard.

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
      if (/^(We |At [A-Z]\w+[,. ]|Our company|Join our|Be part of)/i.test(trimmed)) return false;
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
8. Do NOT use markdown or **bold** markers.
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
    // Always read fresh from disk so selector reflects latest Skill Bank edits
    let bank = skillBank || {};
    try { bank = loadBank(); skillBank = bank; } catch (_) {}

    const allWE       = bank.user_work_experience || [];
    const allProjects = bank.user_projects || [];
    const allCerts    = (bank.user_certifications || []).map(c => ({ id: c.cert_id, name: c.title, provider: c.provider || "", date: c.date || "" }));

    // Static profile header + education for client-side draft pre-fill (no AI needed)
    const profileInfo = bank.profile || {};
    const educationData = (bank.education || []).map(ed => ({
      degree: ed.degree,
      institution: ed.institution,
      date: ed.period || "",
      coursework: Array.isArray(ed.key_modules) ? ed.key_modules.join(", ") : (ed.relevance || "")
    }));

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
      id:         we.work_id,
      title:      we.job_title,
      company:    we.company,
      period:     we.period,
      location:   we.location || "",
      skills_used: we.skills_used || [],
      responsibilities: we.responsibilities || [],
      score: scoreItem([we.job_title, we.company, (we.responsibilities || []).join(" "), (we.skills_used || []).join(" ")])
    })).sort((a, b) => b.score - a.score);

    const scoredProjects = allProjects.map(p => ({
      id:           p.project_id,
      name:         p.project_name,
      tech:         p.tech,
      date:         p.date,
      description:  p.description || "",
      sub_category: p.sub_category || null,
      score: scoreItem([p.project_name, p.tech, p.description || ""])
    })).sort((a, b) => b.score - a.score);

    // Auto-tick top 3 WE + top 3 SAP Technical projects only (PJ prefix)
    const topWeIds      = scoredWE.slice(0, 3).map(w => w.id);
    const sapTechProjects = scoredProjects.filter(p => p.id.startsWith("PJ"));
    const topProjectIds = sapTechProjects.slice(0, 3).map(p => p.id);

    return res.json({
      success: true,
      work_experience: scoredWE,
      projects: scoredProjects,
      certifications: allCerts,
      research: allResearch,
      profile_info: profileInfo,
      education: educationData,
      aiPickWE: topWeIds,
      aiPickProjects: topProjectIds,
      aiPickCerts: allCerts.map(c => c.id)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /generate-section  — Cheap per-section CV generation
// Generates only profile_summary, technical_skills, or key_competencies
// ═══════════════════════════════════════════════════════════════
app.post("/generate-section", async (req, res) => {
  if (!aiProvider) return res.status(503).json({ success: false, error: "No AI provider configured." });

  const { jdText, section, pinnedWeIds, pinnedProjectIds } = req.body;
  if (!jdText || !section) return res.status(400).json({ success: false, error: "Missing jdText or section." });

  const VALID = ["profile_summary", "technical_skills", "key_competencies"];
  if (!VALID.includes(section)) return res.status(400).json({ success: false, error: "Invalid section. Use: " + VALID.join(", ") });

  const toList = (v) => {
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    if (typeof v === "string") return v.split(",").map(x => x.trim()).filter(Boolean);
    return [];
  };
  const pinnedWEList = toList(pinnedWeIds);
  const pinnedProjectList = toList(pinnedProjectIds);

  const now = Date.now();
  const wait = AI_MIN_GAP_MS - (now - lastAICall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastAICall = Date.now();

  try {
    let bank = skillBank || {};
    try { bank = loadBank(); skillBank = bank; } catch (_) {}

    if (!vectorReady || !retrieveContext) return res.status(503).json({ success: false, error: "Vector store not initialized." });

    const ragContext = await retrieveContext(jdText, { topSkills: 10, topProjects: 2, topWork: 2 }, bank);

    if (pinnedWEList.length || pinnedProjectList.length) {
      const workById = new Map((bank.user_work_experience || []).map(w => [w.work_id, w]));
      const projById = new Map((bank.user_projects || []).map(p => [p.project_id, p]));
      const toWork = w => ({ id: w.work_id, document: `${w.job_title} at ${w.company} (${w.period}): ${(w.responsibilities||[]).join(" ")}`, metadata: { title: w.job_title, company: w.company, period: w.period, skills_used: w.skills_used || [] } });
      const toProj = p => ({ id: p.project_id, document: `${p.project_name} (${p.tech}): ${p.description||""}`, metadata: { name: p.project_name, tech: p.tech } });
      if (pinnedWEList.length) ragContext.work = pinnedWEList.map(id => workById.get(id)).filter(Boolean).map(toWork);
      if (pinnedProjectList.length) ragContext.projects = pinnedProjectList.map(id => projById.get(id)).filter(Boolean).map(toProj);
    }

    const skillText = ragContext.skills.map(s => `${s.metadata.skill_name} (${s.metadata.level}): ${s.document}`).join("\n");
    const workText = ragContext.work.map(w => `${w.metadata.title} at ${w.metadata.company}: ${w.document}`).join("\n\n");

    let systemPrompt, userPrompt, outputKey;

    if (section === "profile_summary") {
      outputKey = "profile";
      systemPrompt = `You are a CV writer for Varun Raval. Generate ONLY the profile summary.
RULES: EXACTLY 2 sentences, 35-55 words total. Sentence 1: who Varun is + target role fit. Sentence 2: strongest 2 capability proofs for this specific JD.
NEVER use clichés ("results-driven", "passionate", "proven track record", etc.).
Return ONLY valid JSON: { "profile": "<2 sentences>" }

=== VARUN'S MATCHED SKILLS ===
${skillText}

=== WORK EXPERIENCE ===
${workText}`;
      userPrompt = `=== JOB DESCRIPTION ===\n${jdText.slice(0, 3000)}\n\nGenerate profile JSON. Output ONLY { "profile": "..." }`;
    } else if (section === "technical_skills") {
      outputKey = "technical_skills";
      systemPrompt = `You are a CV writer for Varun Raval. Generate ONLY the technical_skills section.
Group into 4-6 categories (e.g., "SAP Ecosystem", "Development & APIs", "AI & Analytics", "Cloud & DevOps", "Tools & Platforms").
Each category: 4-8 tools separated by semicolons. Use ONLY tools from matched skills data.
Return ONLY valid JSON: { "technical_skills": [{ "category": "...", "items": "Tool; Tool; Tool" }] }

=== VARUN'S MATCHED SKILLS ===
${skillText}`;
      userPrompt = `=== JOB DESCRIPTION ===\n${jdText.slice(0, 2000)}\n\nGenerate technical_skills JSON. Output ONLY { "technical_skills": [...] }`;
    } else {
      outputKey = "key_competencies";
      systemPrompt = `You are a CV writer for Varun Raval. Generate ONLY the key_competencies field.
Select 10-14 competencies that match both Varun's skills AND the JD requirements, separated by • (bullet).
Return ONLY valid JSON: { "key_competencies": "Competency 1 • Competency 2 • ..." }

=== VARUN'S MATCHED SKILLS ===
${skillText}`;
      userPrompt = `=== JOB DESCRIPTION ===\n${jdText.slice(0, 2000)}\n\nGenerate key_competencies JSON. Output ONLY { "key_competencies": "..." }`;
    }

    console.log(`/generate-section [${section}] via ${aiProvider}...`);
    const raw = await callAI(systemPrompt, userPrompt);
    const parsed = parseModelJson(raw);
    if (!parsed || parsed[outputKey] == null) throw new Error(`AI did not return expected field: ${outputKey}`);

    return res.json({ success: true, section, content: parsed[outputKey] });
  } catch (err) {
    console.error("generate-section error:", err.message);
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
    // Always read fresh so pinned lookups use latest Skill Bank edits
    let latestBank = skillBank || {};
    try { latestBank = loadBank(); skillBank = latestBank; } catch (_) {}

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
      ragContext = await retrieveContext(jobDescription, { topSkills: 12, topProjects: 3, topWork: 2 }, latestBank);
      console.log(`  RAG: ${ragContext.skills.length} skills, ${ragContext.projects.length} projects, ${ragContext.work.length} work`);

      // If user pinned specific WE/Project IDs, inject them from skill_data_bank
      if (pinnedWEList.length || pinnedProjectList.length) {
        const bank = latestBank;
        const projectById = new Map((bank.user_projects || []).map(p => [p.project_id, p]));
        const workById    = new Map((bank.user_work_experience || []).map(w => [w.work_id, w]));

        const toWorkCtx = w => ({
          id:       w.work_id,
          document: `${w.job_title} at ${w.company} (${w.period}): ${(w.responsibilities||[]).join(' ')}`,
          metadata: { title: w.job_title, company: w.company, period: w.period, skills_used: w.skills_used || [] }
        });
        const toProjCtx = p => ({
          id:       p.project_id,
          document: `${p.project_name} (${p.tech}): ${p.description || ""}`,
          metadata: { name: p.project_name, tech: p.tech }
        });

        if (documentType === "cv") {
          if (pinnedWEList.length)      ragContext.work     = pinnedWEList.map(id => workById.get(id)).filter(Boolean).map(toWorkCtx);
          if (pinnedProjectList.length) ragContext.projects = pinnedProjectList.map(id => projectById.get(id)).filter(Boolean).map(toProjCtx);
        } else {
          if (pinnedWEList.length) {
            const pinned   = pinnedWEList.map(id => workById.get(id)).filter(Boolean).map(toWorkCtx);
            const ragExtra = ragContext.work.filter(w => !pinnedWEList.includes(w.id));
            ragContext.work = [...pinned, ...ragExtra];
          }
          if (pinnedProjectList.length) {
            const pinned   = pinnedProjectList.map(id => projectById.get(id)).filter(Boolean).map(toProjCtx);
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
      const allCerts = (latestBank.user_certifications || []).map(c => ({ ...c, id: c.cert_id, name: c.title }));
      const selectedCerts = pinnedCertList.length
        ? allCerts.filter(c => pinnedCertList.includes(c.cert_id))
        : allCerts;

      // Resolve selected research papers + activities
      const allRP = latestBank.research_papers || [];
      const allRA = latestBank.research_activities || [];
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
          const byIdNow = new Map((bankNow.user_projects || []).map(p => [p.project_id, p]));
          const resolvedPinnedCvProjects = pinnedProjectList.map(id => byIdNow.get(id)).filter(Boolean).map(p => ({
            id:       p.project_id,
            document: p.description || p.project_name,
            metadata: { name: p.project_name, tech: p.tech }
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

const LATEX_CV_PREAMBLE = `\\documentclass[11pt,a4paper]{article}

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

const LATEX_CL_PREAMBLE = `\\documentclass[11pt,a4paper]{article}
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

  return `\\documentclass[11pt,a4paper]{article}
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

  return `\\documentclass[11pt,a4paper]{article}
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
// POST /rebuild-vector-store  — rebuild from current skill_data_bank.json
// ═══════════════════════════════════════════════════════════════

app.post("/rebuild-vector-store", async (req, res) => {
  if (!rebuildVectorStore) return res.status(503).json({ success: false, error: "RAG engine not loaded" });
  try {
    const bank   = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
    skillBank    = bank;
    const counts = await rebuildVectorStore(bank);
    vectorReady  = true;
    res.json({ success: true, message: "Vector store rebuilt", counts });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /health
// ═══════════════════════════════════════════════════════════════

app.get("/health", (req, res) => res.json({
  status: "ok",
  aiProvider: aiProvider || "none",
  model: aiProvider === "claude" ? CLAUDE_MODEL : aiProvider === "groq" ? GROQ_MODEL : aiProvider === "gemini" ? GEMINI_MODEL : "none",
  browserUp: sharedBrowser?.isConnected() || false,
  vectorStore: vectorReady,
  skillChunks: (skillBank?.user_skills || []).length,
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
    user_skills:          skillBank.user_skills || [],
    user_projects:        skillBank.user_projects || [],
    user_work_experience: skillBank.user_work_experience || [],
    education:            skillBank.education || [],
    certifications:       skillBank.user_certifications || [],
    research_papers: skillBank.research_papers || [],
    research_activities: skillBank.research_activities || [],
    vectorReady
  });
});

// ── Edit project ──
app.post("/skill-bank/update-project", async (req, res) => {
  const { project_id, project_name, tech, date, description, impact } = req.body;
  if (!project_id) return res.status(400).json({ success: false, error: "Missing project_id" });
  try {
    const bankPath = path.join(__dirname, "data", "skill_data_bank.json");
    const bank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    const projects = bank.user_projects || bank.projects || [];
    const proj = projects.find(p => (p.project_id || p.id) === project_id);
    if (!proj) return res.status(404).json({ success: false, error: `Project ${project_id} not found` });
    if (project_name !== undefined) { proj.project_name = project_name; if (proj.name !== undefined) proj.name = project_name; }
    if (tech        !== undefined) proj.tech        = tech;
    if (date        !== undefined) proj.date        = date;
    if (description !== undefined) proj.description = description;
    if (impact      !== undefined) proj.impact      = impact;
    // Regenerate vector_text for this project so RAG picks up the change
    proj.vector_text = `${proj.project_name||proj.name} ${proj.tech||""} ${proj.description||""} ${proj.impact||""}`.replace(/\s+/g," ").trim();
    atomicWriteSync(bankPath, JSON.stringify(bank, null, 2));
    skillBank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    if (rebuildVectorStore) { await rebuildVectorStore(skillBank); vectorReady = true; }
    res.json({ success: true, project: proj, vectorRebuilt: !!rebuildVectorStore });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ── Edit work experience ──
app.post("/skill-bank/update-work", async (req, res) => {
  const { work_id, job_title, company, period, location, skills_used, responsibilities } = req.body;
  if (!work_id) return res.status(400).json({ success: false, error: "Missing work_id" });
  try {
    const bankPath = path.join(__dirname, "data", "skill_data_bank.json");
    const bank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    const workList = bank.user_work_experience || [];
    const entry = workList.find(w => (w.work_id || w.id) === work_id);
    if (!entry) return res.status(404).json({ success: false, error: `Work entry ${work_id} not found` });
    if (job_title      !== undefined) { entry.job_title = job_title; if (entry.title !== undefined) entry.title = job_title; }
    if (company        !== undefined) entry.company        = company;
    if (period         !== undefined) entry.period         = period;
    if (location       !== undefined) entry.location       = location;
    if (skills_used    !== undefined) entry.skills_used    = Array.isArray(skills_used) ? skills_used : skills_used.split(",").map(s => s.trim()).filter(Boolean);
    if (responsibilities !== undefined) { entry.responsibilities = Array.isArray(responsibilities) ? responsibilities : responsibilities.split("\n").map(s => s.trim()).filter(Boolean); if (entry.bullets !== undefined) entry.bullets = entry.responsibilities; }
    // Regenerate vector_text for this work entry
    entry.vector_text = `${entry.job_title||entry.title} ${entry.company} ${(entry.responsibilities||entry.bullets||[]).join(" ")} ${(entry.skills_used||[]).join(" ")}`.replace(/\s+/g," ").trim();
    atomicWriteSync(bankPath, JSON.stringify(bank, null, 2));
    skillBank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    if (rebuildVectorStore) { await rebuildVectorStore(skillBank); vectorReady = true; }
    res.json({ success: true, entry, vectorRebuilt: !!rebuildVectorStore });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

// ── Edit certification ──
app.post("/skill-bank/update-cert", (req, res) => {
  const { cert_id, title, provider, date, duration } = req.body;
  if (!cert_id) return res.status(400).json({ success: false, error: "Missing cert_id" });
  try {
    const bankPath = path.join(__dirname, "data", "skill_data_bank.json");
    const bank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    const list = bank.user_certifications || [];
    const entry = list.find(c => (c.cert_id || c.id) === cert_id);
    if (!entry) return res.status(404).json({ success: false, error: `Cert ${cert_id} not found` });
    if (title    !== undefined) entry.title    = title;
    if (provider !== undefined) entry.provider = provider;
    if (date     !== undefined) entry.date     = date;
    if (duration !== undefined) entry.duration = duration;
    atomicWriteSync(bankPath, JSON.stringify(bank, null, 2));
    skillBank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    res.json({ success: true, entry });
  } catch (err) { res.status(500).json({ success: false, error: safeError(err) }); }
});

// ── Edit research paper or activity ──
app.post("/skill-bank/update-research", (req, res) => {
  const { id, title, description, institution, context, period, date, references, key_finding } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "Missing id" });
  try {
    const bankPath = path.join(__dirname, "data", "skill_data_bank.json");
    const bank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    const entry = (bank.research_papers || []).find(r => r.id === id)
               || (bank.research_activities || []).find(r => r.id === id);
    if (!entry) return res.status(404).json({ success: false, error: `Research ${id} not found` });
    if (title       !== undefined) entry.title       = title;
    if (description !== undefined) entry.description = description;
    if (institution !== undefined) entry.institution = institution;
    if (context     !== undefined) entry.context     = context;
    if (period      !== undefined) entry.period      = period;
    if (date        !== undefined) entry.date        = date;
    if (references  !== undefined) entry.references  = references;
    if (key_finding !== undefined) entry.key_finding = key_finding;
    atomicWriteSync(bankPath, JSON.stringify(bank, null, 2));
    skillBank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    res.json({ success: true, entry });
  } catch (err) { res.status(500).json({ success: false, error: safeError(err) }); }
});

// ── Edit education entry ──
app.post("/skill-bank/update-education", (req, res) => {
  const { degree, institution, period, status, relevance, key_modules } = req.body;
  if (!degree || !institution) return res.status(400).json({ success: false, error: "Missing degree or institution" });
  try {
    const bankPath = path.join(__dirname, "data", "skill_data_bank.json");
    const bank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    const entry = (bank.education || []).find(e => e.degree === degree && e.institution === institution);
    if (!entry) return res.status(404).json({ success: false, error: `Education entry not found` });
    if (period      !== undefined) entry.period      = period;
    if (status      !== undefined) entry.status      = status;
    if (relevance   !== undefined) entry.relevance   = relevance;
    if (key_modules !== undefined) entry.key_modules = Array.isArray(key_modules) ? key_modules : key_modules.split("\n").map(s => s.trim()).filter(Boolean);
    atomicWriteSync(bankPath, JSON.stringify(bank, null, 2));
    skillBank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
    res.json({ success: true, entry });
  } catch (err) { res.status(500).json({ success: false, error: safeError(err) }); }
});

app.post("/skill-bank/add", async (req, res) => {
  if (!skillBankManager) return res.status(503).json({ success: false, error: "Skill bank not available" });
  const { category, skill, level, evidence, phase } = req.body;
  if (!category || !skill || !level || !evidence) return res.status(400).json({ success: false, error: "Missing required fields: category, skill, level, evidence" });
  try {
    const chunk = await skillBankManager.addSkill({ category, skill, level, evidence, phase });
    skillBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
    if (rebuildVectorStore) { await rebuildVectorStore(skillBank); vectorReady = true; }
    res.json({ success: true, chunk, vectorRebuilt: !!rebuildVectorStore });
  } catch (err) {
    res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.post("/skill-bank/update", async (req, res) => {
  if (!skillBankManager) return res.status(503).json({ success: false, error: "Skill bank not available" });
  const { id, level, evidence, description, tools } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "Missing skill id" });
  try {
    const updates = {};
    if (level)                    updates.level       = level;
    if (description || evidence)  updates.description = description || evidence;
    if (tools)                    updates.tools       = tools;
    const chunk = await skillBankManager.updateSkill(id, updates);
    skillBank = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "skill_data_bank.json"), "utf-8"));
    if (rebuildVectorStore) { await rebuildVectorStore(skillBank); vectorReady = true; }
    res.json({ success: true, chunk, vectorRebuilt: !!rebuildVectorStore });
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
    const chunk = (bank.user_skills || []).find(s => s.skill_id === id);
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
  const results = (skillBank.user_skills || []).filter(s => {
    const name = (s.skill_name || "").toLowerCase();
    const ev   = (s.description || "").toLowerCase();
    const cat  = (s.category || "").toLowerCase();
    const toolTags = (s.tools || []).join(" ").toLowerCase();
    const hay = name + " " + ev + " " + cat + " " + toolTags;
    return tokens.every(t => hay.includes(t)) || name.includes(q) || q.includes(name);
  }).map(s => ({
    id: s.skill_id, skill: s.skill_name, category: s.category, level: s.level, evidence: s.description, type: s.type, tools: s.tools || []
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
// START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const lanIp = Object.values(nets).flat().find(n => n.family === 'IPv4' && !n.internal)?.address || 'unknown';
  console.log(`\n  SAP Job Automator`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${lanIp}:${PORT}  ← open this on iPad`);
  console.log(`  AI: ${aiProvider || "NONE (set API key in .env)"}\n`);
});
