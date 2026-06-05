/**
 * First-time setup script.
 * Creates all required directories and empty data files.
 * Run once after cloning: node scripts/setup.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function mkdir(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
    console.log(`  created  ${rel}/`);
  } else {
    console.log(`  exists   ${rel}/`);
  }
}

function writeIfMissing(rel, content) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    fs.writeFileSync(full, JSON.stringify(content, null, 2), "utf-8");
    console.log(`  created  ${rel}`);
  } else {
    console.log(`  exists   ${rel} (skipped)`);
  }
}

// ── Directories ───────────────────────────────────────────────────────────────
console.log("\n[1/3] Creating directories...");
mkdir("data");
mkdir("data/backups");
mkdir("library/foundation/cvs");
mkdir("library/foundation/cover_letters");
mkdir("library/approved");
mkdir("generated");

// ── Data files ────────────────────────────────────────────────────────────────
console.log("\n[2/3] Creating empty data files...");

writeIfMissing("data/skill_data_bank.json", {
  version: "4.0",
  schema: "relational_with_junctions",
  last_updated: new Date().toISOString().split("T")[0],
  rebuild_note: "v4.0: Relational schema with junction tables. vector_text pre-computed for TF-IDF.",
  counts: {
    skills: 0,
    projects: 0,
    work_experience: 0,
    certifications: 0,
    research: 0,
    junctions: { skill_project: 0, skill_work: 0, skill_cert: 0 }
  },
  profile: {
    name: "YOUR NAME",
    email_academic: "your.academic@email.com",
    email_personal: "your.personal@email.com",
    phone: "+XX XXXXXXXXXXX",
    location: "Your City, Country",
    linkedin: "linkedin.com/in/yourprofile",
    github: "github.com/yourusername",
    languages: { English: "Fluent" },
    work_authorization: "Eligible to work in [Country]",
    availability: "Month YYYY – Month YYYY",
    current_status: "Your degree and year",
    target_roles: ["Internship", "Working Student"],
    target_companies: ["Company A", "Company B"]
  },
  education: [],
  user_skills: [],
  projects: [],
  work_experience: [],
  certifications: [],
  research: [],
  junctions: {
    skill_project: [],
    skill_work: [],
    skill_cert: []
  }
});

writeIfMissing("data/vector_store.json", {
  skill_chunks: {
    metadata: {},
    items: {}
  }
});

writeIfMissing("data/writing_style_profile.json", {
  total_samples: 0,
  style_analysis: {},
  _note: "Auto-generated. Run: node scripts/extract_style.js — after uploading your cover letter PDFs."
});

writeIfMissing("data/job_tracker_by_company.json", {
  schema_version: "1.0",
  last_updated: new Date().toISOString(),
  status_logic: {
    Interview: "Interview invite / meeting / scheduling confirmed",
    Rejected: "Explicit rejection email received",
    Applied: "Application confirmed; under review; no further update",
    "No Response": "Application receipt exists but no interview or rejection email",
    Withdrawn: "Application not completed or voluntarily withdrawn"
  },
  summary: {
    total_companies: 0
  },
  companies: []
});

writeIfMissing("data/media_projects_bank.json", {
  media_projects: {
    sap_media_projects: [],
    general_media_projects: []
  }
});

writeIfMissing("data/sap_detail_cache.json", {});

// ── Done ──────────────────────────────────────────────────────────────────────
console.log("\n[3/3] Setup complete.\n");
console.log("Next steps:");
console.log("  1. Copy .env.example → .env  and fill in your API key");
console.log("  2. Edit js/firebase-config.js with your Firebase project credentials");
console.log("  3. Upload your CV PDFs  → library/foundation/cvs/");
console.log("  4. Upload cover letter PDFs (optional) → library/foundation/cover_letters/");
console.log("  5. npm install");
console.log("  6. npx playwright install chromium");
console.log("  7. node scripts/extract_style.js   (generates writing style profile)");
console.log("  8. npm start   →   open http://localhost:3000");
console.log("  9. Use the Skill Bank tab in the UI to add your skills\n");
console.log("See GETTING_STARTED.md for full details.\n");
