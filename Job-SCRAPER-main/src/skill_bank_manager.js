const fs   = require("fs");
const path = require("path");
const { addSkillToVector, updateSkillInVector, resetClient } = require("./rag_engine");

const DB_PATH = path.join(__dirname, "..", "data", "skill_data_bank.json");

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
  fs.writeFileSync(DB_PATH, JSON.stringify(bank, null, 2));
}

async function addSkill({ category, skill, level, evidence, phase, type, source_refs }) {
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
  }
  if (type && !VALID_TYPES.includes(type)) {
    throw new Error(`Invalid type "${type}". Valid: ${VALID_TYPES.join(", ")}`);
  }
  const bank = loadBank();
  const nextNum = bank.skill_chunks.length + 1;
  const id = `SK${String(nextNum).padStart(3, "0")}`;
  const newChunk = { id, category, skill, level, evidence, phase: phase || "SAP_Masters", type: type || "skill", source_refs: source_refs || [], added_date: new Date().toISOString().split("T")[0] };
  bank.skill_chunks.push(newChunk);
  saveBank(bank);
  try { await addSkillToVector(newChunk); console.log(`Added ${id}: "${skill}" → JSON + vector`); }
  catch (err) { console.log(`Added ${id}: "${skill}" → JSON only (${err.message})`); }
  return newChunk;
}

async function updateSkill(skillId, updates) {
  if (updates.category && !VALID_CATEGORIES.includes(updates.category)) {
    throw new Error(`Invalid category "${updates.category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
  }
  const bank = loadBank();
  const chunk = bank.skill_chunks.find(c => c.id === skillId);
  if (!chunk) throw new Error(`Skill ${skillId} not found`);
  if (!chunk.history) chunk.history = [];
  chunk.history.push({ date: new Date().toISOString().split("T")[0], previous_level: chunk.level, previous_evidence: chunk.evidence });
  Object.assign(chunk, updates);
  chunk.last_updated = new Date().toISOString().split("T")[0];
  saveBank(bank);
  try { await updateSkillInVector(chunk); console.log(`Updated ${skillId} → JSON + vector`); }
  catch (err) { console.log(`Updated ${skillId} → JSON only (${err.message})`); }
  return chunk;
}

function logApplication({ company, role, requisition_id, chunks_used, document_type, status }) {
  const bank = loadBank();
  if (!bank.application_history) bank.application_history = [];
  const entry = { id: `APP${String(bank.application_history.length + 1).padStart(3, "0")}`, date: new Date().toISOString().split("T")[0], company, role, requisition_id: requisition_id || null, chunks_used, document_type, status, follow_up_date: null, outcome: null };
  bank.application_history.push(entry);
  saveBank(bank);
  return entry;
}

function getStats() {
  const bank = loadBank();
  const cats = {};
  for (const c of bank.skill_chunks) cats[c.category] = (cats[c.category] || 0) + 1;
  const apps = bank.application_history || [];
  const byStatus = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const chunkUsage = {};
  for (const a of apps) for (const cid of (a.chunks_used || [])) chunkUsage[cid] = (chunkUsage[cid] || 0) + 1;
  const topChunks = Object.entries(chunkUsage).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,count])=>{ const chunk=bank.skill_chunks.find(c=>c.id===id); return {id,skill:chunk?.skill||"unknown",used_in:count}; });
  return { total_skills: bank.skill_chunks.length, skill_categories: cats, valid_categories: VALID_CATEGORIES, total_projects: bank.projects?.length||0, total_applications: apps.length, application_status: byStatus, most_used_skills: topChunks, last_updated: bank.last_updated };
}

function deleteSkill(skillId) {
  const bank = loadBank();
  const idx = bank.skill_chunks.findIndex(c => c.id === skillId);
  if (idx === -1) throw new Error(`Skill ${skillId} not found`);
  const removed = bank.skill_chunks.splice(idx, 1)[0];
  saveBank(bank);
  console.log(`Deleted ${skillId}: "${removed.skill}"`);
  return removed;
}

function getCategories() { return VALID_CATEGORIES; }

module.exports = { addSkill, updateSkill, deleteSkill, logApplication, getStats, getCategories, loadBank, saveBank, VALID_CATEGORIES, VALID_TYPES, resetClient };
