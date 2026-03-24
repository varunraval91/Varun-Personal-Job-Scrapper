/**
 * SKILL BANK MANAGER (CommonJS)
 * Syncs skills to both JSON file and local vector store.
 */

const fs = require("fs");
const path = require("path");
const { addSkillToVector, updateSkillInVector } = require("./rag_engine");

const DB_PATH = path.join(__dirname, "..", "data", "skill_data_bank.json");

function loadBank() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveBank(bank) {
  bank.last_updated = new Date().toISOString().split("T")[0];
  fs.writeFileSync(DB_PATH, JSON.stringify(bank, null, 2));
}

/**
 * Add a new skill — writes to JSON AND embeds in vector store.
 */
async function addSkill({ category, skill, level, evidence, phase }) {
  const bank = loadBank();
  const nextNum = bank.skill_chunks.length + 1;
  const id = `SK${String(nextNum).padStart(3, "0")}`;

  const newChunk = {
    id,
    category,
    skill,
    level,
    evidence,
    phase: phase || "SAP_Masters",
    added_date: new Date().toISOString().split("T")[0]
  };

  bank.skill_chunks.push(newChunk);
  saveBank(bank);

  try {
    await addSkillToVector(newChunk);
    console.log(`Added ${id}: "${skill}" → JSON + vector store`);
  } catch (err) {
    console.log(`Added ${id}: "${skill}" → JSON only (vector store offline: ${err.message})`);
  }

  return newChunk;
}

/**
 * Update an existing skill — preserves history, syncs to vector store.
 */
async function updateSkill(skillId, updates) {
  const bank = loadBank();
  const chunk = bank.skill_chunks.find(c => c.id === skillId);
  if (!chunk) throw new Error(`Skill ${skillId} not found`);

  if (!chunk.history) chunk.history = [];
  chunk.history.push({
    date: new Date().toISOString().split("T")[0],
    previous_level: chunk.level,
    previous_evidence: chunk.evidence
  });

  Object.assign(chunk, updates);
  chunk.last_updated = new Date().toISOString().split("T")[0];
  saveBank(bank);

  try {
    await updateSkillInVector(chunk);
    console.log(`Updated ${skillId} → JSON + vector store`);
  } catch (err) {
    console.log(`Updated ${skillId} → JSON only (vector store offline: ${err.message})`);
  }

  return chunk;
}

/**
 * Log a job application.
 */
function logApplication({ company, role, requisition_id, chunks_used, document_type, status }) {
  const bank = loadBank();
  if (!bank.application_history) bank.application_history = [];

  const entry = {
    id: `APP${String(bank.application_history.length + 1).padStart(3, "0")}`,
    date: new Date().toISOString().split("T")[0],
    company,
    role,
    requisition_id: requisition_id || null,
    chunks_used,
    document_type,
    status,
    follow_up_date: null,
    outcome: null
  };

  bank.application_history.push(entry);
  saveBank(bank);
  return entry;
}

/**
 * Get analytics on the skill bank and applications.
 */
function getStats() {
  const bank = loadBank();
  const cats = {};
  for (const c of bank.skill_chunks) {
    cats[c.category] = (cats[c.category] || 0) + 1;
  }

  const apps = bank.application_history || [];
  const byStatus = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;

  const chunkUsage = {};
  for (const a of apps) {
    for (const cid of (a.chunks_used || [])) {
      chunkUsage[cid] = (chunkUsage[cid] || 0) + 1;
    }
  }
  const topChunks = Object.entries(chunkUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => {
      const chunk = bank.skill_chunks.find(c => c.id === id);
      return { id, skill: chunk?.skill || "unknown", used_in: count };
    });

  return {
    total_skills: bank.skill_chunks.length,
    skill_categories: cats,
    total_projects: bank.projects.length,
    total_applications: apps.length,
    application_status: byStatus,
    most_used_skills: topChunks,
    last_updated: bank.last_updated
  };
}

/**
 * Delete a skill by ID — removes from JSON and vector store.
 */
function deleteSkill(skillId) {
  const bank = loadBank();
  const idx = bank.skill_chunks.findIndex(c => c.id === skillId);
  if (idx === -1) throw new Error(`Skill ${skillId} not found`);
  const removed = bank.skill_chunks.splice(idx, 1)[0];
  saveBank(bank);
  console.log(`Deleted ${skillId}: "${removed.skill}"`);
  return removed;
}

module.exports = { addSkill, updateSkill, deleteSkill, logApplication, getStats, loadBank, saveBank };
