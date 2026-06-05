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
  const TRACKER_VIEW_KEY = "job_hunt_hq_tracker_view";
  const STAGES = ["Wishlist", "Applied", "OA/Test", "Interview", "Rejected", "Offer"];
  const DEFAULT_COMPANY_SHORTCUTS = ["SAP", "Siemens", "DHL"];

  // ═══════════════════════════════════════════════════════════════
  // LOCATION DATA + MATCHING (SAP & BASF)
  // ═══════════════════════════════════════════════════════════════
  const aliasMap = {
    "garching":     ["münchen","munich","muenchen","garching bei münchen","garching"],
    "st. leon-rot": ["sankt leon-rot","st leon rot","saint leon-rot","st.leon-rot"],
    "walldorf":     ["walldorf","walldorf baden"],
    "ludwigshafen": ["ludwigshafen am rhein","ludwigshafen a.rh.","ludwigshafen"],
    "düsseldorf":   ["düsseldorf","dusseldorf","duesseldorf"],
    "münster":      ["münster","muenster","munster"],
    "hannover":     ["hannover","hanover"],
    "berlin":       ["berlin"],
  };

  function locationMatches(jobLoc, sel) {
    if (!sel) return true;
    const job = (jobLoc || "").toLowerCase().trim();
    const s   = sel.toLowerCase().trim();
    // Multi-location jobs show "+N more…" — include them since hidden locations may match
    if (/\+\d+\s*more/i.test(job)) return true;
    return (aliasMap[s] || [s]).some(a => job.includes(a));
  }

  const SAP_LOCATIONS = [
    { label: "All Locations",           value: ""            },
    { label: "Walldorf (20km · HQ)",    value: "walldorf"    },
    { label: "St. Leon-Rot (20km)",     value: "st. leon-rot"},
    { label: "Heidelberg (18km)",       value: "heidelberg"  },
    { label: "Gerlingen (100km)",       value: "gerlingen"   },
    { label: "Bonn (170km)",            value: "bonn"        },
    { label: "Ratingen (220km)",        value: "ratingen"    },
    { label: "Garching/Munich (330km)", value: "garching"    },
    { label: "Berlin (483km)",          value: "berlin"      },
    { label: "Potsdam (490km)",         value: "potsdam"     },
    { label: "Dresden (570km)",         value: "dresden"     },
  ];

  const BASF_LOCATIONS = [
    { label: "All Locations",                    value: ""             },
    { label: "Mannheim (0km)",                   value: "mannheim"     },
    { label: "Ludwigshafen am Rhein (2km · HQ)", value: "ludwigshafen" },
    { label: "Limburgerhof (9km)",               value: "limburgerhof" },
    { label: "Lampertheim (13km)",               value: "lampertheim"  },
    { label: "Frankenthal (15km)",               value: "frankenthal"  },
    { label: "Freiburg (170km)",                 value: "freiburg"     },
    { label: "Düsseldorf (220km)",               value: "düsseldorf"   },
    { label: "Grenzach (240km)",                 value: "grenzach"     },
    { label: "Münster (380km)",                  value: "münster"      },
    { label: "Rudolstadt (400km)",               value: "rudolstadt"   },
    { label: "Hannover (430km)",                 value: "hannover"     },
    { label: "Trostberg (450km)",                value: "trostberg"    },
    { label: "Nienburg (460km)",                 value: "nienburg"     },
    { label: "Berlin (485km)",                   value: "berlin"       },
    { label: "Lemförde (490km)",                 value: "lemförde"     },
    { label: "Schwarzheide (560km)",             value: "schwarzheide" },
  ];

  function buildLocationDropdown(portal) {
    const sel = document.getElementById("scrape-location-dropdown");
    if (!sel) return;
    const locs = portal === "basf" ? BASF_LOCATIONS : SAP_LOCATIONS;
    sel.innerHTML = locs.map(l => `<option value="${l.value}">${l.label}</option>`).join("");
    sel._portal   = portal;
  }

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
    searchTokens: [],
    editingId: null,
    theme: safeStorageGet(THEME_KEY) || "light",
    currentTrackerView: safeStorageGet(TRACKER_VIEW_KEY) || "kanban"
  };

  const anState = {
    initialized: false, isOpen: false,
    from: "", to: "", company: "", location: "", keyword: "", search: "",
    statuses: new Set(["W", "A", "O", "I", "R", "F"]),
    sort: "deadline", filtered: []
  };

  // search view state
  const scrapeState = { jobs: [], selected: new Map() };

  // Extract company name from job URL domain
  function extractCompanyFromUrl(url) {
    if (!url) return "";
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      const parts = host.split(".");
      for (const p of parts) {
        const clean = p.replace(/^(jobs|careers|career|recruiting)-?/i, "");
        if (clean && !["com","org","net","de","io","co","wd1","wd2","wd3","wd4","wd5","myworkdayjobs","myworkdaysite","greenhouse","lever","smartrecruiters","icims"].includes(clean)) {
          return clean.charAt(0).toUpperCase() + clean.slice(1);
        }
      }
      return "";
    } catch { return ""; }
  }

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
      "scrape-portal", "scrape-keyword", "scrape-location", "scrape-state", "scrape-city", "scrape-period", "scrape-careerStatus", "scrape-country",
      "scrape-search-btn", "scrape-spinner", "scrape-btn-text", "scrape-result-count",
      "scrape-results-body", "selected-jobs-card", "selected-count", "selected-jobs-list",
      "add-to-tracker-btn", "go-generate-btn",
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
  // Maps typed keywords → canonical stage values
  const STAGE_KEYWORDS = {
    wishlist: "Wishlist",
    applied: "Applied",
    "oa/test": "OA/Test", oa: "OA/Test", test: "OA/Test",
    interview: "Interview",
    rejected: "Rejected",
    offer: "Offer"
  };

  function applySearchInput(raw) {
    const trimmed = String(raw || "").trim();
    // Split on commas and/or whitespace → supports "450579, 450570" or "sap walldorf"
    const parts = trimmed.split(/[\s,]+/).filter(Boolean);

    // Company shortcut: \sap
    if (parts[0] && parts[0].startsWith("\\") && parts[0].length > 1) {
      const matched = findCompanyByShortcut(parts[0].slice(1));
      if (matched) { state.currentCompanyFilter = matched; state.searchQuery = parts.slice(1).join(" ").toLowerCase(); return; }
    }

    // Stage keyword detection — extract stage tokens, rest become search tokens
    let stageMatch = null;
    const nonStageTokens = [];
    for (const p of parts) {
      const pl = p.toLowerCase();
      if (!stageMatch && STAGE_KEYWORDS[pl]) {
        stageMatch = STAGE_KEYWORDS[pl];
      } else {
        nonStageTokens.push(pl);
      }
    }

    if (stageMatch) {
      state.currentFilter = stageMatch;
      // store remaining tokens as OR-search array
      state.searchTokens = nonStageTokens;
      state.searchQuery = nonStageTokens.join(" ");
    } else {
      if (!trimmed) { state.currentFilter = "all"; state.searchTokens = []; }
      state.searchQuery = trimmed.toLowerCase();
      // all tokens for OR matching
      state.searchTokens = parts.map((p) => p.toLowerCase());
    }
  }

  function appMatchesTokens(a, tokens) {
    const fields = [a.company, a.role, a.location, a.reqId, a.contactType, a.contactName, a.notes]
      .map((v) => (v || "").toLowerCase());
    const haystack = fields.join(" ");
    // OR logic: app passes if ANY token matches
    return tokens.some((tok) => {
      // req ID priority: numeric token checks reqId field first
      const looksLikeReqId = /^[a-z0-9\-_]{2,20}$/i.test(tok) && /\d/.test(tok);
      if (looksLikeReqId && (a.reqId || "").toLowerCase().includes(tok)) return true;
      return haystack.includes(tok);
    });
  }

  function getFilteredApplications() {
    let f = [...state.applications];
    if (state.currentFilter !== "all") f = f.filter((a) => a.stage === state.currentFilter);
    if (state.currentCompanyFilter !== "all") {
      const ck = normalizeCompanyKey(state.currentCompanyFilter);
      f = f.filter((a) => { const ak = normalizeCompanyKey(a.company); return ak.includes(ck) || ck.includes(ak); });
    }
    const tokens = state.searchTokens && state.searchTokens.length ? state.searchTokens : (state.searchQuery ? [state.searchQuery] : []);
    if (tokens.length) {
      f = f.filter((a) => appMatchesTokens(a, tokens));
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
    card.addEventListener("dblclick", () => openAppDetailModal(app.id));
    card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", app.id); e.dataTransfer.effectAllowed = "move"; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    return card;
  }

  function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function cleanLoc(s) { return String(s || "").replace(/#[^{]*\{[^}]*\}/g, "").replace(/\s+/g, " ").trim(); }

  function bindKanbanDnD() {
    document.querySelectorAll(".column-list").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("drag-over"); });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("drag-over"); moveApplicationToStage(e.dataTransfer.getData("text/plain"), col.dataset.stage); });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // INTERVIEW & COMMUNICATION DATA SAVE HELPERS
  // ═══════════════════════════════════════════════════════════════
  async function saveInterviewRound(appId, roundData) {
    const idx = state.applications.findIndex((a) => a.id === appId);
    if (idx < 0) return;
    const app = state.applications[idx];
    const interviews = [...(app.interviews || [])];
    interviews.push({ round: interviews.length + 1, ...roundData });
    state.applications[idx] = { ...app, interviews, updatedAt: new Date().toISOString() };
    await persistApplication(state.applications[idx]);
    renderUI();
  }

  async function saveCommunication(appId, commData) {
    const idx = state.applications.findIndex((a) => a.id === appId);
    if (idx < 0) return;
    const app = state.applications[idx];
    const communications = [...(app.communications || [])];
    communications.push(commData);
    state.applications[idx] = { ...app, communications, updatedAt: new Date().toISOString() };
    await persistApplication(state.applications[idx]);
    renderUI();
  }

  // ═══════════════════════════════════════════════════════════════
  // TRACKER VIEW SWITCHER
  // ═══════════════════════════════════════════════════════════════
  const IV_COLS = [
    { id: "iv-invited",   label: "Invited",       hint: "Invite received, not yet scheduled" },
    { id: "iv-scheduled", label: "Scheduled",      hint: "Date confirmed, interview upcoming" },
    { id: "iv-completed", label: "Completed",      hint: "Interview done, awaiting decision" },
    { id: "iv-decision",  label: "Decision Due",   hint: "Follow-up / decision pending" },
  ];

  function getInterviewRoundStatus(app) {
    const rounds = app.interviews || [];
    if (!rounds.length) return "iv-invited";
    const last = rounds[rounds.length - 1];
    if (last.outcome === "Passed") return "iv-decision";
    if (last.outcome && last.outcome !== "Pending") return "iv-completed";
    const hasDate = !!last.date;
    const isPast = hasDate && new Date(last.date + "T23:59:59") < new Date();
    if (isPast) return "iv-completed";
    if (hasDate) return "iv-scheduled";
    return "iv-invited";
  }

  function switchTrackerView(view) {
    state.currentTrackerView = view;
    safeStorageSet(TRACKER_VIEW_KEY, view);
    document.querySelectorAll(".vsw-btn").forEach((btn) => {
      btn.classList.toggle("vsw-btn--active", btn.dataset.tview === view);
    });
    const containers = { kanban: "kanban-board", interview: "interview-focus-board", list: "list-view-container", pipeline: "pipeline-view-container" };
    Object.entries(containers).forEach(([v, id]) => {
      const el = document.getElementById(id);
      if (el) el.style.display = v === view ? "" : "none";
    });
    renderTrackerView();
  }

  function renderTrackerView() {
    switch (state.currentTrackerView) {
      case "kanban":    renderKanban(); break;
      case "interview": renderInterviewFocusView(); break;
      case "list":      renderListView(); break;
      case "pipeline":  renderPipelineView(); break;
      default:          renderKanban();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // INTERVIEW FOCUS VIEW (View 2)
  // ═══════════════════════════════════════════════════════════════
  function renderInterviewFocusView() {
    const container = document.getElementById("interview-focus-board");
    if (!container) return;
    const interviewApps = state.applications.filter((a) => a.stage === "Interview");
    container.innerHTML =
      `<div class="ivf-header">
        <span class="ivf-title">&#127919; Interview Focus</span>
        <span class="ivf-count">${interviewApps.length} active interview${interviewApps.length !== 1 ? "s" : ""}</span>
      </div>
      <div class="ivf-board">
        ${IV_COLS.map((col) => {
          const colApps = interviewApps.filter((a) => getInterviewRoundStatus(a) === col.id);
          return `<div class="ivf-column">
            <div class="ivf-col-header">
              <span class="ivf-col-title">${col.label}</span>
              <span class="ivf-col-count">${colApps.length}</span>
            </div>
            <div class="ivf-col-body">
              ${colApps.length === 0
                ? `<div class="ivf-empty">${esc(col.hint)}</div>`
                : colApps.map((app) => renderInterviewFocusCard(app)).join("")}
            </div>
          </div>`;
        }).join("")}
      </div>`;
    container.querySelectorAll("[data-ivf-open]").forEach((btn) => {
      btn.addEventListener("click", () => openAppDetailModal(btn.dataset.ivfOpen));
    });
  }

  function renderInterviewFocusCard(app) {
    const rounds = app.interviews || [];
    const lastRound = rounds[rounds.length - 1] || null;
    const roundNum = rounds.length;
    const PLATFORM_ICONS = { Teams: "&#128187;", Zoom: "&#127909;", Phone: "&#128222;", "On-site": "&#127970;", "Google Meet": "&#128249;" };
    const platform = lastRound?.platform || "";
    const icon = PLATFORM_ICONS[platform] || "&#128197;";
    const dateStr = lastRound?.date ? new Date(lastRound.date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    const timeStr = lastRound?.time || "";
    const interviewer = (lastRound?.interviewers || [])[0] || app.contactName || "";
    const commsCount = (app.communications || []).length;
    return `<article class="ivf-card">
      <div class="ivf-card-head">
        <div>
          <p class="ivf-card-company">${esc(app.company)}</p>
          ${roundNum > 0 ? `<span class="ivf-round-badge">R${roundNum}</span>` : ""}
        </div>
        <button type="button" class="ivf-open-btn" data-ivf-open="${esc(app.id)}" title="Open details">&#8599;</button>
      </div>
      <p class="ivf-card-role">${esc(app.role)}</p>
      ${lastRound && dateStr ? `<div class="ivf-card-meta"><span>${icon} ${dateStr}${timeStr ? " " + timeStr : ""}</span>${platform ? `<span>${esc(platform)}</span>` : ""}</div>` : ""}
      ${interviewer ? `<div class="ivf-card-contact">&#128100; ${esc(interviewer)}</div>` : ""}
      ${commsCount > 0 ? `<div class="ivf-card-comms">&#9993; ${commsCount} message${commsCount > 1 ? "s" : ""}</div>` : ""}
      <div class="ivf-card-footer">
        <button type="button" class="btn btn-xs ivf-open-btn" data-ivf-open="${esc(app.id)}" style="background:var(--bg-surface);border:1px solid var(--border-default);color:var(--text-secondary)">&#128221; Log Update</button>
      </div>
    </article>`;
  }

  // ═══════════════════════════════════════════════════════════════
  // LIST VIEW (View 3)
  // ═══════════════════════════════════════════════════════════════
  let listSortState = { col: "updatedAt", dir: "desc" };

  function renderListView() {
    const container = document.getElementById("list-view-container");
    if (!container) return;
    const apps = getFilteredApplications();
    const sorted = [...apps].sort((a, b) => {
      const dir = listSortState.dir === "asc" ? 1 : -1;
      const va = a[listSortState.col] || "";
      const vb = b[listSortState.col] || "";
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    const arrow = (col) => listSortState.col === col ? (listSortState.dir === "asc" ? " &#9650;" : " &#9660;") : "";
    container.innerHTML =
      `<div class="lv-wrap">
        <table class="lv-table" role="grid">
          <thead>
            <tr>
              <th class="lv-th lv-sortable" data-lvcol="company">Company${arrow("company")}</th>
              <th class="lv-th lv-sortable" data-lvcol="role">Role${arrow("role")}</th>
              <th class="lv-th">Stage</th>
              <th class="lv-th lv-sortable lv-hide-sm" data-lvcol="reqId">Req ID${arrow("reqId")}</th>
              <th class="lv-th lv-sortable" data-lvcol="updatedAt">Updated${arrow("updatedAt")}</th>
              <th class="lv-th lv-hide-sm">Contact</th>
              <th class="lv-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${sorted.length === 0
              ? `<tr><td colspan="7" class="lv-empty">No applications match the current filter</td></tr>`
              : sorted.map((app) => {
                  const slug = (app.stage || "").toLowerCase().replace(/[^a-z]/g, "");
                  const updDate = app.updatedAt ? new Date(app.updatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";
                  return `<tr class="lv-row">
                    <td class="lv-td lv-td-company">${esc(app.company)}</td>
                    <td class="lv-td lv-td-role" title="${esc(app.role)}">${esc(app.role)}</td>
                    <td class="lv-td">
                      <select class="lv-stage-sel stage-pill-${slug}" data-lv-stage-id="${esc(app.id)}" title="Change stage">
                        ${STAGES.map((s) => `<option value="${s}" ${s === app.stage ? "selected" : ""}>${s}</option>`).join("")}
                      </select>
                    </td>
                    <td class="lv-td lv-hide-sm">${esc(app.reqId || "—")}</td>
                    <td class="lv-td lv-td-date">${updDate}</td>
                    <td class="lv-td lv-hide-sm lv-td-contact" title="${esc(app.contactName || "")}">${esc(app.contactName || "—")}</td>
                    <td class="lv-td lv-td-actions">
                      <button type="button" class="btn btn-xs" data-lv-detail="${esc(app.id)}" title="View details">&#8599;</button>
                      <button type="button" class="btn btn-xs" data-lv-edit="${esc(app.id)}" title="Edit">&#9998;</button>
                    </td>
                  </tr>`;
                }).join("")}
          </tbody>
        </table>
        <div class="lv-footer">${sorted.length} application${sorted.length !== 1 ? "s" : ""}</div>
      </div>`;
    container.querySelectorAll("[data-lvcol]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.lvcol;
        if (listSortState.col === col) listSortState.dir = listSortState.dir === "asc" ? "desc" : "asc";
        else { listSortState.col = col; listSortState.dir = "asc"; }
        renderListView();
      });
    });
    container.querySelectorAll("[data-lv-stage-id]").forEach((sel) => {
      sel.addEventListener("change", () => moveApplicationToStage(sel.dataset.lvStageId, sel.value));
    });
    container.querySelectorAll("[data-lv-detail]").forEach((btn) => {
      btn.addEventListener("click", () => openAppDetailModal(btn.dataset.lvDetail));
    });
    container.querySelectorAll("[data-lv-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(btn.dataset.lvEdit));
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PIPELINE VIEW (View 4)
  // ═══════════════════════════════════════════════════════════════
  const PIPELINE_STAGES = ["Wishlist", "Applied", "OA/Test", "Interview", "Offer"];

  function renderPipelineView() {
    const container = document.getElementById("pipeline-view-container");
    if (!container) return;
    const apps = getFilteredApplications();
    container.innerHTML =
      `<div class="pv-wrap">
        <div class="pv-header-row">
          <div class="pv-job-label">Job</div>
          ${PIPELINE_STAGES.map((s) => `<div class="pv-stage-label">${s}</div>`).join("")}
          <div class="pv-stage-label" style="color:var(--accent-secondary)">Rejected</div>
        </div>
        ${apps.length === 0
          ? `<div class="pv-empty">No applications match the current filter</div>`
          : apps.map((app) => {
              const isRejected = app.stage === "Rejected";
              const isOffer = app.stage === "Offer";
              const currentIdx = PIPELINE_STAGES.indexOf(app.stage);
              const dots = PIPELINE_STAGES.map((s, i) => {
                let cls = "pv-dot pv-dot-empty";
                if (isOffer) { cls = i <= 4 ? "pv-dot pv-dot-reached" : "pv-dot pv-dot-empty"; if (i === 4) cls = "pv-dot pv-dot-offer"; }
                else if (isRejected && currentIdx >= 0 && i <= currentIdx) cls = "pv-dot pv-dot-reached";
                else if (!isRejected && !isOffer && i < currentIdx) cls = "pv-dot pv-dot-reached";
                else if (!isRejected && !isOffer && i === currentIdx) cls = "pv-dot pv-dot-active";
                return `<div class="pv-stage-cell"><span class="${cls}" title="${esc(s)}"></span></div>`;
              }).join("");
              const rejDot = isRejected
                ? `<div class="pv-stage-cell"><span class="pv-dot pv-dot-terminated" title="Rejected"></span></div>`
                : `<div class="pv-stage-cell"><span class="pv-dot pv-dot-empty" title="Not rejected"></span></div>`;
              const updDate = app.updatedAt ? new Date(app.updatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";
              return `<div class="pv-row">
                <div class="pv-job-cell">
                  <button type="button" class="pv-job-btn" data-pv-detail="${esc(app.id)}" title="${esc(app.company)} — ${esc(app.role)}">
                    <span class="pv-job-company">${esc(app.company)}</span>
                    <span class="pv-job-role">${esc(app.role)}</span>
                    ${updDate ? `<span class="pv-job-date">${updDate}</span>` : ""}
                  </button>
                </div>
                ${dots}${rejDot}
              </div>`;
            }).join("")}
      </div>`;
    container.querySelectorAll("[data-pv-detail]").forEach((btn) => {
      btn.addEventListener("click", () => openAppDetailModal(btn.dataset.pvDetail));
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
        if (state.searchQuery) {
          const looksLikeReqId = /^[a-z0-9\-_]{2,20}$/i.test(state.searchQuery) && /\d/.test(state.searchQuery);
          parts.push(`Search: "${state.searchQuery}"${looksLikeReqId ? " (req ID)" : ""}`);
        }
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
    // Self-deadline widget
    const remaining = Math.max(0, state.currentWeeklyGoal - count);
    const daysLeft = 7 - new Date().getDay(); // Sun=7, Mon=6 … Sat=1
    const appsLeftEl = document.getElementById("dw-apps-left");
    const daysLeftEl = document.getElementById("dw-days-left");
    const hintEl = document.getElementById("dw-hint");
    if (appsLeftEl) appsLeftEl.textContent = remaining;
    if (daysLeftEl) daysLeftEl.textContent = daysLeft;
    if (hintEl) {
      if (remaining === 0) {
        hintEl.textContent = "🎉 Weekly goal achieved!";
        hintEl.className = "dw-hint dw-hint-done";
      } else {
        hintEl.textContent = `Apply ${remaining} more within ${daysLeft} day${daysLeft === 1 ? "" : "s"} to hit your goal`;
        hintEl.className = "dw-hint";
      }
    }
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
    // compute early so template literals can use it
    const defaultDeadline = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().slice(0, 10); })();

    let html = `<div class="modal-inner">`;
    html += `<div class="modal-head"><h2 id="modal-title">${isEdit ? "Edit Application" : "New Application"}</h2><button type="button" class="modal-close-btn" id="close-modal-btn">✕</button></div>`;

    // New app: single-step form with URL autofill bar at the top
    if (!isEdit) {
      html += `<form id="app-form" class="modal-section">
        <div class="autofill-bar">
          <input type="url" id="source-link-input" placeholder="Paste job URL to auto-fill…" class="modal-input autofill-url-input" autocomplete="off"/>
          <button type="button" class="btn btn-primary" id="extract-continue-btn">Fetch &amp; Fill →</button>
        </div>
        <div id="extract-loader" style="display:none;margin:4px 0 2px;color:var(--text-secondary);font-size:.82rem">Extracting job data…</div>
        <div class="autofill-alt-row">
          <button type="button" id="source-file-btn" class="source-alt-link">📎 Upload file instead</button>
        </div>
        <div id="source-file-panel" style="display:none;margin-top:8px">
          <label for="source-file-input">Attachment (.txt, .csv, .xlsx)</label>
          <input type="file" id="source-file-input" accept=".txt,.csv,.xlsx,.xls" class="modal-input"/>
          <button type="button" class="btn btn-primary" id="file-continue-btn" style="margin-top:6px">Parse &amp; Fill</button>
        </div>
        <div class="autofill-divider"></div>
        <input type="hidden" id="form-id" value=""/>
        <input type="hidden" id="form-link" value=""/>
        <div class="modal-grid">
          <div><label for="form-company">Company</label><input type="text" id="form-company" maxlength="120" value="" class="modal-input" placeholder="SAP SE"/></div>
          <div><label for="form-role">Role</label><input type="text" id="form-role" maxlength="200" value="" class="modal-input" placeholder="BTP Developer"/></div>
        </div>
        <div class="modal-grid">
          <div><label for="form-location">Location</label><input type="text" id="form-location" maxlength="120" value="" class="modal-input" placeholder="Walldorf, Germany"/></div>
          <div><label for="form-req-id">Req ID</label><input type="text" id="form-req-id" maxlength="120" value="" class="modal-input" placeholder="123456"/></div>
        </div>
        <div class="modal-grid">
          <div><label for="form-stage">Stage</label><select id="form-stage" class="modal-input">${STAGES.map((s) => `<option value="${s}" ${s === "Wishlist" ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          <div><label for="form-deadline">Self Deadline</label><input type="date" id="form-deadline" value="${defaultDeadline}" class="modal-input"/></div>
        </div>
        <div class="modal-grid">
          <div><label for="form-posting-date">Posting Date</label><input type="date" id="form-posting-date" value="" class="modal-input"/></div>
          <div><label for="form-link-edit">Job Link</label><input type="url" id="form-link-edit" maxlength="500" value="" class="modal-input" oninput="document.getElementById('form-link').value=this.value" placeholder="https://jobs.sap.com/job/..."/></div>
        </div>
        <div><label for="form-notes">Notes</label><textarea id="form-notes" maxlength="500" class="modal-input" rows="2"></textarea></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-modal-btn">Cancel</button>
        </div>
      </form>`;
    }

    // Form step (edit only — new-app form is already built above)
    const a = existing || { id: "", company: "", role: "", link: "", location: "", reqId: "", postingDate: "", stage: "Wishlist", deadline: defaultDeadline, contactType: "", contactName: "", notes: "" };
    if (isEdit) {
      html += `<form id="app-form" class="modal-section">
        <p class="modal-step-label">Edit Application</p>
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
          <div><label for="form-stage">Stage</label><select id="form-stage" class="modal-input">${STAGES.map((s) => `<option value="${s}" ${s === a.stage ? "selected" : ""}>${s}</option>`).join("")}</select></div>
          <div><label for="form-deadline">Self Deadline</label><input type="date" id="form-deadline" value="${a.deadline || ""}" class="modal-input"/></div>
        </div>
        <div class="modal-grid">
          <div><label for="form-posting-date">Posting Date</label><input type="date" id="form-posting-date" value="${a.postingDate || ""}" class="modal-input"/></div>
          <div><label for="form-link-edit">Job Link</label><input type="url" id="form-link-edit" maxlength="500" value="${esc(a.link)}" class="modal-input" oninput="document.getElementById('form-link').value=this.value"/></div>
        </div>
        <div><label for="form-notes">Notes</label><textarea id="form-notes" maxlength="500" class="modal-input" rows="3">${esc(a.notes)}</textarea></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="cancel-modal-btn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>`;
    } else {
      // (new-app form already generated above)
    }
    html += `</div>`;

    DOM.modalBox.innerHTML = html;
    DOM.modalBackdrop.classList.remove("hidden");

    // Bind events
    $("close-modal-btn")?.addEventListener("click", closeModal);
    $("cancel-modal-btn")?.addEventListener("click", closeModal);
    $("app-form")?.addEventListener("submit", saveApplicationFromForm);

    if (!isEdit) {
      $('source-file-btn')?.addEventListener('click', () => {
        const fp = $('source-file-panel');
        fp.style.display = fp.style.display === 'none' ? '' : 'none';
      });
      $('extract-continue-btn')?.addEventListener('click', handleLinkExtraction);
      $('file-continue-btn')?.addEventListener('click', handleFileExtraction);
      $('source-link-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleLinkExtraction(); } });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // APP DETAIL POPUP (double-click kanban card)
  // ═══════════════════════════════════════════════════════════════
  function openAppDetailModal(id) {
    // search both live state and filtered cache
    let app = state.applications.find((a) => a.id === id);
    if (!app) app = (anState.filtered || []).find((a) => a.id === id);
    if (!app) { showToast("Application not found — try refreshing", "error"); return; }
    if (!DOM.modalBox) DOM.modalBox = document.getElementById("modal-box");
    if (!DOM.modalBackdrop) DOM.modalBackdrop = document.getElementById("modal-backdrop");
    if (!DOM.modalBox || !DOM.modalBackdrop) { showToast("Modal unavailable", "error"); return; }

    const slug = (app.stage || "").toLowerCase().replace(/[^a-z]/g, "");
    const added = app.createdAt
      ? new Date(app.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "";

    const analysisKey = "analysis_" + (app.reqId || encodeURIComponent(app.link || ""));
    let analysis = null;
    try {
      const raw = localStorage.getItem(analysisKey);
      if (raw) analysis = JSON.parse(raw);
    } catch {}

    let analysisHtml = "";
    if (analysis && (analysis.jdSummary || analysis.matchedChunks)) {
      const summary = analysis.jdSummary || null;
      const chunks = analysis.matchedChunks || [];
      const topChunks = chunks.slice(0, 6);
      const coverage = topChunks.length;
      const avgRel = coverage
        ? Math.round(topChunks.reduce((sum, c) => sum + Math.round((1 - (c.distance || 0)) * 100), 0) / coverage)
        : 0;
      const coveragePct = Math.round((Math.min(coverage, 6) / 6) * 100);
      const fitScore = Math.round(avgRel * 0.7 + coveragePct * 0.3);
      const fit = (fitScore >= 70)
        ? { label: "STRONG FIT", cls: "strong" }
        : (fitScore >= 52)
        ? { label: "GOOD FIT", cls: "good" }
        : (fitScore >= 35)
        ? { label: "PARTIAL FIT", cls: "partial" }
        : { label: "LOW MATCH", cls: "low" };

      const oneLiner = summary?.snapshot?.one_liner || "";
      const mustHave = (summary?.must_have || []).slice(0, 4);
      const niceToHave = (summary?.nice_to_have || []).slice(0, 3);
      const aiSkills = (summary?.skills || []).slice(0, 6);
      const aiTools = (summary?.tools || []).slice(0, 6);

      const barsHtml = topChunks.slice(0, 5).map((c) => {
        const rel = Math.round((1 - (c.distance || 0)) * 100);
        const color = rel >= 65 ? "#059669" : rel >= 45 ? "#d97706" : "#9ca3af";
        return `<div class="adm-bar-row">
          <span class="adm-bar-name">${esc(c.metadata?.skill_name || c.id || "")}</span>
          <div class="adm-bar-track"><div class="adm-bar-fill" style="width:${rel}%;background:${color}"></div></div>
          <span class="adm-bar-pct" style="color:${color}">${rel}%</span>
        </div>`;
      }).join("");

      analysisHtml = `<section class="adm-analysis">
        <div class="adm-fit-badge adm-fit-${fit.cls}">${fit.label} · fit ${fitScore}% · ${coverage} matches · avg ${avgRel}%</div>
        ${oneLiner ? `<p class="adm-oneliner">${esc(oneLiner)}</p>` : ""}
        <div class="adm-grid">
          <div class="adm-panel">
            <div class="adm-panel-hdr">Requirements</div>
            ${mustHave.length ? `<div class="adm-chip-wrap">${mustHave.map((x) => `<span class="adm-chip adm-chip-must">${esc(x)}</span>`).join("")}</div>` : `<div class="adm-empty">No must-have list extracted</div>`}
            ${niceToHave.length ? `<div class="adm-chip-wrap" style="margin-top:8px">${niceToHave.map((x) => `<span class="adm-chip adm-chip-nice">${esc(x)}</span>`).join("")}</div>` : ""}
          </div>
          <div class="adm-panel">
            <div class="adm-panel-hdr">Skills / Tools</div>
            ${(aiSkills.length || aiTools.length)
              ? `<div class="adm-chip-wrap">${aiSkills.map((x) => `<span class="adm-chip adm-chip-skill">${esc(x)}</span>`).join("")}${aiTools.map((t) => {
                  const clean = t.endsWith("+") ? t.slice(0, -1) : t;
                  return `<span class="adm-chip adm-chip-tool">${esc(clean)}</span>`;
                }).join("")}</div>`
              : `<div class="adm-empty">No skills/tools extracted</div>`}
          </div>
        </div>
        ${barsHtml ? `<div class="adm-panel" style="margin-top:10px"><div class="adm-panel-hdr">Skill Bank Coverage</div>${barsHtml}</div>` : ""}
        <div class="adm-analysis-actions">
          <button type="button" class="btn btn-primary" id="app-det-analyze">↺ Re-analyze in Generate</button>
        </div>
      </section>`;
    } else if (app.link) {
      analysisHtml = `<section class="adm-no-analysis">
        <div class="adm-no-icon">⚡</div>
        <div class="adm-no-text">
          <strong>Analysis not generated yet</strong>
          <span>Open Generate tab, run analysis once, then this tracker popup will always show saved fit details.</span>
        </div>
        <button type="button" class="btn btn-primary" id="app-det-analyze">Analyze Now →</button>
      </section>`;
    }

    let html = `<div class="modal-inner adm-modal">`;
    html += `<div class="modal-head"><span class="stage-pill stage-pill-${slug}">${esc(app.stage)}</span><h2 id="modal-title" class="app-detail-h2">${esc(app.company)}</h2><button type="button" class="modal-close-btn" id="close-modal-btn">✕</button></div>`;
    html += `<p class="app-detail-role">${esc(app.role)}</p>`;
    html += `<div class="app-detail-meta">`;
    if (app.location) html += `<span>📍 ${esc(app.location)}</span>`;
    if (app.reqId) html += `<span>🔎 Req ${esc(app.reqId)}</span>`;
    if (app.postingDate) html += `<span>📅 Posted ${esc(app.postingDate)}</span>`;
    if (app.deadline) html += `<span class="app-detail-deadline">⏰ Deadline ${esc(app.deadline)}</span>`;
    if (added) html += `<span>➕ Added ${added}</span>`;
    html += `</div>`;
    if (app.notes) html += `<div class="app-detail-notes">${esc(app.notes)}</div>`;
    if (app.link) html += `<div class="app-detail-link"><a href="${esc(app.link)}" target="_blank" rel="noopener noreferrer">🔗 Open Job Posting ↗</a></div>`;
    if (app.topMatchedSkills && app.topMatchedSkills.length && !analysisHtml) {
      html += `<div class="app-detail-skills"><span class="app-detail-skills-lbl">Matched Skills</span>${app.topMatchedSkills.slice(0, 6).map((s) => `<span class="scrape-skill-tag">${esc(s)}</span>`).join("")}</div>`;
    }
    html += analysisHtml;

    // ── Focus / Spotlight sections: Interview Rounds + Communications ──
    const interviews = app.interviews || [];
    const comms = app.communications || [];

    const roundsHtml = interviews.length === 0
      ? `<div class="adm-empty-hint">No rounds logged yet</div>`
      : interviews.map((r, i) => {
          const outcomeCls = `adm-outcome-${(r.outcome || "pending").toLowerCase().replace(/\s+/g, "")}`;
          return `<div class="adm-round">
            <span class="adm-round-num">R${i + 1}</span>
            <div style="flex:1">
              <div class="adm-round-info">
                ${r.date ? `<span>&#128197; ${esc(r.date)}${r.time ? " " + esc(r.time) : ""}</span>` : ""}
                ${r.platform ? `<span>&#128187; ${esc(r.platform)}</span>` : ""}
                ${(r.interviewers || []).length ? `<span>&#128100; ${esc(r.interviewers.join(", "))}</span>` : ""}
                ${r.type ? `<span>${esc(r.type)}</span>` : ""}
                <span class="adm-round-outcome ${outcomeCls}">${esc(r.outcome || "Pending")}</span>
              </div>
              ${r.myNotes ? `<div class="adm-round-notes">${esc(r.myNotes)}</div>` : ""}
            </div>
          </div>`;
        }).join("");

    const commsHtml = comms.length === 0
      ? `<div class="adm-empty-hint">No communications logged yet</div>`
      : [...comms].sort((a, b) => (a.date || "") > (b.date || "") ? -1 : 1).map((c) =>
          `<div class="adm-comm">
            <span class="adm-comm-dir">${c.direction === "Sent" ? "&#128228;" : "&#128229;"}</span>
            <div style="flex:1">
              <div><span class="adm-comm-date">${esc(c.date || "")}</span> <span class="adm-comm-from">${esc(c.from || "")}</span></div>
              ${c.subject ? `<div class="adm-comm-subject">${esc(c.subject)}</div>` : ""}
              ${c.summary ? `<div class="adm-comm-summary">${esc(c.summary)}</div>` : ""}
            </div>
          </div>`).join("");

    html += `
    <div class="adm-section">
      <div class="adm-section-hdr">
        <h3 class="adm-section-title">Interview Rounds <span style="font-size:10px;font-weight:400;color:var(--text-muted);text-transform:none">${interviews.length} logged</span></h3>
        <button type="button" class="btn btn-xs" id="adm-add-round-btn">+ Add Round</button>
      </div>
      <div class="adm-section-body" id="adm-rounds-body">${roundsHtml}</div>
      <div id="adm-round-form" style="display:none" class="adm-inline-form-panel">
        <div class="adm-inline-form">
          <div class="adm-inline-form-grid">
            <div><label>Date</label><input type="date" id="adm-rf-date" class="modal-input" style="font-size:var(--text-xs);padding:5px 8px"/></div>
            <div><label>Time</label><input type="time" id="adm-rf-time" class="modal-input" style="font-size:var(--text-xs);padding:5px 8px"/></div>
            <div><label>Platform</label><select id="adm-rf-platform" class="modal-input" style="font-size:var(--text-xs);padding:5px 8px"><option>Teams</option><option>Zoom</option><option>Phone</option><option>On-site</option><option>Google Meet</option><option>Other</option></select></div>
            <div><label>Type</label><select id="adm-rf-type" class="modal-input" style="font-size:var(--text-xs);padding:5px 8px"><option>HR Screen</option><option>Technical</option><option>Case Study</option><option>Manager</option><option>Final Round</option></select></div>
            <div><label>Interviewer(s)</label><input type="text" id="adm-rf-interviewers" class="modal-input" placeholder="Name(s), comma separated" style="font-size:var(--text-xs);padding:5px 8px"/></div>
            <div><label>Outcome</label><select id="adm-rf-outcome" class="modal-input" style="font-size:var(--text-xs);padding:5px 8px"><option>Pending</option><option>Passed</option><option>Rejected</option><option>No Response</option></select></div>
          </div>
          <div><label>Notes</label><textarea id="adm-rf-notes" rows="2" class="modal-input" placeholder="How did it go?" style="font-size:var(--text-xs);padding:5px 8px;width:100%;box-sizing:border-box;resize:vertical"></textarea></div>
          <div class="adm-inline-form-actions">
            <button type="button" class="btn" id="adm-rf-cancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="adm-rf-save">Save Round</button>
          </div>
        </div>
      </div>
    </div>
    <div class="adm-section" style="margin-bottom:6px">
      <div class="adm-section-hdr">
        <h3 class="adm-section-title">Communications <span style="font-size:10px;font-weight:400;color:var(--text-muted);text-transform:none">${comms.length} logged</span></h3>
        <button type="button" class="btn btn-xs" id="adm-add-comm-btn">+ Log Email</button>
      </div>
      <div class="adm-section-body" id="adm-comms-body">${commsHtml}</div>
      <div id="adm-comm-form" style="display:none" class="adm-inline-form-panel">
        <div class="adm-inline-form">
          <div class="adm-inline-form-grid">
            <div><label>Date</label><input type="date" id="adm-cf-date" class="modal-input" style="font-size:var(--text-xs);padding:5px 8px"/></div>
            <div><label>Direction</label><select id="adm-cf-dir" class="modal-input" style="font-size:var(--text-xs);padding:5px 8px"><option>Received</option><option>Sent</option></select></div>
            <div><label>From / To</label><input type="text" id="adm-cf-from" class="modal-input" placeholder="Person name" style="font-size:var(--text-xs);padding:5px 8px"/></div>
            <div><label>Subject</label><input type="text" id="adm-cf-subject" class="modal-input" placeholder="Email subject" style="font-size:var(--text-xs);padding:5px 8px"/></div>
          </div>
          <div><label>Summary</label><textarea id="adm-cf-summary" rows="2" class="modal-input" placeholder="Brief summary of the email" style="font-size:var(--text-xs);padding:5px 8px;width:100%;box-sizing:border-box;resize:vertical"></textarea></div>
          <div class="adm-inline-form-actions">
            <button type="button" class="btn" id="adm-cf-cancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="adm-cf-save">Save</button>
          </div>
        </div>
      </div>
    </div>`;

    html += `<div class="modal-actions app-detail-actions adm-footer-actions">`;
    html += `<button type="button" class="btn" id="app-det-edit">✎ Edit</button>`;
    html += `<select class="modal-input app-detail-stage-sel" id="app-det-stage" title="Move to stage">${STAGES.map((s) => `<option value="${s}" ${s === app.stage ? "selected" : ""}>${s}</option>`).join("")}</select>`;
    html += `<button type="button" class="btn" style="color:var(--accent-secondary);border-color:rgba(220,38,38,.3)" id="app-det-delete">🗑 Delete</button>`;
    html += `</div></div>`;

    DOM.modalBox.innerHTML = html;
    DOM.modalBox.classList.add("adm-wide");
    DOM.modalBackdrop.classList.remove("hidden");

    $("close-modal-btn")?.addEventListener("click", closeModal);
    DOM.modalBackdrop.addEventListener("click", (e) => { if (e.target === DOM.modalBackdrop) closeModal(); }, { once: true });
    $("app-det-edit")?.addEventListener("click", () => { closeModal(); openModal(id); });
    $("app-det-stage")?.addEventListener("change", (e) => { moveApplicationToStage(id, e.target.value); closeModal(); });
    $("app-det-delete")?.addEventListener("click", () => { if (confirm(`Delete "${app.company} — ${app.role}"?`)) { deleteApplicationById(id); closeModal(); } });

    // Interview round form
    $("adm-add-round-btn")?.addEventListener("click", () => {
      const form = $("adm-round-form");
      if (form) form.style.display = form.style.display === "none" ? "" : "none";
    });
    $("adm-rf-cancel")?.addEventListener("click", () => { if ($("adm-round-form")) $("adm-round-form").style.display = "none"; });
    $("adm-rf-save")?.addEventListener("click", async () => {
      const roundData = {
        date: $("adm-rf-date")?.value || "",
        time: $("adm-rf-time")?.value || "",
        platform: $("adm-rf-platform")?.value || "",
        type: $("adm-rf-type")?.value || "",
        interviewers: ($("adm-rf-interviewers")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
        outcome: $("adm-rf-outcome")?.value || "Pending",
        myNotes: $("adm-rf-notes")?.value?.trim() || ""
      };
      await saveInterviewRound(id, roundData);
      openAppDetailModal(id);
    });

    // Communication form
    $("adm-add-comm-btn")?.addEventListener("click", () => {
      const form = $("adm-comm-form");
      if (form) form.style.display = form.style.display === "none" ? "" : "none";
    });
    $("adm-cf-cancel")?.addEventListener("click", () => { if ($("adm-comm-form")) $("adm-comm-form").style.display = "none"; });
    $("adm-cf-save")?.addEventListener("click", async () => {
      const commData = {
        date: $("adm-cf-date")?.value || new Date().toISOString().slice(0, 10),
        direction: $("adm-cf-dir")?.value || "Received",
        from: $("adm-cf-from")?.value?.trim() || "",
        subject: $("adm-cf-subject")?.value?.trim() || "",
        summary: $("adm-cf-summary")?.value?.trim() || ""
      };
      await saveCommunication(id, commData);
      openAppDetailModal(id);
    });

    $("app-det-analyze")?.addEventListener("click", () => {
      closeModal();
      const job = {
        title: app.role,
        url: app.link,
        requisitionId: app.reqId,
        location: app.location,
        matchScore: app.matchScore || null,
        topMatchedSkills: app.topMatchedSkills || []
      };
      if (window.GenerateModule?.addToQueue) {
        window.GenerateModule.addToQueue(job);
        document.querySelector('[data-view="generate"]')?.click();
        showToast("Added to Generation Queue — analysis starting…");
      } else {
        showToast("Open the Generate tab to analyze", "error");
      }
    });
  }

  function closeModal() {
    state.editingId = null;
    DOM.modalBox?.classList.remove("adm-wide");
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
        if ($("form-company")) $("form-company").value = jd.company || extractCompanyFromUrl(url) || "";
        if ($("form-role")) $("form-role").value = jd.title || "";
        if ($("form-location")) $("form-location").value = jd.location || "";
        if ($("form-req-id")) $("form-req-id").value = jd.requisitionId || "";
        // sync to both hidden and visible link fields
        if ($("form-link")) $("form-link").value = url;
        if ($("form-link-edit")) $("form-link-edit").value = url;
        if (jd.postedDate && $("form-posting-date")) $("form-posting-date").value = toIsoDate(jd.postedDate);
        showToast("Fields filled — saving application…", "success");
        // auto-save: submit the form programmatically
        setTimeout(() => $('app-form')?.requestSubmit(), 150);
      } else {
        showToast("Could not extract job data", "error");
      }
    } catch (err) {
      showToast("Extraction failed: " + err.message, "error");
    }
    if (loader) loader.style.display = "none";
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
    // collapse the file panel after parsing
    const fp = $("source-file-panel");
    if (fp) fp.style.display = "none";
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
      link: $('form-link')?.value?.trim() || "",
      location: $('form-location')?.value?.trim() || "",
      reqId: $('form-req-id')?.value?.trim() || "",
      postingDate: $('form-posting-date')?.value || "",
      stage: $('form-stage')?.value || "Wishlist",
      deadline: $('form-deadline')?.value || "",
      contactType: $('form-contact-type')?.value || "",
      contactName: $('form-contact-name')?.value?.trim() || "",
      notes: typeof $('form-notes')?.value === 'string' ? $('form-notes').value.trim() : ($('form-notes')?.getAttribute?.('value') || ""),
      updatedAt: new Date().toISOString()
    };

    if (existing) {
      payload.createdAt = existing.createdAt;
      const idx = state.applications.findIndex((a) => a.id === id);
      state.applications[idx] = { ...existing, ...payload };
    } else {
      payload.createdAt = new Date().toISOString();
      payload.interviews = [];
      payload.communications = [];
      state.applications.unshift(payload);
      // Auto-add to generation queue for fit analysis if app has a link
      if (payload.link && window.GenerateModule?.addToQueue) {
        window.GenerateModule.addToQueue({ title: payload.role, url: payload.link,
          requisitionId: payload.reqId, location: payload.location,
          matchScore: null, topMatchedSkills: [] });
      }
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
    // table action clicks — re-query tbody each time in case DOM was null at init
    const attachTableClicks = () => {
      const tbody = DOM.anTableBody || document.getElementById("anTableBody");
      if (!tbody) return;
      if (tbody._clickBound) return; // prevent duplicates
      tbody._clickBound = true;
      tbody.addEventListener("click", (e) => {
        const editBtn = e.target.closest("[data-edit-id]");
        if (editBtn) { openModal(editBtn.dataset.editId); return; }
        const viewBtn = e.target.closest("[data-view-id]");
        if (viewBtn) { openAppDetailModal(viewBtn.dataset.viewId); return; }
      });
    };
    attachTableClicks();
    // expose so an_applyFilters can call it after first render
    anState._attachTableClicks = attachTableClicks;
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
    an_renderTable(rows); // _attachTableClicks called inside
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
    if (!DOM.anTableBody) DOM.anTableBody = document.getElementById("anTableBody");
    if (!DOM.anTableBody) return;
    if (!rows.length) { DOM.anTableBody.innerHTML = ""; DOM.anEmpty && (DOM.anEmpty.style.display = ""); return; }
    DOM.anEmpty && (DOM.anEmpty.style.display = "none");
    DOM.anTableBody.innerHTML = rows.map((a) => {
      const code = an_stageCode(a.stage);
      const postDate = a.postingDate ? new Date(a.postingDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";
      const dueDate  = a.deadline    ? new Date(a.deadline).toLocaleDateString("en-GB",    { day: "2-digit", month: "short" }) : "—";
      return `<tr data-app-id="${a.id}" style="cursor:pointer">
        <td class="an-td-bold">${esc(a.company)}</td>
        <td class="an-td-role"><span>${esc(a.role)}</span></td>
        <td>${esc(cleanLoc(a.location))}</td>
        <td><span class="an-badge an-badge-${code}"><span class="an-badge-dot"></span>${a.stage}</span></td>
        <td class="an-td-dates"><span class="an-date-post">${postDate}</span><span class="an-date-arrow">→</span><span class="an-date-due">${dueDate}</span></td>
        <td>${esc(a.reqId || "—")}</td>
        <td class="an-td-actions"><button type="button" class="an-btn" data-edit-id="${a.id}">Edit</button></td>
      </tr>`;
    }).join("");
    // double-click row to open detail
    DOM.anTableBody.querySelectorAll("tr[data-app-id]").forEach((row) => {
      row.addEventListener("dblclick", () => openAppDetailModal(row.dataset.appId));
    });
    DOM.anTableBody.querySelectorAll("[data-edit-id]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(btn.dataset.editId));
    });
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
    const portal   = DOM.scrapePortal?.value || "sap";
    const keyword  = DOM.scrapeKeyword?.value?.trim() || "";
    const isSapBasf = portal === "sap" || portal === "basf";
    let location = "";
    if (isSapBasf) {
      const ddEl = document.getElementById("scrape-location-dropdown");
      location = ddEl?.value || "";
    } else {
      location = DOM.scrapeLocation?.value?.trim() || "";
    }
    if (!isSapBasf && !keyword && !location) { showToast("Enter a keyword or location", "error"); return; }
    const period = DOM.scrapePeriod?.value || "1week";
    const careerStatus = DOM.scrapeCareerStatus?.value || "Student";
    const country = DOM.scrapeCountry?.value || "DE";
    const state = DOM.scrapeState?.value?.trim() || "";
    const city  = DOM.scrapeCity?.value?.trim() || "";

    if (DOM.scrapeSpinner) DOM.scrapeSpinner.classList.add("active");
    if (DOM.scrapeBtnText) DOM.scrapeBtnText.textContent = "Searching…";
    if (DOM.scrapeSearchBtn) DOM.scrapeSearchBtn.disabled = true;

    // Show animated search progress bar
    let searchBarEl = document.getElementById("search-progress-bar");
    if (!searchBarEl) {
      searchBarEl = document.createElement("div");
      searchBarEl.id = "search-progress-bar";
      searchBarEl.className = "search-progress-bar";
      searchBarEl.innerHTML = `<div class="search-progress-fill"></div><span class="search-progress-label">Connecting to careers portal…</span>`;
      const card = DOM.scrapeSearchBtn?.closest(".auto-card");
      if (card) card.appendChild(searchBarEl);
    }
    searchBarEl.classList.add("active");
    const fill = searchBarEl.querySelector(".search-progress-fill");
    const label = searchBarEl.querySelector(".search-progress-label");
    const portalName = DOM.scrapePortal?.options?.[DOM.scrapePortal.selectedIndex]?.text || "SAP";
    const steps = [
      { pct: 15, text: `Connecting to ${portalName} careers portal…` },
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
        body: JSON.stringify({ keyword, location, state, city, period, careerStatus, country, portal })
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
          // Warn if keyword doesn't seem related to the selected portal
          if (portal === "sap") {
            const sapKws = ["sap","btp","hana","fiori","s/4","abap","cloud","analytics","erp","concur","ariba","successfactors","signavio","hybris","commerce","datasphere","joule"];
            const kwLower = keyword.toLowerCase();
            if (!sapKws.some(k => kwLower.includes(k)) && scrapeState.jobs.length > 0) {
              showToast(`Note: "${keyword}" may not be SAP-specific. This searches SAP's portal — results may vary in relevance.`, "info");
            }
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
    if (!scrapeState.jobs.length) {
      if (DOM.scrapeResultCount) DOM.scrapeResultCount.textContent = "0 jobs";
      DOM.scrapeResultsBody.innerHTML = `<tr><td colspan="7" class="auto-empty">No jobs found. Adjust filters and try again.</td></tr>`;
      return;
    }
    // Apply post-scrape location filter for SAP/BASF
    const _portal    = DOM.scrapePortal?.value || "sap";
    const _locSelEl  = document.getElementById("scrape-location-dropdown");
    const _locVal    = (_portal === "sap" || _portal === "basf") ? (_locSelEl?.value || "") : "";
    const scrapeSortSel = document.getElementById("scrape-sort-select");
    const scrapeSortVal = scrapeSortSel ? scrapeSortSel.value : "match";
    const postedSortBtn = document.getElementById("scrape-posted-sort-btn");
    if (postedSortBtn) {
      postedSortBtn.classList.toggle("is-date-desc", scrapeSortVal === "date-desc");
      postedSortBtn.classList.toggle("is-date-asc", scrapeSortVal === "date-asc");
      postedSortBtn.setAttribute("aria-sort", scrapeSortVal === "date-desc" ? "descending" : scrapeSortVal === "date-asc" ? "ascending" : "none");
      postedSortBtn.title = scrapeSortVal === "date-desc"
        ? "Posted: newest jobs first"
        : scrapeSortVal === "date-asc"
          ? "Posted: oldest jobs first"
          : "Sort by posted date";
    }
    const parseRawDate = (r) => { if (!r || r === "N/A") return 0; const d = new Date(r); return isNaN(d) ? 0 : d.getTime(); };
    let displayJobs = scrapeState.jobs.map((job, i) => ({ job, i }));
    if (_locVal) displayJobs = displayJobs.filter(({ job }) => locationMatches(job.location, _locVal));
    if (DOM.scrapeResultCount) DOM.scrapeResultCount.textContent = `${displayJobs.length} jobs`;
    if (!displayJobs.length) {
      const locLabel = _locSelEl?.options[_locSelEl.selectedIndex]?.text || _locVal;
      DOM.scrapeResultsBody.innerHTML = `<tr><td colspan="7" class="auto-empty">No jobs match "${locLabel}". Try a different location or "All Locations".</td></tr>`;
      return;
    }
    if (scrapeSortVal === "date-desc") displayJobs.sort((a, b) => parseRawDate(b.job.rawDate) - parseRawDate(a.job.rawDate));
    else if (scrapeSortVal === "date-asc") displayJobs.sort((a, b) => parseRawDate(a.job.rawDate) - parseRawDate(b.job.rawDate));
    DOM.scrapeResultsBody.innerHTML = displayJobs.map(({ job, i }) => {
      const sel = scrapeState.selected.has(i);
      const alreadyTracked = state.applications.some(a => a.reqId && a.reqId === job.requisitionId);
      const trackBtnHtml = alreadyTracked
        ? `<button type="button" class="btn btn-sm scrape-quick-add" data-idx="${i}" disabled style="background:rgba(62,207,142,.15);color:#3ECF8E;border-color:rgba(62,207,142,.4);cursor:default">&#10003; Tracked</button>`
        : `<button type="button" class="btn btn-sm btn-primary scrape-quick-add" data-idx="${i}">+ Track</button>`;
      return `<tr class="${sel ? "selected-row" : ""}" data-idx="${i}" data-selectable="true" role="checkbox" aria-checked="${sel ? "true" : "false"}" tabindex="0">
        <td><input type="checkbox" class="scrape-select-cb" data-idx="${i}" ${sel ? "checked" : ""}/></td>
        <td>
          <div class="scrape-title-cell">
            <a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(job.title)}</a>
            ${job.matchScore != null ? `<span class="match-badge ${job.matchScore >= 65 ? "match-badge-high" : job.matchScore >= 40 ? "match-badge-med" : "match-badge-low"}" title="Quick estimate from title + skill-bank similarity. Use Analyze JD for detailed fit.">${job.matchScore}% quick fit</span>` : ""}
          </div>
          ${(job.topMatchedSkills && job.topMatchedSkills.length) ? `<div class="scrape-skill-tags">${job.topMatchedSkills.slice(0,4).map(s => `<span class="scrape-skill-tag">${esc(s)}</span>`).join("")}</div>` : ""}
        </td>
        <td>${esc(DOM.scrapeKeyword?.value || "")}</td>
        <td>${esc(job.requisitionId || "N/A")}</td>
        <td>${esc(job.location || "N/A")}</td>
        <td>${esc(job.date || "N/A")}</td>
        <td>${trackBtnHtml}</td>
      </tr>`;
    }).join("");

    DOM.scrapeResultsBody.querySelectorAll("tr[data-selectable='true']").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) return;
        const idx = parseInt(row.dataset.idx, 10);
        const shouldSelect = !scrapeState.selected.has(idx);
        if (shouldSelect) scrapeState.selected.set(idx, scrapeState.jobs[idx]);
        else scrapeState.selected.delete(idx);
        renderSelectedJobs();
        renderScrapeResults();
      });
      row.addEventListener("keydown", (event) => {
        if (event.target.closest("a, button")) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const idx = parseInt(row.dataset.idx, 10);
        const shouldSelect = !scrapeState.selected.has(idx);
        if (shouldSelect) scrapeState.selected.set(idx, scrapeState.jobs[idx]);
        else scrapeState.selected.delete(idx);
        renderSelectedJobs();
        renderScrapeResults();
      });
    });

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
        const job = scrapeState.jobs[idx];
        const alreadyTracked = state.applications.some((a) => a.reqId && a.reqId === job.requisitionId);
        if (alreadyTracked) {
          showToast("Already tracking this job", "error");
          return;
        }
        addJobToTracker(job);
        btn.textContent = "✓ Tracked";
        btn.disabled = true;
        btn.classList.remove("btn-primary");
        btn.style.background = "rgba(62,207,142,.15)";
        btn.style.color = "#3ECF8E";
        btn.style.borderColor = "rgba(62,207,142,.4)";
        btn.style.cursor = "default";
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
        ? `<span class="match-badge ${matchScore >= 65 ? "match-badge-high" : matchScore >= 40 ? "match-badge-med" : "match-badge-low"}" title="Quick estimate from title + skill-bank similarity. Use Analyze JD for detailed fit.">${matchScore}% quick fit</span>`
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
      company: job.company || extractCompanyFromUrl(job.url) || "Unknown",
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
        company: job.company || extractCompanyFromUrl(job.url) || "Unknown",
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
    // sync view switcher button states
    document.querySelectorAll(".vsw-btn").forEach((btn) => {
      btn.classList.toggle("vsw-btn--active", btn.dataset.tview === state.currentTrackerView);
    });
    // ensure correct container is visible
    const containers = { kanban: "kanban-board", interview: "interview-focus-board", list: "list-view-container", pipeline: "pipeline-view-container" };
    Object.entries(containers).forEach(([v, id]) => {
      const el = document.getElementById(id);
      if (el) el.style.display = v === state.currentTrackerView ? "" : "none";
    });
    renderTrackerView();
    renderGoal();
    if (anState.initialized) an_applyFilters();
  }

  // ═══════════════════════════════════════════════════════════════
  // BIND EVENTS
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // FULL-VIEW APPLICATIONS OVERLAY
  // ═══════════════════════════════════════════════════════════════
  function openAnFullView() {
    const rows = anState.filtered && anState.filtered.length ? anState.filtered : state.applications;
    const overlay = document.getElementById("anFullViewOverlay");
    const tbody   = document.getElementById("anfvTableBody");
    const count   = document.getElementById("anfvCount");
    if (!overlay || !tbody) return;
    if (count) count.textContent = rows.length;
    tbody.innerHTML = rows.map((a) => {
      const code = an_stageCode(a.stage);
      const postDate = a.postingDate ? new Date(a.postingDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "—";
      const dueDate  = a.deadline    ? new Date(a.deadline).toLocaleDateString("en-GB",    { day: "2-digit", month: "short" }) : "—";
      return `<tr data-app-id="${a.id}" style="cursor:pointer">
        <td class="an-td-bold">${esc(a.company)}</td>
        <td class="an-td-role"><span>${esc(a.role)}</span></td>
        <td>${esc(cleanLoc(a.location))}</td>
        <td><span class="an-badge an-badge-${code}"><span class="an-badge-dot"></span>${a.stage}</span></td>
        <td class="an-td-dates"><span class="an-date-post">${postDate}</span><span class="an-date-arrow">→</span><span class="an-date-due">${dueDate}</span></td>
        <td>${esc(a.reqId || "—")}</td>
        <td class="an-td-actions">
          <button type="button" class="an-btn" data-edit="${a.id}">Edit</button>
        </td>
      </tr>`;
    }).join("");
    // bind row buttons
    tbody.querySelectorAll("tr[data-app-id]").forEach((row) => {
      row.addEventListener("dblclick", () => { closeAnFullView(); openAppDetailModal(row.dataset.appId); });
    });
    tbody.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => { closeAnFullView(); openModal(btn.dataset.edit); });
    });
    overlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closeAnFullView() {
    document.getElementById("anFullViewOverlay")?.classList.add("hidden");
    document.body.style.overflow = "";
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT BINDING
  // ═══════════════════════════════════════════════════════════════
  function bindEvents() {
    // Navigation
    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", (e) => { e.preventDefault(); switchView(btn.dataset.view); });
    });
    DOM.analyticsBtn?.addEventListener("click", () => switchView("analytics"));

    // Tracker view switcher
    document.querySelectorAll(".vsw-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTrackerView(btn.dataset.tview));
    });

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

    // Full-view applications overlay
    document.getElementById("anFullViewBtn")?.addEventListener("click", openAnFullView);
    document.getElementById("anfvCloseBtn")?.addEventListener("click", closeAnFullView);
    document.getElementById("anFullViewOverlay")?.addEventListener("click", (e) => { if (e.target.id === "anFullViewOverlay") closeAnFullView(); });

    // Goal
    DOM.goalEditBtn?.addEventListener("click", editWeeklyGoal);
    document.getElementById("scrape-sort-select")?.addEventListener("change", renderScrapeResults);
    document.getElementById("scrape-posted-sort-btn")?.addEventListener("click", () => {
      const scrapeSortSel = document.getElementById("scrape-sort-select");
      if (!scrapeSortSel) return;
      scrapeSortSel.value = scrapeSortSel.value === "date-desc" ? "date-asc" : "date-desc";
      renderScrapeResults();
    });

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
    function updateSearchBtnState() {
      const portal = DOM.scrapePortal?.value || "sap";
      if (portal === "sap" || portal === "basf") {
        if (DOM.scrapeSearchBtn) DOM.scrapeSearchBtn.disabled = false;
        return;
      }
      const kw  = DOM.scrapeKeyword?.value?.trim() || "";
      const loc = DOM.scrapeLocation?.value?.trim() || "";
      if (DOM.scrapeSearchBtn) DOM.scrapeSearchBtn.disabled = !kw && !loc;
    }
    DOM.scrapeKeyword?.addEventListener("input", updateSearchBtnState);
    DOM.scrapeLocation?.addEventListener("input", updateSearchBtnState);
    updateSearchBtnState();

    // ── AI keyword expansion (debounced) ──
    let kwExpandTimer = null;
    let lastExpandedKw = "";
    DOM.scrapeKeyword?.addEventListener("input", () => {
      clearTimeout(kwExpandTimer);
      const val = DOM.scrapeKeyword.value.trim();
      const expEl = document.getElementById("keyword-expansion");
      const expText = document.getElementById("keyword-expansion-text");
      if (!val || val.length < 2 || val === lastExpandedKw) {
        if (expEl) expEl.classList.add("hidden");
        return;
      }
      kwExpandTimer = setTimeout(async () => {
        try {
          const portal = DOM.scrapePortal?.value || "sap";
          const res = await fetch("/search-intelligence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keyword: val, portal })
          });
          const data = await res.json();
          if (data.success && data.isAbbreviation && data.expanded && data.expanded.toLowerCase() !== val.toLowerCase()) {
            lastExpandedKw = val;
            if (expText) {
              const suggestions = (data.suggestions || []).slice(0, 2).join(", ");
              expText.textContent = `"${val}" = ${data.expanded}${suggestions ? `. Also try: ${suggestions}` : ""}`;
            }
            if (expEl) expEl.classList.remove("hidden");
            // Wire use button
            const useBtn = document.getElementById("keyword-expansion-use");
            if (useBtn) {
              useBtn.onclick = () => {
                DOM.scrapeKeyword.value = data.expanded;
                expEl.classList.add("hidden");
                updateSearchBtnState();
              };
            }
          } else {
            if (expEl) expEl.classList.add("hidden");
          }
        } catch {
          if (expEl) expEl.classList.add("hidden");
        }
      }, 600);
    });

    DOM.scrapeKeyword?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); handleScrapeSearch(); }
    });
    DOM.scrapeLocation?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); handleScrapeSearch(); }
    });
    DOM.scrapeSearchBtn?.addEventListener("click", handleScrapeSearch);

    // Show/hide Siemens-specific state+city filters when portal changes
    function syncPortalFilters() {
      const portal     = DOM.scrapePortal?.value || "sap";
      const isSiemens  = portal === "siemens";
      const isSapBasf  = portal === "sap" || portal === "basf";
      const stateRow   = document.getElementById("filter-state");
      const cityRow    = document.getElementById("filter-city");
      const locRow     = document.getElementById("filter-location");
      if (stateRow) stateRow.style.display = isSiemens ? "" : "none";
      if (cityRow)  cityRow.style.display  = isSiemens ? "" : "none";
      if (locRow)   locRow.style.display   = isSiemens ? "none" : "";
      // Toggle text input vs dropdown for SAP/BASF
      const locInput  = document.getElementById("scrape-location");
      const locDdWrap = document.getElementById("scrape-location-dropdown-wrap");
      if (locInput)  locInput.style.display  = isSapBasf ? "none" : "";
      if (locDdWrap) locDdWrap.style.display = isSapBasf ? "" : "none";
      if (isSapBasf) buildLocationDropdown(portal);
    }
    DOM.scrapePortal?.addEventListener("change", () => { syncPortalFilters(); updateSearchBtnState(); renderScrapeResults(); });
    syncPortalFilters(); // run once on load

    document.getElementById("scrape-location-dropdown")?.addEventListener("change", () => { updateSearchBtnState(); renderScrapeResults(); });
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
      const app = { id, company: appData.company || "", role: appData.role || "", link: appData.link || "", location: appData.location || "", reqId: appData.reqId || "", postingDate: "", stage: appData.stage || "Wishlist", deadline: "", contactType: "", contactName: "", notes: appData.notes || "", interviews: [], communications: [], createdAt: new Date().toISOString() };
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

  // Factory reset — wipe all tracker data
  window.factoryResetTracker = async function () {
    if (!confirm("⚠ Factory Reset: This will permanently delete ALL tracker applications. Continue?")) return;
    state.applications = [];
    safeStorageRemove(STORAGE_KEY);
    safeStorageRemove(GOAL_KEY);
    if (useFirebase && currentUserId && window.FirebaseAPI?.db?.clearAllApplications) {
      try { await FirebaseAPI.db.clearAllApplications(currentUserId); } catch (e) { console.warn("Firebase clear failed:", e.message); }
    }
    state.currentWeeklyGoal = 10;
    renderUI();
    showToast("Factory reset complete — all tracker data cleared");
  };

  // Auto-init when DOM ready
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
