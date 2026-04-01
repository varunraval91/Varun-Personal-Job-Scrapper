/**
 * Skill Data Bank — Frontend module (v4.0)
 * Tabs: Skills | Projects | Work | Certifications | Research | Education | Add Skill | Test Match | Stats
 * Edit pattern: inline expand-row
 */
(function () {
  "use strict";

  let allSkills   = [];
  let allProjects = [];
  let allWork     = [];
  let allCerts    = [];
  let allResearch = [];  // papers + activities combined
  let allEdu      = [];
  let categories  = [];
  let initialized = { skills: false, projects: false, work: false, certs: false, research: false, education: false };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function truncate(s, n) { s = s || ""; return s.length > n ? s.slice(0, n) + "…" : s; }

  // ── Category palette ──────────────────────────────────────────
  const CAT = {
    SAP_Technical:       { color: "#0070f3", label: "SAP Technical",         icon: "🔷" },
    Engineering_Dev:     { color: "#7928ca", label: "Engineering & Dev",     icon: "💻" },
    Data_Analytics:      { color: "#00b894", label: "Data & Analytics",      icon: "📊" },
    Design_UX:           { color: "#f5a623", label: "Design & UX",           icon: "🎨" },
    Creative_Media:      { color: "#e84393", label: "Creative & Media",      icon: "🎬" },
    Tools_Platforms:     { color: "#718096", label: "Tools & Platforms",     icon: "🛠️" },
    Domain_Professional: { color: "#38a169", label: "Domain & Professional", icon: "🧠" }
  };
  function catColor(c) { return (CAT[c] || { color: "#a0aec0" }).color; }
  function catLabel(c) { return (CAT[c] || { label: (c || "").replace(/_/g," ") }).label; }
  function catIcon(c)  { return (CAT[c] || { icon: "" }).icon; }

  // ── Tab switching ─────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll(".sb-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".sb-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".sb-panel").forEach(p => p.style.display = "none");
        tab.classList.add("active");
        const key   = tab.dataset.sbTab;
        const panel = $("sb-panel-" + key);
        if (panel) panel.style.display = "";
        if (key === "stats")     { if (!initialized.stats)     loadStats();        }
        if (key === "skills")    { if (!initialized.skills)    loadSkillBank();     else renderSkillsTable();    }
        if (key === "projects")  { if (!initialized.projects)  loadProjects();      else renderProjectsTable();  }
        if (key === "work")      { if (!initialized.work)      loadWork();          else renderWorkTable();      }
        if (key === "certs")     { if (!initialized.certs)     loadCerts();         else renderCertsTable();     }
        if (key === "research")  { if (!initialized.research)  loadResearch();      else renderResearchTable();  }
        if (key === "education") { if (!initialized.education) loadEducation();     else renderEduTable();       }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SKILLS
  // ═══════════════════════════════════════════════════════════════

  async function loadSkillBank() {
    try {
      const res  = await fetch("/skill-bank");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      allSkills   = data.skill_chunks || data.user_skills || [];
      allProjects = data.user_projects || data.projects || [];
      allWork     = data.user_work_experience || data.work_experience || [];
      allCerts    = data.certifications || [];
      allResearch = [...(data.research_papers || []).map(r => ({...r, _kind: "paper"})),
                    ...(data.research_activities || []).map(r => ({...r, _kind: "activity"}))];
      allEdu      = data.education || [];
      categories  = [...new Set(allSkills.map(s => s.category))].sort();

      // Header stats
      $("sb-total-count").textContent      = allSkills.length   + " skills";
      $("sb-proj-count").textContent       = allProjects.length + " projects";
      $("sb-work-count").textContent       = allWork.length     + " work";
      $("sb-certs-count").textContent      = allCerts.length    + " certs";
      $("sb-categories-count").textContent = categories.length  + " categories";
      $("sb-vector-status").textContent    = "Vector: " + (data.vectorReady ? "Active" : "Offline");

      // Tab count badges
      const ts = $("sb-tab-count-skills");   if (ts) ts.textContent = allSkills.length;
      const tp = $("sb-tab-count-projects"); if (tp) tp.textContent = allProjects.length;
      const tw = $("sb-tab-count-work");     if (tw) tw.textContent = allWork.length;
      const tc = $("sb-tab-count-certs");    if (tc) tc.textContent = allCerts.length;
      const tr = $("sb-tab-count-research"); if (tr) tr.textContent = allResearch.length;
      const te = $("sb-tab-count-edu");      if (te) te.textContent = allEdu.length;

      // Category filter
      const cf = $("sb-category-filter");
      cf.innerHTML = '<option value="">All Categories</option>';
      categories.forEach(c => {
        const o = document.createElement("option");
        o.value = c; o.textContent = c.replace(/_/g," ");
        cf.appendChild(o);
      });

      renderSkillsTable();
      renderProjectsTable();
      renderWorkTable();
      renderCertsTable();
      renderResearchTable();
      renderEduTable();
      initialized.skills    = true;
      initialized.projects  = true;
      initialized.work      = true;
      initialized.certs     = true;
      initialized.research  = true;
      initialized.education = true;
    } catch (err) {
      console.error("Failed to load skill bank:", err);
    }
  }

  function renderSkillsTable() {
    const q    = ($("sb-search")?.value || "").toLowerCase();
    const cat  = $("sb-category-filter")?.value || "";
    const lvl  = $("sb-level-filter")?.value || "";

    const filtered = allSkills.filter(s => {
      const name = (s.skill_name || s.skill || "").toLowerCase();
      const desc = (s.description || s.evidence || "").toLowerCase();
      if (cat && s.category !== cat) return false;
      if (lvl && s.level !== lvl) return false;
      if (q && !name.includes(q) && !desc.includes(q) && !s.category.toLowerCase().includes(q) && !(s.tools||[]).some(t=>t.toLowerCase().includes(q))) return false;
      return true;
    });

    const id = s => s.skill_id || s.id;

    $("sb-table-body").innerHTML = filtered.map(s => {
      const tags = (s.tools||[]).map(t=>`<span class="sb-tool-tag">${esc(t)}</span>`).join(" ");
      return `<tr id="sr-${esc(id(s))}">
        <td><code>${esc(id(s))}</code></td>
        <td><strong>${esc(s.skill_name||s.skill)}</strong></td>
        <td><span class="sb-cat-badge" style="color:${catColor(s.category)};background:${catColor(s.category)}1e;border-color:${catColor(s.category)}4d">${catIcon(s.category)} ${esc(catLabel(s.category))}</span></td>
        <td><span class="sb-level sb-level-${(s.level||"").toLowerCase().replace(/[^a-z]/g,"")}">${esc(s.level)}</span></td>
        <td class="sb-tools-cell">${tags||'<span class="sb-no-tools">—</span>'}</td>
        <td class="sb-evidence">${esc(truncate(s.description||s.evidence,120))}</td>
        <td><button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editSkill('${esc(id(s))}')">Edit</button></td>
      </tr>`;
    }).join("");
  }

  // ── Inline edit row for skills ─────────────────────────────────
  function editSkill(sid) {
    const existing = document.getElementById("sb-edit-row-" + sid);
    if (existing) { existing.remove(); return; }   // toggle off
    const skill = allSkills.find(s => (s.skill_id||s.id) === sid);
    if (!skill) return;

    const row = document.getElementById("sr-" + sid);
    if (!row) return;

    const name = skill.skill_name || skill.skill || "";
    const desc = skill.description || skill.evidence || "";

    const editRow = document.createElement("tr");
    editRow.id = "sb-edit-row-" + sid;
    editRow.className = "sb-edit-row";
    editRow.innerHTML = `
      <td colspan="7">
        <div class="sb-edit-form">
          <div class="sb-edit-grid">
            <div class="sb-edit-field">
              <label>Level</label>
              <select class="sb-select sb-edit-level" id="sbe-level-${esc(sid)}">
                ${["Beginner","Beginner-Intermediate","Intermediate","Intermediate-Advanced","Advanced"].map(l=>`<option ${l===skill.level?"selected":""}>${l}</option>`).join("")}
              </select>
            </div>
            <div class="sb-edit-field">
              <label>Category</label>
              <select class="sb-select sb-edit-cat" id="sbe-cat-${esc(sid)}">
                ${Object.entries(CAT).map(([k,v])=>`<option value="${k}" ${k===skill.category?"selected":""}>${v.icon} ${v.label}</option>`).join("")}
              </select>
            </div>
            <div class="sb-edit-field sb-edit-field-wide">
              <label>Description / Evidence</label>
              <textarea class="sb-textarea" id="sbe-desc-${esc(sid)}" rows="3">${esc(desc)}</textarea>
            </div>
          </div>
          <div class="sb-edit-actions">
            <button class="sb-btn sb-btn-primary sb-btn-sm" onclick="window.SkillBank.saveSkill('${esc(sid)}')">Save</button>
            <button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editSkill('${esc(sid)}')">Cancel</button>
          </div>
          <div id="sbe-status-${esc(sid)}" class="sb-status"></div>
        </div>
      </td>`;
    row.after(editRow);
  }

  async function saveSkill(sid) {
    const level    = document.getElementById("sbe-level-" + sid)?.value;
    const category = document.getElementById("sbe-cat-"   + sid)?.value;
    const desc     = document.getElementById("sbe-desc-"  + sid)?.value;
    const statusEl = document.getElementById("sbe-status-" + sid);

    statusEl.textContent = "Saving…"; statusEl.className = "sb-status";
    try {
      const res  = await fetch("/skill-bank/update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sid, level, category, evidence: desc, description: desc })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      statusEl.textContent = data.vectorRebuilt ? "Saved — search index updated" : "Saved!";
      statusEl.className = "sb-status sb-status-ok";
      setTimeout(() => { document.getElementById("sb-edit-row-" + sid)?.remove(); loadSkillBank(); }, 800);
    } catch (err) {
      statusEl.textContent = "Error: " + err.message; statusEl.className = "sb-status sb-status-err";
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════════════════════════

  async function loadProjects() {
    if (!allProjects.length) await loadSkillBank();
    renderProjectsTable();
  }

  function renderProjectsTable() {
    const q   = ($("sb-proj-search")?.value || "").toLowerCase();
    const cat = $("sb-proj-cat-filter")?.value || "";

    const filtered = allProjects.filter(p => {
      const name = (p.project_name || p.name || "").toLowerCase();
      const desc = (p.description || "").toLowerCase();
      const tech = (p.tech || "").toLowerCase();
      const sc   = (p.sub_category || "").toLowerCase();
      if (cat && sc !== cat.toLowerCase()) return false;
      if (q && !name.includes(q) && !desc.includes(q) && !tech.includes(q)) return false;
      return true;
    });

    const pid = p => p.project_id || p.id;

    $("sb-proj-table-body").innerHTML = filtered.map(p => `
      <tr id="pr-${esc(pid(p))}">
        <td><code>${esc(pid(p))}</code></td>
        <td><strong>${esc(p.project_name||p.name)}</strong>${p.impact?`<div class="sb-impact-tag">${esc(truncate(p.impact,60))}</div>`:""}</td>
        <td class="sb-tech-cell">${esc(p.tech||"")}</td>
        <td class="sb-date-cell">${esc(p.date||"")}</td>
        <td class="sb-evidence">${esc(truncate(p.description,120))}</td>
        <td><button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editProject('${esc(pid(p))}')">Edit</button></td>
      </tr>`).join("");
  }

  function editProject(pid) {
    const existing = document.getElementById("sb-edit-row-p-" + pid);
    if (existing) { existing.remove(); return; }
    const proj = allProjects.find(p => (p.project_id||p.id) === pid);
    if (!proj) return;
    const row = document.getElementById("pr-" + pid);
    if (!row) return;

    const editRow = document.createElement("tr");
    editRow.id = "sb-edit-row-p-" + pid;
    editRow.className = "sb-edit-row";
    editRow.innerHTML = `
      <td colspan="6">
        <div class="sb-edit-form">
          <div class="sb-edit-grid">
            <div class="sb-edit-field">
              <label>Project Name</label>
              <input class="sb-input" id="pbe-name-${esc(pid)}" value="${esc(proj.project_name||proj.name||"")}" />
            </div>
            <div class="sb-edit-field">
              <label>Tech / Tools</label>
              <input class="sb-input" id="pbe-tech-${esc(pid)}" value="${esc(proj.tech||"")}" />
            </div>
            <div class="sb-edit-field">
              <label>Date</label>
              <input class="sb-input" id="pbe-date-${esc(pid)}" value="${esc(proj.date||"")}" />
            </div>
            <div class="sb-edit-field">
              <label>Impact / Outcome</label>
              <input class="sb-input" id="pbe-impact-${esc(pid)}" value="${esc(proj.impact||proj.quantified_impact||"")}" />
            </div>
            <div class="sb-edit-field sb-edit-field-wide">
              <label>Description</label>
              <textarea class="sb-textarea" id="pbe-desc-${esc(pid)}" rows="4">${esc(proj.description||"")}</textarea>
            </div>
          </div>
          <div class="sb-edit-actions">
            <button class="sb-btn sb-btn-primary sb-btn-sm" onclick="window.SkillBank.saveProject('${esc(pid)}')">Save</button>
            <button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editProject('${esc(pid)}')">Cancel</button>
          </div>
          <div id="pbe-status-${esc(pid)}" class="sb-status"></div>
        </div>
      </td>`;
    row.after(editRow);
  }

  async function saveProject(pid) {
    const statusEl = document.getElementById("pbe-status-" + pid);
    statusEl.textContent = "Saving…"; statusEl.className = "sb-status";
    try {
      const res = await fetch("/skill-bank/update-project", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id:   pid,
          project_name: document.getElementById("pbe-name-"  + pid)?.value,
          tech:         document.getElementById("pbe-tech-"  + pid)?.value,
          date:         document.getElementById("pbe-date-"  + pid)?.value,
          impact:       document.getElementById("pbe-impact-"+ pid)?.value,
          description:  document.getElementById("pbe-desc-"  + pid)?.value
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      statusEl.textContent = data.vectorRebuilt ? "Saved — search index updated" : "Saved!";
      statusEl.className = "sb-status sb-status-ok";
      setTimeout(async () => {
        document.getElementById("sb-edit-row-p-" + pid)?.remove();
        initialized.projects = false;
        await loadProjects();
      }, 800);
    } catch (err) {
      statusEl.textContent = "Error: " + err.message; statusEl.className = "sb-status sb-status-err";
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WORK EXPERIENCE
  // ═══════════════════════════════════════════════════════════════

  async function loadWork() {
    if (!allWork.length) await loadSkillBank();
    renderWorkTable();
  }

  function renderWorkTable() {
    const q = ($("sb-work-search")?.value || "").toLowerCase();

    const filtered = allWork.filter(w => {
      const title   = (w.job_title||w.title||"").toLowerCase();
      const company = (w.company||"").toLowerCase();
      if (q && !title.includes(q) && !company.includes(q)) return false;
      return true;
    });

    const wid = w => w.work_id || w.id;

    $("sb-work-table-body").innerHTML = filtered.map(w => {
      const skills  = (w.skills_used||[]).slice(0,4).map(s=>`<span class="sb-tool-tag">${esc(s)}</span>`).join(" ");
      const extra   = (w.skills_used||[]).length > 4 ? `<span class="sb-no-tools">+${(w.skills_used||[]).length-4} more</span>` : "";
      const bullets = (w.responsibilities||w.bullets||[]);
      const resp    = bullets.slice(0,2).map(b=>`<div class="sb-bullet-preview">• ${esc(truncate(b,80))}</div>`).join("");
      const moreB   = bullets.length > 2 ? `<div class="sb-no-tools">+${bullets.length-2} more</div>` : "";
      return `
        <tr id="wr-${esc(wid(w))}">
          <td><code>${esc(wid(w))}</code></td>
          <td><strong>${esc(w.job_title||w.title)}</strong></td>
          <td>${esc(w.company)}</td>
          <td class="sb-date-cell">${esc(w.period||"")}</td>
          <td class="sb-tools-cell">${skills}${extra}</td>
          <td class="sb-evidence">${resp}${moreB}</td>
          <td><button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editWork('${esc(wid(w))}')">Edit</button></td>
        </tr>`;
    }).join("");
  }

  function editWork(wid) {
    const existing = document.getElementById("sb-edit-row-w-" + wid);
    if (existing) { existing.remove(); return; }
    const entry = allWork.find(w => (w.work_id||w.id) === wid);
    if (!entry) return;
    const row = document.getElementById("wr-" + wid);
    if (!row) return;

    const bullets = (entry.responsibilities||entry.bullets||[]).join("\n");
    const skills  = (entry.skills_used||[]).join(", ");

    const editRow = document.createElement("tr");
    editRow.id = "sb-edit-row-w-" + wid;
    editRow.className = "sb-edit-row";
    editRow.innerHTML = `
      <td colspan="7">
        <div class="sb-edit-form">
          <div class="sb-edit-grid">
            <div class="sb-edit-field">
              <label>Job Title</label>
              <input class="sb-input" id="wbe-title-${esc(wid)}"   value="${esc(entry.job_title||entry.title||"")}" />
            </div>
            <div class="sb-edit-field">
              <label>Company</label>
              <input class="sb-input" id="wbe-company-${esc(wid)}" value="${esc(entry.company||"")}" />
            </div>
            <div class="sb-edit-field">
              <label>Period</label>
              <input class="sb-input" id="wbe-period-${esc(wid)}"  value="${esc(entry.period||"")}" />
            </div>
            <div class="sb-edit-field">
              <label>Location</label>
              <input class="sb-input" id="wbe-loc-${esc(wid)}"     value="${esc(entry.location||"")}" />
            </div>
            <div class="sb-edit-field">
              <label>Skills Used <span class="sb-hint">(comma-separated)</span></label>
              <input class="sb-input" id="wbe-skills-${esc(wid)}"  value="${esc(skills)}" />
            </div>
            <div class="sb-edit-field sb-edit-field-wide">
              <label>Responsibilities <span class="sb-hint">(one per line)</span></label>
              <textarea class="sb-textarea" id="wbe-resp-${esc(wid)}" rows="5">${esc(bullets)}</textarea>
            </div>
          </div>
          <div class="sb-edit-actions">
            <button class="sb-btn sb-btn-primary sb-btn-sm" onclick="window.SkillBank.saveWork('${esc(wid)}')">Save</button>
            <button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editWork('${esc(wid)}')">Cancel</button>
          </div>
          <div id="wbe-status-${esc(wid)}" class="sb-status"></div>
        </div>
      </td>`;
    row.after(editRow);
  }

  async function saveWork(wid) {
    const statusEl = document.getElementById("wbe-status-" + wid);
    statusEl.textContent = "Saving…"; statusEl.className = "sb-status";
    try {
      const res = await fetch("/skill-bank/update-work", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          work_id:          wid,
          job_title:        document.getElementById("wbe-title-"  + wid)?.value,
          company:          document.getElementById("wbe-company-"+ wid)?.value,
          period:           document.getElementById("wbe-period-" + wid)?.value,
          location:         document.getElementById("wbe-loc-"    + wid)?.value,
          skills_used:      document.getElementById("wbe-skills-" + wid)?.value,
          responsibilities: document.getElementById("wbe-resp-"   + wid)?.value
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      statusEl.textContent = data.vectorRebuilt ? "Saved — search index updated" : "Saved!";
      statusEl.className = "sb-status sb-status-ok";
      setTimeout(async () => {
        document.getElementById("sb-edit-row-w-" + wid)?.remove();
        initialized.work = false;
        await loadWork();
      }, 800);
    } catch (err) {
      statusEl.textContent = "Error: " + err.message; statusEl.className = "sb-status sb-status-err";
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CERTIFICATIONS
  // ═══════════════════════════════════════════════════════════════

  async function loadCerts() {
    if (!allCerts.length) await loadSkillBank();
    renderCertsTable();
  }

  function renderCertsTable() {
    const q = ($("sb-certs-search")?.value || "").toLowerCase();
    const filtered = allCerts.filter(c => {
      const t = (c.title || "").toLowerCase();
      const p = (c.provider || "").toLowerCase();
      return !q || t.includes(q) || p.includes(q);
    });
    const cid = c => c.cert_id || c.id;
    $("sb-certs-table-body").innerHTML = filtered.map(c => `
      <tr id="cr-${esc(cid(c))}">
        <td><code>${esc(cid(c))}</code></td>
        <td><strong>${esc(c.title)}</strong></td>
        <td>${esc(c.provider)}</td>
        <td class="sb-date-cell">${esc(c.date||"")}</td>
        <td class="sb-date-cell">${esc(c.duration||"")}</td>
        <td><button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editCert('${esc(cid(c))}')">Edit</button></td>
      </tr>`).join("");
  }

  function editCert(cid) {
    const ex = document.getElementById("sb-edit-row-c-" + cid);
    if (ex) { ex.remove(); return; }
    const cert = allCerts.find(c => (c.cert_id||c.id) === cid);
    if (!cert) return;
    const row = document.getElementById("cr-" + cid);
    if (!row) return;
    const er = document.createElement("tr");
    er.id = "sb-edit-row-c-" + cid; er.className = "sb-edit-row";
    er.innerHTML = `<td colspan="6"><div class="sb-edit-form">
      <div class="sb-edit-grid">
        <div class="sb-edit-field"><label>Title</label><input class="sb-input" id="cbe-title-${esc(cid)}" value="${esc(cert.title||"")}"/></div>
        <div class="sb-edit-field"><label>Provider</label><input class="sb-input" id="cbe-prov-${esc(cid)}" value="${esc(cert.provider||"")}"/></div>
        <div class="sb-edit-field"><label>Date</label><input class="sb-input" id="cbe-date-${esc(cid)}" value="${esc(cert.date||"")}"/></div>
        <div class="sb-edit-field"><label>Duration</label><input class="sb-input" id="cbe-dur-${esc(cid)}" value="${esc(cert.duration||"")}"/></div>
      </div>
      <div class="sb-edit-actions">
        <button class="sb-btn sb-btn-primary sb-btn-sm" onclick="window.SkillBank.saveCert('${esc(cid)}')">Save</button>
        <button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editCert('${esc(cid)}')">Cancel</button>
      </div>
      <div id="cbe-status-${esc(cid)}" class="sb-status"></div>
    </div></td>`;
    row.after(er);
  }

  async function saveCert(cid) {
    const st = document.getElementById("cbe-status-" + cid);
    st.textContent = "Saving…"; st.className = "sb-status";
    try {
      const res = await fetch("/skill-bank/update-cert", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cert_id: cid,
          title:    document.getElementById("cbe-title-"+ cid)?.value,
          provider: document.getElementById("cbe-prov-" + cid)?.value,
          date:     document.getElementById("cbe-date-" + cid)?.value,
          duration: document.getElementById("cbe-dur-"  + cid)?.value })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      st.textContent = "Saved!"; st.className = "sb-status sb-status-ok";
      setTimeout(async () => { document.getElementById("sb-edit-row-c-"+cid)?.remove(); initialized.certs=false; await loadCerts(); }, 700);
    } catch (err) { st.textContent = "Error: "+err.message; st.className = "sb-status sb-status-err"; }
  }

  // ═══════════════════════════════════════════════════════════════
  // RESEARCH
  // ═══════════════════════════════════════════════════════════════

  async function loadResearch() {
    if (!allResearch.length) await loadSkillBank();
    renderResearchTable();
  }

  function renderResearchTable() {
    $("sb-research-table-body").innerHTML = allResearch.map(r => `
      <tr id="rr-${esc(r.id)}">
        <td><code>${esc(r.id)}</code></td>
        <td><span class="sb-cat-badge" style="color:#7928ca;background:#7928ca1e;border-color:#7928ca4d">${r._kind === "paper" ? "📄 Paper" : "🔬 Activity"}</span></td>
        <td><strong>${esc(r.title)}</strong></td>
        <td class="sb-evidence">${esc(r.institution||r.context||"")}</td>
        <td class="sb-date-cell">${esc(r.date||r.period||"")}</td>
        <td class="sb-evidence">${esc(truncate(r.description,100))}</td>
        <td><button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editResearch('${esc(r.id)}')">Edit</button></td>
      </tr>`).join("");
  }

  function editResearch(rid) {
    const ex = document.getElementById("sb-edit-row-r-" + rid);
    if (ex) { ex.remove(); return; }
    const r = allResearch.find(x => x.id === rid);
    if (!r) return;
    const row = document.getElementById("rr-" + rid);
    if (!row) return;
    const er = document.createElement("tr");
    er.id = "sb-edit-row-r-" + rid; er.className = "sb-edit-row";
    const isActivity = r._kind === "activity";
    er.innerHTML = `<td colspan="7"><div class="sb-edit-form">
      <div class="sb-edit-grid">
        <div class="sb-edit-field sb-edit-field-wide"><label>Title</label><input class="sb-input" id="rbe-title-${esc(rid)}" value="${esc(r.title||"")}"/></div>
        <div class="sb-edit-field"><label>${isActivity ? "Context" : "Institution"}</label><input class="sb-input" id="rbe-inst-${esc(rid)}" value="${esc(r.institution||r.context||"")}"/></div>
        <div class="sb-edit-field"><label>${isActivity ? "Period" : "Date"}</label><input class="sb-input" id="rbe-date-${esc(rid)}" value="${esc(r.date||r.period||"")}"/></div>
        ${!isActivity ? `<div class="sb-edit-field"><label>References</label><input class="sb-input" id="rbe-ref-${esc(rid)}" value="${esc(r.references||"")}"/></div>` : ""}
        ${!isActivity ? `<div class="sb-edit-field"><label>Key Finding</label><input class="sb-input" id="rbe-finding-${esc(rid)}" value="${esc(r.key_finding||"")}"/></div>` : ""}
        <div class="sb-edit-field sb-edit-field-wide"><label>Description</label><textarea class="sb-textarea" id="rbe-desc-${esc(rid)}" rows="3">${esc(r.description||"")}</textarea></div>
      </div>
      <div class="sb-edit-actions">
        <button class="sb-btn sb-btn-primary sb-btn-sm" onclick="window.SkillBank.saveResearch('${esc(rid)}')">Save</button>
        <button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editResearch('${esc(rid)}')">Cancel</button>
      </div>
      <div id="rbe-status-${esc(rid)}" class="sb-status"></div>
    </div></td>`;
    row.after(er);
  }

  async function saveResearch(rid) {
    const r = allResearch.find(x => x.id === rid);
    const st = document.getElementById("rbe-status-" + rid);
    st.textContent = "Saving…"; st.className = "sb-status";
    try {
      const body = { id: rid,
        title:       document.getElementById("rbe-title-"  + rid)?.value,
        description: document.getElementById("rbe-desc-"   + rid)?.value,
        date:        document.getElementById("rbe-date-"   + rid)?.value,
        period:      document.getElementById("rbe-date-"   + rid)?.value };
      const instEl = document.getElementById("rbe-inst-" + rid);
      if (r?._kind === "activity") body.context     = instEl?.value;
      else                         body.institution = instEl?.value;
      const refEl     = document.getElementById("rbe-ref-"    + rid);
      const findingEl = document.getElementById("rbe-finding-"+ rid);
      if (refEl)     body.references  = refEl.value;
      if (findingEl) body.key_finding = findingEl.value;
      const res = await fetch("/skill-bank/update-research", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      st.textContent = "Saved!"; st.className = "sb-status sb-status-ok";
      setTimeout(async () => { document.getElementById("sb-edit-row-r-"+rid)?.remove(); initialized.research=false; await loadResearch(); }, 700);
    } catch (err) { st.textContent = "Error: "+err.message; st.className = "sb-status sb-status-err"; }
  }

  // ═══════════════════════════════════════════════════════════════
  // EDUCATION
  // ═══════════════════════════════════════════════════════════════

  async function loadEducation() {
    if (!allEdu.length) await loadSkillBank();
    renderEduTable();
  }

  function renderEduTable() {
    const tbody = $("sb-edu-table-body");
    if (!tbody) return;
    tbody.innerHTML = allEdu.map((e, i) => {
      const key = esc(e.degree + "__" + i);
      const mods = (e.key_modules || []).map(m => `<span class="sb-tool-tag">${esc(m)}</span>`).join(" ");
      return `<tr id="edu-${key}">
        <td><strong>${esc(e.degree)}</strong></td>
        <td>${esc(e.institution)}</td>
        <td class="sb-date-cell">${esc(e.period||"")}</td>
        <td class="sb-date-cell">${esc(e.status||e.relevance||"")}</td>
        <td class="sb-tools-cell">${mods||"—"}</td>
        <td><button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editEdu(${i})">Edit</button></td>
      </tr>`;
    }).join("");
  }

  function editEdu(idx) {
    const ex = document.getElementById("sb-edit-row-edu-" + idx);
    if (ex) { ex.remove(); return; }
    const e = allEdu[idx];
    if (!e) return;
    const key = esc(e.degree + "__" + idx);
    const row = document.getElementById("edu-" + key);
    if (!row) return;
    const er = document.createElement("tr");
    er.id = "sb-edit-row-edu-" + idx; er.className = "sb-edit-row";
    er.innerHTML = `<td colspan="6"><div class="sb-edit-form">
      <div class="sb-edit-grid">
        <div class="sb-edit-field"><label>Period</label><input class="sb-input" id="ebe-period-${idx}" value="${esc(e.period||"")}"/></div>
        <div class="sb-edit-field"><label>Status / Relevance</label><input class="sb-input" id="ebe-status-${idx}" value="${esc(e.status||e.relevance||"")}"/></div>
        <div class="sb-edit-field sb-edit-field-wide"><label>Key Modules <span class="sb-hint">(one per line)</span></label>
          <textarea class="sb-textarea" id="ebe-mods-${idx}" rows="4">${esc((e.key_modules||[]).join("\n"))}</textarea></div>
      </div>
      <div class="sb-edit-actions">
        <button class="sb-btn sb-btn-primary sb-btn-sm" onclick="window.SkillBank.saveEdu(${idx})">Save</button>
        <button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editEdu(${idx})">Cancel</button>
      </div>
      <div id="ebe-status-el-${idx}" class="sb-status"></div>
    </div></td>`;
    row.after(er);
  }

  async function saveEdu(idx) {
    const e = allEdu[idx];
    const st = document.getElementById("ebe-status-el-" + idx);
    st.textContent = "Saving…"; st.className = "sb-status";
    try {
      const res = await fetch("/skill-bank/update-education", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ degree: e.degree, institution: e.institution,
          period:      document.getElementById("ebe-period-" + idx)?.value,
          status:      document.getElementById("ebe-status-" + idx)?.value,
          key_modules: document.getElementById("ebe-mods-"   + idx)?.value })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      st.textContent = "Saved!"; st.className = "sb-status sb-status-ok";
      setTimeout(async () => { document.getElementById("sb-edit-row-edu-"+idx)?.remove(); initialized.education=false; await loadEducation(); }, 700);
    } catch (err) { st.textContent = "Error: "+err.message; st.className = "sb-status sb-status-err"; }
  }

  // ── Add skill ─────────────────────────────────────────────────
  function setAddCategoryOptions() {
    const el = $("sb-add-category");
    if (!el) return;
    el.innerHTML = `<option value="">— Select category —</option>` +
      Object.entries(CAT).map(([k,v])=>`<option value="${k}">${v.icon} ${v.label}</option>`).join("");
  }

  async function handleAddSkill(e) {
    e.preventDefault();
    const status = $("sb-add-status");
    status.textContent = "Adding…"; status.className = "sb-status";
    try {
      const res = await fetch("/skill-bank/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: $("sb-add-category").value,
          skill:    $("sb-add-skill").value,
          level:    $("sb-add-level").value,
          evidence: $("sb-add-evidence").value
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const id   = data.chunk.skill_id || data.chunk.id;
      const name = data.chunk.skill_name || data.chunk.skill;
      status.textContent = `Added: ${id} — ${name}`;
      status.className = "sb-status sb-status-ok";
      $("sb-add-form").reset();
      initialized.skills = false;
      await loadSkillBank();
    } catch (err) {
      status.textContent = "Error: " + err.message;
      status.className = "sb-status sb-status-err";
    }
  }

  // ── Test match ────────────────────────────────────────────────
  async function handleMatch() {
    const jobText = $("sb-match-input")?.value;
    if (!jobText) return;
    const results = $("sb-match-results");
    results.innerHTML = '<div class="sb-loading">Searching…</div>';
    try {
      const res  = await fetch("/skill-bank/query", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobText, topN: 12 })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      let html = `<div class="sb-match-header">${data.skills.length} matching skills | ${data.projects.length} projects | ${data.work.length} work experiences</div>`;
      html += '<div class="sb-match-list">';
      data.skills.forEach((s, i) => {
        const pct = Math.max(0, (1 - s.distance) * 100).toFixed(1);
        html += `<div class="sb-match-item">
          <div class="sb-match-rank">#${i + 1}</div>
          <div class="sb-match-info">
            <div class="sb-match-skill">[${esc(s.id)}] ${esc(s.metadata.skill_name)}</div>
            <div class="sb-match-meta">${esc(s.metadata.category)} | ${esc(s.metadata.level)}</div>
            <div class="sb-match-evidence">${esc(truncate(s.document, 200))}</div>
          </div>
          <div class="sb-match-score">${pct}%</div>
        </div>`;
      });
      html += "</div>";

      if (data.projects.length > 0) {
        html += '<div class="sb-match-section-title">Linked Projects (via junction tables)</div>';
        data.projects.forEach(p => {
          html += `<div class="sb-match-item"><div class="sb-match-info"><strong>${esc(p.metadata.name)}</strong> — <span class="sb-match-meta">${esc(p.metadata.tech)}</span></div></div>`;
        });
      }
      if (data.work.length > 0) {
        html += '<div class="sb-match-section-title">Linked Work Experience (via junction tables)</div>';
        data.work.forEach(w => {
          html += `<div class="sb-match-item"><div class="sb-match-info"><strong>${esc(w.metadata.title)}</strong> at ${esc(w.metadata.company)} <span class="sb-match-meta">${esc(w.metadata.period||"")}</span></div></div>`;
        });
      }
      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = `<div class="sb-error">Error: ${esc(err.message)}</div>`;
    }
  }

  async function handleGenerate() {
    const jobText = $("sb-match-input")?.value;
    if (!jobText) { alert("Paste a job description first"); return; }
    const results = $("sb-match-results");
    results.innerHTML = '<div class="sb-loading">Generating cover letter via RAG pipeline…</div>';
    try {
      const res  = await fetch("/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jobText, documentType: "cl", humanizeText: true })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      let html = '<div class="sb-match-header">Generated Cover Letter</div>';
      if (data.decisions?.chunksUsed?.length) {
        const names = data.decisions.chunksUsed.map(c => c.skill_name||c.skill).join(", ");
        html += `<div class="sb-match-meta">Skills used: ${esc(names)}</div>`;
      }
      if (data.humanized) html += '<div class="sb-match-meta" style="color:var(--c-offer,green)">Humanizer applied</div>';
      html += `<div class="sb-generated-text">${esc(data.content).replace(/\n/g,"<br>")}</div>`;
      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = `<div class="sb-error">Error: ${esc(err.message)}</div>`;
    }
  }

  // ── Stats ─────────────────────────────────────────────────────
  async function loadStats() {
    try {
      const res  = await fetch("/skill-bank/stats");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const container = $("sb-stats-content");
      let html = `
        <div class="sb-stat-card"><div class="sb-stat-num">${data.total_skills}</div><div class="sb-stat-label">Total Skills</div></div>
        <div class="sb-stat-card"><div class="sb-stat-num">${Object.keys(data.skill_categories).length}</div><div class="sb-stat-label">Categories</div></div>
        <div class="sb-stat-card"><div class="sb-stat-num">${data.total_projects}</div><div class="sb-stat-label">Projects</div></div>
        <div class="sb-stat-card"><div class="sb-stat-num">${data.total_applications}</div><div class="sb-stat-label">Applications</div></div>
        <div class="sb-stat-wide"><h3>Skills by Category</h3><div class="sb-cat-bars">`;
      const maxC = Math.max(...Object.values(data.skill_categories));
      Object.entries(data.skill_categories).sort((a,b)=>b[1]-a[1]).forEach(([cat,cnt]) => {
        const pct = (cnt/maxC*100).toFixed(0);
        html += `<div class="sb-cat-bar-row">
          <span class="sb-cat-bar-label">${esc(catLabel(cat))}</span>
          <div class="sb-cat-bar-track"><div class="sb-cat-bar-fill" style="width:${pct}%;background:${catColor(cat)}"></div></div>
          <span class="sb-cat-bar-count">${cnt}</span></div>`;
      });
      html += '</div></div>';
      if (data.most_used_skills?.length) {
        html += '<div class="sb-stat-wide"><h3>Most Used Skills</h3>';
        data.most_used_skills.forEach(s => {
          html += `<div class="sb-most-used">[${esc(s.id)}] ${esc(s.skill)} — used in ${s.used_in} application(s)</div>`;
        });
        html += '</div>';
      }
      container.innerHTML = html;
    } catch (err) {
      $("sb-stats-content").innerHTML = `<div class="sb-error">Error: ${esc(err.message)}</div>`;
    }
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    initTabs();
    setAddCategoryOptions();

    $("sb-search")?.addEventListener("input", renderSkillsTable);
    $("sb-category-filter")?.addEventListener("change", renderSkillsTable);
    $("sb-level-filter")?.addEventListener("change", renderSkillsTable);
    $("sb-proj-search")?.addEventListener("input", renderProjectsTable);
    $("sb-proj-cat-filter")?.addEventListener("change", renderProjectsTable);
    $("sb-work-search")?.addEventListener("input", renderWorkTable);
    $("sb-certs-search")?.addEventListener("input", renderCertsTable);

    $("sb-add-form")?.addEventListener("submit", handleAddSkill);
    $("sb-match-btn")?.addEventListener("click", handleMatch);
    $("sb-generate-btn")?.addEventListener("click", handleGenerate);

    const sbView = $("skillBankView");
    if (sbView) {
      new MutationObserver(() => {
        if (sbView.style.display !== "none" && !initialized.skills) loadSkillBank();
      }).observe(sbView, { attributes: true, attributeFilter: ["style"] });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.SkillBank = { editSkill, saveSkill, editProject, saveProject, editWork, saveWork, editCert, saveCert, editResearch, saveResearch, editEdu, saveEdu, loadSkillBank };
})();
