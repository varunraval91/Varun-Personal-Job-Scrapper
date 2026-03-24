/**
 * apply_claude_output.js
 * 
 * Applies Claude's refined skill_chunks array into skill_data_bank.json.
 * Backs up current file, replaces skill_chunks, rebuilds vector store.
 * 
 * Usage: node scripts/apply_claude_output.js <path-to-claude-output.json>
 * 
 * Example:
 *   1. Save Claude's JSON array output to a file: generated/claude_skills.json
 *   2. Run: node scripts/apply_claude_output.js generated/claude_skills.json
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "skill_data_bank.json");
const BACKUP_DIR = path.join(ROOT, "data", "backups");

// Get input file path
const inputFile = process.argv[2];
if (!inputFile) {
  console.error("Usage: node scripts/apply_claude_output.js <path-to-claude-output.json>");
  console.error("Example: node scripts/apply_claude_output.js generated/claude_skills.json");
  process.exit(1);
}

const inputPath = path.isAbsolute(inputFile) ? inputFile : path.join(ROOT, inputFile);
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

// Parse and validate Claude's output
let newChunks;
try {
  const raw = fs.readFileSync(inputPath, "utf8").trim();
  // Handle if wrapped in markdown code block
  const cleaned = raw.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "");
  newChunks = JSON.parse(cleaned);
} catch (e) {
  console.error("Failed to parse JSON:", e.message);
  process.exit(1);
}

if (!Array.isArray(newChunks)) {
  console.error("Expected a JSON array of skill chunks");
  process.exit(1);
}

// Validate each chunk
const VALID_CATS = ["SAP_Technical", "Engineering_Dev", "Data_Analytics", "Design_UX", "Creative_Media", "Tools_Platforms", "Domain_Professional"];
const VALID_LEVELS = ["Beginner", "Intermediate", "Advanced", "Expert"];
const VALID_TYPES = ["tool", "skill"];
const VALID_PHASES = ["CS_Foundations", "Design", "Creative_Production", "SAP_Professional", "SAP_Masters"];

const errors = [];
const seen = new Set();

newChunks.forEach((c, i) => {
  if (!c.id) errors.push(`[${i}] missing id`);
  if (!c.skill) errors.push(`[${i}] missing skill`);
  if (c.type && !VALID_TYPES.includes(c.type)) errors.push(`[${i}] invalid type: ${c.type}`);
  if (!VALID_CATS.includes(c.category)) errors.push(`[${i}] invalid category: ${c.category}`);
  if (!VALID_LEVELS.includes(c.level)) errors.push(`[${i}] invalid level: ${c.level}`);
  if (c.phase && !VALID_PHASES.includes(c.phase)) errors.push(`[${i}] invalid phase: ${c.phase}`);
  
  const evLen = (c.evidence || "").trim().split(/\s+/).length;
  if (evLen < 8) errors.push(`[${i}] ${c.id} evidence too short (${evLen} words): "${c.evidence}"`);
  if (evLen > 35) errors.push(`[${i}] ${c.id} evidence too long (${evLen} words)`);
  
  const key = c.skill.toLowerCase().trim();
  if (seen.has(key)) errors.push(`[${i}] duplicate skill: "${c.skill}"`);
  seen.add(key);
});

if (errors.length > 0) {
  console.error(`\n⚠️  Validation found ${errors.length} issues:\n`);
  errors.forEach(e => console.error("  " + e));
  console.error("\nFix these in the JSON file and re-run.");
  process.exit(1);
}

// Backup current DB
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
const backupPath = path.join(BACKUP_DIR, `skill_data_bank_${timestamp}.json`);
fs.copyFileSync(DB_PATH, backupPath);
console.log(`📦 Backed up to: ${path.relative(ROOT, backupPath)}`);

// Load current bank and replace skill_chunks
const bank = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const oldCount = (bank.skill_chunks || []).length;
bank.skill_chunks = newChunks;
bank.last_updated = new Date().toISOString().split("T")[0];
bank.version = "3.0_CLAUDE_REBUILD";

// Update taxonomy_v2 stats
if (bank.taxonomy_v2) {
  const catCounts = {};
  newChunks.forEach(c => { catCounts[c.category] = (catCounts[c.category] || 0) + 1; });
  bank.taxonomy_v2.category_counts = catCounts;
  bank.taxonomy_v2.total_skills = newChunks.length;
}

fs.writeFileSync(DB_PATH, JSON.stringify(bank, null, 2), "utf8");
console.log(`✅ Replaced skill_chunks: ${oldCount} → ${newChunks.length}`);

// Category breakdown
const catBreakdown = {};
const typeBreakdown = { tool: 0, skill: 0 };
newChunks.forEach(c => {
  catBreakdown[c.category] = (catBreakdown[c.category] || 0) + 1;
  if (c.type) typeBreakdown[c.type]++;
});
console.log("\n📊 Category breakdown:");
Object.entries(catBreakdown).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
  console.log(`   ${k}: ${v}`);
});
console.log(`\n🔧 Tools: ${typeBreakdown.tool}  |  💡 Skills: ${typeBreakdown.skill}`);

// Rebuild vector store
console.log("\n🔄 Rebuilding vector store...");
try {
  // Reset the vector store JSON on disk so it rebuilds fresh
  const storePath = path.join(ROOT, "data", "vector_store.json");
  if (fs.existsSync(storePath)) {
    fs.writeFileSync(storePath, JSON.stringify({ collections: [] }, null, 2), "utf8");
  }

  // Reset cached client, then re-add all chunks
  const rag = require(path.join(ROOT, "src", "rag_engine.js"));
  if (rag.resetClient) rag.resetClient();

  (async () => {
    for (const c of newChunks) {
      await rag.addSkillToVector(c);
    }
    console.log(`✅ Vector store rebuilt with ${newChunks.length} chunks`);
  })();
} catch (e) {
  console.log("⚠️  Vector store rebuild skipped:", e.message);
  console.log("   It will rebuild automatically when the server starts.");
}

console.log("\n✅ Done! Next steps:");
console.log("   1. Restart server: node server.js");
console.log("   2. Hard refresh browser: Ctrl+F5");
console.log("   3. Check Skill Bank tab for new entries");
console.log("   4. Test CV Selector with a job analysis");
