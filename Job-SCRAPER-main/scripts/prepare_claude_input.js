/**
 * prepare_claude_input.js
 * 
 * Consolidates ALL available source documents into two text files
 * for pasting into Claude sessions.
 * 
 * Part 1: Profile data + OCR'd CVs (for Session 1: extraction)
 * Part 2: Current skill_chunks (for Session 2: review/dedup)
 * 
 * Usage: node scripts/prepare_claude_input.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const LIBRARY = path.join(ROOT, "library");
const OUT = path.join(ROOT, "generated");

// Ensure output dir
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// Load main data
const bank = JSON.parse(fs.readFileSync(path.join(DATA, "skill_data_bank.json"), "utf8"));

// Load OCR cache
let ocrCache = {};
const ocrPath = path.join(LIBRARY, "ocr-cache.json");
if (fs.existsSync(ocrPath)) {
  ocrCache = JSON.parse(fs.readFileSync(ocrPath, "utf8"));
}

// ─── PART 1: Everything Claude needs to EXTRACT from ─────────────────────

const lines1 = [];

lines1.push("=" .repeat(70));
lines1.push("VARUN RAVAL — COMPLETE SOURCE DOCUMENTS FOR SKILL EXTRACTION");
lines1.push("=" .repeat(70));

// Profile
lines1.push("\n## PROFILE");
const p = bank.profile;
lines1.push(`Name: ${p.name}`);
lines1.push(`Location: ${p.location}`);
lines1.push(`Status: ${p.current_status}`);
lines1.push(`Availability: ${p.availability}`);
lines1.push(`Languages: ${Object.entries(p.languages).map(([k,v])=>`${k}(${v})`).join(", ")}`);
lines1.push(`Target: ${p.target_roles.join(", ")} at ${p.target_companies.join(", ")}`);

// Education
lines1.push("\n## EDUCATION");
(bank.education || []).forEach((e, i) => {
  lines1.push(`\nEDU${String(i+1).padStart(3,"0")}: ${e.degree}`);
  lines1.push(`  Institution: ${e.institution}`);
  lines1.push(`  Period: ${e.period}`);
  if (e.status) lines1.push(`  Status: ${e.status}`);
  if (e.cooperation) lines1.push(`  Note: ${e.cooperation}`);
  if (e.key_modules) lines1.push(`  Modules: ${e.key_modules.join(", ")}`);
  if (e.relevance) lines1.push(`  Relevance: ${e.relevance}`);
});

// Career Phases
lines1.push("\n## CAREER PHASES");
(bank.career_phases || []).forEach(cp => {
  lines1.push(`Phase ${cp.phase}: ${cp.label} (${cp.period}) — ${cp.key}`);
});

// Work Experience
lines1.push("\n## WORK EXPERIENCE");
(bank.work_experience || []).forEach(we => {
  lines1.push(`\n${we.id}: ${we.title || "(no title)"}`);
  lines1.push(`  Company: ${we.company}`);
  lines1.push(`  Location: ${we.location || "N/A"}`);
  lines1.push(`  Period: ${we.period}`);
  if (we.skills_used && we.skills_used.length) {
    lines1.push(`  Skills used: ${we.skills_used.join(", ")}`);
  }
  if (we.bullets) {
    we.bullets.forEach(b => lines1.push(`  • ${b}`));
  }
});

// Projects
lines1.push("\n## PROJECTS");
(bank.projects || []).forEach(proj => {
  lines1.push(`\n${proj.id}: ${proj.name || proj.title || "(no title)"}`);
  if (proj.tech) lines1.push(`  Tech: ${proj.tech}`);
  if (proj.date) lines1.push(`  Date: ${proj.date}`);
  if (proj.description) lines1.push(`  Description: ${proj.description}`);
  if (proj.quantified_impact) lines1.push(`  Impact: ${proj.quantified_impact}`);
  if (proj.bullets) {
    proj.bullets.forEach(b => lines1.push(`  • ${b}`));
  }
});

// Research Papers
if (bank.research_papers && bank.research_papers.length) {
  lines1.push("\n## RESEARCH PAPERS");
  bank.research_papers.forEach(rp => {
    lines1.push(`\n${rp.id || "RP"}: ${rp.title}`);
    if (rp.date) lines1.push(`  Date: ${rp.date}`);
    if (rp.description) lines1.push(`  Description: ${rp.description}`);
    if (rp.methodology) lines1.push(`  Methodology: ${rp.methodology}`);
    if (rp.key_findings) lines1.push(`  Findings: ${rp.key_findings}`);
  });
}

// Research Activities
if (bank.research_activities && bank.research_activities.length) {
  lines1.push("\n## RESEARCH ACTIVITIES");
  bank.research_activities.forEach(ra => {
    lines1.push(`\n${ra.id || "RA"}: ${ra.title || ra.name || "(untitled)"}`);
    if (ra.description) lines1.push(`  ${ra.description}`);
  });
}

// Certifications
if (bank.certifications && bank.certifications.length) {
  lines1.push("\n## CERTIFICATIONS");
  bank.certifications.forEach(c => {
    lines1.push(`- ${c.name}${c.date ? " (" + c.date + ")" : ""}`);
    if (c.details) lines1.push(`  ${c.details}`);
  });
}

// Key Differentiators
if (bank.key_differentiators) {
  lines1.push("\n## KEY DIFFERENTIATORS");
  if (Array.isArray(bank.key_differentiators)) {
    bank.key_differentiators.forEach(d => lines1.push(`- ${typeof d === 'string' ? d : JSON.stringify(d)}`));
  } else {
    lines1.push(JSON.stringify(bank.key_differentiators, null, 2));
  }
}

// OCR'd CVs
lines1.push("\n" + "=".repeat(70));
lines1.push("OCR-EXTRACTED CV TEXTS (3 variants)");
lines1.push("=".repeat(70));

Object.entries(ocrCache).forEach(([key, val]) => {
  const text = typeof val === "string" ? val : (val.text || JSON.stringify(val));
  const name = key.split("__")[0];
  lines1.push(`\n--- CV: ${name} ---`);
  lines1.push(text);
});

// LaTeX templates (useful for style context)
const templateDir = path.join(LIBRARY, "templates");
if (fs.existsSync(templateDir)) {
  const texFiles = fs.readdirSync(templateDir).filter(f => f.endsWith(".tex"));
  if (texFiles.length) {
    lines1.push("\n" + "=".repeat(70));
    lines1.push("LATEX TEMPLATES (for format reference)");
    lines1.push("=".repeat(70));
    texFiles.forEach(f => {
      lines1.push(`\n--- ${f} ---`);
      lines1.push(fs.readFileSync(path.join(templateDir, f), "utf8"));
    });
  }
}

// Writing style profile
const stylePath = path.join(DATA, "writing_style_profile.json");
if (fs.existsSync(stylePath)) {
  lines1.push("\n## WRITING STYLE PROFILE");
  const style = JSON.parse(fs.readFileSync(stylePath, "utf8"));
  lines1.push(JSON.stringify(style, null, 2));
}

// ─── PART 2: Current skills for review ─────────────────────────────

const lines2 = [];
lines2.push("CURRENT SKILL_CHUNKS (125 entries) — for review/dedup reference");
lines2.push("=".repeat(70));
lines2.push(JSON.stringify(bank.skill_chunks, null, 2));

// ─── Write outputs ─────────────────────────────────────────────────

const part1 = lines1.join("\n");
const part2 = lines2.join("\n");

fs.writeFileSync(path.join(OUT, "claude_input_part1.txt"), part1, "utf8");
fs.writeFileSync(path.join(OUT, "claude_input_part2.txt"), part2, "utf8");

// Stats
const charCount1 = part1.length;
const charCount2 = part2.length;
const tokenEst1 = Math.ceil(charCount1 / 4);
const tokenEst2 = Math.ceil(charCount2 / 4);

console.log("✅ Files created in generated/");
console.log(`   claude_input_part1.txt: ${(charCount1/1024).toFixed(1)} KB (~${tokenEst1.toLocaleString()} tokens)`);
console.log(`   claude_input_part2.txt: ${(charCount2/1024).toFixed(1)} KB (~${tokenEst2.toLocaleString()} tokens)`);
console.log("");
console.log("📋 Next steps:");
console.log("   1. Open generated/claude_input_part1.txt");
console.log("   2. Start a new Claude conversation");
console.log("   3. Paste the Session 1 prompt from docs/CLAUDE_DB_REBUILD_PLAN.md");
console.log("   4. Paste or attach claude_input_part1.txt below the prompt");
