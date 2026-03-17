/**
 * SAP Job Automator — Main Application Logic
 * Ported from SAPcareers-tracker with 4-view navigation:
 *   Search | Generate | Tracker (Kanban) | Analytics
 */
(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════
  // CONSTANTS
  // ═══════════════════════════════════════════════════════════════
  const STORAGE_KEY = "job_hunt_hq_applications";
  const GOAL_KEY = "job_hunt_hq_weekly_goal";
  const THEME_KEY = "job_hunt_hq_theme";
  const THEME_EVENT = "jobhunt-theme-changed";
  const STAGES = ["Wishlist", "Applied", "OA/Test", "Interview", "Rejected", "Offer"];
  const DEFAULT_COMPANY_SHORTCUTS = ["SAP", "Siemens", "DHL"];

  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════
  let currentUserId = null;
  let useFirebase = false;

  const anCharts = { bar: null, donut: null };

  const quoteState = { selectedQuote: "", typingTimer: null, canReplayOnScroll: true, observer: null };

  const state = {
    applications: [],
    currentWeeklyGoal: parseInt(safeStorageGet(GOAL_KEY), 10) || 10,
    currentFilter: "all",
    currentCompanyFilter: "all",
    currentSort: "deadline-asc",
    searchQuery: "",
    editingId: null,
    theme: safeStorageGet(THEME_KEY) || "light"
  };

  const anState = {
    initialized: false, isOpen: false,
    from: "", to: "", company: "", location: "", keyword: "", search: "",
    statuses: new Set(["W", "A", "O", "I", "R", "F"]),
    sort: "deadline", filtered: []
  };

  // search view state
  const scrapeState = { jobs: [], selected: new Map() };

  // ═══════════════════════════════════════════════════════════════
  // SAFE STORAGE
  // ═══════════════════════════════════════════════════════════════
  function safeStorageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function safeStorageSet(key, val) { try { localStorage.setItem(key, val); } catch { /* */ } }
  function safeStorageRemove(key) { try { localStorage.removeItem(key); } catch { /* */ } }

  // ═══════════════════════════════════════════════════════════════
  // DOM REFS
  // ═══════════════════════════════════════════════════════════════
  const $ = (id) => document.getElementById(id);
  const DOM = {};

  function cacheDom() {
    const ids = [
      "toast-container", "modal-backdrop", "modal-box",
      "theme-toggle", "theme-icon", "account-status", "account-logout-btn",
      "import-data-btn", "import-file-input", "download-template-btn", "export-csv-btn",
      "open-modal-btn",
      "goal-bar-fill", "goal-text", "goal-edit-btn",
      "analyticsBtn", "dashboardBtn", "searchNavBtn", "generateNavBtn",
      "searchView", "generateView", "kanbanView", "analyticsView",
      "anTopCount", "anFrom", "anTo",
      "anExportBtn", "anRefreshBtn",
      "anStatusChecks", "anCompany", "anLocation", "anKeyword",
      "anApplyFiltersBtn", "anClearFiltersBtn", "anStatusCount",
      "anActiveChips", "anSearch", "anSort",
      "anTableBody", "anTableCount", "anEmpty",
      "anStatTotal", "anStatRate", "anStatActive", "anStatOffers", "anStatOfferRate",
      "anBarChart", "anDonutChart",
      "stat-total", "stat-applied", "stat-interview", "stat-offers", "stat-followup", "stat-response", "stat-rate",
      "search-input", "sort-select", "active-filter-bar", "active-filter-label",
      "company-shortcuts", "kanban-board", "scroll-to-top-btn", "filter-chips",
      "motivational-quote-container",
      // search view
      "scrape-keyword", "scrape-location", "scrape-period", "scrape-careerStatus", "scrape-country",
      "scrape-search-btn", "scrape-spinner", "scrape-btn-text", "scrape-result-count",
      "scrape-results-body", "selected-jobs-card", "selected-count", "selected-jobs-list",
      "add-to-tracker-btn", "go-generate-btn"
    ];
    ids.forEach((id) => {
      const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      DOM[camel] = $(id);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9); }

  function showToast(msg, type) {
    if (!DOM.toastContainer) return;
    const t = document.createElement("div");
    t.className = `toast toast-${type || "info"}`;
    t.textContent = msg;
    DOM.toastContainer.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
  }

  function compareDates(a, b, asc) {
    const da = a ? new Date(a).getTime() : (asc ? Infinity : -Infinity);
    const db = b ? new Date(b).getTime() : (asc ? Infinity : -Infinity);
    return asc ? da - db : db - da;
  }

  function toIsoDate(val) {
    if (!val) return "";
    const d = new Date(val);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  function normalizeCompanyKey(c) { return String(c || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function findCompanyByShortcut(q) {
    const k = normalizeCompanyKey(q);
    const all = [...new Set(state.applications.map((a) => a.company).filter(Boolean))];
    return all.find((c) => normalizeCompanyKey(c).includes(k));
  }

  function checkFirebase() {
    return !!(window.FirebaseAPI && FirebaseAPI.isReady && FirebaseAPI.isReady());
  }

  function isFollowupDue(app) {
    if (!app.followupDate) return false;
    return new Date(app.followupDate) <= new Date();
  }

  // ═══════════════════════════════════════════════════════════════
  // VIEW NAVIGATION
  // ═══════════════════════════════════════════════════════════════
  const views = { search: "searchView", generate: "generateView", dashboard: "kanbanView", analytics: "analyticsView", skillbank: "skillBankView" };
  let currentView = "search";

  function switchView(view) {
    if (!views[view]) return;
    currentView = view;
    Object.entries(views).forEach(([key, elId]) => {
      const el = $(elId);
      if (el) el.style.display = key === view ? "" : "none";
    });
    document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
      const v = btn.dataset.view || btn.id.replace("Btn", "").replace("Nav", "");
      btn.classList.toggle("active", v === view);
    });
    // refresh analytics when opening
    if (view === "analytics" && anState.initialized) { anState.isOpen = true; an_refresh(); }
    else { anState.isOpen = false; }
  }

  // ═══════════════════════════════════════════════════════════════
  // THEME
  // ═══════════════════════════════════════════════════════════════
  function setupTheme() {
    const saved = safeStorageGet(THEME_KEY) || "light";
    state.theme = saved;
    applyTheme(saved);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    state.theme = theme;
    if (DOM.themeIcon) DOM.themeIcon.textContent = theme === "dark" ? "☾" : "☀";
    const authIcon = $("auth-theme-icon");
    if (authIcon) authIcon.textContent = theme === "dark" ? "☾" : "☀";
  }

  function toggleTheme() {
    const next = state.theme === "dark" ? "light" : "dark";
    safeStorageSet(THEME_KEY, next);
    applyTheme(next);
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: next } }));
    if (useFirebase && currentUserId) {
      FirebaseAPI.db.saveSettings(currentUserId, { theme: next, weeklyGoal: state.currentWeeklyGoal });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ACCOUNT UI
  // ═══════════════════════════════════════════════════════════════
  function updateAccountStatusUI(user) {
    if (!DOM.accountStatus) return;
    if (user) {
      const email = user.email || "Signed in";
      DOM.accountStatus.textContent = email.split("@")[0];
      DOM.accountStatus.title = email;
    } else {
      DOM.accountStatus.textContent = "Signed out";
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // APPLICATION PERSISTENCE
  // ═══════════════════════════════════════════════════════════════
  function loadApplications() {
    try { return JSON.parse(safeStorageGet(STORAGE_KEY)) || []; } catch { return []; }
  }

  function saveApplications() {
    if (!useFirebase) safeStorageSet(STORAGE_KEY, JSON.stringify(state.applications));
  }

  async function persistApplication(app) {
    if (useFirebase && currentUserId) {
      await FirebaseAPI.db.saveApplication(currentUserId, app);
    } else {
      saveApplications();
    }
  }

  async function deleteApplicationById(appId) {
    state.applications = state.applications.filter((a) => a.id !== appId);
    if (useFirebase && currentUserId) {
      await FirebaseAPI.db.deleteApplication(currentUserId, appId);
    } else {
      saveApplications();
    }
    renderUI();
    showToast("Application deleted");
  }

  async function moveApplicationToStage(appId, targetStage) {
    const idx = state.applications.findIndex((a) => a.id === appId);
    if (idx < 0 || state.applications[idx].stage === targetStage) return;
    state.applications[idx] = { ...state.applications[idx], stage: targetStage, updatedAt: new Date().toISOString() };
    await persistApplication(state.applications[idx]);
    renderUI();
    showToast(`Moved to ${targetStage}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // FILTER / SORT
  // ═══════════════════════════════════════════════════════════════
  function applySearchInput(raw) {
    const trimmed = String(raw || "").trim();
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const first = parts[0] || "";
    if (first.startsWith("\\") && first.length > 1) {
      const matched = findCompanyByShortcut(first.slice(1));
      if (matched) { state.currentCompanyFilter = matched; state.searchQuery = parts.slice(1).join(" ").toLowerCase(); return; }
    }
    state.searchQuery = trimmed.toLowerCase();
  }

  function getFilteredApplications() {
    let f = [...state.applications];
    if (state.currentFilter !== "all") f = f.filter((a) => a.stage === state.currentFilter);
    if (state.currentCompanyFilter !== "all") {
      const ck = normalizeCompanyKey(state.currentCompanyFilter);
      f = f.filter((a) => { const ak = normalizeCompanyKey(a.company); return ak.includes(ck) || ck.includes(ak); });
    }
    if (state.searchQuery) {
      const q = state.searchQuery;
      f = f.filter((a) => [a.company, a.role, a.contactType, a.contactName, a.notes].join(" ").toLowerCase().includes(q));
    }
    f.sort((a, b) => {
      switch (state.currentSort) {
        case "deadline-desc": return compareDates(a.deadline, b.deadline, false);
        case "date-desc": return compareDates(a.createdAt, b.createdAt, false);
        case "date-asc": return compareDates(a.createdAt, b.createdAt, true);
        case "company-asc": return (a.company || "").localeCompare(b.company || "");
        case "fit-desc": return (b.fitRating || 0) - (a.fitRating || 0);
        default: return compareDates(a.deadline, b.deadline, true);
      }
    });
    return f;
  }

  // ═══════════════════════════════════════════════════════════════
  // KANBAN RENDERING
  // ═══════════════════════════════════════════════════════════════
  function renderKanban() {
    if (!DOM.kanbanBoard) return;
    const filtered = getFilteredApplications();
    DOM.kanbanBoard.innerHTML = "";
    for (const stage of STAGES) {
      const col = document.createElement("section");
      col.className = "kanban-column";
      col.dataset.stage = stage;
      const slug = stage.toLowerCase().replace(/[^a-z]/g, "");
      const items = filtered.filter((a) => a.stage === stage);
      col.innerHTML =
        `<div class="column-header"><h3 class="column-title">${stage}</h3><span class="column-count">${items.length}</span></div>` +
        `<div class="column-list" id="column-${slug}" data-stage="${stage}"></div>`;
      const list = col.querySelector(".column-list");
      if (items.length === 0) {
        list.innerHTML = `<div class="empty-column"><p>No ${stage.toLowerCase()} applications</p></div>`;
      } else {
        items.forEach((app) => list.appendChild(renderCard(app)));
      }
      DOM.kanbanBoard.appendChild(col);
    }
    bindKanbanDnD();
  }

  function renderCard(app) {
    const card = document.createElement("article");
    card.className = "kanban-card";
    card.draggable = true;
    card.dataset.appId = app.id;

    // urgency
    if (app.deadline) {
      const diff = (new Date(app.deadline) - new Date()) / 864e5;
      if (diff < 0) card.classList.add("urgent-critical");
      else if (diff < 3) card.classList.add("urgent-soon");
    }

    const slug = (app.stage || "").toLowerCase().replace(/[^a-z]/g, "");
    card.innerHTML =
      `<div class="card-head-row">
        <div class="card-brand"><p class="card-company">${esc(app.company)}</p><p class="card-location">${esc(app.location || "")}</p></div>
        <details class="card-menu-wrap"><summary class="card-menu-btn">⋯</summary>
          <div class="card-menu"><button type="button" data-action="edit">Edit</button><button type="button" data-action="delete">Delete</button></div>
        </details>
      </div>
      <h4 class="card-title">${esc(app.role)}</h4>
      <div class="card-meta-row">${app.deadline ? `<span>Due ${app.deadline}</span>` : ""} ${app.reqId ? `<span>ID ${esc(app.reqId)}</span>` : ""}</div>
      <div class="card-footer-row">
        <span class="stage-pill stage-pill-${slug}">${app.stage}</span>
        ${app.link ? `<a class="open-link-btn" href="${esc(app.link)}" target="_blank" rel="noopener">Open ↗</a>` : ""}
      </div>
      ${app.notes ? `<div class="card-notes">${esc(app.notes)}</div>` : ""}`;

    card.querySelector('[data-action="edit"]')?.addEventListener("click", () => openModal(app.id));
    card.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
      if (confirm(`Delete "${app.company} — ${app.role}"?`)) deleteApplicationById(app.id);
    });
    card.addEventListener("dblclick", () => openModal(app.id));
    card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", app.id); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    return card;
  }

  function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  function bindKanbanDnD() {
    document.querySelectorAll(".column-list").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("drag-over"); });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("drag-over"); moveApplicationToStage(e.dataTransfer.getData("text/plain"), col.dataset.stage); });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════════════
  function renderStats() {
    const apps = state.applications;
    const counts = {};
    STAGES.forEach((s) => counts[s] = apps.filter((a) => a.stage === s).length);
    const total = apps.length;
    const rr = total > 0 ? Math.round(((counts.Interview + counts.Offer) / total) * 100) : 0;
    if (DOM.statTotal) DOM.statTotal.textContent = counts.Wishlist;
    if (DOM.statApplied) DOM.statApplied.textContent = counts.Applied;
    if (DOM.statInterview) DOM.statInterview.textContent = counts["OA/Test"];
    if (DOM.statOffers) DOM.statOffers.textContent = counts.Interview;
    if (DOM.statFollowup) DOM.statFollowup.textContent = counts.Rejected;
    if (DOM.statResponse) DOM.statResponse.textContent = counts.Offer;
    if (DOM.statRate) DOM.statRate.textContent = `${rr}%`;
  }

  // ═══════════════════════════════════════════════════════════════
  // FILTER UI
  // ═══════════════════════════════════════════════════════════════
  function renderFilterUI() {
    document.querySelectorAll("#filter-chips .chip").forEach((btn) => {
      btn.classList.toggle("chip-active", (btn.dataset.stage || "all") === state.currentFilter);
    });
    renderCompanyShortcuts();
    if (DOM.activeFilterBar) {
      const hasFilter = state.currentFilter !== "all" || state.currentCompanyFilter !== "all" || state.searchQuery;
      DOM.activeFilterBar.hidden = !hasFilter;
      if (hasFilter && DOM.activeFilterLabel) {
        const parts = [];
        if (state.currentFilter !== "all") parts.push(`Stage: ${state.currentFilter}`);
        if (state.currentCompanyFilter !== "all") parts.push(`Company: ${state.currentCompanyFilter}`);
        if (state.searchQuery) parts.push(`Search: "${state.searchQuery}"`);
        DOM.activeFilterLabel.textContent = parts.join(" · ");
      }
    }
  }

  function renderCompanyShortcuts() {
    if (!DOM.companyShortcuts) return;
    const companies = DEFAULT_COMPANY_SHORTCUTS;
    DOM.companyShortcuts.innerHTML = "";
    companies.forEach((c) => {
      const btn = document.createElement("button");
      btn.className = "chip" + (state.currentCompanyFilter === c ? " chip-active" : "");
      btn.textContent = c;
      btn.type = "button";
      btn.addEventListener("click", () => {
        state.currentCompanyFilter = state.currentCompanyFilter === c ? "all" : c;
        renderUI();
      });
      DOM.companyShortcuts.appendChild(btn);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GOAL
  // ═══════════════════════════════════════════════════════════════
  function getApplicationsThisWeek() {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(now.getDate() - now.getDay());
    return state.applications.filter((a) => a.createdAt && new Date(a.createdAt) >= start);
  }

  function renderGoal() {
    const count = getApplicationsThisWeek().length;
    const pct = Math.min(100, (count / state.currentWeeklyGoal) * 100);
    if (DOM.goalBarFill) DOM.goalBarFill.style.width = `${pct}%`;
    if (DOM.goalText) DOM.goalText.textContent = `${count} / ${state.currentWeeklyGoal} applications this week`;
  }

  function editWeeklyGoal() {
    const raw = window.prompt("Set weekly application goal", String(state.currentWeeklyGoal));
    if (raw === null) return;
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) { showToast("Enter a valid positive number", "error"); return; }
    state.currentWeeklyGoal = parsed;
    if (useFirebase && currentUserId) FirebaseAPI.db.saveSettings(currentUserId, { theme: state.theme, weeklyGoal: parsed });
    else safeStorageSet(GOAL_KEY, String(parsed));
    renderGoal();
    showToast("Weekly goal updated");
  }

  // ═══════════════════════════════════════════════════════════════
  // QUOTES
  // ═══════════════════════════════════════════════════════════════
  const QUOTES = [
    "Every rejection is redirection towards something better.",
    "The job hunt is a marathon, not a sprint. Keep going.",
    "Your dream role is out there — keep applying.",
    "Success is the sum of small efforts, repeated daily.",
    "Today's 'no' is tomorrow's 'not yet'.",
    "Hard work beats talent when talent doesn't work hard.",
    "Small daily progress leads to extraordinary career outcomes."
  ];

  function loadMotivationalQuote() {
    quoteState.selectedQuote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    runQuoteTypewriter();
    setupQuoteScrollAnimation();
  }

  function runQuoteTypewriter() {
    const el = DOM.motivationalQuoteContainer;
    if (!el) return;
    if (quoteState.typingTimer) clearInterval(quoteState.typingTimer);
    el.textContent = "";
    el.classList.add("is-typing");
    let i = 0;
    quoteState.typingTimer = setInterval(() => {
      i++;
      el.textContent = quoteState.selectedQuote.slice(0, i);
      if (i >= quoteState.selectedQuote.length) { clearInterval(quoteState.typingTimer); quoteState.typingTimer = null; el.classList.remove("is-typing"); }
    }, 38);
  }

  function setupQuoteScrollAnimation() {
    const banner = document.querySelector(".quote-banner");
    if (!banner || !("IntersectionObserver" in window)) return;
    quoteState.observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && quoteState.canReplayOnScroll) { quoteState.canReplayOnScroll = false; runQuoteTypewriter(); }
      else if (!entry.isIntersecting) { quoteState.canReplayOnScroll = true; }
    }, { threshold: 0.45 });
    quoteState.observer.observe(banner);
  }

  // ═══════════════════════════════════════════════════════════════
  // MODAL (ADD / EDIT APPLICATION)
  // ═══════════════════════════════════════════════════════════════
  function openModal(editId) {
    if (!currentUserId) { showToast("Please sign in first", "error"); return; }
    state.editingId = editId || null;
    const existing = editId ? state.applications.find((a) => a.id === editId) : null;
    const isEdit = !!existing;

    let html = `<div class="modal-inner">`;
    html += `<div class="modal-head"><h2 id="modal-title">${isEdit ? "Edit Application" : "New Application"}</h2><button type="button" class="modal-close-btn" id="close-modal-btn">✕</button></div>`;

    // Source step (new only)
    if (!isEdit) {
      html += `<section id="source-step" class="modal-section">
        <p class="modal-step-label">Step 1 · Choose input source</p>
        <div class="source-btns">
          <button type="button" class="btn btn-primary" id="source-link-btn">Use Job Link</button>
          <button type="button" class="btn btn-primary" id="source-file-btn" style="background:var(--accent-secondary)">Use File</button>
          <button type="button" class="btn btn-primary" id="source-skip-btn" style="background:var(--text-secondary)">Skip → Manual</button>
        </div>
        <div id="source-link-panel" style="display:none;margin-top:12px;">
          <label for="source-link-input">Job Link</label>
          <input type="url" id="source-link-input" placeholder="https://jobs.sap.com/job/..." class="modal-input"/>
          <button type="button" class="btn btn-primary" id="extract-continue-btn" style="margin-top:8px">Extract & Continue</button>
          <div id="extract-loader" style="display:none;margin-top:8px;color:var(--text-secondary)">Extracting…</div>
        </div>
        <div id="source-file-panel" style="display:none;margin-top:12px;">
          <label for="source-file-input">Attachment (.txt, .csv, .xlsx — single job)</label>
          <input type="file" id="source-file-input" accept=".txt,.csv,.xlsx,.xls" class="modal-input"/>
          <button type="button" class="btn btn-primary" id="file-continue-btn" style="margin-top:8px">Parse & Continue</button>
        </div>
      </section>`;
    }

    // Form step
    const a = existing || { id: "", company: "", role: "", link: "", location: "", reqId: "", postingDate: "", stage: "Wishlist", deadline: "", contactType: "", contactName: "", notes: "" };
    html += `<form id="app-form" class="modal-section" ${isEdit ? "" : 'style="display:none"'}>
      <p class="modal-step-label">${isEdit ? "" : "Step 2 · "}Application Details</p>
      <input type="hidden" id="form-id" value="${esc(a.id)}"/>
      <input type="hidden" id="form-link" value="${esc(a.link)}"/>
      <div class="modal-grid">
        <div><label for="form-company">Company</label><input type="text" id="form-company" maxlength="120" value="${esc(a.company)}" class="modal-input"/></div>
        <div><label for="form-role">Role</label><input type="text" id="form-role" maxlength="200" value="${esc(a.role)}" class="modal-input"/></div>
      </div>
      <div class="modal-grid">
        <div><label for="form-location">Location</label><input type="text" id="form-location" maxlength="120" value="${esc(a.location)}" class="modal-input"/></div>
        <div><label for="form-req-id">Req ID</label><input type="text" id="form-req-id" maxlength="120" value="${esc(a.reqId)}" class="modal-input"/></div>
      </div>
      <div class="modal-grid">
        <div><label for="form-posting-date">Posting Date</label><input type="date" id="form-posting-date" value="${a.postingDate || ""}" class="modal-input"/></div>
        <div><label for="form-stage">Stage</label><select id="form-stage" class="modal-input">${STAGES.map((s) => `<option value="${s}" ${s === a.stage ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      </div>
      <div class="modal-grid">
        <div><label for="form-deadline">Self Deadline</label><input type="date" id="form-deadline" value="${a.deadline || ""}" class="modal-input"/></div>
        <div><label for="form-contact-type">Contact Type</label><select id="form-contact-type" class="modal-input"><option value="">None</option><option value="HR" ${a.contactType === "HR" ? "selected" : ""}>HR</option><option value="Friend" ${a.contactType === "Friend" ? "selected" : ""}>Friend</option><option value="Company Employee" ${a.contactType === "Company Employee" ? "selected" : ""}>Employee</option></select></div>
      </div>
      <div><label for="form-contact-name">Contact Name</label><input type="text" id="form-contact-name" maxlength="120" value="${esc(a.contactName)}" class="modal-input"/></div>
      <div><label for="form-notes">Notes</label><textarea id="form-notes" maxlength="500" class="modal-input" rows="3">${esc(a.notes)}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn" id="cancel-modal-btn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save Application</button>
      </div>
    </form>`;
    html += `</div>`;

    DOM.modalBox.innerHTML = html;
    DOM.modalBackdrop.classList.remove("hidden");

    // Bind events
    $("close-modal-btn")?.addEventListener("click", closeModal);
    $("cancel-modal-btn")?.addEventListener("click", closeModal);
    $("app-form")?.addEventListener("submit", saveApplicationFromForm);

    if (!isEdit) {
      $("source-link-btn")?.addEventListener("click", () => { $("source-link-panel").style.display = ""; $("source-file-panel").style.display = "none"; });
      $("source-file-btn")?.addEventListener("click", () => { $("source-file-panel").style.display = ""; $("source-link-panel").style.display = "none"; });
      $("source-skip-btn")?.addEventListener("click", () => { $("source-step").style.display = "none"; $("app-form").style.display = ""; });
      $("extract-continue-btn")?.addEventListener("click", handleLinkExtraction);
      $("file-continue-btn")?.addEventListener("click", handleFileExtraction);
    }
  }

  function closeModal() {
    state.editingId = null;
    if (DOM.modalBackdrop) DOM.modalBackdrop.classList.add("hidden");
  }

  async function handleLinkExtraction() {
    const url = $("source-link-input")?.value?.trim();
    if (!url) { showToast("Enter a job link", "error"); return; }
    const loader = $("extract-loader");
    if (loader) loader.style.display = "";
    try {
      const res = await fetch("/fetch-jd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await res.json();
      if (data.success && data.jd) {
        const jd = data.jd;
        $("form-company").value = "SAP";
        $("form-role").value = jd.title || "";
        $("form-location").value = jd.location || "";
        $("form-req-id").value = jd.requisitionId || "";
        $("form-link").value = url;
        if (jd.postedDate) $("form-posting-date").value = toIsoDate(jd.postedDate);
      }
    } catch (err) {
      showToast("Extraction failed: " + err.message, "error");
    }
    if (loader) loader.style.display = "none";
    $("source-step").style.display = "none";
    $("app-form").style.display = "";
  }

  async function handleFileExtraction() {
    const fileInput = $("source-file-input");
    const file = fileInput?.files?.[0];
    if (!file) { showToast("Select a file", "error"); return; }
    try {
      const rows = await parseImportFile(file);
      if (rows.length === 0) { showToast("No data found in file", "error"); return; }
      const normalized = normalizeImportedEntry(rows[0]);
      if (normalized.company) $("form-company").value = normalized.company;
      if (normalized.role) $("form-role").value = normalized.role;
      if (normalized.location) $("form-location").value = normalized.location;
      if (normalized.reqId) $("form-req-id").value = normalized.reqId;
      if (normalized.link) $("form-link").value = normalized.link;
      if (normalized.postingDate) $("form-posting-date").value = normalized.postingDate;
      if (normalized.stage) $("form-stage").value = normalized.stage;
      if (normalized.deadline) $("form-deadline").value = normalized.deadline;
      if (normalized.notes) $("form-notes").value = normalized.notes;
    } catch (err) {
      showToast("Parse error: " + err.message, "error");
    }
    $("source-step").style.display = "none";
    $("app-form").style.display = "";
  }

  async function saveApplicationFromForm(e) {
    e.preventDefault();
    const company = $("form-company")?.value?.trim() || "";
    const role = $("form-role")?.value?.trim() || "";
    if (!company && !role) { showToast("Company or Role is required", "error"); return; }

    const id = $("form-id")?.value || uuid();
    const existing = state.applications.find((a) => a.id === id);

    const payload = {
      id,
      company: company || "Unknown",
      role: role || "Unknown",
      link: $("form-link")?.value?.trim() || "",
      location: $("form-location")?.value?.trim() || "",
      reqId: $("form-req-id")?.value?.trim() || "",
      postingDate: $("form-posting-date")?.value || "",
      stage: $("form-stage")?.value || "Wishlist",
      deadline: $("form-deadline")?.value || "",
      contactType: $("form-contact-type")?.value || "",
      contactName: $("form-contact-name")?.value?.trim() || "",
      notes: $("form-notes")?.value?.trim() || "",
      updatedAt: new Date().toISOString()
    };

    if (existing) {
      payload.createdAt = existing.createdAt;
      const idx = state.applications.findIndex((a) => a.id === id);
      state.applications[idx] = { ...existing, ...payload };
    } else {
      payload.createdAt = new Date().toISOString();
      state.applications.unshift(payload);
    }

    await persistApplication(payload);
    closeModal();
    renderUI();
    showToast(existing ? "Application updated" : "Application added");
  }

  // ═══════════════════════════════════════════════════════════════
  // IMPORT / EXPORT
  // ═══════════════════════════════════════════════════════════════
  function exportToCSV() {
    if (!state.applications.length) { showToast("Nothing to export", "error"); return; }
    const headers = ["Company","Job Title","Location","Req ID","Job Link","Job Posting Date","Stage","Self Deadline","Contact Type","Contact Name","Notes"];
    const rows = state.applications.map((a) => [a.company, a.role, a.location, a.reqId, a.link, a.postingDate, a.stage, a.deadline, a.contactType, a.contactName, a.notes].map((v) => `"${String(v || "").replace(/"/g, '""')}"`));
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    downloadBlob(csv, "applications_export.csv", "text/csv;charset=utf-8;");
  }

  function downloadImportTemplate() {
    const headers = ["Company","Job Title","Location","Req ID","Job Link","Job Posting Date","Stage","Self Deadline","Contact Type","Contact Name","Notes"];
    if (window.XLSX) {
      const ws = XLSX.utils.aoa_to_sheet([headers]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Applications");
      XLSX.writeFile(wb, "import_template.xlsx");
    } else {
      downloadBlob(headers.join(",") + "\n", "import_template.csv", "text/csv;charset=utf-8;");
    }
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function onImportFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await parseImportFile(file);
      let count = 0;
      for (const raw of rows) {
        const n = normalizeImportedEntry(raw);
        if (!n.company && !n.role) continue;
        const app = { ...n, id: uuid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        state.applications.unshift(app);
        await persistApplication(app);
        count++;
      }
      renderUI();
      showToast(`Imported ${count} application(s)`);
    } catch (err) {
      showToast("Import failed: " + err.message, "error");
    }
    e.target.value = "";
  }

  function parseImportFile(file) {
    return new Promise((resolve, reject) => {
      const ext = (file.name || "").split(".").pop().toLowerCase();
      if (ext === "xlsx" || ext === "xls") {
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const wb = XLSX.read(ev.target.result, { type: "array" });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            resolve(XLSX.utils.sheet_to_json(sheet) || []);
          } catch (err) { reject(err); }
        };
        reader.readAsArrayBuffer(file);
      } else {
        const reader = new FileReader();
        reader.onload = (ev) => { resolve(parseCSVText(ev.target.result)); };
        reader.readAsText(file);
      }
    });
  }

  function parseCSVText(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const headerLine = lines[0];
    const headers = splitCSVLine(headerLine).map(normalizeKey);
    const result = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = splitCSVLine(lines[i]);
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = vals[idx] || ""; });
      result.push(obj);
    }
    return result;
  }

  function splitCSVLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ",") { result.push(current.trim()); current = ""; }
        else current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  function normalizeKey(k) { return k.replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); }

  function normalizeImportedEntry(raw) {
    const map = {};
    Object.entries(raw).forEach(([k, v]) => { map[normalizeKey(k)] = String(v || "").trim(); });
    const g = (...keys) => { for (const k of keys) { if (map[k]) return map[k]; } return ""; };
    return {
      link: g("joblink", "link", "url"),
      company: g("company", "companyname", "employer"),
      role: g("jobtitle", "title", "role", "position"),
      location: g("location", "city", "joblocation"),
      reqId: g("reqid", "requisitionid", "jobid", "referenceid"),
      postingDate: toIsoDate(g("jobpostingdate", "postingdate", "dateposted")),
      stage: g("stage") || "Applied",
      deadline: toIsoDate(g("selfdeadline", "deadline")),
      contactType: g("contacttype"),
      contactName: g("contactname", "contactperson", "contact"),
      notes: g("notes", "remark", "comments")
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════
  const stageCodeMap = { Wishlist: "W", Applied: "A", "OA/Test": "O", Interview: "I", Rejected: "R", Offer: "F" };
  const codeLabelMap = { W: "Wishlist", A: "Applied", O: "OA/Test", I: "Interview", R: "Rejected", F: "Offer" };

  function an_stageCode(stage) { return stageCodeMap[stage] || "W"; }
  function an_stageLabel(code) { return codeLabelMap[code] || "Unknown"; }

  function an_init() {
    if (anState.initialized) return;
    // bind status checkboxes
    DOM.anStatusChecks?.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      const label = cb.closest("[data-status]");
      if (!label) return;
      cb.addEventListener("change", () => {
        const code = label.dataset.status;
        cb.checked ? anState.statuses.add(code) : anState.statuses.delete(code);
      });
    });
    DOM.anApplyFiltersBtn?.addEventListener("click", an_applyFilters);
    DOM.anClearFiltersBtn?.addEventListener("click", an_clearAll);
    DOM.anRefreshBtn?.addEventListener("click", an_refresh);
    DOM.anExportBtn?.addEventListener("click", an_exportFilteredCSV);
    DOM.anSort?.addEventListener("change", (e) => { anState.sort = e.target.value; an_applyFilters(); });
    DOM.anSearch?.addEventListener("input", (e) => { anState.search = e.target.value.trim().toLowerCase(); an_applyFilters(); });
    // table edit click
    DOM.anTableBody?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-edit-id]");
      if (btn) openModal(btn.dataset.editId);
    });
    anState.initialized = true;
  }

  function an_refresh() {
    anState.from = DOM.anFrom?.value || "";
    anState.to = DOM.anTo?.value || "";
    anState.company = DOM.anCompany?.value?.trim().toLowerCase() || "";
    anState.location = DOM.anLocation?.value?.trim().toLowerCase() || "";
    anState.keyword = DOM.anKeyword?.value?.trim().toLowerCase() || "";
    an_applyFilters();
  }

  function an_applyFilters() {
    let rows = [...state.applications];
    if (anState.from) rows = rows.filter((a) => (a.createdAt || "") >= anState.from);
    if (anState.to) rows = rows.filter((a) => (a.createdAt || "") <= anState.to + "T23:59:59");
    if (anState.company) rows = rows.filter((a) => (a.company || "").toLowerCase().includes(anState.company));
    if (anState.location) rows = rows.filter((a) => (a.location || "").toLowerCase().includes(anState.location));
    if (anState.keyword) rows = rows.filter((a) => [a.notes, a.role].join(" ").toLowerCase().includes(anState.keyword));
    if (anState.search) rows = rows.filter((a) => [a.company, a.role, a.location, a.notes, a.reqId].join(" ").toLowerCase().includes(anState.search));
    rows = rows.filter((a) => anState.statuses.has(an_stageCode(a.stage)));
    if (anState.sort === "company") rows.sort((a, b) => (a.company || "").localeCompare(b.company || ""));
    else if (anState.sort === "status") rows.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
    else rows.sort((a, b) => compareDates(a.deadline, b.deadline, true));
    anState.filtered = rows;
    an_renderStatusMeta(rows);
    an_renderActiveChips();
    an_updateStats(rows);
    an_renderTable(rows);
    an_buildCharts(rows);
  }

  function an_renderStatusMeta(rows) {
    const counts = { W: 0, A: 0, O: 0, I: 0, R: 0, F: 0 };
    rows.forEach((a) => { const c = an_stageCode(a.stage); if (counts[c] !== undefined) counts[c]++; });
    const total = rows.length || 1;
    DOM.anStatusChecks?.querySelectorAll("[data-status]").forEach((label) => {
      const code = label.dataset.status;
      const countEl = label.querySelector(".an-s-count");
      const fill = label.querySelector(".an-s-fill");
      if (countEl) countEl.textContent = counts[code] || 0;
      if (fill) fill.style.width = `${Math.round((counts[code] / total) * 100)}%`;
    });
    if (DOM.anStatusCount) DOM.anStatusCount.textContent = anState.statuses.size;
  }

  function an_renderActiveChips() {
    if (!DOM.anActiveChips) return;
    DOM.anActiveChips.innerHTML = "";
    if (anState.statuses.size < 6) {
      [...anState.statuses].forEach((code) => {
        const chip = document.createElement("span");
        chip.className = "an-chip";
        chip.textContent = an_stageLabel(code);
        DOM.anActiveChips.appendChild(chip);
      });
    }
    if (anState.company) addChip("Company: " + anState.company);
    if (anState.location) addChip("Location: " + anState.location);
    if (anState.keyword) addChip("Keyword: " + anState.keyword);
    if (anState.search) addChip("Search: " + anState.search);
    function addChip(text) {
      const chip = document.createElement("span");
      chip.className = "an-chip";
      chip.textContent = text;
      DOM.anActiveChips.appendChild(chip);
    }
  }

  function an_updateStats(rows) {
    const total = rows.length;
    const interviews = rows.filter((a) => a.stage === "Interview").length;
    const offers = rows.filter((a) => a.stage === "Offer").length;
    const active = rows.filter((a) => ["Wishlist", "Applied", "OA/Test", "Interview"].includes(a.stage)).length;
    const rr = total ? Math.round(((interviews + offers) / total) * 100) : 0;
    if (DOM.anStatTotal) DOM.anStatTotal.textContent = total;
    if (DOM.anStatRate) DOM.anStatRate.textContent = `${rr}%`;
    if (DOM.anStatActive) DOM.anStatActive.textContent = active;
    if (DOM.anStatOffers) DOM.anStatOffers.textContent = offers;
    if (DOM.anStatOfferRate) DOM.anStatOfferRate.textContent = `${total ? Math.round((offers / total) * 100) : 0}% offer rate`;
    if (DOM.anTopCount) DOM.anTopCount.textContent = total;
    if (DOM.anTableCount) DOM.anTableCount.textContent = total;
  }

  function an_renderTable(rows) {
    if (!DOM.anTableBody) return;
    if (!rows.length) { DOM.anTableBody.innerHTML = ""; DOM.anEmpty && (DOM.anEmpty.style.display = ""); return; }
    DOM.anEmpty && (DOM.anEmpty.style.display = "none");
    DOM.anTableBody.innerHTML = rows.map((a) => {
      const code = an_stageCode(a.stage);
      const kws = an_extractKeywords(a);
      return `<tr>
        <td><input type="checkbox"/></td>
        <td class="an-td-bold">${esc(a.company)}</td>
        <td>${esc(a.role)}</td>
        <td>${esc(a.location)}</td>
        <td><span class="an-badge an-badge-${code}"><span class="an-badge-dot"></span>${a.stage}</span></td>
        <td><div class="an-kw-tags">${kws.map((k) => `<span class="an-kw-tag">${esc(k)}</span>`).join("")}</div></td>
        <td>${a.deadline || "—"}</td>
        <td>${esc(a.reqId || "—")}</td>
        <td><button type="button" class="an-btn" data-edit-id="${a.id}">Edit</button></td>
      </tr>`;
    }).join("");
  }

  function an_extractKeywords(app) {
    const raw = (app.notes || "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
    return raw.slice(0, 3);
  }

  function an_buildCharts(rows) {
    if (!DOM.anBarChart || !DOM.anDonutChart || typeof Chart === "undefined") return;
    rows = rows || anState.filtered;
    const counts = { W: 0, A: 0, O: 0, I: 0, R: 0, F: 0 };
    rows.forEach((a) => { const c = an_stageCode(a.stage); if (counts[c] !== undefined) counts[c]++; });

    const colors = ["#8b5cf6", "#6366f1", "#f59e0b", "#06b6d4", "#ef4444", "#10b981"];
    const labels = STAGES;

    if (anCharts.bar) anCharts.bar.destroy();
    anCharts.bar = new Chart(DOM.anBarChart, {
      type: "bar",
      data: { labels, datasets: [{ label: "Applications", data: [counts.W, counts.A, counts.O, counts.I, counts.R, counts.F], backgroundColor: colors, borderRadius: 8 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });

    if (anCharts.donut) anCharts.donut.destroy();
    anCharts.donut = new Chart(DOM.anDonutChart, {
      type: "doughnut",
      data: { labels: ["Interview", "Rejected", "Offer"], datasets: [{ data: [counts.I, counts.R, counts.F], backgroundColor: ["#06b6d4", "#ef4444", "#10b981"], borderWidth: 2, borderColor: state.theme === "dark" ? "#10162b" : "#fff" }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom", labels: { usePointStyle: true } } }, cutout: "68%" }
    });
  }

  function an_exportFilteredCSV() {
    const rows = anState.filtered;
    if (!rows.length) { showToast("No data to export", "error"); return; }
    const headers = ["Company", "Role", "Location", "Stage", "Deadline", "ReqID", "Notes"];
    const csv = [headers.join(","), ...rows.map((a) => [a.company, a.role, a.location, a.stage, a.deadline, a.reqId, a.notes].map((v) => `"${String(v || "").replace(/"/g, '""')}"`).join(","))].join("\n");
    downloadBlob(csv, "analytics_export.csv", "text/csv;charset=utf-8;");
  }

  function an_clearAll() {
    anState.from = ""; anState.to = ""; anState.company = ""; anState.location = ""; anState.keyword = ""; anState.search = "";
    anState.statuses = new Set(["W", "A", "O", "I", "R", "F"]);
    if (DOM.anFrom) DOM.anFrom.value = "";
    if (DOM.anTo) DOM.anTo.value = "";
    if (DOM.anCompany) DOM.anCompany.value = "";
    if (DOM.anLocation) DOM.anLocation.value = "";
    if (DOM.anKeyword) DOM.anKeyword.value = "";
    if (DOM.anSearch) DOM.anSearch.value = "";
    DOM.anStatusChecks?.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = true; });
    an_applyFilters();
  }

  // ═══════════════════════════════════════════════════════════════
  // SEARCH VIEW (SCRAPING)
  // ═══════════════════════════════════════════════════════════════
  async function handleScrapeSearch() {
    const keyword = DOM.scrapeKeyword?.value?.trim();
    if (!keyword) { showToast("Enter a keyword", "error"); return; }
    const location = DOM.scrapeLocation?.value?.trim() || "";
    const period = DOM.scrapePeriod?.value || "1week";
    const careerStatus = DOM.scrapeCareerStatus?.value || "Student";
    const country = DOM.scrapeCountry?.value || "DE";

    if (DOM.scrapeSpinner) DOM.scrapeSpinner.classList.add("active");
    if (DOM.scrapeBtnText) DOM.scrapeBtnText.textContent = "Searching…";
    if (DOM.scrapeSearchBtn) DOM.scrapeSearchBtn.disabled = true;

    // Show animated search progress bar
    let searchBarEl = document.getElementById("search-progress-bar");
    if (!searchBarEl) {
      searchBarEl = document.createElement("div");
      searchBarEl.id = "search-progress-bar";
      searchBarEl.className = "search-progress-bar";
      searchBarEl.innerHTML = `<div class="search-progress-fill"></div><span class="search-progress-label">Connecting to SAP careers…</span>`;
      const card = DOM.scrapeSearchBtn?.closest(".auto-card");
      if (card) card.appendChild(searchBarEl);
    }
    searchBarEl.classList.add("active");
    const fill = searchBarEl.querySelector(".search-progress-fill");
    const label = searchBarEl.querySelector(".search-progress-label");
    const steps = [
      { pct: 15, text: "Connecting to SAP careers portal…" },
      { pct: 35, text: "Launching headless browser…" },
      { pct: 50, text: "Loading search results page…" },
      { pct: 65, text: "Scraping job listings…" },
      { pct: 80, text: "Matching skills from your bank…" },
      { pct: 90, text: "Ranking results…" }
    ];
    let stepIdx = 0;
    const progTimer = setInterval(() => {
      if (stepIdx < steps.length) {
        if (fill) fill.style.width = steps[stepIdx].pct + "%";
        if (label) label.textContent = steps[stepIdx].text;
        stepIdx++;
      }
    }, 2200);

    try {
      const res = await fetch("/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword, location, period, careerStatus, country })
      });
      if (!res.ok) {
        let errMsg = `Server error (${res.status})`;
        try { const errData = await res.json(); errMsg = errData.error || errMsg; } catch {}
        showToast(errMsg, "error");
      } else {
        const data = await res.json();
        if (data.success) {
          scrapeState.jobs = data.jobs || [];
          renderScrapeResults();
          showToast(`Found ${scrapeState.jobs.length} jobs`);
          // Warn if keyword doesn't seem SAP-related
          const sapKws = ["sap","btp","hana","fiori","s/4","abap","cloud","analytics","erp","concur","ariba","successfactors","signavio","hybris","commerce","datasphere","joule"];
          const kwLower = keyword.toLowerCase();
          if (!sapKws.some(k => kwLower.includes(k)) && scrapeState.jobs.length > 0) {
            showToast(`Note: "${keyword}" may not be SAP-specific. This searches SAP's portal — results may vary in relevance.`, "info");
          }
        } else {
          showToast(data.error || "Search failed", "error");
        }
      }
    } catch (err) {
      if (err.message.includes("JSON") || err.message.includes("fetch")) {
        showToast("Server not running. Start it with: node server.js", "error");
      } else {
        showToast("Search error: " + err.message, "error");
      }
    }

    clearInterval(progTimer);
    if (fill) fill.style.width = "100%";
    if (label) label.textContent = "Done!";
    setTimeout(() => { if (searchBarEl) searchBarEl.classList.remove("active"); }, 1200);

    if (DOM.scrapeSpinner) DOM.scrapeSpinner.classList.remove("active");
    if (DOM.scrapeBtnText) DOM.scrapeBtnText.textContent = "Search Jobs";
    if (DOM.scrapeSearchBtn) DOM.scrapeSearchBtn.disabled = false;
  }

  function renderScrapeResults() {
    if (!DOM.scrapeResultsBody) return;
    if (DOM.scrapeResultCount) DOM.scrapeResultCount.textContent = `${scrapeState.jobs.length} jobs`;
    if (!scrapeState.jobs.length) {
      DOM.scrapeResultsBody.innerHTML = `<tr><td colspan="7" class="auto-empty">No jobs found. Adjust filters and try again.</td></tr>`;
      return;
    }
    DOM.scrapeResultsBody.innerHTML = scrapeState.jobs.map((job, i) => {
      const sel = scrapeState.selected.has(i);
      return `<tr class="${sel ? "selected-row" : ""}">
        <td><input type="checkbox" class="scrape-select-cb" data-idx="${i}" ${sel ? "checked" : ""}/></td>
        <td>
          <div class="scrape-title-cell">
            <a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(job.title)}</a>
            ${job.matchScore != null ? `<span class="match-badge ${job.matchScore >= 40 ? "match-badge-high" : job.matchScore >= 20 ? "match-badge-med" : "match-badge-low"}">${job.matchScore}% match</span>` : ""}
          </div>
          ${(job.topMatchedSkills && job.topMatchedSkills.length) ? `<div class="scrape-skill-tags">${job.topMatchedSkills.slice(0,4).map(s => `<span class="scrape-skill-tag">${esc(s)}</span>`).join("")}</div>` : ""}
        </td>
        <td>${esc(DOM.scrapeKeyword?.value || "")}</td>
        <td>${esc(job.requisitionId || "N/A")}</td>
        <td>${esc(job.location || "N/A")}</td>
        <td>${esc(job.date || "N/A")}</td>
        <td><button type="button" class="btn btn-sm btn-primary scrape-quick-add" data-idx="${i}">+ Track</button></td>
      </tr>`;
    }).join("");

    // Bind checkboxes
    DOM.scrapeResultsBody.querySelectorAll(".scrape-select-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        const idx = parseInt(cb.dataset.idx, 10);
        if (cb.checked) scrapeState.selected.set(idx, scrapeState.jobs[idx]);
        else scrapeState.selected.delete(idx);
        renderSelectedJobs();
        renderScrapeResults();
      });
    });

    // Bind quick add buttons
    DOM.scrapeResultsBody.querySelectorAll(".scrape-quick-add").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        addJobToTracker(scrapeState.jobs[idx]);
      });
    });
  }

  function renderSelectedJobs() {
    const count = scrapeState.selected.size;
    if (DOM.selectedJobsCard) DOM.selectedJobsCard.style.display = count ? "" : "none";
    if (DOM.selectedCount) DOM.selectedCount.textContent = `${count} selected`;
    if (!DOM.selectedJobsList) return;
    DOM.selectedJobsList.innerHTML = "";

    scrapeState.selected.forEach((job, idx) => {
      const card = document.createElement("div");
      card.className = "search-kanban-card";

      const matchScore = job.matchScore;
      const scoreBadge = matchScore != null
        ? `<span class="match-badge ${matchScore >= 40 ? "match-badge-high" : matchScore >= 20 ? "match-badge-med" : "match-badge-low"}">${matchScore}% match</span>`
        : "";
      const skillTags = (job.topMatchedSkills || []).slice(0, 5)
        .map(s => `<span class="scrape-skill-tag">${esc(s)}</span>`).join("");

      card.innerHTML = `
        <div class="skc-header">
          <div class="skc-title-row">
            <h4 class="skc-title">${esc(job.title)}</h4>
            ${scoreBadge}
            <button type="button" class="skc-remove btn btn-sm" title="Remove">✕</button>
          </div>
          <div class="skc-meta">
            ${esc(job.location || "")}${job.requisitionId ? ` &middot; Req ${esc(job.requisitionId)}` : ""}${job.date ? ` &middot; ${esc(job.date)}` : ""}
          </div>
        </div>
        ${skillTags ? `<div class="skc-skills">${skillTags}</div>` : ""}
        <div class="skc-actions">
          <a href="${esc(job.url || "#")}" target="_blank" rel="noopener" class="btn btn-sm">Open JD ↗</a>
        </div>
      `;

      card.querySelector(".skc-remove").addEventListener("click", () => {
        scrapeState.selected.delete(idx);
        renderSelectedJobs();
        renderScrapeResults();
      });

      DOM.selectedJobsList.appendChild(card);
    });
  }

  function addJobToTracker(job) {
    const existing = state.applications.find((a) => a.reqId && a.reqId === job.requisitionId);
    if (existing) { showToast("Already tracking this job", "error"); return; }
    const app = {
      id: uuid(),
      company: "SAP",
      role: job.title || "Unknown",
      link: job.url || "",
      location: job.location || "",
      reqId: job.requisitionId || "",
      postingDate: toIsoDate(job.rawDate || job.date || ""),
      stage: "Wishlist",
      deadline: "",
      contactType: "",
      contactName: "",
      notes: `Keyword: ${DOM.scrapeKeyword?.value || ""}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.applications.unshift(app);
    persistApplication(app).catch(e => console.warn("Persist failed:", e.message));
    renderUI();
    showToast(`Added "${app.role}" to Wishlist`);
  }

  function addSelectedToTracker() {
    let count = 0;
    scrapeState.selected.forEach((job) => {
      const existing = state.applications.find((a) => a.reqId && a.reqId === job.requisitionId);
      if (existing) return;
      const app = {
        id: uuid(),
        company: "SAP",
        role: job.title || "Unknown",
        link: job.url || "",
        location: job.location || "",
        reqId: job.requisitionId || "",
        postingDate: toIsoDate(job.rawDate || job.date || ""),
        stage: "Wishlist",
        deadline: "",
        contactType: "",
        contactName: "",
        notes: `Keyword: ${DOM.scrapeKeyword?.value || ""}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.applications.unshift(app);
      persistApplication(app).catch(e => console.warn("Persist failed:", e.message));
      count++;
    });
    scrapeState.selected.clear();
    renderSelectedJobs();
    renderScrapeResults();
    renderUI();
    showToast(`Added ${count} job(s) to Wishlist`);
  }

  // ═══════════════════════════════════════════════════════════════
  // RENDER UI
  // ═══════════════════════════════════════════════════════════════
  function renderUI() {
    renderStats();
    renderFilterUI();
    renderKanban();
    renderGoal();
    if (anState.isOpen) an_applyFilters();
  }

  // ═══════════════════════════════════════════════════════════════
  // BIND EVENTS
  // ═══════════════════════════════════════════════════════════════
  function bindEvents() {
    // Navigation
    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.preventDefault(); switchView(btn.dataset.view); });
    });
    DOM.analyticsBtn?.addEventListener("click", () => switchView("analytics"));

    // Theme
    DOM.themeToggle?.addEventListener("click", toggleTheme);
    $("auth-theme-toggle")?.addEventListener("click", toggleTheme);

    // Logout
    DOM.accountLogoutBtn?.addEventListener("click", () => {
      if (window.FirebaseAPI?.auth?.signOut) {
        FirebaseAPI.auth.signOut();
        showToast("Signed out");
      }
    });

    // Modal
    DOM.openModalBtn?.addEventListener("click", () => openModal());
    DOM.modalBackdrop?.addEventListener("click", (e) => { if (e.target === DOM.modalBackdrop) closeModal(); });

    // Goal
    DOM.goalEditBtn?.addEventListener("click", editWeeklyGoal);

    // Filter chips
    document.querySelectorAll("#filter-chips .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.currentFilter = chip.dataset.stage || "all";
        state.currentCompanyFilter = "all";
        renderUI();
      });
    });

    // Search input
    DOM.searchInput?.addEventListener("input", (e) => { applySearchInput(e.target.value); renderUI(); });
    DOM.sortSelect?.addEventListener("change", (e) => { state.currentSort = e.target.value; renderUI(); });

    // Import / Export
    DOM.importDataBtn?.addEventListener("click", () => DOM.importFileInput?.click());
    DOM.importFileInput?.addEventListener("change", onImportFileChange);
    DOM.downloadTemplateBtn?.addEventListener("click", downloadImportTemplate);
    DOM.exportCsvBtn?.addEventListener("click", exportToCSV);

    // Scroll to top
    DOM.scrollToTopBtn?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    window.addEventListener("scroll", () => {
      if (DOM.scrollToTopBtn) DOM.scrollToTopBtn.classList.toggle("hidden", window.scrollY < 300);
    });

    // Search view — Enter key triggers search
    DOM.scrapeKeyword?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); handleScrapeSearch(); }
    });
    DOM.scrapeLocation?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); handleScrapeSearch(); }
    });
    DOM.scrapeSearchBtn?.addEventListener("click", handleScrapeSearch);
    DOM.addToTrackerBtn?.addEventListener("click", addSelectedToTracker);
    DOM.goGenerateBtn?.addEventListener("click", () => {
      if (!scrapeState.selected.size) { showToast("Select at least one job", "error"); return; }
      // Push selected to generate queue
      if (window.GenerateModule) {
        const kw = DOM.scrapeKeyword?.value?.trim() || "";
        scrapeState.selected.forEach((job) => window.GenerateModule.addToQueue({ ...job, keyword: kw }));
        scrapeState.selected.clear();
        renderSelectedJobs();
        renderScrapeResults();
      }
      switchView("generate");
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════
  function init() {
    cacheDom();
    useFirebase = checkFirebase();
    if (!useFirebase) {
      state.applications = loadApplications();
    }
    setupTheme();
    bindEvents();

    window.addEventListener("storage", (e) => { if (e.key === THEME_KEY) applyTheme(e.newValue || "light"); });
    window.addEventListener(THEME_EVENT, (e) => applyTheme(e.detail?.theme || "light"));

    const currentUser = window.FirebaseAPI?.auth?.getCurrentUser?.() || null;
    updateAccountStatusUI(currentUser);
    renderUI();
    an_init();
    loadMotivationalQuote();
    switchView("search");
  }

  function loadUserDataAndRender(userId, applications) {
    currentUserId = userId;
    useFirebase = true;
    state.applications = applications || [];
    const user = window.FirebaseAPI?.auth?.getCurrentUser?.();
    updateAccountStatusUI(user);
    renderUI();
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════
  window.JobHuntApp = {
    init: loadUserDataAndRender,
    setApplications: (apps) => { state.applications = apps || []; renderUI(); },
    setTheme: (theme) => { applyTheme(theme); safeStorageSet(THEME_KEY, theme); },
    setWeeklyGoal: (goal) => { state.currentWeeklyGoal = goal || 10; renderGoal(); },
    setAuthUser: (user) => { updateAccountStatusUI(user); },
    addTrackerApplication: async (appData) => {
      const id = appData.id || `app_${Date.now()}`;
      const app = { id, company: appData.company || "", role: appData.role || "", link: appData.link || "", location: appData.location || "", reqId: appData.reqId || "", postingDate: "", stage: appData.stage || "Wishlist", deadline: "", contactType: "", contactName: "", notes: appData.notes || "", createdAt: new Date().toISOString() };
      state.applications.push(app);
      await persistApplication(app);
      renderUI();
    }
  };
  window.JobHuntHQOpenModal = () => openModal();
  window.an_toggle = (v) => switchView("analytics");
  window.an_quickFilter = (type, value) => {
    if (type === "company" && DOM.anCompany) { DOM.anCompany.value = value; anState.company = value.toLowerCase(); }
    if (type === "location" && DOM.anLocation) { DOM.anLocation.value = value; anState.location = value.toLowerCase(); }
    an_applyFilters();
  };
  window.an_clearAll = an_clearAll;

  // Auto-init when DOM ready
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
