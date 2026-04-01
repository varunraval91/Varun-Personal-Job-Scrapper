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
    libExpanded: false,
    selectors: {},      // reqId → { we, projects, certifications, aiPickWE, aiPickProjects, aiPickCerts, pinnedWE, pinnedProjects, pinnedCerts, loading }
    bankToolIndex: null  // cached map: tool-name-lower → true (for tool chip matching)
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
      if (/^\s*(We |At [A-Z]\w+[,. ]|We help|We're |We win|We keep|Join us|Be part)/i.test(t)) return true;
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
    const titleMatchBadge = job.titleMatch ? `<span class="match-badge-title-hit" title="Keyword found in job title">🎯 title match</span>` : "";
    const skillTags  = (job.topMatchedSkills || []).slice(0, 4).map(s => `<span class="queue-skill-tag">${esc(s)}</span>`).join("");
    const analysisHtml = buildJDIntelPanel(job, i);

    // Top-right action area
    let topAction = "";
    const sel = genState.selectors[key];
    const hasPins = sel && (sel.pinnedWE?.length || sel.pinnedProjects?.length || sel.pinnedCerts?.length);
    const customBtnCls = hasPins ? "btn btn-sm gqi-custom-btn gqi-custom-active" : "btn btn-sm gqi-custom-btn";
    const customBtnTip = hasPins ? `${(sel.pinnedWE||[]).length} WE + ${(sel.pinnedProjects||[]).length} projects + ${(sel.pinnedCerts||[]).length} certs selected` : "Customize CV selection";
    const customBtn = `<button type="button" class="${customBtnCls}" data-gen-selector="${esc(key)}" title="${customBtnTip}">⚙ CV</button>`;
    if (gen.state === "idle") {
      topAction = `${customBtn}<button type="button" class="btn btn-primary btn-sm gen-start-btn" data-idx="${i}">Generate</button>`;
    } else if (gen.state === "generating") {
      topAction = `<span class="gqi-status-chip gqi-status-generating"><span class="gqi-inline-spin"></span>Generating…</span>`;
    } else if (gen.state === "done") {
      topAction = `${customBtn}<span class="gqi-status-chip gqi-status-done">✓ Ready</span>
        <button type="button" class="btn btn-sm gen-start-btn" data-idx="${i}" title="Re-generate">↺</button>`;
    } else if (gen.state === "applied") {
      topAction = `<span class="gqi-status-chip gqi-status-done" style="background:rgba(5,150,105,.12);color:#059669;border-color:rgba(5,150,105,.3)">✓ Applied</span>
        <button type="button" class="btn btn-sm gen-start-btn" data-idx="${i}" title="Re-generate">↺</button>`;
    } else if (gen.state === "wishlisted") {
      topAction = `<span class="gqi-status-chip gqi-status-done" style="background:rgba(217,119,6,.1);color:#d97706;border-color:rgba(217,119,6,.25)">★ Wishlisted</span>
        <button type="button" class="btn btn-sm gen-start-btn" data-idx="${i}" title="Re-generate">↺</button>`;
    } else if (gen.state === "error") {
      topAction = `${customBtn}<button type="button" class="btn btn-sm gen-start-btn" data-idx="${i}" style="color:var(--accent-secondary)">↺ Retry</button>`;
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
        ${thoughtsHtml ? `<details class="gqi-log-details" open><summary>AI log</summary><div class="gen-thinking-body gqi-log-body">${thoughtsHtml}</div></details>` : ""}
      </div>`;
    }

    // ── Inline results section (when done, applied, wishlisted or error) ──
    let resultsHtml = "";
    if (gen.state === "done" || gen.state === "applied" || gen.state === "wishlisted") {
      resultsHtml = `<div class="gqi-results">
        <div class="gqi-results-header">
          <span class="gqi-results-title">Generated for: <strong>${job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="gqi-title-link">${esc(job.title)}</a>` : esc(job.title)}</strong></span>
        </div>
        <div class="gqi-results-panels">
          <div class="gqi-result-panel">
            <div class="gqi-panel-toolbar">
              <span class="gqi-panel-doc-label">CV</span>
              <div class="gen-panel-controls">
                <button type="button" class="btn btn-sm gqi-regen-btn" data-gen-regen="${esc(key)}" data-regen-type="cv" title="Regenerate CV">&#8635;</button>
                <button type="button" class="btn btn-sm gen-font-minus" data-target="gqi-cv-${safe}" title="A-">A-</button>
                <button type="button" class="btn btn-sm gen-font-plus"  data-target="gqi-cv-${safe}" title="A+">A+</button>
                <button type="button" class="btn btn-sm gen-copy-btn"   data-target="gqi-cv-${safe}" title="Copy to clipboard">&#x2398;</button>
                <button type="button" class="btn btn-sm gen-fullview"   data-target="gqi-cv-${safe}" data-label="CV">&#x26F6;</button>
                <button type="button" class="btn btn-sm gen-clear-write" data-target="gqi-cv-${safe}" title="Clear &amp; write your own">&#x270E;</button>
              </div>
            </div>
            <textarea class="gqi-result-textarea" id="gqi-cv-${safe}" rows="20">${esc(gen.cvContent || "")}</textarea>
          </div>
          <div class="gqi-result-panel">
            <div class="gqi-panel-toolbar">
              <span class="gqi-panel-doc-label">Cover Letter</span>
              <div class="gen-panel-controls">
                <button type="button" class="btn btn-sm gqi-regen-btn" data-gen-regen="${esc(key)}" data-regen-type="cl" title="Regenerate CL">&#8635;</button>
                <button type="button" class="btn btn-sm gen-font-minus" data-target="gqi-cl-${safe}" title="A-">A-</button>
                <button type="button" class="btn btn-sm gen-font-plus"  data-target="gqi-cl-${safe}" title="A+">A+</button>
                <button type="button" class="btn btn-sm gen-copy-btn"   data-target="gqi-cl-${safe}" title="Copy to clipboard">&#x2398;</button>
                <button type="button" class="btn btn-sm gen-fullview"   data-target="gqi-cl-${safe}" data-label="Cover Letter">&#x26F6;</button>
                <button type="button" class="btn btn-sm gen-clear-write" data-target="gqi-cl-${safe}" title="Clear &amp; write your own">&#x270E;</button>
                <button type="button" class="btn btn-sm gen-cl-bold" data-target="gqi-cl-${safe}" title="Bold selected word (**word**)"><strong>B</strong></button>
              </div>
            </div>
            <textarea class="gqi-result-textarea" id="gqi-cl-${safe}" rows="20">${esc(gen.clContent || "")}</textarea>
          </div>
        </div>
        <div class="gqi-result-actions">
          ${gen.state === "applied"
            ? `<span class="gqi-status-chip" style="background:rgba(5,150,105,.1);color:#059669;border:1px solid rgba(5,150,105,.3)">&#10003; Applied</span>`
            : `<button class="btn btn-outline-success btn-sm" data-gen-approve="${esc(key)}">&#10003; Mark Applied</button>`}
          ${gen.state === "wishlisted"
            ? `<span class="gqi-status-chip" style="background:rgba(245,158,11,.1);color:#d97706;border:1px solid rgba(245,158,11,.3)">&#9733; Wishlisted</span>`
            : `<button class="btn btn-outline btn-sm" data-gen-save-draft="${esc(key)}">&#9733; Wishlist</button>`}
          <button class="btn btn-primary btn-sm" data-gen-export-cv="${esc(key)}">&#x2B73; Export CV</button>
          <button class="btn btn-primary btn-sm" data-gen-export-cl="${esc(key)}">&#x2B73; Export CL</button>
          <button class="btn btn-sm gqi-dach-btn" data-gen-dach="${esc(key)}">&#x1F1E9;&#x1F1EA; DACH Check</button>
        </div>
        ${gen.dachIssues ? buildDachResultsHtml(gen.dachIssues, key) : ""}
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
          <span class="gqi-task-num">Task #${i + 1}</span>
          <span class="gen-queue-title">${job.url ? `<a href="${esc(job.url)}" target="_blank" rel="noopener" class="gqi-title-link">${esc(job.title)}</a>` : esc(job.title)} ${scoreBadge}${titleMatchBadge}</span>
          <span class="gen-queue-meta">${esc(job.location)} &middot; ${esc(job.reqId)}</span>
          ${skillTags ? `<div class="gen-queue-skills">${skillTags}</div>` : ""}
        </div>
        <div class="gen-queue-actions">
          ${topAction}
          <button type="button" class="btn btn-sm gqi-remove-btn" data-remove="${i}" style="color:var(--accent-secondary)">&#10005;</button>
        </div>
      </div>
      ${analysisHtml}
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
        if (job) {
          const k = getGenKey(job);
          // Prevent removing while generating — user must wait or refresh
          if (genState.generations[k]?.state === "generating") {
            showToast("Cannot remove while generating — wait for completion", "error");
            return;
          }
          delete genState.generations[k];
          delete genState.selectors[k];
        }
        genState.queue.splice(idx, 1);
        renderQueue();
      });
    });
    el.querySelectorAll(".qa-analyze-btn").forEach(btn => {
      btn.addEventListener("click", () => analyzeQueueItem(parseInt(btn.dataset.idx, 10)));
    });
    el.querySelectorAll("[data-gen-selector]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.genSelector;
        const job = genState.queue.find(j => getGenKey(j) === key);
        if (!job) return;
        let jdText = (job.jdData && job.jdData.jdText) || job.jobDescription || job.fullText || "";

        // If JD not yet fetched, pull it now before opening selector
        if (!jdText && job.url) {
          btn.textContent = "Loading JD…";
          btn.disabled = true;
          try {
            const res  = await fetch("/fetch-jd", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: job.url })
            });
            const data = await res.json();
            if (data.success && data.jd?.fullText) {
              jdText = data.jd.fullText;
              if (!job.jdData) job.jdData = {};
              job.jdData.jdText = jdText;
            }
          } catch (_) {}
          btn.textContent = "CV Selector";
          btn.disabled = false;
        }

        if (!jdText) {
          showToast("Open the job URL or click Analyze first to load the job description.");
          return;
        }
        openCvSelector(key, jdText, el);
      });
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
      titleMatch: job.titleMatch || false,
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

      // Ask backend to build a compact UX summary — always send full JD text so the AI
      // has context for both "what you'll do" and "what you bring" sections.
      let jdSummary = null;
      try {
        const sumRes = await fetch("/jd-summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jdText: jdText,
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
      // Persist analysis so kanban detail popup can show it without re-running
      try {
        const ck = 'analysis_' + (job.reqId ? job.reqId : encodeURIComponent(job.url));
        localStorage.setItem(ck, JSON.stringify({ jdSummary, matchedChunks }));
      } catch (_) {}
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

    // Visual match bars — gradient fills, SK badge
    const matchBarsHtml = topChunks.slice(0, 5).map(c => {
      const rel    = Math.round((1 - (c.distance || 0)) * 100);
      const barCls = rel >= 65 ? "gqi-bar-high" : rel >= 45 ? "gqi-bar-mid" : "gqi-bar-low";
      const pctCls = rel >= 65 ? "gqi-pct-high" : rel >= 45 ? "gqi-pct-mid"  : "gqi-pct-low";
      const name   = c.metadata?.skill_name || c.id || "";
      return `<div class="gqi-match-row">
        <div class="gqi-match-id"><span class="gqi-sk-id">${esc(c.id || "")}</span></div>
        <div class="gqi-match-name">${esc(name)}</div>
        <div class="gqi-match-bar-wrap"><div class="gqi-bar-track"><div class="gqi-bar-fill ${barCls}" style="width:${rel}%"></div></div></div>
        <div class="gqi-match-pct ${pctCls}">${rel}%</div>
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

    // AI-extracted skills & tools (from jd-summary response)
    const aiSkills = (summary?.skills || []).slice(0, 7);
    const aiTools  = (summary?.tools  || []).slice(0, 8);
    const matchedSkillNames = chunks.map(c => (c.metadata?.skill_name || "").toLowerCase());
    const toolIndex = genState.bankToolIndex || {};

    const skillsHtml = aiSkills.map(s =>
      `<span class="gqi-chip gqi-chip-skill">${esc(s)}</span>`
    ).join("");

    const toolsHtml = aiTools.map(t => {
      const isOptional = t.endsWith("+");
      const name = isOptional ? t.slice(0, -1) : t;
      const tl = name.toLowerCase();
      const inBank = matchedSkillNames.some(n => n.includes(tl) || tl.includes(n)) || !!toolIndex[tl];
      const cls = inBank ? "gqi-chip gqi-chip-tool-match" : "gqi-chip gqi-chip-tool-gap";
      const tip = inBank ? "✓ In your skill bank" : "⚠ Not in skill bank — click to tag";
      return `<span class="${cls}${isOptional ? " gqi-chip-optional" : ""}" title="${tip}">${esc(name)}${isOptional ? `<sup class="gqi-opt-mark">opt</sup>` : ""}</span>`;
    }).join("");

    // Req rows wrapped in table layout
    const reqRowNice   = niceToHave.length  ? `<div class="gqi-req-group"><div class="gqi-req-cell-label"><span class="gqi-req-label gqi-req-label-nice">Nice</span></div><div class="gqi-req-chips"><div class="gqi-req-chips-wrap">${niceHtml}</div></div></div>` : "";
    const reqRowSkills = aiSkills.length    ? `<div class="gqi-req-group"><div class="gqi-req-cell-label"><span class="gqi-req-label gqi-req-label-skills">Skills</span></div><div class="gqi-req-chips"><div class="gqi-req-chips-wrap">${skillsHtml}</div></div></div>` : "";
    const reqRowTools  = aiTools.length     ? `<div class="gqi-req-group"><div class="gqi-req-cell-label"><span class="gqi-req-label gqi-req-label-tools">Tools</span></div><div class="gqi-req-chips"><div class="gqi-req-chips-wrap">${toolsHtml}</div></div></div>` : "";

    // Auto-open when idle (user is deciding), collapse when generating/done
    const openAttr = (gen.state === "idle" || gen.state === "error") ? " open" : "";
    // Modifier for tinted fit-banner summary background
    const stratMod = strat.cls.replace("gqi-strat-", "");  // strong/good/partial/low

    return `<details class="gqi-jd-details gqi-strat-${stratMod}"${openAttr}>
      <summary class="gqi-jd-summary">
        <span class="gqi-strat-badge ${strat.cls}">\u2713 ${strat.label}</span>
        <span class="gqi-jd-sum-meta"><span style="color:#4f46e5;font-weight:700">${coverage} matches</span> &middot; avg ${avgRel >= 65 ? `<span style="color:#059669;font-weight:700">${avgRel}%</span>` : avgRel >= 45 ? `<span style="color:#d97706;font-weight:700">${avgRel}%</span>` : `<span style="color:#e11d48;font-weight:700">${avgRel}%</span>`}</span>
      </summary>
      <div class="gqi-jd-body">
        ${oneLiner ? `<p class="gqi-jd-oneliner">${esc(oneLiner)}</p>` : ""}
        <div class="gqi-jd-cols">
          <div class="gqi-jd-col">
            <div class="gqi-jd-col-hdr gqi-jd-col-hdr-do"><span class="gqi-jd-col-hdr-icon">&#x1F527;</span>What you'll do</div>
            ${doHtml}
          </div>
          <div class="gqi-jd-col">
            <div class="gqi-jd-col-hdr gqi-jd-col-hdr-req"><span class="gqi-jd-col-hdr-icon">&#x2B50;</span>Requirements</div>
            <div class="gqi-req-table">
              <div class="gqi-req-group"><div class="gqi-req-cell-label"><span class="gqi-req-label gqi-req-label-must">Must</span></div><div class="gqi-req-chips"><div class="gqi-req-chips-wrap">${mustHtml}</div></div></div>
              ${reqRowNice}
              ${reqRowSkills}
              ${reqRowTools}
            </div>
          </div>
        </div>
        ${matchBarsHtml ? `<div class="gqi-jd-matches">
          <div class="gqi-matches-hdr">
            <span class="gqi-matches-title"><span style="width:20px;height:20px;border-radius:6px;background:rgba(124,58,237,.1);display:inline-flex;align-items:center;justify-content:center;font-size:12px">&#x1F9E0;</span> Skill Bank Coverage</span>
            <span class="gqi-matches-count">${coverage} of ${chunks.length} relevant</span>
          </div>
          <div class="gqi-match-rows">${matchBarsHtml}</div>
        </div>` : ""}
        <div class="gqi-jd-legend">
          <strong>Key:</strong>
          <span class="gqi-jd-leg-chip" style="background:rgba(220,38,38,.08);color:#dc2626;border-color:rgba(220,38,38,.22);">Must</span>
          <span class="gqi-jd-leg-chip" style="background:rgba(245,158,11,.08);color:#b45309;border-color:rgba(245,158,11,.25);">Nice</span>
          <span class="gqi-jd-leg-chip" style="background:rgba(79,70,229,.08);color:#4f46e5;border-color:rgba(79,70,229,.2);">Skill</span>
          <span class="gqi-jd-leg-chip" style="background:rgba(13,148,136,.08);color:#0d9488;border-color:rgba(13,148,136,.22);">Tool &#x2713;</span>
          <span class="gqi-jd-leg-chip" style="background:rgba(156,163,175,.07);color:#9ca3af;border-color:rgba(156,163,175,.18);text-decoration:line-through;">Tool gap</span>
          <span style="margin-left:6px;color:#ccc">&verbar;</span>
          <span>Bars:</span>
          <span style="color:#e11d48;font-weight:800">&bull;</span>&lt;40%
          <span style="color:#d97706;font-weight:800">&bull;</span>40&ndash;60%
          <span style="color:#059669;font-weight:800">&bull;</span>&gt;60%
        </div>
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
  // CV SELECTOR DRAWER
  // ═══════════════════════════════════════════════════════════════
  async function openCvSelector(key, jdText, itemEl) {
    const prevSel = genState.selectors[key] || null;

    // Show loading state
    genState.selectors[key] = { ...(prevSel || {}), loading: true };
    updateJobUI(key);

    try {
      const res = await fetch("/cv-selector-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jdText })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Selector load failed");

      const we           = data.work_experience || [];
      const projects     = data.projects || [];
      const certifications = data.certifications || [];
      const research     = data.research || [];
      const weIds        = new Set(we.map(w => w.id || w.work_id));
      const projectIds   = new Set(projects.map(p => p.id || p.project_id));
      const certIds = new Set(certifications.map(c => c.id));
      const researchIds = new Set(research.map(r => r.id));

      // Preserve previous manual selections when still valid; otherwise use fresh AI picks
      const preservedWE = (prevSel?.pinnedWE || []).filter(id => weIds.has(id));
      const preservedProjects = (prevSel?.pinnedProjects || []).filter(id => projectIds.has(id));
      const preservedResearch = (prevSel?.pinnedResearch || []).filter(id => researchIds.has(id));
      const aiPickCerts = (data.aiPickCerts || []).filter(id => certIds.has(id));
      const certDefaults = aiPickCerts.length ? aiPickCerts : certifications.map(c => c.id);

      genState.selectors[key] = {
        loading: false,
        we,
        projects,
        certifications,
        research,
        aiPickWE: data.aiPickWE || [],
        aiPickProjects: data.aiPickProjects || [],
        aiPickCerts: certDefaults,
        pinnedWE: preservedWE.length ? preservedWE : [...(data.aiPickWE || [])],
        pinnedProjects: preservedProjects.length ? preservedProjects : [...(data.aiPickProjects || [])],
        pinnedCerts: [],
        pinnedResearch: preservedResearch.length ? preservedResearch : research.map(r => r.id)
      };
    } catch (err) {
      genState.selectors[key] = null;
      updateJobUI(key);
      showToast("CV selector: " + err.message, "error");
      return;
    }

    updateJobUI(key);
    // After updateJobUI the old itemEl reference may be stale — find fresh one
    const freshEl = document.querySelector(`[data-gqi="${CSS.escape(key)}"]`);
    renderSelectorDrawer(key, genState.selectors[key], freshEl || itemEl);
  }

  function renderSelectorDrawer(key, sel, itemEl) {
    document.querySelectorAll(".gqi-selector-modal").forEach(m => m.remove());

    // ── Section config ───────────────────────────────────────────
    const SECTIONS = {
      we: {
        label: "Work Experience", emoji: "💼", accent: "#6c63ff",
        getItems: () => sel.we,
        getPinned: () => genState.selectors[key].pinnedWE || [],
        setPinned: v => { genState.selectors[key].pinnedWE = v; },
        getAiPick: () => genState.selectors[key].aiPickWE || [],
        getTitle: e => e.title  || e.job_title  || "",
        getSub:   e => `${e.company || ""}${e.period ? " · " + e.period : ""}`,
        getDesc: null,
        getTags: null
      },
      projects: {
        label: "Projects", emoji: "📁", accent: "#10b981",
        getItems: () => sel.projects,
        getPinned: () => genState.selectors[key].pinnedProjects || [],
        setPinned: v => { genState.selectors[key].pinnedProjects = v; },
        getAiPick: () => genState.selectors[key].aiPickProjects || [],
        getTitle: e => e.name  || e.project_name || "",
        getSub:   e => e.tech  || "",
        getDesc:  e => e.description || "",
        getTags:  e => (e.tech || "").split(/[,;]/).map(t => t.trim()).filter(Boolean)
      },
      certs: {
        label: "Certifications", emoji: "📜", accent: "#7e839e",
        getItems: () => sel.certifications || [],
        getPinned: () => genState.selectors[key].pinnedCerts || [],
        setPinned: v => { genState.selectors[key].pinnedCerts = v; },
        getAiPick: () => [],
        getTitle: e => e.name || "",
        getSub: e => `${e.provider || ""}${e.date ? " · " + e.date : ""}`,
        getDesc: null,
        getTags: null
      },
      research: {
        label: "Research", emoji: "🔬", accent: "#4fc3f7",
        getItems: () => sel.research || [],
        getPinned: () => genState.selectors[key].pinnedResearch || [],
        setPinned: v => { genState.selectors[key].pinnedResearch = v; },
        getAiPick: () => [],
        getTitle: e => e.title || "",
        getSub: e => e.kind === "paper"
          ? `${e.institution || ""}${e.date ? " · " + e.date : ""}`
          : `${e.context || ""}${e.period ? " · " + e.period : ""}`,
        getDesc: e => e.description || "",
        getTags: null
      }
    };

    // ── UI state ─────────────────────────────────────────────────
    let activeTab = "we";
    let searchQuery = "";
    let filterMode = "all";
    let projectFilter = "all"; // "all" | "sap_technical" | "sap_media" | "creative_media"

    // ── Build modal skeleton ─────────────────────────────────────
    const modal = document.createElement("div");
    modal.className = "gqi-selector-modal";
    modal.setAttribute("data-sel-key", key);
    modal.innerHTML = `
      <div class="gqi-sel-backdrop"></div>
      <div class="gqi-selector-drawer" role="dialog" aria-modal="true" aria-labelledby="gqi-sel-dlg-title">
        <div class="gqi-sel-hdr">
          <span class="gqi-sel-hdr-title" id="gqi-sel-dlg-title">⚙ CV Selector</span>
          <span class="gqi-sel-ai-legend"><span class="gqi-sel-ai-pill">✦ AI</span> Recommended</span>
          <div class="gqi-sel-hdr-actions">
            <button type="button" class="gqi-sel-reset-btn" aria-label="Reset to AI picks">↺ Reset</button>
            <button type="button" class="gqi-sel-close-btn" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="gqi-sel-tabs" role="tablist" aria-label="CV sections">
          ${Object.entries(SECTIONS).map(([t, s]) =>
            `<button class="gqi-sel-tab${t === "we" ? " gqi-tab-active" : ""}" data-tab="${t}" role="tab" aria-selected="${t === "we"}" style="--tab-accent:${s.accent}">
              ${s.emoji} ${s.label} <span class="gqi-sel-tab-badge" data-tab-badge="${t}">0</span>
            </button>`
          ).join("")}
        </div>
        <div class="gqi-proj-subfilter" role="tablist" aria-label="Project category filter" style="display:none">
          <button class="gqi-pf-btn gqi-pf-active" data-pf="all">📁 All Projects <span class="gqi-pf-count" data-pf-count="all">0</span></button>
          <button class="gqi-pf-btn" data-pf="sap_technical">⚙️ SAP & Technical <span class="gqi-pf-count" data-pf-count="sap_technical">0</span></button>
          <button class="gqi-pf-btn" data-pf="sap_media">🎬 SAP Media <span class="gqi-pf-count" data-pf-count="sap_media">0</span></button>
          <button class="gqi-pf-btn" data-pf="creative_media">🎨 Creative Media <span class="gqi-pf-count" data-pf-count="creative_media">0</span></button>
        </div>
        <div class="gqi-sel-search-row">
          <div class="gqi-sel-search-wrap">
            <span class="gqi-sel-search-icon">⌕</span>
            <input type="text" class="gqi-sel-search-input" placeholder="Search Work Experience..." aria-label="Search items">
            <button type="button" class="gqi-sel-search-clear" aria-label="Clear search" style="display:none">✕</button>
          </div>
          <select class="gqi-sel-filter-select" aria-label="Filter items">
            <option value="all">All Items</option>
            <option value="ai">✦ AI Recommended</option>
            <option value="selected">Selected</option>
            <option value="unselected">Not Selected</option>
          </select>
        </div>
        <div class="gqi-sel-chips-row" aria-label="Selected items">
          <span class="gqi-sel-chips-label">Selected:</span>
          <div class="gqi-sel-chips-list"><span class="gqi-chips-empty">Nothing selected yet</span></div>
        </div>
        <div class="gqi-sel-list-panel" role="tabpanel" aria-live="polite"></div>
        <div class="gqi-sel-footer">
          <div class="gqi-sel-footer-counts">
            ${Object.entries(SECTIONS).map(([t, s]) =>
              `<span class="gqi-sel-footer-chip gqi-footer-chip-zero" data-footer-chip="${t}" style="--chip-accent:${s.accent}">${s.emoji} ${s.label}: <strong data-footer-num="${t}">0</strong></span>`
            ).join("")}
          </div>
          <button type="button" class="gqi-sel-confirm-btn" aria-label="Confirm CV selection" disabled>Confirm Selection</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    const drawer    = modal.querySelector(".gqi-selector-drawer");
    const backdrop  = modal.querySelector(".gqi-sel-backdrop");
    const searchIn  = drawer.querySelector(".gqi-sel-search-input");
    const searchClr = drawer.querySelector(".gqi-sel-search-clear");
    const filterSel = drawer.querySelector(".gqi-sel-filter-select");
    const chipsRow       = drawer.querySelector(".gqi-sel-chips-row");
    const chipsList      = drawer.querySelector(".gqi-sel-chips-list");
    const listPanel      = drawer.querySelector(".gqi-sel-list-panel");
    const confirmBtn     = drawer.querySelector(".gqi-sel-confirm-btn");
    const subfilterRow   = drawer.querySelector(".gqi-proj-subfilter");

    const rootTheme = document.documentElement.getAttribute("data-theme");
    if (rootTheme === "dark" || rootTheme === "light") {
      drawer.setAttribute("data-theme", rootTheme);
    }

    // ── Helpers ──────────────────────────────────────────────────
    function getPinned(t)   { return SECTIONS[t].getPinned(); }
    function setPinned(t,v) { SECTIONS[t].setPinned(v); }
    function selCount(t)    { return getPinned(t).length; }
    function totalSel()     { return Object.keys(SECTIONS).reduce((n,t) => n + selCount(t), 0); }
    function projectBucket(item) {
      if (!item?.id) return "sap_technical";
      if (item.id.startsWith("PJ")) return "sap_technical";
      if (!item.id.startsWith("MPJ")) return "sap_technical";
      const n = parseInt(item.id.replace("MPJ", ""), 10);
      if (!Number.isFinite(n)) return "sap_technical";
      return n <= 11 ? "sap_media" : "creative_media";
    }
    function projectAccent(bucket) {
      if (bucket === "sap_media") return "#2563eb";
      if (bucket === "creative_media") return "#d97706";
      return "#6c63ff";
    }
    function projectGroupLabel(bucket) {
      if (bucket === "sap_media") return "🎬 SAP Media Projects";
      if (bucket === "creative_media") return "🎨 Creative Media Projects";
      return "⚙️ SAP & Technical Projects";
    }
    function formatSubCategory(raw) {
      if (!raw) return "";
      return String(raw).replace(/_/g, " ");
    }
    function refreshProjectFilterCounts() {
      const projects = SECTIONS.projects.getItems();
      const sapTechnical = projects.filter(p => projectBucket(p) === "sap_technical").length;
      const sapMedia = projects.filter(p => projectBucket(p) === "sap_media").length;
      const creativeMedia = projects.filter(p => projectBucket(p) === "creative_media").length;
      const total = projects.length;
      const setCount = (key, value) => {
        const el = drawer.querySelector(`[data-pf-count="${key}"]`);
        if (el) el.textContent = String(value);
      };
      setCount("all", total);
      setCount("sap_technical", sapTechnical);
      setCount("sap_media", sapMedia);
      setCount("creative_media", creativeMedia);
    }

    // ── Refresh counters / footer / confirm state ────────────────
    function refreshAll() {
      Object.keys(SECTIONS).forEach(t => {
        const n = selCount(t);
        const badge = drawer.querySelector(`[data-tab-badge="${t}"]`);
        if (badge) badge.textContent = n;
        const num = drawer.querySelector(`[data-footer-num="${t}"]`);
        if (num) num.textContent = n;
        const chip = drawer.querySelector(`[data-footer-chip="${t}"]`);
        if (chip) chip.classList.toggle("gqi-footer-chip-zero", n === 0);
      });
      confirmBtn.disabled = totalSel() === 0;
      refreshProjectFilterCounts();
      renderChips();
    }

    // ── Chips row ────────────────────────────────────────────────
    function renderChips() {
      const sec    = SECTIONS[activeTab];
      const pinned = getPinned(activeTab);
      const items  = sec.getItems();
      const accent = sec.accent;
      if (!pinned.length) { chipsList.innerHTML = `<span class="gqi-chips-empty">Nothing selected yet</span>`; return; }
      chipsList.innerHTML = pinned.map(id => {
        const item  = items.find(i => i.id === id);
        const raw   = item ? sec.getTitle(item) : id;
        const label = raw.length > 22 ? raw.slice(0, 20) + "…" : raw;
        return `<span class="gqi-sel-chip" style="border-color:${accent}55;color:${accent}">${esc(label)}<button type="button" class="gqi-sel-chip-x" data-remove-id="${esc(id)}" aria-label="Remove">✕</button></span>`;
      }).join("");
      chipsList.querySelectorAll(".gqi-sel-chip-x").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();
          const arr = getPinned(activeTab).filter(x => x !== btn.dataset.removeId);
          setPinned(activeTab, arr);
          refreshAll(); renderList();
        });
      });
    }

    // ── Item list ────────────────────────────────────────────────
    function renderList() {
      const sec    = SECTIONS[activeTab];
      const items  = sec.getItems();
      const pinned = new Set(getPinned(activeTab));
      const aiPick = new Set(sec.getAiPick());
      const accent = sec.accent;
      const q      = searchQuery.toLowerCase().trim();

      let filtered = items.filter(item => {
        const t = sec.getTitle(item).toLowerCase();
        const s = sec.getSub(item).toLowerCase();
        if (q && !t.includes(q) && !s.includes(q)) return false;
        if (filterMode === "ai")         return aiPick.has(item.id);
        if (filterMode === "selected")   return pinned.has(item.id);
        if (filterMode === "unselected") return !pinned.has(item.id);
        // Projects sub-filter
        if (activeTab === "projects" && projectFilter !== "all") {
          return projectBucket(item) === projectFilter;
        }
        return true;
      });

      // Sort: selected → AI → score
      filtered.sort((a, b) => {
        const ds = (pinned.has(b.id) ? 2 : 0) - (pinned.has(a.id) ? 2 : 0);
        if (ds !== 0) return ds;
        const da = (aiPick.has(b.id) ? 1 : 0) - (aiPick.has(a.id) ? 1 : 0);
        if (da !== 0) return da;
        return (b.score || 0) - (a.score || 0);
      });

      if (!filtered.length) {
        listPanel.innerHTML = `<div class="gqi-sel-empty">No items match your search.${q ? ` <button type="button" class="gqi-sel-empty-clear">Clear</button>` : ""}</div>`;
        listPanel.querySelector(".gqi-sel-empty-clear")?.addEventListener("click", () => {
          searchQuery = ""; searchIn.value = ""; searchClr.style.display = "none";
          renderList();
        });
        return;
      }

      const renderItem = (item) => {
        const isSel  = pinned.has(item.id);
        const isAi   = aiPick.has(item.id);
        const score  = item.score || 0;
        const title  = sec.getTitle(item);
        const sub    = sec.getSub(item);
        const desc   = sec.getDesc ? sec.getDesc(item) : "";
        const rawTags = sec.getTags ? sec.getTags(item) : [];
        const tags   = rawTags.slice(0, 3);
        const extra  = rawTags.length > 3 ? rawTags.length - 3 : 0;
        const bucket = activeTab === "projects" ? projectBucket(item) : "sap_technical";
        const itemAccent = activeTab === "projects" ? projectAccent(bucket) : accent;
        const barColor = score >= 70 ? itemAccent : score >= 40 ? itemAccent + "99" : "#252840";
        const subBadge = activeTab === "projects" && !item.id.startsWith("PJ")
          ? `<span class="gqi-sel-sub-badge" style="border-color:${itemAccent}4d;background:${itemAccent}1a;color:${itemAccent}">${esc(formatSubCategory(item.sub_category || "Media"))}</span>`
          : "";

        const tagHtml = tags.length
          ? `<div class="gqi-sel-tags">${tags.map(t => `<span class="gqi-sel-tag" style="border-color:${itemAccent}4d;background:${itemAccent}1a;color:${itemAccent}">${esc(t)}</span>`).join("")}${extra ? `<span class="gqi-sel-tag" style="border-color:${itemAccent}4d;background:${itemAccent}1a;color:${itemAccent}">+${extra}</span>` : ""}</div>`
          : "";

        return `<div class="gqi-sel-item${isSel ? " gqi-item-sel" : ""}" data-item-id="${esc(item.id)}" role="checkbox" aria-checked="${isSel}" tabindex="0" draggable="true"
            style="${isSel ? `--item-accent:${itemAccent};border-left-color:${itemAccent}` : ""}">
          <span class="gqi-sel-chk${isSel ? " gqi-chk-on" : ""}" style="${isSel ? `border-color:${itemAccent};background:${itemAccent}22` : ""}">
            ${isSel ? `<svg viewBox="0 0 10 8" fill="none" width="10" height="8"><polyline points="1,4 4,7 9,1" stroke="${itemAccent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ""}
          </span>
          <div class="gqi-sel-item-body">
            <div class="gqi-sel-item-hrow">
              <span class="gqi-sel-item-title${isSel ? " gqi-title-sel" : ""}">${esc(title)}</span>
              ${subBadge}
              ${isAi ? `<span class="gqi-sel-ai-badge">✦ AI</span>` : ""}
              <div class="gqi-sel-rel">
                <div class="gqi-sel-bar-track"><div class="gqi-sel-bar-fill" style="width:${score}%;background:${barColor}"></div></div>
                <span class="gqi-sel-bar-pct">${score}%</span>
              </div>
              <button type="button" class="gqi-sel-edit-btn" data-edit-id="${esc(item.id)}" title="Edit">✏</button>
            </div>
            ${sub  ? `<span class="gqi-sel-item-sub">${esc(sub)}</span>` : ""}
            ${desc ? `<span class="gqi-sel-item-desc">${esc(desc.length > 120 ? desc.slice(0, 117) + "…" : desc)}</span>` : ""}
            ${tagHtml}
          </div>
        </div>`;
      };

      if (activeTab === "projects" && projectFilter === "all") {
        const groupKeys = ["sap_technical", "sap_media", "creative_media"];
        const grouped = groupKeys.map(key => {
          const groupItems = filtered.filter(item => projectBucket(item) === key).sort((a, b) => {
            const ds = (pinned.has(b.id) ? 2 : 0) - (pinned.has(a.id) ? 2 : 0);
            if (ds !== 0) return ds;
            const da = (aiPick.has(b.id) ? 1 : 0) - (aiPick.has(a.id) ? 1 : 0);
            if (da !== 0) return da;
            return (b.score || 0) - (a.score || 0);
          });
          return { key, items: groupItems };
        }).filter(g => g.items.length);

        listPanel.innerHTML = grouped.map(g => {
          const accentColor = projectAccent(g.key);
          const header = `<div class="gqi-sel-group-header" style="color:${accentColor};border-color:${accentColor}55">${projectGroupLabel(g.key)} (${g.items.length})</div>`;
          return header + g.items.map(renderItem).join("");
        }).join("");
      } else {
        listPanel.innerHTML = filtered.map(renderItem).join("");
      }

      listPanel.querySelectorAll(".gqi-sel-item").forEach(el => {
        const toggle = () => {
          const id  = el.dataset.itemId;
          const arr = getPinned(activeTab);
          const idx = arr.indexOf(id);
          if (idx !== -1) arr.splice(idx, 1); else arr.push(id);
          setPinned(activeTab, [...arr]);
          refreshAll(); renderList();
        };
        el.addEventListener("click", e => { if (e.target.closest(".gqi-sel-edit-btn")) return; toggle(); });
        el.addEventListener("keydown", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); } });
      });

      listPanel.querySelectorAll(".gqi-sel-edit-btn").forEach(btn => {
        btn.addEventListener("click", e => { e.stopPropagation(); openEditForm(btn.dataset.editId); });
      });

      // ── Drag-to-reorder ──────────────────────────────────────
      let dragSrcId = null;
      listPanel.querySelectorAll(".gqi-sel-item").forEach(el => {
        el.addEventListener("dragstart", e => {
          dragSrcId = el.dataset.itemId;
          el.classList.add("gqi-item-dragging");
          e.dataTransfer.effectAllowed = "move";
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("gqi-item-dragging");
          listPanel.querySelectorAll(".gqi-item-dragover").forEach(x => x.classList.remove("gqi-item-dragover"));
        });
        el.addEventListener("dragover", e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (el.dataset.itemId !== dragSrcId) {
            listPanel.querySelectorAll(".gqi-item-dragover").forEach(x => x.classList.remove("gqi-item-dragover"));
            el.classList.add("gqi-item-dragover");
          }
        });
        el.addEventListener("drop", e => {
          e.preventDefault();
          el.classList.remove("gqi-item-dragover");
          if (!dragSrcId || dragSrcId === el.dataset.itemId) return;
          const items = sec.getItems();
          const srcIdx = items.findIndex(i => i.id === dragSrcId);
          const dstIdx = items.findIndex(i => i.id === el.dataset.itemId);
          if (srcIdx === -1 || dstIdx === -1) return;
          const [moved] = items.splice(srcIdx, 1);
          items.splice(dstIdx, 0, moved);
          dragSrcId = null;
          renderList();
          fetch("/reorder-bank-items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: activeTab, orderedIds: items.map(i => i.id) })
          }).then(r => r.json()).then(d => {
            showToast(d.success ? "Order saved" : ("Reorder failed: " + d.error), d.success ? "success" : "error");
          }).catch(() => showToast("Reorder failed", "error"));
        });
      });
    }

    // ── Inline edit form ─────────────────────────────────────────
    function openEditForm(itemId) {
      const sec   = SECTIONS[activeTab];
      const items = sec.getItems();
      const item  = items.find(i => i.id === itemId);
      if (!item) return;
      drawer.querySelector(".gqi-sel-edit-form")?.remove();

      let fields = [];
      if (activeTab === "we") {
        fields = [
          { key: "title",       label: "Title",           value: item.title       || "" },
          { key: "company",     label: "Company / Team",  value: item.company     || "" },
          { key: "period",      label: "Period",          value: item.period      || "" },
          { key: "description", label: "Description",     value: item.description || (Array.isArray(item.bullets) ? item.bullets.join("\n") : ""), multi: true }
        ];
      } else if (activeTab === "projects") {
        fields = [
          { key: "name",        label: "Project Name",    value: item.name        || "" },
          { key: "tech",        label: "Technologies",    value: item.tech        || "" },
          { key: "description", label: "Description",     value: item.description || "", multi: true }
        ];
      } else if (activeTab === "certs") {
        fields = [
          { key: "name",        label: "Name",            value: item.name        || "" },
          { key: "provider",    label: "Provider",        value: item.provider    || "" },
          { key: "date",        label: "Date",            value: item.date        || "" },
          { key: "description", label: "Description",     value: item.description || "", multi: true }
        ];
      } else if (activeTab === "research") {
        fields = [
          { key: "title",       label: "Title",           value: item.title       || "" },
          { key: "_org",        label: "Institution / Context", value: item.institution || item.context || "" },
          { key: "_period",     label: "Period / Date",   value: item.period      || item.date || "" },
          { key: "description", label: "Description",     value: item.description || "", multi: true }
        ];
      }

      const form = document.createElement("div");
      form.className = "gqi-sel-edit-form";
      form.innerHTML = `
        <div class="gqi-edit-form-title">Edit: ${esc(sec.getTitle(item))}</div>
        ${fields.map(f => `<div class="gqi-edit-field">
          <label class="gqi-edit-label">${f.label}</label>
          ${f.multi
            ? `<textarea class="gqi-edit-input" data-field="${f.key}" rows="3">${esc(f.value)}</textarea>`
            : `<input class="gqi-edit-input" data-field="${f.key}" type="text" value="${esc(f.value)}">`}
        </div>`).join("")}
        <div class="gqi-edit-actions">
          <button type="button" class="gqi-edit-save-btn">Save</button>
          <button type="button" class="gqi-edit-cancel-btn">Cancel</button>
        </div>`;

      const itemEl = listPanel.querySelector(`[data-item-id="${itemId}"]`);
      itemEl?.after(form);
      form.querySelector(".gqi-edit-input")?.focus();

      form.querySelector(".gqi-edit-cancel-btn").addEventListener("click", () => form.remove());
      form.querySelector(".gqi-edit-save-btn").addEventListener("click", async () => {
        const fields = {};
        form.querySelectorAll(".gqi-edit-input").forEach(inp => {
          const f = inp.dataset.field, v = inp.value;
          if (f === "_org") {
            const key = "institution" in item ? "institution" : "context";
            item[key] = v; fields[key] = v;
          } else if (f === "_period") {
            const key = "period" in item ? "period" : "date";
            item[key] = v; fields[key] = v;
          } else if (f === "description" && Array.isArray(item.bullets)) {
            item.bullets = v.split("\n").map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean);
            item.description = v;
            fields.bullets = item.bullets; fields.description = v;
          } else {
            item[f] = v; fields[f] = v;
          }
        });
        form.remove();
        renderList();
        try {
          const r = await fetch("/update-bank-item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: activeTab, id: itemId, fields })
          });
          const d = await r.json();
          showToast(d.success ? "Saved permanently" : ("Save failed: " + d.error), d.success ? "success" : "error");
        } catch (e) {
          showToast("Save failed: " + e.message, "error");
        }
      });
    }

    // ── Tab switching ────────────────────────────────────────────
    function switchTab(t) {
      activeTab = t; searchQuery = ""; filterMode = "all"; projectFilter = "all";
      searchIn.value = ""; searchClr.style.display = "none";
      filterSel.value = "all";
      searchIn.placeholder = `Search ${SECTIONS[t].label}...`;
      drawer.querySelectorAll(".gqi-sel-tab").forEach(btn => {
        const on = btn.dataset.tab === t;
        btn.classList.toggle("gqi-tab-active", on);
        btn.setAttribute("aria-selected", on);
      });
      // Show sub-filter row only on Projects tab
      subfilterRow.style.display = t === "projects" ? "flex" : "none";
      // Reset sub-filter button active state
      subfilterRow.querySelectorAll(".gqi-pf-btn").forEach(b =>
        b.classList.toggle("gqi-pf-active", b.dataset.pf === "all")
      );
      // Fade-in animation on content change
      listPanel.classList.remove("gqi-list-animating");
      void listPanel.offsetWidth; // force reflow
      listPanel.classList.add("gqi-list-animating");
      renderList(); renderChips();
      requestAnimationFrame(() => searchIn.focus());
    }

    // ── Sub-filter (Projects) event bindings ─────────────────────
    subfilterRow.querySelectorAll(".gqi-pf-btn").forEach(btn =>
      btn.addEventListener("click", () => {
        projectFilter = btn.dataset.pf;
        subfilterRow.querySelectorAll(".gqi-pf-btn").forEach(b =>
          b.classList.toggle("gqi-pf-active", b === btn)
        );
        listPanel.classList.remove("gqi-list-animating");
        void listPanel.offsetWidth;
        listPanel.classList.add("gqi-list-animating");
        renderList();
      })
    );

    // ── Event bindings ───────────────────────────────────────────
    drawer.querySelectorAll(".gqi-sel-tab").forEach(btn =>
      btn.addEventListener("click", () => switchTab(btn.dataset.tab))
    );

    searchIn.addEventListener("input", () => {
      searchQuery = searchIn.value;
      searchClr.style.display = searchQuery ? "flex" : "none";
      renderList();
    });
    searchClr.addEventListener("click", () => {
      searchQuery = ""; searchIn.value = ""; searchClr.style.display = "none";
      renderList();
    });
    filterSel.addEventListener("change", () => { filterMode = filterSel.value; renderList(); });

    drawer.querySelector(".gqi-sel-reset-btn").addEventListener("click", () => {
      const s = genState.selectors[key];
      s.pinnedWE       = [...(s.aiPickWE || [])];
      s.pinnedProjects = [...(s.aiPickProjects || [])];
      s.pinnedCerts    = [];
      s.pinnedResearch = (s.research || []).map(r => r.id);
      refreshAll(); renderList();
    });

    const closeModal = () => { document.removeEventListener("keydown", onEsc); modal.remove(); updateJobUI(key); };
    const onEsc = e => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onEsc);
    drawer.querySelector(".gqi-sel-close-btn").addEventListener("click", closeModal);
    backdrop.addEventListener("click", closeModal);

    confirmBtn.addEventListener("click", () => {
      closeModal();
      showToast("CV selection saved — click Generate to use it", "success");
    });

    // ── Initial render + entrance animation ─────────────────────
    refreshAll();
    renderList();
    requestAnimationFrame(() => {
      drawer.classList.add("gqi-drawer-in");
      searchIn.focus();
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
        setStep("jd", `Fetching JD from ${job.company || "careers"} page…`, 10);
        addThought("Server fetch:", `No cache — fetching JD from ${job.company || "careers"} page…`);
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
      const selState = genState.selectors[key] || {};
      const cvRes = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobDescription: jdText, documentType: "cv",
          jobTitle: job.title || null,
          jobReqId: job.reqId || null,
          pinnedWeIds: selState.pinnedWE?.length ? selState.pinnedWE : null,
          pinnedProjectIds: selState.pinnedProjects?.length ? selState.pinnedProjects : null,
          pinnedCertIds: selState.pinnedCerts?.length ? selState.pinnedCerts : null,
          pinnedResearchIds: selState.pinnedResearch?.length ? selState.pinnedResearch : null
        })
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
        body: JSON.stringify({
          jobDescription: jdText, documentType: "cl",
          jobTitle: job.title || null,
          jobReqId: job.reqId || null,
          pinnedWeIds: selState.pinnedWE?.length ? selState.pinnedWE : null,
          pinnedProjectIds: selState.pinnedProjects?.length ? selState.pinnedProjects : null,
          pinnedCertIds: selState.pinnedCerts?.length ? selState.pinnedCerts : null,
          pinnedResearchIds: selState.pinnedResearch?.length ? selState.pinnedResearch : null
        })
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
        try {
          await FirebaseAPI.library.saveApprovedGeneration(userId, {
            id: `gen_${job.reqId || Date.now()}`,
            jobTitle: job.title, reqId: job.reqId,
            cvText, clText, status: "applied", weight: 1.0
          });
        } catch (e) { /* no-auth or offline — skip */ }
      }
      gen.state = "applied";
      if (window.JobHuntApp?.addTrackerApplication) {
        await window.JobHuntApp.addTrackerApplication({
          id: `gen_${job.reqId || Date.now()}`,
          company: (job.title || "").split(/\s*[-–(]/)[0]?.trim() || job.title,
          role: job.title, link: job.url || "", location: job.location || "",
          reqId: job.reqId || "", stage: "Applied", notes: "Auto-added from generation"
        });
      }
      renderQueue();
      showToast("✓ Applied — saved to tracker. Use ✕ to remove from queue.");
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
        try {
          await FirebaseAPI.library.saveApprovedGeneration(userId, {
            id: `wishlist_${job.reqId || Date.now()}`,
            jobTitle: job.title, reqId: job.reqId,
            cvText, clText, status: "wishlist", weight: 0.5
          });
        } catch (e) { /* no-auth or offline — skip */ }
      }
      if (window.JobHuntApp?.addTrackerApplication) {
        await window.JobHuntApp.addTrackerApplication({
          id: `wishlist_${job.reqId || Date.now()}`,
          company: (job.title || "").split(/\s*[-–(]/)[0]?.trim() || job.title,
          role: job.title, link: job.url || "", location: job.location || "",
          reqId: job.reqId || "", stage: "Wishlist", notes: "Saved to wishlist from generation"
        });
      }
      gen.state = "wishlisted";
      renderQueue();
      showToast("★ Saved to Wishlist — use ✕ to remove from queue.");
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

  function toggleClearWrite(btn) {
    const ta = $(btn.dataset.target);
    if (!ta) return;
    if (btn.classList.contains("cw-active")) {
      ta.value = btn.dataset.cwOriginal || "";
      delete btn.dataset.cwOriginal;
      btn.classList.remove("cw-active");
      btn.title = "Clear & write your own";
    } else {
      btn.dataset.cwOriginal = ta.value;
      ta.value = "";
      ta.focus();
      btn.classList.add("cw-active");
      btn.title = "Restore AI content";
    }
  }

  function buildDachResultsHtml(issues, reqId) {
    if (!issues || !issues.length) return `<div class="gqi-dach-results gqi-dach-pass">&#x2705; DACH check passed \u2014 no issues found.</div>`;
    const sevIcon = { high: "\u{1F534}", medium: "\u{1F7E1}", low: "\u{1F7E2}" };
    const rows = issues.map((iss, idx) =>
      `<div class="gqi-dach-row">
        <label class="gqi-dach-cb-wrap" title="Include in fix"><input type="checkbox" checked class="gqi-dach-cb" data-idx="${idx}"></label>
        <span class="gqi-dach-sev">${sevIcon[iss.severity] || "\u{26AA}"}</span>
        <div><strong>${esc(iss.issue)}</strong>${iss.suggestion ? `<br><span class="gqi-dach-fix">${esc(iss.suggestion)}</span>` : ""}</div>
      </div>`
    ).join("");
    return `<div class="gqi-dach-results">
      <div class="gqi-dach-hdr">\u{1F1E9}\u{1F1EA} DACH Compliance</div>
      ${rows}
      <button class="btn btn-sm gqi-dach-fix-btn" data-gen-dach-fix="${esc(reqId)}">&#x1F527; Fix Issues</button>
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

  async function dachFix(reqId) {
    const gen = genState.generations[reqId];
    if (!gen || !gen.dachIssues?.length) { showToast("No DACH issues to fix", "error"); return; }
    const safe = safeId(reqId);
    const fixBtn = document.querySelector(`[data-gen-dach-fix="${CSS.escape(reqId)}"]`);
    if (fixBtn) { fixBtn.disabled = true; fixBtn.innerHTML = "&#x231B; Fixing\u2026"; }

    const cvText = document.getElementById("gqi-cv-" + safe)?.value || gen.cvContent || "";
    const clText = document.getElementById("gqi-cl-" + safe)?.value || gen.clContent || "";
    const resultsContainer = fixBtn?.closest(".gqi-dach-results");
    const checkedIdxs = [...(resultsContainer?.querySelectorAll(".gqi-dach-cb:checked") || [])].map(cb => +cb.dataset.idx);
    const issues = gen.dachIssues.filter((_, i) => !checkedIdxs.length || checkedIdxs.includes(i));
    if (!issues.length) { showToast("Select at least one issue to fix", "error"); if (fixBtn) { fixBtn.disabled = false; fixBtn.innerHTML = "&#x1F527; Fix Issues"; } return; }

    // Fix both documents in parallel
    const fixDoc = async (docText, docType) => {
      if (!docText) return null;
      const res = await fetch("/dach-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentText: docText, documentType: docType, issues })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || `${docType} fix failed`);
      return data.content;
    };

    try {
      const [fixedCv, fixedCl] = await Promise.all([
        cvText ? fixDoc(cvText, "cv") : Promise.resolve(null),
        clText ? fixDoc(clText, "cl") : Promise.resolve(null)
      ]);

      if (fixedCv) {
        gen.cvContent = fixedCv;
        const ta = document.getElementById("gqi-cv-" + safe);
        if (ta) ta.value = fixedCv;
      }
      if (fixedCl) {
        gen.clContent = fixedCl;
        const ta = document.getElementById("gqi-cl-" + safe);
        if (ta) ta.value = fixedCl;
      }
      gen.dachIssues = null;
      updateJobUI(reqId);
      await dachCheck(reqId);
      showToast("DACH issues fixed — verification finished");
    } catch (err) {
      showToast("DACH fix failed: " + err.message, "error");
    } finally {
      if (fixBtn) { fixBtn.disabled = false; fixBtn.innerHTML = "&#x1F527; Fix Issues"; }
    }
  }

  function parseDisplayToCvJson(text) {
    if (!text) return null;
    try {
      const lines = text.split('\n');
      const SECTIONS = ['PROFILE SUMMARY','PROFILE','KEY COMPETENCIES','TECHNICAL SKILLS','EDUCATION','WORK EXPERIENCE','PROJECTS','RESEARCH & ACTIVITIES','CERTIFICATIONS'];
      const sectionMap = {};
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (SECTIONS.includes(t)) sectionMap[t] = i;
      }
      const allStarts = Object.values(sectionMap).filter(v => !isNaN(v));
      const firstSection = allStarts.length ? Math.min(...allStarts) : lines.length;
      const headerLines = lines.slice(0, firstSection).filter(l => l.trim());
      const j = {};
      if (headerLines[0]) j.name = headerLines[0].trim();
      let hIdx = 1;
      if (headerLines[hIdx] && !/^(Phone:|Email:|LinkedIn:|GitHub:|Languages:)/i.test(headerLines[hIdx])) {
        j.location = headerLines[hIdx].trim(); hIdx++;
      }
      for (let k = hIdx; k < headerLines.length; k++) {
        headerLines[k].split('|').map(p => p.trim()).forEach(part => {
          if (part.startsWith('Phone:')) j.phone = part.slice(6).trim();
          if (part.startsWith('Email:')) j.email = part.slice(6).trim();
          if (part.startsWith('LinkedIn:')) j.linkedin = part.slice(9).trim();
          if (part.startsWith('GitHub:')) j.github = part.slice(7).trim();
          if (part.startsWith('Languages:')) j.languages = part.slice(10).trim();
        });
      }
      function getSectionLines(name) {
        if (sectionMap[name] === undefined) return [];
        const start = sectionMap[name] + 1;
        const nextStarts = SECTIONS.filter(s => s !== name && sectionMap[s] !== undefined && sectionMap[s] > sectionMap[name]).map(s => sectionMap[s]);
        const end = nextStarts.length > 0 ? Math.min(...nextStarts) : lines.length;
        return lines.slice(start, end);
      }
      function parseEntries(name) {
        const slines = getSectionLines(name);
        const entries = [], current = [];
        for (const line of slines) {
          if (line.trim() === '') { if (current.length) { entries.push([...current]); current.length = 0; } }
          else current.push(line);
        }
        if (current.length) entries.push([...current]);
        return entries;
      }
      function parseTitleDate(line) {
        const m = line.match(/^(.+?)\s{3,}(.+)$/);
        return m ? { title: m[1].trim(), date: m[2].trim() } : { title: line.trim(), date: '' };
      }
      const profLines = (getSectionLines('PROFILE SUMMARY').length ? getSectionLines('PROFILE SUMMARY') : getSectionLines('PROFILE')).filter(l => l.trim());
      if (profLines.length) j.profile = profLines.join(' ').trim();
      const kcLines = getSectionLines('KEY COMPETENCIES').filter(l => l.trim());
      if (kcLines.length) j.key_competencies = kcLines.join(' ').trim();
      const techLines = getSectionLines('TECHNICAL SKILLS').filter(l => l.trim());
      if (techLines.length) j.technical_skills = techLines.map(line => {
        const ci = line.indexOf(':');
        return ci > 0 ? { category: line.slice(0, ci).trim(), items: line.slice(ci + 1).trim() } : { category: line.trim(), items: '' };
      });
      const eduEntries = parseEntries('EDUCATION');
      if (eduEntries.length) j.education = eduEntries.map(entry => {
        const { title: degree, date } = parseTitleDate(entry[0] || '');
        const institution = entry[1]?.trim() || '';
        const cwLine = entry.find(l => l.trim().startsWith('Selected coursework:'));
        return { degree, date, institution, coursework: cwLine ? cwLine.replace('Selected coursework:', '').trim() : '' };
      });
      const weEntries = parseEntries('WORK EXPERIENCE');
      if (weEntries.length) j.experience = weEntries.map(entry => {
        const { title, date } = parseTitleDate(entry[0] || '');
        const company = entry[1]?.trim() || '';
        const descLines = entry.slice(2);
        if (descLines.some(l => l.trim().startsWith('- '))) return { title, date, company, bullets: descLines.filter(l => l.trim().startsWith('- ')).map(l => l.replace(/^-\s*/, '')) };
        return { title, date, company, description: descLines.join(' ').trim() };
      });
      const projEntries = parseEntries('PROJECTS');
      if (projEntries.length) j.projects = projEntries.map(entry => {
        const { title, date } = parseTitleDate(entry[0] || '');
        let tech = '', descLines = [];
        if (entry.length > 1) {
          const second = entry[1]?.trim() || '';
          if (!second.startsWith('- ') && !parseTitleDate(second).date) { tech = second; descLines = entry.slice(2); }
          else descLines = entry.slice(1);
        }
        if (descLines.some(l => l.trim().startsWith('- '))) return { title, date, tech, bullets: descLines.filter(l => l.trim().startsWith('- ')).map(l => l.replace(/^-\s*/, '')) };
        return { title, date, tech, description: descLines.join(' ').trim() };
      });
      const resEntries = parseEntries('RESEARCH & ACTIVITIES');
      if (resEntries.length) j.research_activities = resEntries.map(entry => {
        const { title, date } = parseTitleDate(entry[0]?.trim() || '');
        const organization = entry[1]?.trim() || '';
        const description = entry.slice(2).join(' ').trim();
        return { title, date, organization, description };
      });
      const certEntries = parseEntries('CERTIFICATIONS');
      if (certEntries.length) j.certifications = certEntries.map(entry => {
        const { title: name, date } = parseTitleDate(entry[0] || '');
        return { name, date, description: entry.slice(1).join(' ').trim() };
      });
      return j;
    } catch (e) { console.warn('parseDisplayToCvJson failed:', e); return null; }
  }

  function parseDisplayToClJson(text, existingJson) {
    if (!text) return null;
    try {
      const lines = text.split('\n');
      const j = existingJson ? { ...existingJson } : {};
      const headerLine = lines[0]?.trim() || '';
      if (headerLine.includes('Position:') || headerLine.includes('Req ID:') || headerLine.includes('Location:')) {
        headerLine.split('|').map(p => p.trim()).forEach(part => {
          if (part.startsWith('Position:')) j.position_title = part.slice(9).trim();
          if (part.startsWith('Req ID:')) j.req_id = part.slice(7).trim();
          if (part.startsWith('Location:')) j.location = part.slice(9).trim();
        });
      }
      let inBody = false;
      const paragraphs = [];
      let currentPara = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'Dear Hiring Manager,') { inBody = true; continue; }
        if (!inBody) continue;
        if (trimmed.startsWith('Thank you very much')) break;
        if (trimmed === '') {
          if (currentPara.length) { paragraphs.push(currentPara.join(' ')); currentPara = []; }
        } else { currentPara.push(trimmed); }
      }
      if (currentPara.length) paragraphs.push(currentPara.join(' '));
      if (paragraphs.length) j.paragraphs = paragraphs;
      return j;
    } catch (e) { console.warn('parseDisplayToClJson failed:', e); return null; }
  }

  async function exportPdfForJob(type, reqId) {
    const gen  = genState.generations[reqId];
    const i    = genState.queue.findIndex(j => getGenKey(j) === reqId);
    const job  = i >= 0 ? genState.queue[i] : null;
    if (!gen) { showToast("No generation found", "error"); return; }
    const safe = safeId(reqId);
    const content = type === "cv"
      ? (document.getElementById("gqi-cv-" + safe)?.value || gen.cvContent)
      : (document.getElementById("gqi-cl-" + safe)?.value || gen.clContent);
    const originalContent = type === "cv" ? gen.cvContent : gen.clContent;
    const isEdited = content !== originalContent;
    let contentJson;
    if (!isEdited) {
      // Unedited: use original structured JSON for clean template formatting
      contentJson = type === "cv" ? gen.cvJson : gen.clJson;
    } else {
      // Edited: try to parse display text back to JSON for template formatting
      const parsed = type === "cv" ? parseDisplayToCvJson(content) : parseDisplayToClJson(content, null);
      // If parse produced a meaningful JSON, use it; otherwise null → server uses text parser
      // NEVER fall back to gen.cvJson/gen.clJson when edited (that would export original text)
      if (type === "cl") {
        // CL: require at least one body paragraph, otherwise text parser handles raw content
        contentJson = (parsed && parsed.paragraphs?.length > 0) ? parsed : null;
      } else {
        // CV: require at least one real section (not just name/location header fields)
        const CV_SECTIONS = ["profile","key_competencies","technical_skills","education","experience","projects","research_activities","certifications"];
        const hasSection = parsed && CV_SECTIONS.some(k => parsed[k]?.length > 0);
        contentJson = hasSection ? parsed : null;
      }
    }
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
    const url = prompt("Paste job URL (SAP, Infineon, Siemens, or any careers page):");
    if (!url || !url.trim()) return;
    const trimmed = url.trim();
    // Try to extract a req ID from the URL (5-16 digits to handle various portals)
    const reqMatch = trimmed.match(/(\d{5,16})/);
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
    const bgPicker = $("scratchpad-bg-picker");
    const resetSizeBtn = $("scratchpad-reset-size");
    if (!fab || !popup || !ta) return;

    // ── Restore saved background color ──
    const savedBg = localStorage.getItem("scratchpad_bg");
    if (savedBg) { ta.style.background = savedBg; if (bgPicker) bgPicker.value = savedBg; }

    // ── Background color picker ──
    if (bgPicker) {
      bgPicker.addEventListener("input", (e) => {
        ta.style.background = e.target.value;
        localStorage.setItem("scratchpad_bg", e.target.value);
      });
    }

    // ── Reset window size & position ──
    if (resetSizeBtn) {
      resetSizeBtn.addEventListener("click", () => {
        popup.style.width = "";
        popup.style.height = "";
        popup.style.top = "";
        popup.style.left = "";
        popup.style.bottom = "";
        popup.style.right = "";
      });
    }

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
    // ── Double-click tab to rename ──
    tabsEl?.addEventListener("dblclick", (e) => {
      const tab = e.target.closest("[data-scratch-idx]");
      if (!tab) return;
      const idx = parseInt(tab.dataset.scratchIdx, 10);
      const input = document.createElement("input");
      input.type = "text";
      input.value = notes[idx].name;
      input.className = "scratchpad-rename-input";
      tab.textContent = "";
      tab.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        const v = input.value.trim();
        if (v) notes[idx].name = v;
        saveScratchNotes(notes);
        renderTabs();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") { input.value = notes[idx].name; input.blur(); }
      });
    });
    ta.addEventListener("input", save);

    // ── Drag-to-move via header ──
    const header = popup.querySelector(".scratchpad-header");
    if (header) {
      let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
      header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return; // don't drag when clicking buttons
        dragging = true;
        const rect = popup.getBoundingClientRect();
        // Switch from bottom/right positioning to top/left for free movement
        popup.style.top = rect.top + "px";
        popup.style.left = rect.left + "px";
        popup.style.bottom = "auto";
        popup.style.right = "auto";
        startX = e.clientX;
        startY = e.clientY;
        origLeft = rect.left;
        origTop = rect.top;
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        popup.style.left = Math.max(0, origLeft + dx) + "px";
        popup.style.top = Math.max(0, origTop + dy) + "px";
      });
      document.addEventListener("mouseup", () => { dragging = false; });
    }
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
      const dachFixBtn = e.target.closest("[data-gen-dach-fix]");
      if (dachFixBtn) { dachFix(dachFixBtn.dataset.genDachFix); return; }
      const clearWriteBtn = e.target.closest(".gen-clear-write");
      if (clearWriteBtn) { toggleClearWrite(clearWriteBtn); return; }
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

    // CL Bold button — wraps selection with **...**
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".gen-cl-bold");
      if (!btn) return;
      const ta = $(btn.dataset.target);
      if (!ta) return;
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      const replacement = sel.length ? `**${sel}**` : `****`;
      ta.value = ta.value.slice(0, start) + replacement + ta.value.slice(end);
      // Place cursor: inside the stars if no selection, after closing ** if selection
      const newPos = sel.length ? start + replacement.length : start + 2;
      ta.setSelectionRange(newPos, newPos);
      ta.focus();
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
      modalTa._docType = (btn.dataset.label || "").toLowerCase().includes("cover") ? "cl" : "cv";
      if (title) title.textContent = "Edit " + (btn.dataset.label || "Document");
      modal.classList.remove("hidden");
      updateA4Preview();
    });
    $("gen-fullview-close")?.addEventListener("click", () => {
      const modal = $("gen-fullview-modal");
      const modalTa = $("gen-fullview-textarea");
      if (!modal || !modalTa) return;
      if (modalTa._sourceId) { const src = $(modalTa._sourceId); if (src) src.value = modalTa.value; }
      modal.classList.add("hidden");
    });

    // A4 preview toggle
    $("gen-fv-toggle-preview")?.addEventListener("click", () => {
      const pane = $("gen-fv-preview-pane");
      const btn  = $("gen-fv-toggle-preview");
      if (!pane) return;
      const hidden = pane.classList.toggle("hidden");
      btn?.classList.toggle("gen-fv-active", !hidden);
    });

    // Swap preview/editor sides
    $("gen-fv-swap")?.addEventListener("click", () => {
      const body = document.querySelector(".gen-fv-body");
      const btn  = $("gen-fv-swap");
      if (!body) return;
      const swapped = body.classList.toggle("swapped");
      if (btn) btn.classList.toggle("gen-fv-active", swapped);
    });

    // Drag-to-resize between editor and preview panes
    const resizer    = $("gen-fv-resizer");
    const editorPane = $("gen-fv-editor-pane");
    const fvBody     = $("gen-fv-body");
    if (resizer && editorPane && fvBody) {
      let dragging = false, startX = 0, startW = 0;
      resizer.addEventListener("mousedown", e => {
        dragging = true;
        startX = e.clientX;
        startW = editorPane.getBoundingClientRect().width;
        resizer.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
      });
      document.addEventListener("mousemove", e => {
        if (!dragging) return;
        const body = fvBody;
        const swapped = body.classList.contains("swapped");
        const delta = swapped ? startX - e.clientX : e.clientX - startX;
        const totalW = fvBody.getBoundingClientRect().width;
        const newW = Math.min(Math.max(startW + delta, 240), totalW - 240);
        editorPane.style.width = newW + "px";
      });
      document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      });
    }

    // Live A4 preview update (debounced)
    let _fvPreviewTimer = null;
    $("gen-fullview-textarea")?.addEventListener("input", () => {
      clearTimeout(_fvPreviewTimer);
      _fvPreviewTimer = setTimeout(updateA4Preview, 300);
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

    // Add external job — unified modal (same as Tracker/Search tabs)
    $("gen-add-job-btn")?.addEventListener("click", () => {
      if (window.JobHuntHQOpenModal) { window.JobHuntHQOpenModal(); }
      else { addJobManual(); } // fallback
    });

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
  // QUICK-ADD / DELETE TOOL CHIP INTERACTIONS
  // ═══════════════════════════════════════════════════════════════
  let _qaTargetChip    = null;
  let _qaToolName      = null;
  let _qaSearchResults = [];
  let _qaIsToolMode    = false; // true = tag existing skills; false = add new skill

  function positionQuickAdd(chipEl) {
    const dlg  = document.getElementById("gqi-quick-add");
    if (!dlg) return;
    const rect = chipEl.getBoundingClientRect();
    const dlgW = 420, dlgH = 520;
    let top  = rect.bottom + 8;
    let left = rect.left;
    if (left + dlgW > window.innerWidth - 8)  left  = window.innerWidth  - dlgW - 8;
    if (top  + dlgH > window.innerHeight - 8) top   = rect.top - dlgH - 8;
    dlg.style.top  = Math.max(8, top)  + "px";
    dlg.style.left = Math.max(8, left) + "px";
  }

  function showQuickAdd(toolName, chipEl, isToolMode) {
    _qaTargetChip    = chipEl;
    _qaToolName      = toolName;
    _qaSearchResults = [];
    _qaIsToolMode    = !!isToolMode;
    const dlg = document.getElementById("gqi-quick-add");
    if (!dlg) return;

    // Adjust title and visible sections based on mode
    const titleEl = dlg.querySelector(".gqi-qa-title");
    if (titleEl) titleEl.innerHTML = _qaIsToolMode ? "&#x1F3F7; Tag Skills with Tool" : "&#x2795; Add to Skill Bank";
    document.getElementById("gqi-qa-tool-name").textContent = toolName;

    // In tool mode, hide add-skill fields (category, level, evidence, actions)
    // Show only search bar + results with Tag buttons
    const addFields = dlg.querySelector(".gqi-qa-add-fields");
    if (addFields) addFields.style.display = _qaIsToolMode ? "none" : "";
    const toolActions = dlg.querySelector(".gqi-qa-tool-actions");
    if (toolActions) toolActions.style.display = _qaIsToolMode ? "" : "none";

    const evidenceEl = document.getElementById("gqi-qa-evidence");
    if (evidenceEl) {
      evidenceEl.value = "";
      evidenceEl.placeholder = _qaIsToolMode ? "" : "Select results below or click Generate…";
    }
    document.getElementById("gqi-qa-level").value = "Intermediate";
    // Pre-fill search bar and auto-search
    const searchInput = document.getElementById("gqi-qa-search");
    if (searchInput) searchInput.value = toolName;
    const resultsEl = document.getElementById("gqi-qa-results");
    if (resultsEl) resultsEl.innerHTML = "";
    dlg.classList.remove("hidden");
    positionQuickAdd(chipEl);
    // Auto-search skill bank for the keyword
    searchSkillBank(toolName);
  }

  // ── Skill bank search ──
  async function searchSkillBank(query) {
    const resultsEl = document.getElementById("gqi-qa-results");
    if (!resultsEl || !query.trim()) return;
    resultsEl.innerHTML = '<div class="gqi-qa-results-loading">Searching…</div>';
    try {
      const res  = await fetch("/skill-bank/search?q=" + encodeURIComponent(query.trim()));
      const data = await res.json();
      if (data.success && data.results.length > 0) {
        _qaSearchResults = data.results;
        renderQAResults(data.results);
      } else {
        _qaSearchResults = [];
        if (_qaIsToolMode) {
          // Tool-tag mode: offer inline Generate & Add instead of dead text
          resultsEl.innerHTML = `
            <div class="gqi-qa-results-empty" style="padding:10px 0;">
              <div style="margin-bottom:10px;color:var(--text-muted,#888);">Not in skill bank yet.</div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <select id="gqi-qa-inline-level" style="padding:4px 8px;border-radius:6px;border:1px solid #ccc;font-size:13px;">
                  <option value="Beginner">Beginner</option>
                  <option value="Intermediate" selected>Intermediate</option>
                  <option value="Advanced">Advanced</option>
                </select>
                <button type="button" id="gqi-qa-inline-gen-btn" class="btn btn-sm" style="background:var(--gqi-accent,#5b4fcf);color:#fff;padding:4px 12px;">⚡ Generate &amp; Add</button>
              </div>
            </div>`;
          document.getElementById("gqi-qa-inline-gen-btn")?.addEventListener("click", generateAndAddSkill);
        } else {
          resultsEl.innerHTML = '<div class="gqi-qa-results-empty">No matches — click <strong>⚡ Generate</strong> to create evidence</div>';
        }
      }
    } catch {
      _qaSearchResults = [];
      resultsEl.innerHTML = '<div class="gqi-qa-results-empty">Search failed</div>';
    }
  }

  function renderQAResults(results) {
    const el = document.getElementById("gqi-qa-results");
    if (!el) return;

    if (_qaIsToolMode) {
      // Tool-tag mode: show Tag button per skill
      el.innerHTML = `<div class="gqi-qa-results-header">${results.length} skill${results.length !== 1 ? "s" : ""} to tag with "${esc(_qaToolName)}"</div>` +
        results.map((r, i) => {
          const alreadyTagged = (r.tools || []).some(t => t.toLowerCase() === _qaToolName.toLowerCase());
          const existingTags = (r.tools || []).map(t => `<span class="gqi-qa-tool-pill">${esc(t)}</span>`).join(" ");
          return `
        <div class="gqi-qa-result-item gqi-qa-result-taggable" data-idx="${i}">
          <div class="gqi-qa-result-info">
            <div class="gqi-qa-result-name">${esc(r.skill)} <span class="gqi-qa-result-meta">${esc(r.level)} · ${esc(r.category.replace(/_/g, " "))}</span></div>
            <div class="gqi-qa-result-evidence">${esc(r.evidence)}</div>
            ${existingTags ? `<div class="gqi-qa-result-tools">${existingTags}</div>` : ""}
          </div>
          <button class="gqi-qa-tag-btn${alreadyTagged ? " tagged" : ""}" data-idx="${i}" ${alreadyTagged ? "disabled" : ""}>${alreadyTagged ? "✓ Tagged" : "🏷 Tag"}</button>
        </div>`;
        }).join("");
      el.querySelectorAll(".gqi-qa-tag-btn:not(.tagged)").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          tagSkillWithTool(parseInt(btn.dataset.idx));
        });
      });
    } else {
      // Add-skill mode: show checkboxes (existing behavior)
      el.innerHTML = `<div class="gqi-qa-results-header">${results.length} match${results.length !== 1 ? "es" : ""} found</div>` +
        results.map((r, i) => {
          const existingTags = (r.tools || []).map(t => `<span class="gqi-qa-tool-pill">${esc(t)}</span>`).join(" ");
          return `
        <label class="gqi-qa-result-item">
          <input type="checkbox" class="gqi-qa-result-cb" data-idx="${i}" />
          <div class="gqi-qa-result-info">
            <div class="gqi-qa-result-name">${esc(r.skill)} <span class="gqi-qa-result-meta">${esc(r.level)} · ${esc(r.category.replace(/_/g, " "))}</span></div>
            <div class="gqi-qa-result-evidence">${esc(r.evidence)}</div>
            ${existingTags ? `<div class="gqi-qa-result-tools">${existingTags}</div>` : ""}
          </div>
        </label>`;
        }).join("");
      el.querySelectorAll(".gqi-qa-result-cb").forEach(cb => {
        cb.addEventListener("change", onQAResultSelectionChange);
      });
    }
  }

  // Tag an existing skill with the tool keyword
  async function tagSkillWithTool(idx) {
    const skill = _qaSearchResults[idx];
    if (!skill) return;
    const btn = document.querySelector(`.gqi-qa-tag-btn[data-idx="${idx}"]`);
    if (btn) { btn.textContent = "Tagging…"; btn.disabled = true; }
    try {
      const res = await fetch("/skill-bank/add-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skill.id, tool: _qaToolName })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      // Update local result with new tools
      skill.tools = data.chunk.tools || [];
      if (btn) { btn.textContent = "✓ Tagged"; btn.classList.add("tagged"); }
      // Flip chip to match style
      if (_qaTargetChip) {
        _qaTargetChip.classList.replace("gqi-chip-tool-gap", "gqi-chip-tool-match");
        _qaTargetChip.style.textDecoration = "";
        _qaTargetChip.style.opacity = "";
        _qaTargetChip.title = "✓ In your skill bank";
      }
      showToast(`✓ Tagged "${skill.skill}" with tool "${_qaToolName}"`);
      // Refresh tool index cache
      loadBankToolIndex();
      // Refresh result item to show the new pill
      const item = btn.closest(".gqi-qa-result-taggable");
      const toolsDiv = item?.querySelector(".gqi-qa-result-tools");
      if (toolsDiv) {
        toolsDiv.innerHTML = skill.tools.map(t => `<span class="gqi-qa-tool-pill">${esc(t)}</span>`).join(" ");
      } else if (item) {
        const info = item.querySelector(".gqi-qa-result-info");
        if (info) info.insertAdjacentHTML("beforeend", `<div class="gqi-qa-result-tools">${skill.tools.map(t => `<span class="gqi-qa-tool-pill">${esc(t)}</span>`).join(" ")}</div>`);
      }
    } catch (err) {
      showToast("Tag failed: " + err.message, "error");
      if (btn) { btn.textContent = "🏷 Tag"; btn.disabled = false; }
    }
  }

  // Called when user clicks "⚡ Generate & Add" in tool-tag mode with no search results.
  // Generates evidence via /skill-bank/suggest, shows an editable confirm form,
  // then saves the new skill + immediately tags it with the tool name.
  async function generateAndAddSkill() {
    const resultsEl = document.getElementById("gqi-qa-results");
    const genBtn    = document.getElementById("gqi-qa-inline-gen-btn");
    const level     = document.getElementById("gqi-qa-inline-level")?.value || "Intermediate";
    if (!_qaToolName || !resultsEl) return;

    if (genBtn) { genBtn.textContent = "⚡ Generating…"; genBtn.disabled = true; }

    try {
      const suggestRes  = await fetch("/skill-bank/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill: _qaToolName, level })
      });
      const suggestData = await suggestRes.json();
      if (!suggestData.success) throw new Error(suggestData.error || "Generate failed");

      const category = suggestData.category || "Tools";
      const evidence = suggestData.suggestion || "";

      // Show editable confirm form
      resultsEl.innerHTML = `
        <div style="padding:8px 0;">
          <div style="font-size:12px;color:var(--text-muted,#888);margin-bottom:6px;">
            New skill · <strong>${esc(_qaToolName)}</strong> · ${esc(level)} · ${esc(category)}
          </div>
          <textarea id="gqi-qa-inline-evidence" rows="3"
            style="width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #ccc;font-size:13px;resize:vertical;">${esc(evidence)}</textarea>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button type="button" id="gqi-qa-inline-save-btn" class="btn btn-sm"
              style="background:var(--gqi-accent,#5b4fcf);color:#fff;padding:4px 14px;">💾 Save &amp; Tag</button>
            <button type="button" id="gqi-qa-inline-back-btn" class="btn btn-sm">↩ Back</button>
          </div>
        </div>`;

      document.getElementById("gqi-qa-inline-back-btn")?.addEventListener("click", () => {
        searchSkillBank(_qaToolName);
      });

      document.getElementById("gqi-qa-inline-save-btn")?.addEventListener("click", async () => {
        const finalEvidence = document.getElementById("gqi-qa-inline-evidence")?.value?.trim();
        if (!finalEvidence) return;
        const saveBtn = document.getElementById("gqi-qa-inline-save-btn");
        if (saveBtn) { saveBtn.textContent = "Saving…"; saveBtn.disabled = true; }

        try {
          // 1. Add skill to bank
          const addRes  = await fetch("/skill-bank/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category, skill: _qaToolName, level, evidence: finalEvidence })
          });
          const addData = await addRes.json();
          if (!addData.success) throw new Error(addData.error);

          // 2. Tag the new skill with the tool name (the chip keyword)
          const tagRes  = await fetch("/skill-bank/add-tool", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: addData.chunk.id, tool: _qaToolName })
          });
          const tagData = await tagRes.json();
          if (!tagData.success) throw new Error(tagData.error);

          // Flip chip to matched style
          if (_qaTargetChip) {
            _qaTargetChip.classList.replace("gqi-chip-tool-gap", "gqi-chip-tool-match");
            _qaTargetChip.style.textDecoration = "";
            _qaTargetChip.style.opacity        = "";
            _qaTargetChip.title                = "✓ In your skill bank";
            _qaTargetChip.dataset.skillId      = addData.chunk.id;
          }
          showToast(`✓ "${_qaToolName}" added to skill bank and tagged`);
          loadBankToolIndex();
          hideQuickAdd();
        } catch (err) {
          showToast("Save failed: " + err.message, "error");
          if (saveBtn) { saveBtn.textContent = "💾 Save & Tag"; saveBtn.disabled = false; }
        }
      });

    } catch (err) {
      showToast("Generate failed: " + err.message, "error");
      // Restore the generate button
      searchSkillBank(_qaToolName);
    }
  }

  function onQAResultSelectionChange() {
    const checked = document.querySelectorAll(".gqi-qa-result-cb:checked");
    const evidenceEl = document.getElementById("gqi-qa-evidence");
    if (!evidenceEl) return;
    if (checked.length === 0) {
      evidenceEl.value = "";
      evidenceEl.placeholder = "Select results above or click Generate…";
      return;
    }
    const parts = [];
    checked.forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      if (_qaSearchResults[idx]) parts.push(_qaSearchResults[idx].evidence);
    });
    evidenceEl.value = parts.join(" | ");
    // Apply first match's category
    const firstIdx = parseInt(checked[0].dataset.idx);
    if (_qaSearchResults[firstIdx]) {
      const catEl = document.getElementById("gqi-qa-category");
      if (catEl) catEl.value = _qaSearchResults[firstIdx].category;
    }
  }

  async function generateQAEvidence() {
    const evidenceEl = document.getElementById("gqi-qa-evidence");
    const genBtn     = document.getElementById("gqi-qa-generate");
    if (!evidenceEl || !_qaToolName) return;
    if (genBtn) { genBtn.textContent = "⚡ Generating…"; genBtn.disabled = true; }
    try {
      const checked = document.querySelectorAll(".gqi-qa-result-cb:checked");
      const selectedEvidence = [];
      checked.forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        if (_qaSearchResults[idx]) selectedEvidence.push(_qaSearchResults[idx].evidence);
      });
      const level = document.getElementById("gqi-qa-level")?.value || "Intermediate";

      if (selectedEvidence.length > 0) {
        // Synthesize from selected evidence
        const res  = await fetch("/skill-bank/synthesize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword: _qaToolName, evidence: selectedEvidence, level })
        });
        const data = await res.json();
        if (data.success) {
          evidenceEl.value = data.evidence;
        } else {
          throw new Error(data.error || "Synthesis failed");
        }
      } else {
        // No selections → generate from scratch
        const res  = await fetch("/skill-bank/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skill: _qaToolName, level })
        });
        const data = await res.json();
        if (data.success && data.suggestion) {
          evidenceEl.value = data.suggestion;
          const catEl = document.getElementById("gqi-qa-category");
          if (catEl && data.category) catEl.value = data.category;
        }
      }
      // Flash to indicate new content
      evidenceEl.style.borderColor = "var(--gqi-pct-high)";
      setTimeout(() => { evidenceEl.style.borderColor = ""; }, 800);
    } catch (err) {
      showToast("Generate failed: " + err.message, "error");
    } finally {
      if (genBtn) { genBtn.textContent = "⚡ Generate"; genBtn.disabled = false; }
    }
  }

  async function fetchEvidenceSuggestion() {
    const evidenceEl  = document.getElementById("gqi-qa-evidence");
    const catEl       = document.getElementById("gqi-qa-category");
    const suggestBtn  = document.getElementById("gqi-qa-suggest-btn");
    const level       = document.getElementById("gqi-qa-level")?.value   || "Intermediate";
    if (!evidenceEl || !_qaToolName) return;
    if (suggestBtn) suggestBtn.classList.add("loading");
    evidenceEl.placeholder = "Generating suggestion…";
    evidenceEl.value = "";
    try {
      const res  = await fetch("/skill-bank/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill: _qaToolName, level })
      });
      const data = await res.json();
      if (data.success && data.suggestion) {
        evidenceEl.value = data.suggestion;
        evidenceEl.placeholder = "";
        // Apply AI-suggested category (only if user hasn't manually changed it)
        if (catEl && data.category) catEl.value = data.category;
      } else {
        evidenceEl.placeholder = "e.g. Used for 2 years in marketing role";
      }
    } catch {
      evidenceEl.placeholder = "e.g. Used for 2 years in marketing role";
    } finally {
      if (suggestBtn) suggestBtn.classList.remove("loading");
    }
  }

  async function rephraseEvidence() {
    const evidenceEl = document.getElementById("gqi-qa-evidence");
    const btn        = document.getElementById("gqi-qa-rephrase");
    const current    = evidenceEl?.value.trim();
    if (!current) { evidenceEl?.focus(); return; }
    if (btn) { btn.textContent = "✨ Rephrasing…"; btn.disabled = true; }
    try {
      const res  = await fetch("/skill-bank/rephrase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: current, skill: _qaToolName })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      evidenceEl.value = data.rephrased;
      // Flash the textarea briefly to signal change
      evidenceEl.style.borderColor = "var(--gqi-pct-high)";
      setTimeout(() => { evidenceEl.style.borderColor = ""; }, 800);
    } catch (err) {
      showToast("Rephrase failed: " + err.message, "error");
    } finally {
      if (btn) { btn.textContent = "✨ Rephrase"; btn.disabled = false; }
    }
  }

  function hideQuickAdd() {
    document.getElementById("gqi-quick-add")?.classList.add("hidden");
    _qaTargetChip = null;
    _qaToolName   = null;
  }

  async function submitQuickAdd() {
    const addBtn = document.getElementById("gqi-qa-add");
    const cat      = document.getElementById("gqi-qa-category").value;
    const level    = document.getElementById("gqi-qa-level").value;
    const evidence = document.getElementById("gqi-qa-evidence").value.trim();
    if (!evidence) { document.getElementById("gqi-qa-evidence").focus(); return; }
    if (addBtn) { addBtn.textContent = "Adding…"; addBtn.disabled = true; }
    try {
      const res  = await fetch("/skill-bank/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: cat, skill: _qaToolName, level, evidence })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      // Flip chip to green "match" style immediately
      if (_qaTargetChip) {
        _qaTargetChip.classList.replace("gqi-chip-tool-gap", "gqi-chip-tool-match");
        _qaTargetChip.style.textDecoration = "";
        _qaTargetChip.style.opacity = "";
        _qaTargetChip.title = "✓ In your skill bank";
        _qaTargetChip.dataset.skillId = data.chunk.id;
      }
      showToast(`✓ "${_qaToolName}" added to skill bank (${data.chunk.id})`);
      hideQuickAdd();
    } catch (err) {
      showToast("Add failed: " + err.message, "error");
      if (addBtn) { addBtn.textContent = "Add to Bank ✓"; addBtn.disabled = false; }
    }
  }

  async function deleteFromBank(toolName, chipEl) {
    if (!confirm(`Remove "${toolName}" from your skill bank?`)) return;
    try {
      // Find the skill ID — prefer data attribute set on add, else fetch bank
      let skillId = chipEl.dataset.skillId || null;
      if (!skillId) {
        const r = await fetch("/skill-bank");
        const d = await r.json();
        const tl = toolName.toLowerCase();
        const match = (d.skill_chunks || []).find(s => s.skill.toLowerCase() === tl ||
          s.skill.toLowerCase().includes(tl) || tl.includes(s.skill.toLowerCase()));
        if (!match) { showToast(`"${toolName}" not found in skill bank`, "error"); return; }
        skillId = match.id;
      }
      const res  = await fetch("/skill-bank/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: skillId })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      // Flip chip back to grey gap style
      chipEl.classList.replace("gqi-chip-tool-match", "gqi-chip-tool-gap");
      chipEl.title = "⚠ Not in skill bank";
      delete chipEl.dataset.skillId;
      showToast(`"${toolName}" removed from skill bank`);
    } catch (err) {
      showToast("Delete failed: " + err.message, "error");
    }
  }

  function initChipInteractions() {
    const listEl = document.getElementById("gen-queue-list");
    if (!listEl) return;

    // Single click: TOOLS chips → tool-tag mode; SKILLS chips → add mode
    listEl.addEventListener("click", (e) => {
      const chip = e.target.closest(".gqi-chip");
      if (!chip) return;
      const name = chip.childNodes[0]?.textContent?.trim() || chip.textContent.replace("opt", "").trim();
      if (chip.classList.contains("gqi-chip-tool-gap") || chip.classList.contains("gqi-chip-tool-match")) {
        showQuickAdd(name, chip, true);  // tool-tag mode
      } else if (chip.classList.contains("gqi-chip-skill")) {
        showQuickAdd(name, chip, false); // add-skill mode
      }
    });

    // Double-click match chip: delete from bank
    listEl.addEventListener("dblclick", (e) => {
      const chip = e.target.closest(".gqi-chip");
      if (!chip) return;
      const name = chip.childNodes[0]?.textContent?.trim() || chip.textContent.replace("opt", "").trim();
      if (chip.classList.contains("gqi-chip-tool-match")) {
        deleteFromBank(name, chip);
      }
    });

    // ── Drag-to-move the dialog via its header ──
    const dlg = document.getElementById("gqi-quick-add");
    const header = document.getElementById("gqi-qa-header");
    if (dlg && header) {
      let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
      header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button")) return;
        dragging = true;
        const rect = dlg.getBoundingClientRect();
        origLeft = rect.left;
        origTop  = rect.top;
        startX   = e.clientX;
        startY   = e.clientY;
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const nx = Math.max(0, origLeft + (e.clientX - startX));
        const ny = Math.max(0, origTop  + (e.clientY - startY));
        dlg.style.left   = nx + "px";
        dlg.style.top    = ny + "px";
        dlg.style.bottom = "auto";
        dlg.style.right  = "auto";
      });
      document.addEventListener("mouseup", () => { dragging = false; });
    }

    // Dialog button wiring (runs once)
    document.getElementById("gqi-qa-add")?.addEventListener("click", submitQuickAdd);
    document.getElementById("gqi-qa-cancel")?.addEventListener("click", hideQuickAdd);
    document.getElementById("gqi-qa-close")?.addEventListener("click", hideQuickAdd);
    document.getElementById("gqi-qa-tool-cancel")?.addEventListener("click", hideQuickAdd);
    document.getElementById("gqi-qa-suggest-btn")?.addEventListener("click", fetchEvidenceSuggestion);
    document.getElementById("gqi-qa-rephrase")?.addEventListener("click", rephraseEvidence);
    document.getElementById("gqi-qa-generate")?.addEventListener("click", generateQAEvidence);
    // Search bar: search on Enter or button click
    document.getElementById("gqi-qa-search")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); searchSkillBank(e.target.value); }
    });
    document.getElementById("gqi-qa-search-btn")?.addEventListener("click", () => {
      const q = document.getElementById("gqi-qa-search")?.value;
      if (q) searchSkillBank(q);
    });
    document.getElementById("gqi-qa-evidence")?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideQuickAdd();
    });
    // Close when clicking outside
    document.addEventListener("mousedown", (e) => {
      const dlg = document.getElementById("gqi-quick-add");
      if (dlg && !dlg.classList.contains("hidden") && !dlg.contains(e.target) && !e.target.closest(".gqi-chip")) {
        hideQuickAdd();
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════
  async function loadBankToolIndex() {
    try {
      const res = await fetch("/skill-bank");
      const data = await res.json();
      if (data.success) {
        const idx = {};
        for (const s of (data.skill_chunks || [])) {
          // Index skill name
          idx[s.skill.toLowerCase()] = true;
          // Index tool tags
          for (const t of (s.tools || [])) idx[t.toLowerCase()] = true;
        }
        genState.bankToolIndex = idx;
      }
    } catch { /* silent — tool index is optional enhancement */ }
  }

  // ═══════════════════════════════════════════════════════════════
  // ✨ POLISH DRAWER
  // ═══════════════════════════════════════════════════════════════

  function initPolishDrawer() {
    const popup     = document.getElementById("polish-popup");
    const header    = document.getElementById("polish-popup-header");
    const closeBtn  = document.getElementById("polish-drawer-close");
    const openBtn   = document.getElementById("polishNavBtn");
    const resetBtn  = document.getElementById("polish-reset-size");
    const runBtn    = document.getElementById("polish-run-btn");
    const copyBtn   = document.getElementById("polish-copy-btn");
    const inputTa   = document.getElementById("polish-input");
    const outputTa  = document.getElementById("polish-output");
    const inputWc   = document.getElementById("polish-input-wc");
    const status    = document.getElementById("polish-status");
    const outputSec = document.getElementById("polish-output-section");
    const wcDiff    = document.getElementById("polish-wc-diff");
    let   activeMode = "cl";

    if (!popup) return;

    openBtn?.addEventListener("click", () => popup.classList.toggle("hidden"));
    document.getElementById("polish-fab")?.addEventListener("click", () => popup.classList.toggle("hidden"));
    closeBtn?.addEventListener("click", () => popup.classList.add("hidden"));

    // Reset size & position
    resetBtn?.addEventListener("click", () => {
      popup.style.width = ""; popup.style.height = "";
      popup.style.top = ""; popup.style.left = "";
      popup.style.bottom = ""; popup.style.right = "";
    });

    // Drag-to-move via header
    if (header) {
      let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
      header.addEventListener("mousedown", (e) => {
        if (e.target.closest("button, input, select")) return;
        dragging = true;
        const rect = popup.getBoundingClientRect();
        popup.style.top    = rect.top  + "px";
        popup.style.left   = rect.left + "px";
        popup.style.bottom = "auto";
        popup.style.right  = "auto";
        startX = e.clientX; startY = e.clientY;
        origLeft = rect.left; origTop = rect.top;
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        popup.style.left = Math.max(0, origLeft + (e.clientX - startX)) + "px";
        popup.style.top  = Math.max(0, origTop  + (e.clientY - startY)) + "px";
      });
      document.addEventListener("mouseup", () => { dragging = false; });
    }

    // Mode toggle
    document.querySelectorAll(".polish-mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".polish-mode-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        activeMode = btn.dataset.mode;
      });
    });

    // Live word count on input
    function countWords(str) { return str.trim() ? str.trim().split(/\s+/).length : 0; }
    inputTa?.addEventListener("input", () => {
      const n = countWords(inputTa.value);
      if (inputWc) inputWc.textContent = `${n} word${n !== 1 ? "s" : ""}`;
    });

    // Run: apply style then humanize
    runBtn?.addEventListener("click", async () => {
      const raw = inputTa?.value?.trim();
      if (!raw) { inputTa?.focus(); return; }

      runBtn.disabled = true;
      runBtn.textContent = "⚡ Applying style…";
      outputSec?.classList.add("hidden");
      status?.classList.remove("hidden");
      if (status) status.textContent = "Pass 1 — applying Varun's writing style…";

      try {
        // Pass 1: style
        const styleRes  = await fetch("/apply-style", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: raw, mode: activeMode })
        });
        const styleData = await styleRes.json();
        if (!styleData.success) throw new Error(styleData.error || "Style pass failed");

        if (status) status.textContent = "Pass 2 — removing AI patterns…";
        runBtn.textContent = "⚡ Humanizing…";

        // Pass 2: humanize
        const humanRes  = await fetch("/humanize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: styleData.styled })
        });
        const humanData = await humanRes.json();
        if (!humanData.success) throw new Error(humanData.error || "Humanize pass failed");

        const finalText = (humanData.humanized || styleData.styled).trim();
        if (outputTa) outputTa.value = finalText;

        const inWords  = countWords(raw);
        const outWords = countWords(finalText);
        const diff     = outWords - inWords;
        if (wcDiff) wcDiff.textContent = `${inWords}w → ${outWords}w${diff !== 0 ? ` (${diff > 0 ? "+" : ""}${diff})` : ""}`;

        outputSec?.classList.remove("hidden");
        status?.classList.add("hidden");
        showToast("✨ Polished");
      } catch (err) {
        status?.classList.add("hidden");
        showToast("Polish failed: " + err.message, "error");
      } finally {
        runBtn.disabled  = false;
        runBtn.textContent = "✨ Apply Style + Humanize";
      }
    });

    // Copy button
    copyBtn?.addEventListener("click", () => {
      const text = outputTa?.value;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "✓ Copied";
        setTimeout(() => { copyBtn.textContent = "⎘ Copy"; }, 1500);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // A4 LIVE PREVIEW RENDERER
  // ═══════════════════════════════════════════════════════════════

  function updateA4Preview() {
    const ta   = $("gen-fullview-textarea");
    const page = $("gen-fv-a4-page");
    if (!ta || !page) return;
    const docType = ta._docType || "cv";
    page.innerHTML = docType === "cl" ? renderClA4(ta.value) : renderCvA4(ta.value);
  }

  // ── Shared LaTeX strip helper ───────────────────────────────
  function stripTex(s) {
    return (s || '')
      .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
      .replace(/\\url\{([^}]*)\}/g, '$1')
      .replace(/\\textbf\{([^}]*)\}/g, '$1')
      .replace(/\\textit\{([^}]*)\}/g, '$1')
      .replace(/\\textsc\{([^}]*)\}/g, '$1')
      .replace(/\\color\{[^}]*\}/g, '')
      .replace(/\\small\b|\\large\b|\\Huge\b|\\bfseries\b|\\itshape\b/g, '')
      .replace(/\\nobreakdash/g, '-')
      .replace(/\\enspace\b/g, ' ')
      .replace(/\\quad\b/g, '  ')
      .replace(/\\textbar\{\}/g, '|')
      .replace(/\\textbackslash\{\}/g, '\\')
      .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\#/g, '#')
      .replace(/\\_/g, '_').replace(/\\par\b/g, '')
      .replace(/\\vspace\{[^}]*\}|\\sectrule\b|\\pagestyle\{[^}]*\}/g, '')
      .replace(/\{|\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Extract body after \begin{document} ────────────────────
  function extractDocBody(text) {
    let body = text;
    const di = body.indexOf('\\begin{document}');
    if (di !== -1) body = body.slice(di + '\\begin{document}'.length);
    const ei = body.indexOf('\\end{document}');
    if (ei !== -1) body = body.slice(0, ei);
    return body;
  }

  function renderCvA4(text) {
    if (!text?.trim()) return `<p class="fv-empty">Start typing to see preview…</p>`;
    const h = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const body = extractDocBody(text);
    let html = '';

    // ── Name ──
    const nameM = /\\name\{([^}]+)\}/.exec(body);
    if (nameM) {
      html += `<div class="fv-contact">`;
      html += `<div class="fv-name">${h(stripTex(nameM[1]))}</div>`;
      // Contact block: {\small\n...\n}
      const smallM = /\{\\small\n([\s\S]*?)\n\}/.exec(body);
      if (smallM) {
        smallM[1].split('\\par').forEach(part => {
          const t = stripTex(part);
          if (t) html += `<div class="fv-contact-line">${h(t)}</div>`;
        });
      }
      html += `</div><hr class="fv-rule">`;
    }

    // ── Sections: split on \section*{...} ──
    const secRe = /\\section\*\{([^}]+)\}/g;
    const secs = [];
    let sm;
    while ((sm = secRe.exec(body)) !== null) {
      secs.push({ name: sm[1], matchStart: sm.index, contentStart: sm.index + sm[0].length });
    }

    secs.forEach((sec, idx) => {
      const contentEnd = idx + 1 < secs.length ? secs[idx + 1].matchStart : body.length;
      const secBody = body.slice(sec.contentStart, contentEnd);

      html += `<div class="fv-section">`;
      html += `<div class="fv-section-hdr">${h(sec.name)}</div>`;

      if (/\\cventry\{/.test(secBody)) {
        // Entry-based section (Education, Work Experience, Projects…)
        const eRe = /\\cventry\{([^}]*)\}\{([^}]*)\}|\\cvsubtitle\{([^}]*)\}|\\cvbody\{([^}]*)\}/g;
        let em;
        while ((em = eRe.exec(secBody)) !== null) {
          if (em[1] !== undefined) {
            html += `<div class="fv-entry-row">` +
              `<span class="fv-entry-title">${h(stripTex(em[1]))}</span>` +
              `<span class="fv-entry-date">${h(stripTex(em[2]))}</span></div>`;
          } else if (em[3] !== undefined) {
            html += `<div class="fv-subtitle">${h(stripTex(em[3]))}</div>`;
          } else if (em[4] !== undefined) {
            html += `<div class="fv-cvbody">${h(stripTex(em[4]))}</div>`;
          }
        }
      } else {
        // Plain-text section (Profile, Key Competencies, Technical Skills)
        const cleaned = secBody
          .replace(/\\vspace\{[^}]*\}|\\sectrule\b/g, '')
          .split('\n')
          .map(l => stripTex(l))
          .filter(Boolean)
          .join(' ');
        if (cleaned) html += `<div class="fv-cvbody">${h(cleaned)}</div>`;
      }

      html += `</div>`;
    });

    return html || `<p class="fv-empty">Start typing to see preview…</p>`;
  }

  function renderClA4(text) {
    if (!text?.trim()) return `<p class="fv-empty">Start typing to see preview…</p>`;
    const h = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let body = extractDocBody(text);
    let html = '';

    // Extract \begin{center}...\end{center} blocks (title + position info)
    const centerBlocks = [];
    body = body.replace(/\\begin\{center\}([\s\S]*?)\\end\{center\}/g, (_, c) => {
      centerBlocks.push(c.trim());
      return '\n';
    });
    if (centerBlocks[0]) html += `<div class="fv-cl-title">${h(stripTex(centerBlocks[0]))}</div>`;
    if (centerBlocks[1]) html += `<div class="fv-cl-meta">${h(stripTex(centerBlocks[1]))}</div>`;

    // Remaining body → paragraphs
    body = body.replace(/\\vspace\{[^}]*\}/g, '\n');
    body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).forEach(para => {
      const t = stripTex(para);
      if (!t) return;
      if (/^best regards/i.test(t) || /^varun\s+raval$/i.test(t)) {
        html += `<div class="fv-cl-sign">${h(t)}</div>`;
      } else if (para.includes('raval.varun@') || para.includes('linkedin.com') || para.includes('github.com')) {
        html += `<div class="fv-cl-footer">${h(t)}</div>`;
      } else if (/i am open to/i.test(t)) {
        html += `<div class="fv-cl-footer">${h(t)}</div>`;
      } else {
        html += `<p class="fv-cl-para">${h(t)}</p>`;
      }
    });

    return html || `<p class="fv-empty">Start typing to see preview…</p>`;
  }

  function init() {
    bindEvents();
    renderQueue();
    loadRagStatus();
    initChipInteractions();
    loadBankToolIndex();
    initPolishDrawer();
  }

  window.GenerateModule = { addToQueue, init };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
