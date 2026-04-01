const fs   = require("fs");
const path = require("path");
const { addSkillToVector, updateSkillInVector, resetClient } = require("./rag_engine");

const DB_PATH = path.join(__dirname, "..", "data", "skill_data_bank.json");

// Atomic write with retry — avoids EPERM on Windows when file is briefly locked
function atomicWriteSync(filePath, data) {
  const tmpPath = filePath + ".tmp";
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(tmpPath, data);
      // Atomic rename (overwrites target on Windows with Node 14+)
      try { fs.renameSync(tmpPath, filePath); } catch {
        // renameSync can fail on some Windows configs; fall back to direct write
        fs.writeFileSync(filePath, data);
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      return;
    } catch (err) {
      if (i < maxRetries - 1 && (err.code === "EPERM" || err.code === "EBUSY")) {
        // Brief delay then retry
        const waitMs = 100 * (i + 1);
        const start = Date.now();
        while (Date.now() - start < waitMs) { /* busy wait */ }
        continue;
      }
      throw err;
    }
  }
}

const VALID_CATEGORIES = [
  "SAP_Technical",
  "Engineering_Dev",
  "Data_Analytics",
  "Design_UX",
  "Creative_Media",
  "Tools_Platforms",
  "Domain_Professional"
];

const VALID_TYPES = ["tool", "skill"];

function loadBank() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveBank(bank) {
  bank.last_updated = new Date().toISOString().split("T")[0];
  atomicWriteSync(DB_PATH, JSON.stringify(bank, null, 2));
}

// ── v4.0: skills live in user_skills ─────────────────────────────────────────

async function addSkill({ category, skill, skill_name, level, evidence, description, phase, type, source_refs }) {
  const name = skill_name || skill;
  const desc = description || evidence;
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
  }
  if (type && !VALID_TYPES.includes(type)) {
    throw new Error(`Invalid type "${type}". Valid: ${VALID_TYPES.join(", ")}`);
  }
  const bank    = loadBank();
  const skills  = bank.user_skills || bank.skill_chunks || [];
  const nextNum = skills.length + 1;
  const skill_id = `SK${String(nextNum).padStart(3, "0")}`;
  const newChunk = {
    skill_id,
    skill_name:  name,
    type:        type || "skill",
    category,
    level,
    description: desc,
    phase:       phase || "SAP_Masters",
    source_refs: source_refs || [],
    vector_text: `${name}. Level: ${level}. ${desc} ${category}`
  };
  if (bank.user_skills) {
    bank.user_skills.push(newChunk);
    if (bank.counts) bank.counts.skills = bank.user_skills.length;
  } else {
    // legacy v3.2 fallback
    bank.skill_chunks.push({ id: skill_id, skill: name, ...newChunk });
  }
  saveBank(bank);
  try { await addSkillToVector(newChunk); console.log(`Added ${skill_id}: "${name}" → JSON + vector`); }
  catch (err) { console.log(`Added ${skill_id}: "${name}" → JSON only (${err.message})`); }
  return newChunk;
}

async function updateSkill(skillId, updates) {
  if (updates.category && !VALID_CATEGORIES.includes(updates.category)) {
    throw new Error(`Invalid category "${updates.category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
  }
  const bank   = loadBank();
  const skills = bank.user_skills || bank.skill_chunks || [];
  const chunk  = skills.find(s => (s.skill_id || s.id) === skillId);
  if (!chunk) throw new Error(`Skill ${skillId} not found`);

  if (!chunk.history) chunk.history = [];
  chunk.history.push({
    date:              new Date().toISOString().split("T")[0],
    previous_level:    chunk.level,
    previous_evidence: chunk.description || chunk.evidence
  });

  // Accept both old and new field names in updates
  if (updates.skill_name || updates.skill) chunk.skill_name = updates.skill_name || updates.skill;
  if (updates.description || updates.evidence) chunk.description = updates.description || updates.evidence;
  if (updates.level)      chunk.level      = updates.level;
  if (updates.category)   chunk.category   = updates.category;
  if (updates.tools)      chunk.tools      = updates.tools;

  chunk.last_updated = new Date().toISOString().split("T")[0];
  // Regenerate vector_text
  chunk.vector_text = `${chunk.skill_name || chunk.skill}. Level: ${chunk.level}. ${chunk.description || chunk.evidence} ${chunk.category}`;

  saveBank(bank);
  try { await updateSkillInVector(chunk); console.log(`Updated ${skillId} → JSON + vector`); }
  catch (err) { console.log(`Updated ${skillId} → JSON only (${err.message})`); }
  return chunk;
}

function deleteSkill(skillId) {
  const bank   = loadBank();
  const skills = bank.user_skills || bank.skill_chunks || [];
  const idx    = skills.findIndex(s => (s.skill_id || s.id) === skillId);
  if (idx === -1) throw new Error(`Skill ${skillId} not found`);
  const removed = skills.splice(idx, 1)[0];
  if (bank.counts) bank.counts.skills = (bank.user_skills || []).length;
  saveBank(bank);
  console.log(`Deleted ${skillId}: "${removed.skill_name || removed.skill}"`);
  return removed;
}

function logApplication({ company, role, requisition_id, chunks_used, document_type, status }) {
  const bank = loadBank();
  if (!bank.application_history) bank.application_history = [];
  const entry = {
    id:             `APP${String(bank.application_history.length + 1).padStart(3, "0")}`,
    date:           new Date().toISOString().split("T")[0],
    company, role,
    requisition_id: requisition_id || null,
    chunks_used, document_type, status,
    follow_up_date: null,
    outcome:        null
  };
  bank.application_history.push(entry);
  saveBank(bank);
  return entry;
}

function getStats() {
  const bank   = loadBank();
  const skills = bank.user_skills || bank.skill_chunks || [];
  const cats   = {};
  for (const s of skills) cats[s.category] = (cats[s.category] || 0) + 1;
  const apps     = bank.application_history || [];
  const byStatus = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const chunkUsage = {};
  for (const a of apps) for (const cid of (a.chunks_used || [])) chunkUsage[cid] = (chunkUsage[cid] || 0) + 1;
  const topChunks = Object.entries(chunkUsage).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => {
    const s = skills.find(c => (c.skill_id || c.id) === id);
    return { id, skill: s?.skill_name || s?.skill || "unknown", used_in: count };
  });
  return {
    total_skills:       skills.length,
    skill_categories:   cats,
    valid_categories:   VALID_CATEGORIES,
    total_projects:     (bank.user_projects || bank.projects || []).length,
    total_applications: apps.length,
    application_status: byStatus,
    most_used_skills:   topChunks,
    last_updated:       bank.last_updated
  };
}

function getCategories() { return VALID_CATEGORIES; }

module.exports = { addSkill, updateSkill, deleteSkill, logApplication, getStats, getCategories, loadBank, saveBank, VALID_CATEGORIES, VALID_TYPES, resetClient };
