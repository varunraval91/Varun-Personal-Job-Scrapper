/**
 * migrate_v4.js
 * Transforms skill_data_bank.json v3.2 → v4.0 relational schema with junction tables.
 * Run: node scripts/migrate_v4.js
 */
const fs   = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "data");
const src  = JSON.parse(fs.readFileSync(path.join(DATA, "backups", "skill_data_bank_v3.2_20260327.json"), "utf-8"));

// ── helpers ──────────────────────────────────────────────────────────────────

function isProjectId(id) { return /^(PJ|MPJ|PJ_)/.test(id); }
function isWorkId(id)    { return /^WE/.test(id); }
function isCertId(id)    { return /^CERT_/.test(id); }

// ── 1. user_skills (from skill_chunks) ───────────────────────────────────────

const skillMap = {};  // skill_id → skill record (for junction building)

const user_skills = (src.skill_chunks || []).map(s => {
  const rec = {
    skill_id:    s.id,
    skill_name:  s.skill,
    type:        s.type || "skill",
    category:    s.category,
    level:       s.level,
    description: s.evidence,
    phase:       s.phase,
    source_refs: s.source_refs || [],
    tools:       s.tools || undefined
  };
  if (!rec.tools) delete rec.tools;
  // vector_text filled after junctions
  skillMap[rec.skill_id] = rec;
  return rec;
});

// ── 2. user_projects (flat merge of projects + media_projects) ────────────────

const rawProjects = [
  ...(src.projects || []),
  ...(src.media_projects?.sap_media_projects    || []),
  ...(src.media_projects?.creative_media_projects || [])
];

const projectMap = {};

const user_projects = rawProjects.map(p => {
  const rec = {
    project_id:   p.id,
    project_name: p.name || p.title,
    tech:         p.tech || (Array.isArray(p.tech_tools) ? p.tech_tools.join(", ") : ""),
    date:         p.date || p.date_range || "",
    description:  p.description || (Array.isArray(p.responsibilities) ? p.responsibilities.join(" ") : ""),
    impact:       p.quantified_impact || p.impact || "",
    responsibilities: p.responsibilities || undefined,
    sub_category: p.sub_category || undefined
  };
  if (!rec.responsibilities) delete rec.responsibilities;
  if (!rec.sub_category)     delete rec.sub_category;
  if (!rec.impact)           delete rec.impact;
  projectMap[rec.project_id] = rec;
  return rec;
});

// ── 3. user_work_experience ───────────────────────────────────────────────────

const workMap = {};

const user_work_experience = (src.work_experience || []).map(w => {
  const rec = {
    work_id:         w.id,
    job_title:       w.title,
    company:         w.company,
    period:          w.period,
    location:        w.location || "",
    skills_used:     w.skills_used || [],
    responsibilities: w.bullets || [],
    vector_text:     ""  // filled below
  };
  workMap[rec.work_id] = rec;
  return rec;
});

// ── 4. user_certifications ────────────────────────────────────────────────────

const certMap = {};

const user_certifications = (src.certifications_registry || []).map(c => {
  const rec = {
    cert_id:  c.id,
    title:    c.name,
    provider: c.provider || "",
    date:     c.date || c.date_range || "",
    duration: c.duration || ""
  };
  certMap[rec.cert_id] = rec;
  return rec;
});

// ── 5. Junction tables ────────────────────────────────────────────────────────

const skill_project = [];
const skill_work    = [];
const skill_cert    = [];

for (const s of user_skills) {
  for (const ref of (s.source_refs || [])) {
    if (isProjectId(ref) && projectMap[ref]) skill_project.push({ skill_id: s.skill_id, project_id: ref });
    if (isWorkId(ref)    && workMap[ref])    skill_work.push({    skill_id: s.skill_id, work_id:    ref });
    if (isCertId(ref)    && certMap[ref])    skill_cert.push({    skill_id: s.skill_id, cert_id:    ref });
  }
}

// ── 6. vector_text generation ─────────────────────────────────────────────────

// Pre-index: which skills link to each project/work?
const skillsForProject = {};
const skillsForWork    = {};
for (const j of skill_project) {
  (skillsForProject[j.project_id] = skillsForProject[j.project_id] || []).push(j.skill_id);
}
for (const j of skill_work) {
  (skillsForWork[j.work_id] = skillsForWork[j.work_id] || []).push(j.skill_id);
}

// Skills: name + description + category + level + linked project names
for (const s of user_skills) {
  const linkedProjNames = (skill_project
    .filter(j => j.skill_id === s.skill_id)
    .map(j => {
      const p = projectMap[j.project_id];
      return p ? `${p.project_name} ${p.tech}` : "";
    })
    .filter(Boolean)
    .join(" "));
  const linkedWorkNames = (skill_work
    .filter(j => j.skill_id === s.skill_id)
    .map(j => {
      const w = workMap[j.work_id];
      return w ? `${w.job_title} ${w.company}` : "";
    })
    .filter(Boolean)
    .join(" "));
  s.vector_text = `${s.skill_name} ${s.description} ${s.category} ${s.level} ${linkedProjNames} ${linkedWorkNames}`.replace(/\s+/g, " ").trim();
}

// Projects: name + tech + description + linked skill names
for (const p of user_projects) {
  const linkedSkillNames = (skillsForProject[p.project_id] || [])
    .map(sid => skillMap[sid]?.skill_name || "")
    .filter(Boolean)
    .join(" ");
  p.vector_text = `${p.project_name} ${p.tech} ${p.description} ${linkedSkillNames}`.replace(/\s+/g, " ").trim();
}

// Work: job_title + company + responsibilities + linked skill names
for (const w of user_work_experience) {
  const linkedSkillNames = (skillsForWork[w.work_id] || [])
    .map(sid => skillMap[sid]?.skill_name || "")
    .filter(Boolean)
    .join(" ");
  w.vector_text = `${w.job_title} ${w.company} ${w.responsibilities.join(" ")} ${w.skills_used.join(" ")} ${linkedSkillNames}`.replace(/\s+/g, " ").trim();
}

// ── 7. Assemble v4.0 bank ─────────────────────────────────────────────────────

const v4 = {
  version:       "4.0",
  schema:        "relational_with_junctions",
  last_updated:  new Date().toISOString().split("T")[0],
  rebuild_note:  "v4.0: Relational schema with junction tables. vector_text pre-computed for TF-IDF.",
  counts: {
    skills:          user_skills.length,
    projects:        user_projects.length,
    work_experience: user_work_experience.length,
    certifications:  user_certifications.length,
    research:        (src.research_papers?.length || 0) + (src.research_activities?.length || 0),
    junctions: {
      skill_project: skill_project.length,
      skill_work:    skill_work.length,
      skill_cert:    skill_cert.length
    }
  },
  profile:             src.profile,
  education:           src.education,
  user_skills,
  user_projects,
  user_work_experience,
  user_certifications,
  research_papers:     src.research_papers     || [],
  research_activities: src.research_activities || [],
  skill_project,
  skill_work,
  skill_cert,
  // preserve misc fields
  writing_style_profile: src.writing_style_profile,
  application_history:   src.application_history || []
};

// ── 8. Write ─────────────────────────────────────────────────────────────────

const out = path.join(DATA, "skill_data_bank.json");
fs.writeFileSync(out, JSON.stringify(v4, null, 2));

console.log(`✅ v4.0 written to data/skill_data_bank.json`);
console.log(`   Skills: ${v4.counts.skills}, Projects: ${v4.counts.projects}, Work: ${v4.counts.work_experience}`);
console.log(`   Junctions — skill_project: ${v4.counts.junctions.skill_project}, skill_work: ${v4.counts.junctions.skill_work}, skill_cert: ${v4.counts.junctions.skill_cert}`);
