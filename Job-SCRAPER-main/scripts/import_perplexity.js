/**
 * import_perplexity.js
 * ─────────────────────────────────────────────────────────────
 * Merges Perplexity-generated JSON into the skill DB.
 *
 * Usage:  node import_perplexity.js
 *
 * Input:  perplexity_import.json  (save Perplexity output here)
 * Output: data/skill_data_bank.json + data/vector_store.json (updated in-place)
 *
 * Safe to run multiple times — will never create duplicates.
 * ─────────────────────────────────────────────────────────────
 */

const fs   = require("fs");
const path = require("path");

const INPUT  = path.join(__dirname, "perplexity_import.json");
const BANK   = path.join(__dirname, "data", "skill_data_bank.json");
const STORE  = path.join(__dirname, "data", "vector_store.json");

// ── 0. Load files ────────────────────────────────────────────────────────────

if (!fs.existsSync(INPUT)) {
  console.error(`\n❌  perplexity_import.json not found in this folder.\n`);
  console.error(`    Steps:\n    1. Copy Perplexity's full JSON output\n    2. Paste into a new file: ${INPUT}\n    3. Run this script again\n`);
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(INPUT, "utf-8"));
} catch (e) {
  console.error(`\n❌  Could not parse perplexity_import.json: ${e.message}`);
  console.error(`    Make sure the file contains valid JSON (no trailing commas, no comments)\n`);
  process.exit(1);
}

// Accept both formats:
//   { skill_chunks: [...], work_experience: [...] }   ← Task 1 format
//   [ ... ]                                            ← plain array of skill chunks
let newSkills = [];
let newWEs    = [];

if (Array.isArray(raw)) {
  newSkills = raw;
} else if (raw && typeof raw === "object") {
  newSkills = Array.isArray(raw.skill_chunks)    ? raw.skill_chunks    : [];
  newWEs    = Array.isArray(raw.work_experience) ? raw.work_experience : [];
}

if (newSkills.length === 0 && newWEs.length === 0) {
  console.error("\n❌  No skill_chunks or work_experience arrays found in the file.");
  console.error("    Check the structure Perplexity returned and save it as perplexity_import.json\n");
  process.exit(1);
}

console.log(`\n📂  Input: ${newSkills.length} skill chunk(s), ${newWEs.length} work experience(s)\n`);

// ── 1. Load current DBs ──────────────────────────────────────────────────────

const bank  = JSON.parse(fs.readFileSync(BANK,  "utf-8"));
const store = JSON.parse(fs.readFileSync(STORE, "utf-8"));

// ── 2. Validate required fields ──────────────────────────────────────────────

const REQUIRED = ["category", "skill", "level", "evidence", "phase"];
const VALID_CATEGORIES = new Set([
  "SAP_Technical","Programming","Data_Analytics","UX_Design","Creative",
  "Instructional_Design","Professional","Tools","Domain"
]);
const VALID_PHASES = new Set([
  "SAP_Masters","SAP_Work","Design","Creative","Multiple"
]);

const valid   = [];
const skipped = [];

for (const chunk of newSkills) {
  const missing = REQUIRED.filter(f => !chunk[f] || String(chunk[f]).trim() === "");
  if (missing.length) {
    skipped.push({ reason: `Missing fields: ${missing.join(", ")}`, chunk });
    continue;
  }
  if (!VALID_CATEGORIES.has(chunk.category)) {
    console.warn(`  ⚠️  Unknown category "${chunk.category}" for "${chunk.skill}" — keeping anyway`);
  }
  if (!VALID_PHASES.has(chunk.phase)) {
    console.warn(`  ⚠️  Unknown phase "${chunk.phase}" for "${chunk.skill}" — keeping anyway`);
  }
  valid.push(chunk);
}

if (skipped.length) {
  console.warn(`  ⚠️  Skipped ${skipped.length} chunk(s) with missing fields:`);
  skipped.forEach(s => console.warn(`     - "${s.chunk.skill || "??"}": ${s.reason}`));
  console.warn("");
}

// ── 3. Deduplicate against existing skills ───────────────────────────────────

const existingSkillNames = new Set(
  bank.skill_chunks.map(s => s.skill.toLowerCase().trim())
);

const toAdd   = [];
const dupes   = [];

for (const chunk of valid) {
  const key = chunk.skill.toLowerCase().trim();
  if (existingSkillNames.has(key)) {
    dupes.push(chunk.skill);
  } else {
    toAdd.push(chunk);
    existingSkillNames.add(key); // prevent dupes within the import itself
  }
}

if (dupes.length) {
  console.log(`  ℹ️  Skipping ${dupes.length} duplicate(s) already in DB:`);
  dupes.forEach(d => console.log(`     - ${d}`));
  console.log("");
}

// ── 4. Assign sequential IDs ─────────────────────────────────────────────────

// Find current max SK number
const maxId = bank.skill_chunks.reduce((max, s) => {
  const n = parseInt((s.id || "SK000").replace(/^SK/, ""), 10);
  return isNaN(n) ? max : Math.max(max, n);
}, 0);

const today = new Date().toISOString().split("T")[0];
let nextNum = maxId + 1;

const newChunksWithIds = toAdd.map(chunk => {
  const id = `SK${String(nextNum++).padStart(3, "0")}`;
  return {
    id,
    category:   chunk.category.trim(),
    skill:      chunk.skill.trim(),
    level:      chunk.level.trim(),
    evidence:   chunk.evidence.trim(),
    phase:      chunk.phase.trim(),
    added_date: today
  };
});

// ── 5. Handle work_experience ────────────────────────────────────────────────

const existingWETitles = new Set(
  (bank.work_experience || []).map(w => (w.title + "_" + w.company).toLowerCase().trim())
);

const wesToAdd   = [];
const weDupes    = [];
let weCount      = (bank.work_experience || []).length + 1;

for (const we of newWEs) {
  const key = ((we.title || "") + "_" + (we.company || "")).toLowerCase().trim();
  if (existingWETitles.has(key)) {
    weDupes.push(`${we.title} @ ${we.company}`);
  } else {
    // Assign a clean ID if not already set
    const id = we.id && /^WE\d+$/.test(we.id) ? we.id : `WE${String(weCount).padStart(3, "0")}`;
    wesToAdd.push({ ...we, id });
    existingWETitles.add(key);
    weCount++;
  }
}

if (weDupes.length) {
  console.log(`  ℹ️  Skipping ${weDupes.length} duplicate work experience(s):`);
  weDupes.forEach(d => console.log(`     - ${d}`));
  console.log("");
}

// ── 6. Early exit if nothing new ─────────────────────────────────────────────

if (newChunksWithIds.length === 0 && wesToAdd.length === 0) {
  console.log("✅  Nothing new to add — database is already up to date.\n");
  process.exit(0);
}

// ── 7. Write skill_data_bank.json ────────────────────────────────────────────

bank.skill_chunks.push(...newChunksWithIds);
if (!Array.isArray(bank.work_experience)) bank.work_experience = [];
bank.work_experience.push(...wesToAdd);
bank.last_updated = today;

fs.writeFileSync(BANK, JSON.stringify(bank, null, 2));
console.log(`✅  skill_data_bank.json updated: ${bank.skill_chunks.length} total skill chunks`);

// ── 8. Write vector_store.json ───────────────────────────────────────────────

for (const chunk of newChunksWithIds) {
  store.skill_chunks.items[chunk.id] = {
    id:       chunk.id,
    document: `${chunk.skill}. Level: ${chunk.level}. ${chunk.evidence}`,
    metadata: {
      category:   chunk.category,
      level:      chunk.level,
      skill_name: chunk.skill,
      phase:      chunk.phase,
      added_date: chunk.added_date
    }
  };
}

for (const we of wesToAdd) {
  const bullets = Array.isArray(we.bullets) ? we.bullets.join(". ") : (we.description || "");
  const skills  = Array.isArray(we.skills_used) ? `Skills: ${we.skills_used.join(", ")}` : "";
  store.work_experience.items[we.id] = {
    id:       we.id,
    document: `${we.title} at ${we.company}. ${bullets} ${skills}`.trim(),
    metadata: {
      title:   we.title   || "",
      company: we.company || "",
      period:  we.period  || ""
    }
  };
}

fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
console.log(`✅  vector_store.json updated: ${Object.keys(store.skill_chunks.items).length} total skill chunks`);

// ── 9. Summary ───────────────────────────────────────────────────────────────

console.log(`\n📊  IMPORT SUMMARY`);
console.log(`    ─────────────────────────────────────`);
console.log(`    New skill chunks added : ${newChunksWithIds.length}`);
console.log(`    Work experience added  : ${wesToAdd.length}`);
console.log(`    Duplicates skipped     : ${dupes.length + weDupes.length}`);
console.log(`    Invalid entries skipped: ${skipped.length}`);
console.log(`\n    New IDs assigned: ${newChunksWithIds.map(c => c.id).join(", ") || "none"}`);
console.log(`\n    New skills:\n${newChunksWithIds.map(c => `    ✓ ${c.id}: ${c.skill}`).join("\n")}`);
if (wesToAdd.length) {
  console.log(`\n    New work experience:\n${wesToAdd.map(w => `    ✓ ${w.id}: ${w.title} @ ${w.company}`).join("\n")}`);
}
console.log(`\n🔁  Restart server to reload the updated DB: node server.js\n`);
