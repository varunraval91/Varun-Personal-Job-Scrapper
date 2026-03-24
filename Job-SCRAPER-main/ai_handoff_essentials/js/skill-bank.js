/**
 * Skill Data Bank — Frontend module
 * Handles: skill table, add skill, test match, stats
 */
(function () {
  "use strict";

  let allSkills = [];
  let categories = [];
  let initialized = false;

  function $(id) { return document.getElementById(id); }

  // ── Tab switching ──────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll(".sb-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".sb-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".sb-panel").forEach(p => p.style.display = "none");
        tab.classList.add("active");
        const panel = $("sb-panel-" + tab.dataset.sbTab);
        if (panel) panel.style.display = "";

        if (tab.dataset.sbTab === "stats") loadStats();
        if (tab.dataset.sbTab === "skills" && !initialized) loadSkillBank();
      });
    });
  }

  // ── Load skill bank data ───────────────────────────────────────
  async function loadSkillBank() {
    try {
      const res = await fetch("/skill-bank");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      allSkills = data.skill_chunks || [];
      categories = [...new Set(allSkills.map(s => s.category))].sort();

      // Update header stats
      $("sb-total-count").textContent = allSkills.length + " skills";
      $("sb-categories-count").textContent = categories.length + " categories";
      $("sb-vector-status").textContent = "Vector: " + (data.vectorReady ? "Active" : "Offline");

      // Populate category filter
      const catFilter = $("sb-category-filter");
      catFilter.innerHTML = '<option value="">All Categories</option>';
      categories.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c.replace(/_/g, " ");
        catFilter.appendChild(opt);
      });

      renderTable();
      initialized = true;
    } catch (err) {
      console.error("Failed to load skill bank:", err);
    }
  }

  // ── Render skills table ────────────────────────────────────────
  function renderTable() {
    const search = ($("sb-search")?.value || "").toLowerCase();
    const catFilter = $("sb-category-filter")?.value || "";
    const levelFilter = $("sb-level-filter")?.value || "";

    const filtered = allSkills.filter(s => {
      if (catFilter && s.category !== catFilter) return false;
      if (levelFilter && s.level !== levelFilter) return false;
      if (search && !s.skill.toLowerCase().includes(search) && !s.evidence.toLowerCase().includes(search) && !s.category.toLowerCase().includes(search)) return false;
      return true;
    });

    const tbody = $("sb-table-body");
    tbody.innerHTML = filtered.map(s => `
      <tr>
        <td><code>${esc(s.id)}</code></td>
        <td><strong>${esc(s.skill)}</strong></td>
        <td><span class="sb-cat-badge">${esc(s.category.replace(/_/g, " "))}</span></td>
        <td><span class="sb-level sb-level-${s.level.toLowerCase().replace(/[^a-z]/g, "")}">${esc(s.level)}</span></td>
        <td class="sb-evidence">${esc(s.evidence)}</td>
        <td><button class="sb-btn sb-btn-sm" onclick="window.SkillBank.editSkill('${s.id}')">Edit</button></td>
      </tr>
    `).join("");
  }

  // ── Add skill ──────────────────────────────────────────────────
  async function handleAddSkill(e) {
    e.preventDefault();
    const status = $("sb-add-status");
    status.textContent = "Adding...";
    status.className = "sb-status";

    try {
      const res = await fetch("/skill-bank/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: $("sb-add-category").value,
          skill: $("sb-add-skill").value,
          level: $("sb-add-level").value,
          evidence: $("sb-add-evidence").value
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      status.textContent = `Added: ${data.chunk.id} — ${data.chunk.skill}`;
      status.className = "sb-status sb-status-ok";
      $("sb-add-form").reset();
      await loadSkillBank();
    } catch (err) {
      status.textContent = "Error: " + err.message;
      status.className = "sb-status sb-status-err";
    }
  }

  // ── Edit skill (inline prompt for now) ─────────────────────────
  async function editSkill(id) {
    const skill = allSkills.find(s => s.id === id);
    if (!skill) return;

    const newLevel = prompt(`Update level for "${skill.skill}" (current: ${skill.level}):`, skill.level);
    if (!newLevel || newLevel === skill.level) return;

    const newEvidence = prompt("Update evidence (or leave as-is):", skill.evidence);

    try {
      const body = { id };
      if (newLevel !== skill.level) body.level = newLevel;
      if (newEvidence && newEvidence !== skill.evidence) body.evidence = newEvidence;

      const res = await fetch("/skill-bank/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      await loadSkillBank();
    } catch (err) {
      alert("Update failed: " + err.message);
    }
  }

  // ── Test match ─────────────────────────────────────────────────
  async function handleMatch() {
    const jobText = $("sb-match-input")?.value;
    if (!jobText) return;

    const results = $("sb-match-results");
    results.innerHTML = '<div class="sb-loading">Searching...</div>';

    try {
      const res = await fetch("/skill-bank/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobText, topN: 12 })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      let html = `<div class="sb-match-header">${data.skills.length} matching skills | ${data.projects.length} projects | ${data.work.length} work experiences</div>`;

      html += '<div class="sb-match-list">';
      data.skills.forEach((s, i) => {
        const pct = Math.max(0, (1 - s.distance) * 100).toFixed(1);
        html += `
          <div class="sb-match-item">
            <div class="sb-match-rank">#${i + 1}</div>
            <div class="sb-match-info">
              <div class="sb-match-skill">[${esc(s.id)}] ${esc(s.metadata.skill_name)}</div>
              <div class="sb-match-meta">${esc(s.metadata.category)} | ${esc(s.metadata.level)}</div>
              <div class="sb-match-evidence">${esc(s.document)}</div>
            </div>
            <div class="sb-match-score">${pct}%</div>
          </div>`;
      });
      html += "</div>";

      if (data.projects.length > 0) {
        html += '<div class="sb-match-section-title">Matching Projects</div>';
        data.projects.forEach(p => {
          html += `<div class="sb-match-item"><div class="sb-match-info"><strong>${esc(p.metadata.name)}</strong> (${esc(p.metadata.tech)})</div></div>`;
        });
      }

      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = `<div class="sb-error">Error: ${esc(err.message)}</div>`;
    }
  }

  // ── Generate CL from match tab ─────────────────────────────────
  async function handleGenerate() {
    const jobText = $("sb-match-input")?.value;
    if (!jobText) { alert("Paste a job description first"); return; }

    const results = $("sb-match-results");
    results.innerHTML = '<div class="sb-loading">Generating cover letter via RAG pipeline...</div>';

    try {
      const res = await fetch("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription: jobText, documentType: "cl", humanizeText: true })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      let html = '<div class="sb-match-header">Generated Cover Letter</div>';
      if (data.decisions?.chunksUsed?.length) {
        html += `<div class="sb-match-meta">Skills used: ${data.decisions.chunksUsed.map(c => c.skill).join(", ")}</div>`;
      }
      if (data.humanized) html += '<div class="sb-match-meta" style="color:var(--c-offer,green)">Humanizer applied</div>';
      html += `<div class="sb-generated-text">${esc(data.content).replace(/\n/g, "<br>")}</div>`;
      results.innerHTML = html;
    } catch (err) {
      results.innerHTML = `<div class="sb-error">Error: ${esc(err.message)}</div>`;
    }
  }

  // ── Stats ──────────────────────────────────────────────────────
  async function loadStats() {
    try {
      const res = await fetch("/skill-bank/stats");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      const container = $("sb-stats-content");
      let html = `
        <div class="sb-stat-card">
          <div class="sb-stat-num">${data.total_skills}</div>
          <div class="sb-stat-label">Total Skills</div>
        </div>
        <div class="sb-stat-card">
          <div class="sb-stat-num">${Object.keys(data.skill_categories).length}</div>
          <div class="sb-stat-label">Categories</div>
        </div>
        <div class="sb-stat-card">
          <div class="sb-stat-num">${data.total_projects}</div>
          <div class="sb-stat-label">Projects</div>
        </div>
        <div class="sb-stat-card">
          <div class="sb-stat-num">${data.total_applications}</div>
          <div class="sb-stat-label">Applications</div>
        </div>`;

      // Category breakdown
      html += '<div class="sb-stat-wide"><h3>Skills by Category</h3><div class="sb-cat-bars">';
      const maxCount = Math.max(...Object.values(data.skill_categories));
      Object.entries(data.skill_categories).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
        const pct = (count / maxCount * 100).toFixed(0);
        html += `
          <div class="sb-cat-bar-row">
            <span class="sb-cat-bar-label">${esc(cat.replace(/_/g, " "))}</span>
            <div class="sb-cat-bar-track"><div class="sb-cat-bar-fill" style="width:${pct}%"></div></div>
            <span class="sb-cat-bar-count">${count}</span>
          </div>`;
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

  function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  // ── Init ───────────────────────────────────────────────────────
  function init() {
    initTabs();

    // Filters
    $("sb-search")?.addEventListener("input", renderTable);
    $("sb-category-filter")?.addEventListener("change", renderTable);
    $("sb-level-filter")?.addEventListener("change", renderTable);

    // Add skill form
    $("sb-add-form")?.addEventListener("submit", handleAddSkill);

    // Match
    $("sb-match-btn")?.addEventListener("click", handleMatch);
    $("sb-generate-btn")?.addEventListener("click", handleGenerate);

    // Load on first visit — use MutationObserver for when view becomes visible
    const sbView = $("skillBankView");
    if (sbView) {
      const observer = new MutationObserver(() => {
        if (sbView.style.display !== "none" && !initialized) {
          loadSkillBank();
        }
      });
      observer.observe(sbView, { attributes: true, attributeFilter: ["style"] });
    }
  }

  // Wait for DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Export for edit button onclick
  window.SkillBank = { editSkill, loadSkillBank };
})();
