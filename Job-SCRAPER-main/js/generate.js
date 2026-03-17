/**
 * SAP Job Automator — Generate Module
 * Features:
 * - Animated progress bar with step markers
 * - AI thinking panel showing reasoning during generation
 * - Collapsible Document Library with CV/CL split table
 * - Server-side smart selection with TF-IDF scoring
 */
(function () {
  "use strict";

  const genState = {
    queue: [],
    generations: {},   // reqId → per-job generation state
    libraryIndexed: false,
    libraryDocs: [],
    foundationDocs: [],
    approvedDocs: [],
    domainInsights: [],
    userId: null,
    libExpanded: false
  };

  const $ = (id) => document.getElementById(id);

  // ─── Helpers ───
  function showToast(msg, type) {
    const tc = document.getElementById("toast-container");
    if (!tc) return;
    const t = document.createElement("div");
    t.className = `toast toast-${type || "info"}`;
    t.textContent = msg;
    tc.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }


  // JD SECTION PARSER (generic — works for SAP, Siemens, Mercedes, etc.)
  // ═══════════════════════════════════════════════════════════════
  function parseJDSections(jdText) {
    const sectionPatterns = [
      { key: "role",    labels: ["about the role", "about this role", "role overview", "position overview", "job summary", "uber die stelle", "stellenbeschreibung"] },
      { key: "build",   labels: ["what you'll build", "what you will build", "your tasks", "your responsibilities", "key responsibilities", "responsibilities", "ihre aufgaben", "aufgaben"] },
      { key: "bring",   labels: ["what you bring", "what you'll bring", "your profile", "requirements", "qualifications", "what we expect", "your qualifications", "ihr profil", "was sie mitbringen", "anforderungen"] },
      { key: "team",    labels: ["meet your team", "the team", "about the team", "your team", "das team", "unser team"] },
      { key: "belong",  labels: ["where you belong", "what we offer", "benefits", "why join us", "we offer", "was wir bieten", "unser angebot", "ihre vorteile"] },
      { key: "company", labels: ["about us", "about sap", "about the company", "company overview", "uber uns"] }
    ];
    const sections = {};
    const lines = jdText.split(/\n/);
    let currentKey = null;
    let currentContent = [];

    for (const line of lines) {
      const lower = line.toLowerCase().trim();
      if (!lower) { if (currentKey) currentContent.push(""); continue; }
      let matched = false;
      for (const sp of sectionPatterns) {
        if (sp.labels.some(l => lower.includes(l) && lower.length < 80)) {
          if (currentKey && currentContent.length) sections[currentKey] = currentContent.join("\n").trim();
          currentKey = sp.key;
          currentContent = [];
          matched = true;
          break;
        }
      }
      // Fallback: detect headings by structure (short ALL CAPS lines or lines ending with colon)
      if (!matched && !currentKey && line.length < 60 && line.length > 3 && (line === line.toUpperCase() || line.endsWith(":"))) {
        if (currentKey && currentContent.length) sections[currentKey] = currentContent.join("\n").trim();
        currentKey = "other_" + Object.keys(sections).length;
        currentContent = [];
        matched = true;
      }
      if (!matched && currentKey) currentContent.push(line);
    }
    if (currentKey && currentContent.length) sections[currentKey] = currentContent.join("\n").trim();
    return sections;
  }

  const SECTION_LABELS = {
    role: "About the Role", build: "What You'll Build", bring: "What You Bring",
    team: "The Team", belong: "What's Offered", company: "About the Company"
  };

  // Tech/skill keywords to highlight as chips in the "bring" section
  const TECH_KEYWORDS = [
    "SAP BTP","SAP S/4HANA","SAP Fiori","SAP HANA","SAP Analytics Cloud","SAP Datasphere",
    "SAP SuccessFactors","SAP Ariba","SAP Concur","SAP Integration Suite","SAP Build",
    "ABAP","OData","REST","GraphQL","Python","JavaScript","TypeScript","Java","Node.js",
    "React","Angular","Vue","SQL","NoSQL","MongoDB","PostgreSQL","MySQL",
    "Docker","Kubernetes","Azure","AWS","GCP","CI/CD","Git","Agile","Scrum",
    "Machine Learning","AI","GenAI","LLM","RAG","Power BI","Tableau","Jupyter",
    "CAP","CDS","CAPM","BAS","Cloud Foundry","Kyma","SAP Work Zone",
    "SFTP","API","Microservices","DevOps","Terraform","Jenkins","GitHub Actions"
  ];

  const SECTION_ICONS = {
    role: "🎯", build: "🔨", bring: "⭐", team: "👥", belong: "🎁", company: "🏢"
  };

  // Map server-side section headings (any key) to normalized build / bring / role
  function normalizeSections(serverSections) {
    if (!serverSections || typeof serverSections !== "object") return null;
    const out = { build: "", bring: "", role: "" };
    const buildLabels = /what you['\u2019]ll build|what you will build|your tasks|your responsibilities|key responsibilities|responsibilities|what you['\u2019]ll do|ihre aufgaben|aufgaben/i;
    const bringLabels = /what you bring|what you['\u2019]ll bring|your profile|requirements|qualifications|what we expect|your qualifications|ihr profil|was sie mitbringen|anforderungen/i;
    const roleLabels = /about the role|about this role|role overview|position overview|job summary|uber die stelle|stellenbeschreibung/i;
    for (const [heading, content] of Object.entries(serverSections)) {
      if (!content || typeof content !== "string") continue;
      const h = heading.trim().toLowerCase();
      if (buildLabels.test(h)) out.build += (out.build ? "\n\n" : "") + content;
      else if (bringLabels.test(h)) out.bring += (out.bring ? "\n\n" : "") + content;
      else if (roleLabels.test(h)) out.role += (out.role ? "\n\n" : "") + content;
    }
    if (!out.build && !out.bring && !out.role) return null;
    return out;
  }

  function extractSkillChips(text) {
    if (!text) return [];
    const found = [];
    const lower = text.toLowerCase();
    for (const kw of TECH_KEYWORDS) {
      if (lower.includes(kw.toLowerCase()) && !found.includes(kw)) found.push(kw);
    }
    return found;
  }

  function extractBullets(content) {
    if (!content) return [];
    // Split on newlines, bullets, and standalone list markers — but NOT on hyphens inside words
    return content
      .split(/\n|(?:^|\n)\s*[•·▪▸◦‣–—*]\s*/m)
      .map(s => s.replace(/^\s*[-–—]\s+/, "").trim())  // strip leading dashes with space
      .filter(s => s.length > 8 && !/^[-–—]{2,}$/.test(s));  // remove separators
  }

  // ── Expert JD Analysis helpers ──

  // Categorize bullets into MUST HAVE vs NICE TO HAVE
  function categorizeBullets(bringText) {
    if (!bringText) return { mustHave: [], niceToHave: [] };
    const lines = bringText.split(/\n/);
    const mustHave = [];
    const niceToHave = [];
    const nicePatterns = /prefer|nice.to.have|advantage|plus|desirable|beneficial|ideally|optionally|bonus|not.required/i;
    const mustPatterns = /must|required|essential|mandatory|necessary|minimum|at.least/i;

    let currentBucket = null; // track if we entered a "Nice to Have" heading
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lc = trimmed.toLowerCase();
      // Detect heading-level bucket changes
      if (trimmed.length < 60 && nicePatterns.test(lc)) {
        currentBucket = "nice";
        continue;
      }
      if (trimmed.length < 60 && mustPatterns.test(lc)) {
        currentBucket = "must";
        continue;
      }
      // Clean bullet marker
      const bullet = trimmed.replace(/^[•·▪▸◦‣–—*\-]\s+/, "").trim();
      if (bullet.length < 8) continue;

      if (currentBucket === "nice" || nicePatterns.test(lc)) {
        niceToHave.push(bullet);
      } else if (currentBucket === "must" || mustPatterns.test(lc)) {
        mustHave.push(bullet);
      } else {
        // Default uncategorized → must have
        mustHave.push(bullet);
      }
    }

    // If nothing ended up in niceToHave, split mustHave 70/30
    if (!niceToHave.length && mustHave.length > 4) {
      const splitAt = Math.ceil(mustHave.length * 0.7);
      niceToHave.push(...mustHave.splice(splitAt));
    }

    // Drop company branding / non-requirement bullets from MUST HAVE
    const requirementKeywords = /experience|knowledge|skill|degree|education|proficiency|familiarity|background|enrolled|student|language|fluent|ability|competency/i;
    const isFluff = (b) => {
      const t = (b || "").trim();
      if (t.length > 280) return true; // long paragraph = likely culture text
      if (/^\s*(We |At SAP|We help|We're |We win|We keep)/i.test(t)) return true;
      if (!requirementKeywords.test(t)) return true; // no requirement-like wording
      return false;
    };
    const filteredMust = mustHave.filter(b => !isFluff(b));

    return { mustHave: (filteredMust.length ? filteredMust : mustHave).slice(0, 8), niceToHave: niceToHave.slice(0, 5) };
  }

  // Classify matched chunks into MATCHED / PARTIAL / and derive GAPS from JD keywords
  function classifyMatches(matchedChunks, jdText) {
    const matched = [];
    const partial = [];
    for (const c of matchedChunks) {
      const rel = Math.round((1 - (c.distance || 0)) * 100);
      if (rel >= 65) matched.push({ ...c, rel });
      else if (rel >= 40) partial.push({ ...c, rel });
    }

    // Find GAPS: tech keywords in JD not covered by matched chunk names
    const matchedNames = matchedChunks.map(c => (c.metadata?.skill_name || c.id || "").toLowerCase());
    const jdLower = jdText.toLowerCase();
    const gaps = TECH_KEYWORDS.filter(kw => {
      const kwLower = kw.toLowerCase();
      return jdLower.includes(kwLower) && !matchedNames.some(n => n.includes(kwLower) || kwLower.includes(n));
    }).slice(0, 6);

    return { matched, partial, gaps };
  }

  // Build STRATEGY recommendation text
  function buildStrategy(matched, partial, gaps) {
    const score = matched.length * 2 + partial.length;
    if (score >= 10) {
      return { text: "STRONG FIT — Your skill bank directly covers the core requirements. Lead with your matched skills and quantify impact.", cls: "exp-strategy-strong" };
    } else if (score >= 6) {
      return { text: "GOOD FIT — Solid overlap with role requirements. In your cover letter, explicitly address the partially-matched areas with concrete examples.", cls: "exp-strategy-good" };
    } else if (gaps.length > matched.length) {
      return { text: "SKILL GAP — Several key technologies are missing from your bank. Consider highlighting transferable skills and willingness to learn these areas.", cls: "exp-strategy-partial" };
    } else {
      return { text: "PARTIAL FIT — Limited direct skill matches. Focus application on areas where your background is strongest and use the cover letter to bridge the gaps.", cls: "exp-strategy-partial" };
    }
  }

  function populateJDPanel(jdText, serverSections, matchedChunks, job, jdSummary) {
    const panel = $("gen-jd-panel");
    const expertEl = $("gen-jd-expert-content");
    const highlightsEl = $("gen-jd-highlights-content");
    const fullEl = $("gen-jd-full-content");
    if (!panel) return;

        // Compute sections first - used by all tabs
    const rawSections = (serverSections && Object.keys(serverSections).length) ? serverSections : null;
    const sections = normalizeSections(rawSections) || parseJDSections(jdText);

    // Full JD tab - structured HTML with section headings + bullet lists
    if (fullEl) {
      if (rawSections && Object.keys(rawSections).length > 0) {
        let html = "";
        for (const [heading, content] of Object.entries(rawSections)) {
          if (!content || !content.trim()) continue;
          const bullets = content.split("\n").map(l => l.replace(/^[\u2022\u00b7\u25aa\u25b8\u25e6\u2023\u2013\u2014*\-]\s*/, "").trim()).filter(l => l.length > 3);
          if (!bullets.length) continue;
          html += `<div class="jd-full-section"><h4 class="jd-full-heading">${esc(heading)}</h4><ul class="jd-full-list">${bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul></div>`;
        }
        fullEl.innerHTML = html || `<div class="jd-full-plain">${esc(jdText.replace(/\n{3,}/g, "\n\n").trim())}</div>`;
      } else {
        const paras = jdText.replace(/\n{3,}/g, "\n\n").trim().split("\n\n");
        fullEl.innerHTML = paras.map(p => {
          const t = p.trim(); if (!t) return "";
          if (t.length < 70 && !t.includes("\n") && !t.endsWith(".") && t.length > 3) return `<h4 class="jd-full-heading">${esc(t)}</h4>`;
          const lines = t.split("\n").map(l => l.trim()).filter(Boolean);
          if (lines.length > 1) return `<ul class="jd-full-list">${lines.map(l => `<li>${esc(l.replace(/^[\u2022\u00b7\u25aa\u25b8\u25e6\u2023\u2013\u2014*\-]\s*/, ""))}</li>`).join("")}</ul>`;
          return `<p class="jd-full-para">${esc(t)}</p>`;
        }).join("");
      }
    }
    // Highlights tab - prefer AI-extracted bullets, fallback to section parsing
    if (highlightsEl) {
      const doBullets = (jdSummary && jdSummary.what_you_do_summary && jdSummary.what_you_do_summary.length)
        ? jdSummary.what_you_do_summary.slice(0, 7)
        : extractBullets(sections.build || sections.role || "").slice(0, 6);
      const bringBullets = (jdSummary && jdSummary.what_you_bring_summary && jdSummary.what_you_bring_summary.length)
        ? jdSummary.what_you_bring_summary.slice(0, 7)
        : extractBullets(sections.bring || "").slice(0, 6);
      const html = `<div class="jd-two-col">
        <div class="jd-col">
          <div class="jd-col-header">
            <span class="jd-section-icon">🛠</span>
            <span class="jd-section-label">What you'll do</span>
          </div>
          <ul class="jd-section-list">
            ${doBullets.length ? doBullets.map(b => `<li>${esc(b)}</li>`).join("") : "<li class='jd-empty'>No role responsibilities extracted. Check Full JD.</li>"}
          </ul>
        </div>
        <div class="jd-col">
          <div class="jd-col-header">
            <span class="jd-section-icon">⭐</span>
            <span class="jd-section-label">What you bring</span>
          </div>
          <ul class="jd-section-list">
            ${bringBullets.length ? bringBullets.map(b => `<li>${esc(b)}</li>`).join("") : "<li class='jd-empty'>No requirements extracted. Check Full JD.</li>"}
          </ul>
        </div>
      </div>`;
      highlightsEl.innerHTML = html;
    }

    // ── Expert Analysis tab ──
    if (expertEl) {
      const chunks = matchedChunks || [];
      const { matched, partial, gaps } = classifyMatches(chunks, jdText);
      const strategy = buildStrategy(matched, partial, gaps);

      // Snapshot: prefer AI summary, fallback to JD parsing
      const snap = (jdSummary && jdSummary.snapshot) ? jdSummary.snapshot : null;
      const workArea = (snap && snap.work_area) ? snap.work_area : (sections.role ? extractBullets(sections.role)[0] || "—" : "—");
      const careerType = snap ? [snap.career_status, snap.employment_type].filter(Boolean).join(" · ") : "";
      const oneLiner = (snap && snap.one_liner) ? snap.one_liner : "";

      // Panel 1: Job Snapshot
      const overviewHtml = `<div class="exp-panel exp-overview">
        <div class="exp-panel-header">
          <span class="exp-panel-icon">📋</span>
          <span class="exp-panel-title">Job Snapshot</span>
        </div>
        <div class="exp-overview-grid">
          <div class="exp-ov-row"><span class="exp-ov-label">Title</span><span class="exp-ov-val">${job && job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(job.title || "—")}</a>` : esc((job && job.title) || "—")}</span></div>
          <div class="exp-ov-row"><span class="exp-ov-label">Location</span><span class="exp-ov-val">${esc((job && job.location) || "—")}</span></div>
          <div class="exp-ov-row"><span class="exp-ov-label">Req ID</span><span class="exp-ov-val">${esc((job && job.reqId) || "—")}</span></div>
          <div class="exp-ov-row"><span class="exp-ov-label">Work Area</span><span class="exp-ov-val">${esc(workArea)}</span></div>
          ${careerType ? `<div class="exp-ov-row"><span class="exp-ov-label">Type</span><span class="exp-ov-val">${esc(careerType)}</span></div>` : ""}
          ${oneLiner ? `<div class="exp-ov-row" style="grid-column:1/-1"><span class="exp-ov-label">Summary</span><span class="exp-ov-val" style="font-style:italic;color:var(--text-secondary)">${esc(oneLiner)}</span></div>` : ""}
        </div>
      </div>`;

      // Panel 2: What They Want - AI summary first, fallback to section parse
      const _bringText = sections.bring || "";
      const _cat = categorizeBullets(_bringText);
      const mustHave = (jdSummary && jdSummary.must_have && jdSummary.must_have.length) ? jdSummary.must_have : _cat.mustHave;
      const niceToHave = (jdSummary && jdSummary.nice_to_have && jdSummary.nice_to_have.length) ? jdSummary.nice_to_have : _cat.niceToHave;

      // Skill chips from AI summary or JD text
      const _chipSrc = ((jdSummary && jdSummary.what_you_bring_summary) || []).concat((jdSummary && jdSummary.must_have) || []).join(" ") || _bringText;
      const skillChips = extractSkillChips(_chipSrc).slice(0, 10);

      const wantHtml = `<div class="exp-panel exp-want">
        <div class="exp-panel-header">
          <span class="exp-panel-icon">🎯</span>
          <span class="exp-panel-title">What They Want</span>
          ${jdSummary ? '<span class="exp-ai-badge">AI</span>' : ""}
        </div>
        ${skillChips.length ? `<div class="exp-chip-row">${skillChips.map(c => `<span class="exp-skill-chip">${esc(c)}</span>`).join("")}</div>` : ""}
        <div class="exp-want-cols">
          <div class="exp-want-col">
            <div class="exp-want-col-header exp-must-header">MUST HAVE</div>
            <ul class="exp-want-list">
              ${mustHave.length ? mustHave.map(b => `<li><span class="exp-must-dot"></span>${esc(b)}</li>`).join("") : "<li class='exp-empty-li'>No explicit requirements found</li>"}
            </ul>
          </div>
          <div class="exp-want-col">
            <div class="exp-want-col-header exp-nice-header">NICE TO HAVE</div>
            <ul class="exp-want-list">
              ${niceToHave.length ? niceToHave.map(b => `<li><span class="exp-nice-dot"></span>${esc(b)}</li>`).join("") : "<li class='exp-empty-li'>None specified</li>"}
            </ul>
          </div>
        </div>
      </div>`;

      expertEl.innerHTML = overviewHtml + wantHtml;
    }

    panel.style.display = "";
    // Ensure body is uncollapsed, expert tab is active, arrow reflects open state
    $("gen-jd-panel-body")?.classList.remove("collapsed");
    // Switch to expert tab
    document.querySelectorAll(".gen-jd-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "expert"));
    document.querySelectorAll(".gen-jd-tab-content").forEach(c => c.classList.toggle("active", c.id === "gen-jd-expert-content"));
    const arrow = $("gen-jd-panel-arrow");
    if (arrow) arrow.classList.add("open");
  }

  // ═══════════════════════════════════════════════════════════════
  // PER-JOB GENERATION HELPERS (background parallel generation)
  // ═══════════════════════════════════════════════════════════════

  function getGenKey(job) {
    return String(job.reqId || job.url || (job.title + (job.location || "")));
  }

  function safeId(s) {
    return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function updateJobUI(reqId) {
    const listEl = $("gen-queue-list");
    if (!listEl) return;
    const i = genState.queue.findIndex(j => getGenKey(j) === reqId);
    if (i < 0) return;
    // Preserve any edits the user made to the textareas before replacing DOM
    const gen = genState.generations[reqId];
    if (gen) {
      const safe = safeId(reqId);
      const cvTa = document.getElementById("gqi-cv-" + safe);
      const clTa = document.getElementById("gqi-cl-" + safe);
      if (cvTa) gen.cvContent = cvTa.value;
      if (clTa) gen.clContent = clTa.value;
    }
    const existing = Array.from(listEl.querySelectorAll("[data-gqi]")).find(el => el.dataset.gqi === reqId);
    const html = buildQueueItemHtml(genState.queue[i], i);
    const temp = document.createElement("div");
    temp.innerHTML = html;
    const newEl = temp.firstElementChild;
    if (!newEl) return;
    bindQueueItemEvents(newEl, i);
    if (existing) existing.replaceWith(newEl);
    else renderQueue();
    // Update badge count
    const countEl = $("gen-queue-count");
    if (countEl) {
      const genCount = Object.values(genState.generations).filter(g => g.state === "generating").length;
      countEl.textContent = `${genState.queue.length} job${genState.queue.length !== 1 ? "s" : ""}` +
        (genCount ? ` · ${genCount} generating` : "");
    }
  }

  function buildQueueItemHtml(job, i) {
    const key  = getGenKey(job);
    const safe = safeId(key);
    const gen  = genState.generations[key] || { state: "idle" };

    const scoreBadge = job.matchScore != null
      ? `<span class="match-badge ${job.matchScore >= 40 ? "match-badge-high" : job.matchScore >= 20 ? "match-badge-med" : "match-badge-low"}">${job.matchScore}% match</span>`
      : "";
    const skillTags  = (job.topMatchedSkills || []).slice(0, 4).map(s => `<span class="queue-skill-tag">${esc(s)}</span>`).join("");
    const analysisHtml = buildJDIntelPanel(job, i);

    // Top-right action area
    let topAction = "";
    if (gen.state === "idle") {
      topAction = `<button type="button" class="btn btn-primary btn-sm gen-start-btn" data-idx="${i}">Generate</button>`;
    } else if (gen.state === "generating") {
      topAction = `<span class="gqi-status-chip gqi-status-generating"><span class="gqi-inline-spin"></span>Generating…</span>`;
    } else if (gen.state === "done") {
      topAction = `<span class="gqi-status-chip gqi-status-done">✓ Ready</span>
        <button type="button" class="btn btn-sm gen-start-btn" data-idx="${i}" title="Re-generate">↺</button>`;
    } else if (gen.state === "error") {
      topAction = `<button type="button" class="btn btn-sm gen-start-btn" data-idx="${i}" style="color:var(--accent-secondary)">↺ Retry</button>`;
    }

    // ── Inline progress section (only when generating) ──
    let genProgressHtml = "";
    if (gen.state === "generating") {
      const stepOrder = { jd: 1, skills: 2, cv: 3, cl: 4, done: 5 };
      const curN = stepOrder[gen.step] || 0;
      const stepsHtml = [
        { key: "jd",     label: "Fetch JD",     n: 1 },
        { key: "skills", label: "Match Skills",  n: 2 },
        { key: "cv",     label: "Generate CV",   n: 3 },
        { key: "cl",     label: "Generate CL",   n: 4 },
      ].map(s => {
        const done   = curN > s.n;
        const active = !done && gen.step === s.key;
        return `<div class="gen-pb-step ${done ? "done" : active ? "active" : ""}" data-step="${s.n}">
          <span class="gen-pb-dot"></span>
          <span class="gen-pb-label">${s.label}</span>
        </div>`;
      }).join("");
      const thoughtsHtml = (gen.thoughts || []).slice(-8).map(t =>
        `<div class="think-step${t.done ? " done" : ""}"><span class="think-label">${esc(t.label)}</span> <span class="think-detail">${esc(t.detail)}</span></div>`
      ).join("");
      genProgressHtml = `<div class="gqi-generating">
        <div class="gqi-gen-header">
          <span class="gqi-gen-spinner"></span>
          <span class="gqi-gen-title">Generating for: <strong>${job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="gqi-title-link">${esc(job.title)}</a>` : esc(job.title)}</strong></span>
          <span class="gqi-gen-status">${esc(gen.stepLabel || "")}</span>
        </div>
        <div class="gen-progressbar-wrap" style="margin:0 0 10px">
          <div class="gen-progressbar-track">
            <div class="gen-progressbar-fill" style="width:${gen.progress || 0}%"></div>
          </div>
          <div class="gen-progressbar-steps">${stepsHtml}</div>
        </div>
        ${thoughtsHtml ? `<details class="gqi-log-details"><summary>AI log</summary><div class="gen-thinking-body gqi-log-body">${thoughtsHtml}</div></details>` : ""}
      </div>`;
    }

    // ── Inline results section (when done or error) ──
    let resultsHtml = "";
    if (gen.state === "done") {
      resultsHtml = `<div class="gqi-results">
        <div class="gqi-results-header">
          <span class="gqi-results-title">Generated for: <strong>${job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="gqi-title-link">${esc(job.title)}</a>` : esc(job.title)}</strong></span>
        </div>
        <div class="gqi-results-panels">
          <div class="gqi-result-panel">
            <div class="gqi-panel-toolbar">
              <span>CV</span>
              <div class="gen-panel-controls">
                <button type="button" class="btn btn-sm gqi-regen-btn" data-gen-regen="${esc(key)}" data-regen-type="cv" title="Regenerate CV">&#8635;</button>
                <button type="button" class="btn btn-sm gen-font-minus" data-target="gqi-cv-${safe}" title="A-">A-</button>
                <button type="button" class="btn btn-sm gen-font-plus"  data-target="gqi-cv-${safe}" title="A+">A+</button>
                <button type="button" class="btn btn-sm gen-copy-btn"   data-target="gqi-cv-${safe}" title="Copy to clipboard">&#x2398;</button>
                <button type="button" class="btn btn-sm gen-fullview"   data-target="gqi-cv-${safe}" data-label="CV">&#x26F6;</button>
              </div>
            </div>
            <textarea class="gqi-result-textarea" id="gqi-cv-${safe}" rows="20">${esc(gen.cvContent || "")}</textarea>
          </div>
          <div class="gqi-result-panel">
            <div class="gqi-panel-toolbar">
              <span>Cover Letter</span>
              <div class="gen-panel-controls">
                <button type="button" class="btn btn-sm gqi-regen-btn" data-gen-regen="${esc(key)}" data-regen-type="cl" title="Regenerate CL">&#8635;</button>
                <button type="button" class="btn btn-sm gen-font-minus" data-target="gqi-cl-${safe}" title="A-">A-</button>
                <button type="button" class="btn btn-sm gen-font-plus"  data-target="gqi-cl-${safe}" title="A+">A+</button>
                <button type="button" class="btn btn-sm gen-copy-btn"   data-target="gqi-cl-${safe}" title="Copy to clipboard">&#x2398;</button>
                <button type="button" class="btn btn-sm gen-fullview"   data-target="gqi-cl-${safe}" data-label="Cover Letter">&#x26F6;</button>
              </div>
            </div>
            <textarea class="gqi-result-textarea" id="gqi-cl-${safe}" rows="20">${esc(gen.clContent || "")}</textarea>
          </div>
        </div>
        <div class="gqi-result-actions">
          <button class="btn btn-success btn-sm" data-gen-approve="${esc(key)}">&#10003; Applied</button>
          <button class="btn btn-warning btn-sm" data-gen-save-draft="${esc(key)}">Save to Wishlist</button>
          <button class="btn btn-danger btn-sm"  data-gen-discard="${esc(key)}">Discard</button>
          <button class="btn btn-primary btn-sm" data-gen-export-cv="${esc(key)}">Export CV PDF</button>
          <button class="btn btn-primary btn-sm" data-gen-export-cl="${esc(key)}">Export CL PDF</button>
        </div>
        <div class="gqi-result-actions gqi-result-actions-secondary">
          <button class="btn btn-sm gqi-dach-btn" data-gen-dach="${esc(key)}">&#x1F1E9;&#x1F1EA; DACH Check</button>
        </div>
        ${gen.dachIssues ? buildDachResultsHtml(gen.dachIssues) : ""}
      </div>`;
    } else if (gen.state === "error") {
      resultsHtml = `<div class="gqi-error-msg">
        Generation failed: ${esc(gen.error || "Unknown error")}
        <button class="btn btn-sm gen-start-btn" data-idx="${i}" style="margin-left:8px">&#8635; Retry</button>
      </div>`;
    }

    return `<div class="gen-queue-item" data-gqi="${esc(key)}" data-qi="${i}">
      <div class="gqi-top">
        <div class="gen-queue-info">
          <span class="gen-queue-title">${job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="gqi-title-link">${esc(job.title)}</a>` : esc(job.title)} ${scoreBadge}</span>
          <span class="gen-queue-meta">${esc(job.location)} &middot; ${esc(job.reqId)}</span>
          ${skillTags ? `<div class="gen-queue-skills">${skillTags}</div>` : ""}
          ${analysisHtml}
        </div>
        <div class="gen-queue-actions">
          ${topAction}
          <button type="button" class="btn btn-sm gqi-remove-btn" data-remove="${i}" style="color:var(--accent-secondary)">&#10005;</button>
        </div>
      </div>
      ${genProgressHtml}
      ${resultsHtml}
    </div>`;
  }

  function bindQueueItemEvents(el, i) {
    el.querySelectorAll(".gen-start-btn[data-idx]").forEach(btn => {
      btn.addEventListener("click", () => startGeneration(parseInt(btn.dataset.idx, 10)));
    });
    el.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.remove, 10);
        const job = genState.queue[idx];
        if (job) delete genState.generations[getGenKey(job)];
        genState.queue.splice(idx, 1);
        renderQueue();
      });
    });
    el.querySelectorAll(".qa-analyze-btn").forEach(btn => {
      btn.addEventListener("click", () => analyzeQueueItem(parseInt(btn.dataset.idx, 10)));
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // LIBRARY INDEXING & RENDERING
  // ═══════════════════════════════════════════════════════════════
  async function indexLibrary() {
    const btn = $("index-library-btn");
    const statusEl = $("library-status");
    if (btn) { btn.disabled = true; btn.textContent = "Indexing..."; }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 600000);
      const res = await fetch("/index-library", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Index failed");

      genState.libraryDocs = data.indexed || [];
      genState.libraryIndexed = true;

      try {
        const userId = getUserId();
        if (userId && window.FirebaseAPI?.library) {
          for (const doc of genState.libraryDocs) {
            await FirebaseAPI.library.saveFoundationDoc(userId, {
              id: doc.id, filename: doc.filename, type: doc.type,
              charCount: doc.charCount, preview: doc.preview
            });
          }
        }
      } catch (fbErr) {
        console.warn("Firebase library save skipped:", fbErr.message);
      }

      renderLibraryStatus(data.indexed, data.errors);
      showToast(`Indexed ${data.indexed.length} documents`);
    } catch (err) {
      showToast("Index error: " + err.message, "error");
      if (statusEl) statusEl.innerHTML = `<p style="color:var(--accent-secondary)">Error: ${esc(err.message)}</p>`;
    }

    if (btn) { btn.disabled = false; btn.textContent = "Index Foundation PDFs"; }
  }

  function renderLibraryStatus(indexed, errors) {
    const el = $("library-status");
    if (!el) return;
    if (!indexed || indexed.length === 0) {
      el.innerHTML = `<p class="auto-empty">No documents indexed.</p>`;
      return;
    }

    const cvDocs = indexed.filter(d => d.type === "cv");
    const clDocs = indexed.filter(d => d.type === "cover_letter");

    let html = `<div class="lib-summary">
      <div class="lib-summary-stat"><span class="dot cv"></span>${cvDocs.length} CVs</div>
      <div class="lib-summary-stat"><span class="dot cl"></span>${clDocs.length} Cover Letters</div>
      <div class="lib-summary-stat" style="color:var(--text-muted)">${indexed.length} total docs</div>
    </div>`;

    html += `<div class="lib-table-grid">`;

    // CV column
    html += `<div class="lib-column"><h4 class="cv-col">CVs (${cvDocs.length})</h4>`;
    if (cvDocs.length === 0) {
      html += `<p class="auto-empty" style="padding:12px 0;">No CV samples found</p>`;
    } else {
      cvDocs.forEach((d, i) => {
        html += `<div class="lib-doc-item" data-doc-idx="cv-${i}">
          <span class="expand-icon">&#9656;</span>
          <span class="lib-doc-type cv">CV</span>
          <span class="lib-doc-name">${esc(d.filename)}</span>
          <span class="lib-doc-chars">${(d.charCount || 0).toLocaleString()} chars</span>
        </div>
        <div class="lib-doc-preview" id="preview-cv-${i}">${esc(d.preview || d.text?.substring(0, 500) || "No preview available")}</div>`;
      });
    }
    html += `</div>`;

    // CL column
    html += `<div class="lib-column"><h4 class="cl-col">Cover Letters (${clDocs.length})</h4>`;
    if (clDocs.length === 0) {
      html += `<p class="auto-empty" style="padding:12px 0;">No CL samples found</p>`;
    } else {
      clDocs.forEach((d, i) => {
        html += `<div class="lib-doc-item" data-doc-idx="cl-${i}">
          <span class="expand-icon">&#9656;</span>
          <span class="lib-doc-type cover_letter">CL</span>
          <span class="lib-doc-name">${esc(d.filename)}</span>
          <span class="lib-doc-chars">${(d.charCount || 0).toLocaleString()} chars</span>
        </div>
        <div class="lib-doc-preview" id="preview-cl-${i}">${esc(d.preview || d.text?.substring(0, 500) || "No preview available")}</div>`;
      });
    }
    html += `</div></div>`;

    if (errors && errors.length) {
      html += `<p style="margin-top:10px;color:var(--accent-secondary);font-size:.82rem;">${errors.length} file(s) failed to parse</p>`;
    }
    el.innerHTML = html;

    // Bind expand/collapse on doc items
    el.querySelectorAll(".lib-doc-item").forEach(item => {
      item.addEventListener("click", () => {
        const idx = item.dataset.docIdx;
        const preview = $("preview-" + idx);
        if (!preview) return;
        const isOpen = preview.classList.contains("show");
        preview.classList.toggle("show", !isOpen);
        item.classList.toggle("expanded", !isOpen);
      });
    });

    // Keep library collapsed — user expands manually
    el.classList.remove("lib-expanded");
    el.classList.add("lib-collapsed");
    const toggle = $("lib-toggle-btn");
    if (toggle) toggle.classList.remove("open");
    genState.libExpanded = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // GENERATION QUEUE
  // ═══════════════════════════════════════════════════════════════
  function addToQueue(job) {
    if (genState.queue.some(q => q.reqId && q.reqId === job.requisitionId)) return;
    const item = {
      title: job.title || "Unknown",
      url: job.url || "",
      reqId: job.requisitionId || "",
      location: job.location || "",
      keyword: job.keyword || "",
      matchScore: job.matchScore != null ? job.matchScore : null,
      topMatchedSkills: job.topMatchedSkills || [],
      jdData: null,
      analyzing: false
    };
    genState.queue.push(item);
    renderQueue();
    // Auto-trigger analysis in background if url available
    const idx = genState.queue.length - 1;
    if (item.url) analyzeQueueItem(idx);
  }

  // ── Job Analysis (JD fetch + AI summary + skill chunk match) ──
  async function analyzeQueueItem(idx) {
    const job = genState.queue[idx];
    if (!job || !job.url || job.analyzing || job.jdData) return;
    genState.queue[idx].analyzing = true;
    renderQueue();

    try {
      // Fetch JD via Playwright
      const jdRes = await fetch("/fetch-jd", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: job.url })
      });
      const jdData = await jdRes.json();
      if (!jdData.success) throw new Error(jdData.error || "JD fetch failed");
      const jdText = jdData.jd.fullText || "";
      const jdSections = jdData.jd.sections || {};

      // Build a requirements-only text slice for Sonnet (What you bring / profile / requirements),
      // falling back to the full JD text when we cannot detect a dedicated section.
      let reqText = "";
      try {
        const reqChunks = [];
        for (const [label, content] of Object.entries(jdSections)) {
          const lower = (label || "").toLowerCase();
          if (
            lower.includes("what you bring") ||
            lower.includes("your profile") ||
            lower.includes("requirements") ||
            lower.includes("qualifications")
          ) {
            if (content) reqChunks.push(content);
          }
        }
        reqText = reqChunks.join("\n\n").trim();
      } catch {
        reqText = "";
      }
      if (!reqText) reqText = jdText;

      // Ask backend to build a compact UX summary (Snapshot + What They Want)
      let jdSummary = null;
      try {
        const sumRes = await fetch("/jd-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jdText: reqText,
            title: jdData.jd.title,
            location: jdData.jd.location,
            requisitionId: jdData.jd.requisitionId,
            postedDate: jdData.jd.postedDate
          })
        });
        const sumData = await sumRes.json();
        if (sumData.success) jdSummary = sumData.summary;
      } catch (sumErr) {
        console.warn("JD summary skipped:", sumErr.message);
      }

      // Query skill bank for matched chunks
      const queryRes = await fetch("/skill-bank/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobText: jdText, topN: 8 })
      });
      const queryData = await queryRes.json();
      const matchedChunks = queryData.success ? (queryData.skills || []) : [];

      genState.queue[idx].jdData = { jdText, jdSections, jdSummary, matchedChunks };
    } catch (err) {
      genState.queue[idx].jdData = { error: err.message };
    }

    genState.queue[idx].analyzing = false;
    renderQueue();
  }

  function buildJDIntelPanel(job, i) {
    const gen = genState.generations[getGenKey(job)] || { state: "idle" };

    // Still analyzing
    if (job.analyzing) {
      return `<div class="gqi-jd-panel gqi-jd-analyzing">
        <span class="qa-spinner"></span>
        <span>Analyzing JD &amp; matching your skill bank…</span>
      </div>`;
    }

    // Not yet analyzed
    if (!job.jdData) {
      return job.url
        ? `<div class="gqi-jd-panel gqi-jd-pending">
            <span>JD not yet analyzed</span>
            <button type="button" class="btn btn-sm qa-analyze-btn" data-idx="${i}">🔍 Analyze JD</button>
           </div>`
        : "";
    }

    // Error
    if (job.jdData.error) {
      return `<div class="gqi-jd-panel gqi-jd-pending">
        <span style="color:var(--accent-secondary)">Analysis failed: ${esc(job.jdData.error)}</span>
        <button class="btn btn-sm qa-analyze-btn" data-idx="${i}">↺ Retry</button>
      </div>`;
    }

    const chunks    = job.jdData.matchedChunks || [];
    const summary   = job.jdData.jdSummary || null;
    const topChunks = chunks.slice(0, 6);
    const coverage  = topChunks.length;
    const avgRel    = coverage
      ? Math.round(topChunks.reduce((s, c) => s + Math.round((1 - (c.distance || 0)) * 100), 0) / coverage)
      : 0;

    // Strategy badge
    const strat = (coverage >= 6 || avgRel >= 55)
      ? { label: "STRONG FIT — apply immediately", cls: "gqi-strat-strong" }
      : (coverage >= 4 || avgRel >= 42)
      ? { label: "GOOD FIT — worth applying",      cls: "gqi-strat-good"   }
      : (coverage >= 2)
      ? { label: "PARTIAL FIT — assess gaps",      cls: "gqi-strat-partial" }
      : { label: "LOW MATCH — consider skipping",  cls: "gqi-strat-low"    };

    const doBullets  = (summary?.what_you_do_summary || []).slice(0, 4);
    const mustHave   = (summary?.must_have    || []).slice(0, 4);
    const niceToHave = (summary?.nice_to_have || []).slice(0, 3);
    const oneLiner   = summary?.snapshot?.one_liner || "";

    // Visual match bars
    const matchBarsHtml = topChunks.slice(0, 5).map(c => {
      const rel    = Math.round((1 - (c.distance || 0)) * 100);
      const color  = rel >= 65 ? "#059669" : rel >= 45 ? "#d97706" : "#9ca3af";
      const name   = c.metadata?.skill_name || c.id || "";
      const display = name.length > 36 ? name.slice(0, 34) + "\u2026" : name;
      return `<div class="gqi-match-row">
        <span class="gqi-match-id">${esc(c.id || "")}</span>
        <span class="gqi-match-name">${esc(display)}</span>
        <div class="gqi-bar-track"><div class="gqi-bar-fill" style="width:${rel}%;background:${color}"></div></div>
        <span class="gqi-match-pct" style="color:${color}">${rel}%</span>
      </div>`;
    }).join("");

    const doHtml = doBullets.length
      ? `<ul class="gqi-jd-bullets">${doBullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>`
      : `<span class="gqi-jd-empty">No role details extracted</span>`;

    const mustHtml = mustHave.length
      ? mustHave.map(b => `<span class="gqi-req-chip gqi-req-must">${esc(b)}</span>`).join("")
      : `<span class="gqi-jd-empty">—</span>`;

    const niceHtml = niceToHave.length
      ? niceToHave.map(b => `<span class="gqi-req-chip gqi-req-nice">${esc(b)}</span>`).join("")
      : "";

    // Auto-open when idle (user is deciding), collapse when generating/done
    const openAttr = (gen.state === "idle" || gen.state === "error") ? " open" : "";

    return `<details class="gqi-jd-details"${openAttr}>
      <summary class="gqi-jd-summary">
        <span class="gqi-strat-badge ${strat.cls}">${strat.label}</span>
        <span class="gqi-jd-sum-meta">${coverage} matches &middot; avg ${avgRel}%</span>
      </summary>
      <div class="gqi-jd-body">
        ${oneLiner ? `<p class="gqi-jd-oneliner">${esc(oneLiner)}</p>` : ""}
        <div class="gqi-jd-cols">
          <div class="gqi-jd-col">
            <div class="gqi-jd-col-hdr">&#x1F6E0; What you'll do</div>
            ${doHtml}
          </div>
          <div class="gqi-jd-col">
            <div class="gqi-jd-col-hdr">&#x2B50; Requirements</div>
            <div class="gqi-req-group">
              <span class="gqi-req-label gqi-req-label-must">Must</span>
              <div class="gqi-req-chips">${mustHtml}</div>
            </div>
            ${niceToHave.length ? `<div class="gqi-req-group" style="margin-top:6px">
              <span class="gqi-req-label gqi-req-label-nice">Nice</span>
              <div class="gqi-req-chips">${niceHtml}</div>
            </div>` : ""}
          </div>
        </div>
        ${matchBarsHtml ? `<div class="gqi-jd-matches">
          <div class="gqi-matches-hdr">
            <span class="gqi-matches-title">Skill bank coverage</span>
            <span class="gqi-matches-count">${coverage} of ${chunks.length} relevant</span>
          </div>
          <div class="gqi-match-rows">${matchBarsHtml}</div>
        </div>` : ""}
      </div>
    </details>`;
  }

  function renderQueue() {
    const listEl = $("gen-queue-list");
    const countEl = $("gen-queue-count");
    const genCount = Object.values(genState.generations).filter(g => g.state === "generating").length;
    if (countEl) {
      countEl.textContent = `${genState.queue.length} job${genState.queue.length !== 1 ? "s" : ""}` +
        (genCount ? ` · ${genCount} generating` : "");
    }
    if (!listEl) return;

    if (!genState.queue.length) {
      listEl.innerHTML = `<p class="auto-empty">Select jobs from the Search tab to generate documents.</p>`;
      return;
    }

    listEl.innerHTML = genState.queue.map((job, i) => buildQueueItemHtml(job, i)).join("");
    listEl.querySelectorAll("[data-gqi]").forEach((el) => {
      const i = parseInt(el.dataset.qi, 10);
      if (!isNaN(i)) bindQueueItemEvents(el, i);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GENERATION PIPELINE (parallel / non-blocking per-job)
  // ═══════════════════════════════════════════════════════════════
  async function startGeneration(queueIdx) {
    const job = genState.queue[queueIdx];
    if (!job) return;
    const key = getGenKey(job);

    // Prevent duplicate: if already generating this job, ignore
    if (genState.generations[key]?.state === "generating") return;

    // Init per-job generation state
    genState.generations[key] = {
      state: "generating",
      step: "jd",
      stepLabel: "Fetching job description…",
      progress: 5,
      thoughts: [],
      cvContent: "",
      clContent: "",
      cvJson: null,
      clJson: null,
      cvDecisions: null,
      clDecisions: null,
      error: null
    };
    updateJobUI(key);

    // Scoped helpers — safe for parallel runs (each closes over its own `key`)
    function setStep(step, label, progress) {
      const g = genState.generations[key];
      if (!g) return;
      g.step = step; g.stepLabel = label; g.progress = progress;
      updateJobUI(key);
    }
    function addThought(label, detail, done) {
      const g = genState.generations[key];
      if (!g) return;
      g.thoughts.push({ label, detail, done: !!done });
      g.stepLabel = label + " " + detail;
      updateJobUI(key);
    }
    function markLastThoughtDone() {
      const g = genState.generations[key];
      if (!g || !g.thoughts.length) return;
      g.thoughts[g.thoughts.length - 1].done = true;
      updateJobUI(key);
    }

    try {
      // ── Step 1: Fetch JD ──
      let jdText = "";
      let jdServerSections = null;
      addThought("Fetch JD:", `Loading for ${job.title} (${job.reqId || job.url || ""})`);

      // Queue analysis cache
      if (job.jdData && job.jdData.jdText && !job.jdData.error) {
        jdText = job.jdData.jdText;
        jdServerSections = job.jdData.jdSections || null;
        markLastThoughtDone();
        addThought("JD cached:", `${jdText.length.toLocaleString()} chars — reusing from queue analysis`, true);
      }

      // Firebase cache
      if (!jdText) {
        try {
          const userId = getUserId();
          if (userId && job.reqId && window.FirebaseAPI?.jd?.loadCachedJD) {
            const cached = await FirebaseAPI.jd.loadCachedJD(userId, job.reqId);
            if (cached && cached.fullText) {
              jdText = cached.fullText;
              addThought("Cache hit:", "Found cached JD in Firebase", true);
            }
          }
        } catch {}
      }

      // Server-side fetch
      if (!jdText && job.url) {
        setStep("jd", "Fetching JD from SAP careers page…", 10);
        addThought("Server fetch:", "No cache — fetching JD from SAP careers…");
        try {
          const res = await fetch("/fetch-jd", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: job.url })
          });
          const data = await res.json();
          if (data.success && data.jd) {
            jdText = data.jd.fullText || "";
            jdServerSections = data.jd.sections || null;
            markLastThoughtDone();
            addThought("JD extracted:", `${jdText.length.toLocaleString()} chars`, true);
            try {
              const userId = getUserId();
              if (userId && job.reqId && window.FirebaseAPI?.jd?.saveCachedJD) {
                await FirebaseAPI.jd.saveCachedJD(userId, {
                  id: job.reqId, title: data.jd.title,
                  location: data.jd.location, fullText: jdText, url: job.url
                });
              }
            } catch {}
          } else {
            throw new Error(data.error || "Failed to fetch JD");
          }
        } catch (fetchErr) {
          throw new Error("JD fetch failed: " + fetchErr.message);
        }
      }

      if (!jdText) throw new Error("No JD text available — check the job URL");

      // Cache JD text for regen
      genState.generations[key].jdText = jdText;

      // ── Step 2: Match Skills ──
      setStep("skills", "Matching skills from vector store…", 25);
      try {
        const healthRes = await fetch("/health");
        const health = await healthRes.json();
        addThought("Vector store:", `${health.skillChunks} chunks · Style: ${health.styleProfile || "loaded"} · AI: ${health.model || health.aiProvider}`, true);
      } catch {
        addThought("Vector store:", "Ready", true);
      }

      // ── Step 3a: Generate CV ──
      setStep("cv", "Generating CV via RAG pipeline…", 40);
      addThought("CV generation:", "Sending JD → vector retrieval + style profile → AI…");
      const cvRes = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jdText, documentType: "cv" })
      });
      const cvData = await cvRes.json();
      if (!cvData.success) throw new Error(cvData.error || "CV generation failed");
      genState.generations[key].cvContent   = cvData.content;
      genState.generations[key].cvJson      = cvData.contentJson || null;
      genState.generations[key].cvDecisions = cvData.decisions || null;
      markLastThoughtDone();
      addThought("CV complete:", `${cvData.content.length.toLocaleString()} chars · ${cvData.decisions?.provider || "AI"}`, true);

      // ── Step 3b: Generate CL ──
      setStep("cl", "Generating Cover Letter via RAG + Humanizer…", 70);
      addThought("CL generation:", "Sending JD → vector retrieval + style profile → AI → Humanizer…");
      const clRes = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jdText, documentType: "cl" })
      });
      const clData = await clRes.json();
      if (!clData.success) throw new Error(clData.error || "Cover letter generation failed");
      genState.generations[key].clContent   = clData.content;
      genState.generations[key].clJson      = clData.contentJson || null;
      genState.generations[key].clDecisions = clData.decisions || null;
      genState.generations[key].jdText      = jdText;
      markLastThoughtDone();
      addThought("CL complete:", `${clData.content.length.toLocaleString()} chars · ${clData.decisions?.provider || "AI"}${clData.humanized ? " · Humanized ✓" : ""}`, true);

      // ── Done ──
      genState.generations[key].state    = "done";
      genState.generations[key].step     = "done";
      genState.generations[key].progress = 100;
      updateJobUI(key);
      showToast(`Generated: ${job.title}`);

      try {
        const userId = getUserId();
        if (userId && window.FirebaseAPI?.library) {
          genState.approvedDocs  = await FirebaseAPI.library.loadApprovedGenerations(userId);
          genState.domainInsights = await FirebaseAPI.library.loadDomainInsights(userId);
        }
      } catch {}

    } catch (err) {
      const g = genState.generations[key];
      if (g) { g.state = "error"; g.error = err.message || "Generation failed"; g.stepLabel = "Error"; }
      updateJobUI(key);
      showToast("Generation failed: " + (err.message || ""), "error");
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PER-JOB ACTIONS (approve / draft / discard / export)
  // ═══════════════════════════════════════════════════════════════
  async function approveJob(reqId) {
    const i   = genState.queue.findIndex(j => getGenKey(j) === reqId);
    const job = i >= 0 ? genState.queue[i] : null;
    const gen = genState.generations[reqId];
    if (!job || !gen) return;
    try {
      const userId = getUserId();
      const safe   = safeId(reqId);
      const cvText = document.getElementById("gqi-cv-" + safe)?.value || gen.cvContent || "";
      const clText = document.getElementById("gqi-cl-" + safe)?.value || gen.clContent || "";
      if (userId && window.FirebaseAPI?.library) {
        await FirebaseAPI.library.saveApprovedGeneration(userId, {
          id: `gen_${job.reqId || Date.now()}`,
          jobTitle: job.title, reqId: job.reqId,
          cvText, clText, status: "applied", weight: 1.0
        });
      }
      delete genState.generations[reqId];
      genState.queue.splice(i, 1);
      if (window.JobHuntApp?.addTrackerApplication) {
        await window.JobHuntApp.addTrackerApplication({
          id: `gen_${job.reqId || Date.now()}`,
          company: (job.title || "").split(/\s*[-–(]/)[0]?.trim() || job.title,
          role: job.title, link: job.url || "", location: job.location || "",
          reqId: job.reqId || "", stage: "Applied", notes: "Auto-added from generation"
        });
      }
      renderQueue();
      showToast("Marked as Applied and saved to library");
    } catch (err) {
      showToast("Save failed: " + err.message, "error");
    }
  }

  async function saveDraftJob(reqId) {
    const i   = genState.queue.findIndex(j => getGenKey(j) === reqId);
    const job = i >= 0 ? genState.queue[i] : null;
    const gen = genState.generations[reqId];
    if (!job || !gen) return;
    try {
      const userId = getUserId();
      const safe   = safeId(reqId);
      const cvText = document.getElementById("gqi-cv-" + safe)?.value || gen.cvContent || "";
      const clText = document.getElementById("gqi-cl-" + safe)?.value || gen.clContent || "";
      if (userId && window.FirebaseAPI?.library) {
        await FirebaseAPI.library.saveApprovedGeneration(userId, {
          id: `wishlist_${job.reqId || Date.now()}`,
          jobTitle: job.title, reqId: job.reqId,
          cvText, clText, status: "wishlist", weight: 0.5
        });
      }
      if (window.JobHuntApp?.addTrackerApplication) {
        await window.JobHuntApp.addTrackerApplication({
          id: `wishlist_${job.reqId || Date.now()}`,
          company: (job.title || "").split(/\s*[-–(]/)[0]?.trim() || job.title,
          role: job.title, link: job.url || "", location: job.location || "",
          reqId: job.reqId || "", stage: "Wishlist", notes: "Saved to wishlist from generation"
        });
      }
      showToast("Saved to Wishlist");
    } catch (err) {
      showToast("Wishlist save failed: " + err.message, "error");
    }
  }

  function discardJob(reqId) {
    if (!confirm("Discard this generation?")) return;
    const i = genState.queue.findIndex(j => getGenKey(j) === reqId);
    delete genState.generations[reqId];
    if (i >= 0) genState.queue.splice(i, 1);
    renderQueue();
    showToast("Generation discarded");
  }

  function buildDachResultsHtml(issues) {
    if (!issues || !issues.length) return `<div class="gqi-dach-results gqi-dach-pass">&#x2705; DACH check passed — no issues found.</div>`;
    const sevIcon = { high: "\u{1F534}", medium: "\u{1F7E1}", low: "\u{1F7E2}" };
    const rows = issues.map(iss =>
      `<div class="gqi-dach-row">
        <span class="gqi-dach-sev">${sevIcon[iss.severity] || "\u{26AA}"}</span>
        <div><strong>${esc(iss.issue)}</strong>${iss.suggestion ? `<br><span class="gqi-dach-fix">${esc(iss.suggestion)}</span>` : ""}</div>
      </div>`
    ).join("");
    return `<div class="gqi-dach-results">
      <div class="gqi-dach-hdr">\u{1F1E9}\u{1F1EA} DACH Compliance</div>
      ${rows}
    </div>`;
  }

  async function regenDoc(reqId, type) {
    const gen = genState.generations[reqId];
    if (!gen || !gen.jdText) { showToast("No JD text cached — regenerate the full job", "error"); return; }
    const safe = safeId(reqId);
    const prefix = type === "cv" ? "gqi-cv-" : "gqi-cl-";
    const panel = document.getElementById(prefix + safe)?.closest(".gqi-result-panel");
    const btn = panel?.querySelector(`[data-regen-type="${type}"]`);

    // ── Show overlay on the panel ──
    let overlay = null;
    if (panel) {
      overlay = document.createElement("div");
      overlay.className = "regen-overlay";
      overlay.innerHTML = `<span class="regen-overlay-content"><span class="regen-spinner">&#8635;</span><span class="regen-pct">0%</span></span>`;
      panel.style.position = "relative";
      panel.appendChild(overlay);
    }
    if (btn) btn.disabled = true;

    const label = type === "cv" ? "CV" : "CL";
    let pct = 0;
    const pctEl = overlay?.querySelector(".regen-pct");

    // Simulate progress ticks while waiting for server
    const ticker = setInterval(() => {
      if (pct < 90) { pct += Math.random() * 12 + 3; pct = Math.min(pct, 90); }
      if (pctEl) pctEl.textContent = Math.round(pct) + "%";
    }, 600);

    try {
      const res = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: gen.jdText, documentType: type })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || `${label} regeneration failed`);

      // Update progress to 100%
      pct = 100;
      if (pctEl) pctEl.textContent = "100%";

      if (type === "cv") {
        gen.cvContent   = data.content;
        gen.cvJson      = data.contentJson || null;
        gen.cvDecisions = data.decisions || null;
      } else {
        gen.clContent   = data.content;
        gen.clJson      = data.contentJson || null;
        gen.clDecisions = data.decisions || null;
      }
      gen.dachIssues = null; // reset DACH results after regen

      // Update the textarea directly (faster than full re-render)
      const ta = document.getElementById(prefix + safe);
      if (ta) ta.value = data.content;

      showToast(`${label} regenerated${data.humanized ? " + humanized" : ""}`);
    } catch (err) {
      showToast(`${label} regen failed: ` + err.message, "error");
    } finally {
      clearInterval(ticker);
      if (overlay) { overlay.remove(); }
      if (btn) btn.disabled = false;
    }
  }

  async function dachCheck(reqId) {
    const gen  = genState.generations[reqId];
    if (!gen) return;
    const safe = safeId(reqId);
    const cvText = document.getElementById("gqi-cv-" + safe)?.value || gen.cvContent || "";
    const clText = document.getElementById("gqi-cl-" + safe)?.value || gen.clContent || "";
    const combined = `=== CV ===\n${cvText}\n\n=== COVER LETTER ===\n${clText}`;
    const btn = document.querySelector(`[data-gen-dach="${CSS.escape(reqId)}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = "\u231B Checking\u2026"; }
    try {
      const res = await fetch("/dach-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: combined })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "DACH check failed");
      gen.dachIssues = data.issues;
      updateJobUI(reqId);
      showToast(data.issues.length ? `DACH: ${data.issues.length} issue(s) found` : "DACH check passed \u2713");
    } catch (err) {
      showToast("DACH check failed: " + err.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = "\u{1F1E9}\u{1F1EA} DACH Check"; }
    }
  }

  async function exportPdfForJob(type, reqId) {
    const gen  = genState.generations[reqId];
    const i    = genState.queue.findIndex(j => getGenKey(j) === reqId);
    const job  = i >= 0 ? genState.queue[i] : null;
    if (!gen) { showToast("No generation found", "error"); return; }
    const safe = safeId(reqId);
    const content     = type === "cv"
      ? (document.getElementById("gqi-cv-" + safe)?.value || gen.cvContent)
      : (document.getElementById("gqi-cl-" + safe)?.value || gen.clContent);
    const contentJson = type === "cv" ? gen.cvJson : gen.clJson;
    if (!content && !contentJson) { showToast("No content to export", "error"); return; }
    const filename = `Varun_Raval_${type === "cv" ? "CV" : "CL"}_${(job?.reqId || "doc")}`;
    try {
      showToast(`Exporting ${type.toUpperCase()} PDF via LaTeX…`);
      const res = await fetch("/export-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, contentJson, type, filename })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "PDF export failed");
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `${filename}.pdf`; a.click();
      URL.revokeObjectURL(url);
      showToast(`${type.toUpperCase()} PDF downloaded`);
    } catch (err) {
      showToast("PDF export error: " + err.message, "error");
    }
  }



  // ═══════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════
  // ADD EXTERNAL JOB MANUALLY
  // ═══════════════════════════════════════════════════════════════
  function addJobManual() {
    const url = prompt("Paste SAP careers job URL:");
    if (!url || !url.trim()) return;
    const trimmed = url.trim();
    // Try to extract a req ID from the URL
    const reqMatch = trimmed.match(/(\d{5,7})/);
    const reqId = reqMatch ? reqMatch[1] : "manual_" + Date.now();
    addToQueue({
      title: "External Job — " + reqId,
      url: trimmed,
      requisitionId: reqId,
      location: "",
      matchScore: null,
      topMatchedSkills: []
    });
    showToast("Job added to queue — analyzing JD…");
  }

  // ═══════════════════════════════════════════════════════════════
  // SCRATCHPAD (auto-save, multi-tab notes)
  // ═══════════════════════════════════════════════════════════════
  const SCRATCH_KEY = "scratchpad_notes";
  function loadScratchNotes() {
    try { return JSON.parse(localStorage.getItem(SCRATCH_KEY)) || [{ name: "Note 1", text: "" }]; }
    catch { return [{ name: "Note 1", text: "" }]; }
  }
  function saveScratchNotes(notes) { localStorage.setItem(SCRATCH_KEY, JSON.stringify(notes)); }

  function initScratchpad() {
    let notes = loadScratchNotes();
    let activeIdx = 0;
    const fab = $("scratchpad-fab");
    const popup = $("scratchpad-popup");
    const tabsEl = $("scratchpad-tabs");
    const ta = $("scratchpad-textarea");
    const newBtn = $("scratchpad-new");
    const closeBtn = $("scratchpad-close");
    if (!fab || !popup || !ta) return;

    function renderTabs() {
      tabsEl.innerHTML = notes.map((n, i) =>
        `<button class="scratchpad-tab${i === activeIdx ? " active" : ""}" data-scratch-idx="${i}">
          ${esc(n.name)}${notes.length > 1 ? `<span class="scratchpad-tab-x" data-scratch-del="${i}">&times;</span>` : ""}
        </button>`
      ).join("");
      ta.value = notes[activeIdx]?.text || "";
    }
    function save() { if (notes[activeIdx]) notes[activeIdx].text = ta.value; saveScratchNotes(notes); }

    fab.addEventListener("click", () => { popup.classList.toggle("hidden"); renderTabs(); });
    closeBtn?.addEventListener("click", () => { save(); popup.classList.add("hidden"); });
    newBtn?.addEventListener("click", () => {
      const name = prompt("Note name:", "Note " + (notes.length + 1));
      if (!name) return;
      notes.push({ name: name.trim(), text: "" });
      activeIdx = notes.length - 1;
      saveScratchNotes(notes);
      renderTabs();
    });
    tabsEl?.addEventListener("click", (e) => {
      const del = e.target.closest("[data-scratch-del]");
      if (del) {
        const di = parseInt(del.dataset.scratchDel, 10);
        if (!confirm("Delete " + notes[di].name + "?")) return;
        notes.splice(di, 1);
        if (activeIdx >= notes.length) activeIdx = notes.length - 1;
        saveScratchNotes(notes); renderTabs(); return;
      }
      const tab = e.target.closest("[data-scratch-idx]");
      if (tab) { save(); activeIdx = parseInt(tab.dataset.scratchIdx, 10); renderTabs(); }
    });
    ta.addEventListener("input", save);
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════
  function getUserId() {
    if (genState.userId) return genState.userId;
    const user = window.FirebaseAPI?.auth?.getCurrentUser?.();
    if (user) { genState.userId = user.uid; return user.uid; }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // RAG STATUS
  // ═══════════════════════════════════════════════════════════════
  async function loadRagStatus() {
    const btn = $("rag-refresh-btn");
    if (btn) btn.textContent = "⟳ Loading…";
    try {
      const res = await fetch("/health");
      const data = await res.json();

      // Skill chunks
      const skillEl = $("rag-skill-count");
      const tileVector = $("rag-tile-vector");
      if (skillEl) skillEl.textContent = data.skillChunks != null ? data.skillChunks : "N/A";
      if (tileVector) tileVector.classList.toggle("rag-tile-ok", !!data.vectorStore);

      // Writing style
      const styleEl = $("rag-style-status");
      const tileStyle = $("rag-tile-style");
      if (styleEl) styleEl.textContent = data.styleProfile ? "Loaded" : "Missing";
      if (tileStyle) tileStyle.classList.toggle("rag-tile-ok", !!data.styleProfile);

      // Vector store status
      const docEl = $("rag-doc-count");
      const tileDocs = $("rag-tile-docs");
      if (docEl) docEl.textContent = data.vectorStore ? "Ready ✓" : "Offline";
      if (tileDocs) tileDocs.classList.toggle("rag-tile-ok", !!data.vectorStore);

      // AI provider + model
      const aiEl = $("rag-ai-provider");
      if (aiEl) aiEl.textContent = data.aiProvider ? `${data.aiProvider}` : "None";

    } catch {
      const skillEl = $("rag-skill-count");
      if (skillEl) skillEl.textContent = "Offline";
    }
    if (btn) btn.textContent = "⟳ Refresh";
  }

  // ═══════════════════════════════════════════════════════════════
  // BIND EVENTS
  // ═══════════════════════════════════════════════════════════════
  function bindEvents() {
    $("index-library-btn")?.addEventListener("click", indexLibrary);
    $("rag-refresh-btn")?.addEventListener("click", loadRagStatus);

    // Per-job action delegation — buttons live inside dynamically rendered queue items
    document.addEventListener("click", (e) => {
      const approveBtn = e.target.closest("[data-gen-approve]");
      if (approveBtn) { approveJob(approveBtn.dataset.genApprove); return; }
      const draftBtn = e.target.closest("[data-gen-save-draft]");
      if (draftBtn) { saveDraftJob(draftBtn.dataset.genSaveDraft); return; }
      const discardBtn = e.target.closest("[data-gen-discard]");
      if (discardBtn) { discardJob(discardBtn.dataset.genDiscard); return; }
      const cvBtn = e.target.closest("[data-gen-export-cv]");
      if (cvBtn) { exportPdfForJob("cv", cvBtn.dataset.genExportCv); return; }
      const clBtn = e.target.closest("[data-gen-export-cl]");
      if (clBtn) { exportPdfForJob("cl", clBtn.dataset.genExportCl); return; }
      const regenBtn = e.target.closest("[data-gen-regen]");
      if (regenBtn) { regenDoc(regenBtn.dataset.genRegen, regenBtn.dataset.regenType); return; }
      const dachBtn = e.target.closest("[data-gen-dach]");
      if (dachBtn) { dachCheck(dachBtn.dataset.genDach); return; }
    });

    // JD panel tabs (legacy workspace still in DOM, kept for potential use)
    document.querySelectorAll(".gen-jd-tab").forEach(tab => {
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll(".gen-jd-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".gen-jd-tab-content").forEach(c => c.classList.remove("active"));
        tab.classList.add("active");
        const tabMap = { expert: "gen-jd-expert-content", highlights: "gen-jd-highlights-content", full: "gen-jd-full-content" };
        $(tabMap[tab.dataset.tab] || "gen-jd-expert-content")?.classList.add("active");
      });
    });
    $("gen-jd-panel-toggle")?.addEventListener("click", () => {
      const body = $("gen-jd-panel-body");
      const arrow = $("gen-jd-panel-arrow");
      if (!body) return;
      const nowCollapsed = body.classList.toggle("collapsed");
      if (arrow) arrow.classList.toggle("open", !nowCollapsed);
    });

    // Font size controls (works for both inline gqi-result-textarea and workspace textareas)
    document.addEventListener("click", (e) => {
      const target = e.target.closest(".gen-font-plus, .gen-font-minus");
      if (!target) return;
      const textarea = $(target.dataset.target);
      if (!textarea) return;
      const current = parseFloat(getComputedStyle(textarea).fontSize);
      const delta = target.classList.contains("gen-font-plus") ? 2 : -2;
      textarea.style.fontSize = Math.max(10, Math.min(24, current + delta)) + "px";
    });

    // Inline copy buttons
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".gen-copy-btn");
      if (!btn) return;
      const textarea = $(btn.dataset.target);
      if (!textarea) return;
      navigator.clipboard.writeText(textarea.value).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = "&#x2713; Copied";
        btn.disabled = true;
        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1800);
      });
    });

    // Fullview modal
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".gen-fullview");
      if (!btn) return;
      const textarea = $(btn.dataset.target);
      if (!textarea) return;
      const modal = $("gen-fullview-modal");
      const modalTa = $("gen-fullview-textarea");
      const title = $("gen-fullview-title");
      if (!modal || !modalTa) return;
      modalTa.value = textarea.value;
      modalTa._sourceId = btn.dataset.target;
      if (title) title.textContent = "Edit " + (btn.dataset.label || "Document");
      modal.classList.remove("hidden");
    });
    $("gen-fullview-close")?.addEventListener("click", () => {
      const modal = $("gen-fullview-modal");
      const modalTa = $("gen-fullview-textarea");
      if (!modal || !modalTa) return;
      if (modalTa._sourceId) { const src = $(modalTa._sourceId); if (src) src.value = modalTa.value; }
      modal.classList.add("hidden");
    });
    $("gen-fullview-copy")?.addEventListener("click", (e) => {
      const modalTa = $("gen-fullview-textarea");
      if (!modalTa) return;
      navigator.clipboard.writeText(modalTa.value).then(() => {
        const btn = e.currentTarget;
        const orig = btn.innerHTML;
        btn.innerHTML = "&#x2713; Copied";
        btn.disabled = true;
        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1800);
      });
    });

    // Fullview font size
    $("gen-fullview-font-plus")?.addEventListener("click", () => {
      const ta = $("gen-fullview-textarea"); if (!ta) return;
      const cur = parseFloat(getComputedStyle(ta).fontSize);
      ta.style.fontSize = Math.min(28, cur + 2) + "px";
    });
    $("gen-fullview-font-minus")?.addEventListener("click", () => {
      const ta = $("gen-fullview-textarea"); if (!ta) return;
      const cur = parseFloat(getComputedStyle(ta).fontSize);
      ta.style.fontSize = Math.max(10, cur - 2) + "px";
    });

    // Add external job
    $("gen-add-job-btn")?.addEventListener("click", addJobManual);

    // Scratchpad
    initScratchpad();

    // Library toggle
    $("lib-toggle-btn")?.addEventListener("click", () => {
      const el = $("library-status");
      const btn = $("lib-toggle-btn");
      if (!el) return;
      genState.libExpanded = !genState.libExpanded;
      if (genState.libExpanded) {
        el.classList.remove("lib-collapsed");
        el.classList.add("lib-expanded");
        btn?.classList.add("open");
      } else {
        el.classList.remove("lib-expanded");
        el.classList.add("lib-collapsed");
        btn?.classList.remove("open");
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════
  function init() {
    bindEvents();
    renderQueue();
    loadRagStatus();

  }

  window.GenerateModule = { addToQueue, init };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
