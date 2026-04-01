/**
 * smoke-test-v4.js — Strict v4.0 migration smoke test
 * Run: node scripts/smoke-test-v4.js
 *
 * Tests:
 *  1. No normalizeBank references remain in server.js
 *  2. No old alias field names (skill_chunks, work_experience as top-level, etc.) remain
 *  3. skill_data_bank.json is pure v4.0 schema
 *  4. /health endpoint reports correct counts
 *  5. /skill-bank endpoint returns v4.0 arrays
 *  6. /cv-selector-data returns non-empty work + projects with correct field names
 *  7. Pinned IDs resolve correctly end-to-end
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");

const ROOT    = path.join(__dirname, "..");
const BASE    = "http://localhost:3000";
const PASS    = "\x1b[32m✓\x1b[0m";
const FAIL    = "\x1b[31m✗\x1b[0m";
const WARN    = "\x1b[33m!\x1b[0m";
let failures  = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
  } else {
    console.log(`  ${FAIL} ${label}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

async function get(path) {
  return new Promise((res, rej) => {
    http.get(BASE + path, r => {
      let body = "";
      r.on("data", d => body += d);
      r.on("end", () => { try { res(JSON.parse(body)); } catch { res(body); } });
    }).on("error", rej);
  });
}

async function post(path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, r => {
      let b = "";
      r.on("data", d => b += d);
      r.on("end", () => { try { res(JSON.parse(b)); } catch { res(b); } });
    });
    req.on("error", rej);
    req.write(data);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════");
console.log(" SMOKE TEST — v4.0 Migration Verification");
console.log("═══════════════════════════════════════════════════\n");

// ── SECTION 1: Static code analysis ─────────────────────────────────────────
console.log("▶ 1. Static code analysis (server.js)");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf-8");

assert("normalizeBank function is gone",
  !serverSrc.includes("function normalizeBank"));

assert("normalizeBank() call is gone",
  !serverSrc.includes("normalizeBank("));

assert("No bank.skill_chunks access",
  !serverSrc.match(/bank\.skill_chunks\b/));

assert("No bank.work_experience access (old v3.2 top-level key)",
  !serverSrc.match(/bank\.work_experience\b/));

assert("No bank.certifications_registry access",
  !serverSrc.match(/bank\.certifications_registry\b/));

assert("No bank.media_projects access",
  !serverSrc.match(/bank\.media_projects\b/));

// These should exist (v4.0 field names)
assert("bank.user_work_experience used",
  serverSrc.includes("bank.user_work_experience") || serverSrc.includes("latestBank.user_work_experience") || serverSrc.includes(".user_work_experience"));

assert("bank.user_projects used",
  serverSrc.includes(".user_projects"));

assert("bank.user_certifications used",
  serverSrc.includes(".user_certifications"));

assert("work_id used in pinned lookups",
  serverSrc.includes("work_id"));

assert("project_id used in pinned lookups",
  serverSrc.includes("project_id"));

assert("job_title used in document builder",
  serverSrc.includes("job_title"));

assert("responsibilities used in document builder",
  serverSrc.includes("responsibilities"));

assert("project_name used in document builder",
  serverSrc.includes("project_name"));

// ── SECTION 2: JSON schema check ────────────────────────────────────────────
console.log("\n▶ 2. skill_data_bank.json schema integrity");
const bank = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "skill_data_bank.json"), "utf-8"));

assert("Version is 4.0", bank.version === "4.0", `got: ${bank.version}`);

assert("user_skills exists and non-empty",
  Array.isArray(bank.user_skills) && bank.user_skills.length > 0,
  `length: ${bank.user_skills?.length}`);

assert("user_projects exists and non-empty",
  Array.isArray(bank.user_projects) && bank.user_projects.length > 0,
  `length: ${bank.user_projects?.length}`);

assert("user_work_experience exists and non-empty",
  Array.isArray(bank.user_work_experience) && bank.user_work_experience.length > 0,
  `length: ${bank.user_work_experience?.length}`);

assert("user_certifications exists",
  Array.isArray(bank.user_certifications) && bank.user_certifications.length > 0,
  `length: ${bank.user_certifications?.length}`);

assert("skill_project junction exists",
  Array.isArray(bank.skill_project) && bank.skill_project.length > 0,
  `junctions: ${bank.skill_project?.length}`);

assert("skill_work junction exists",
  Array.isArray(bank.skill_work) && bank.skill_work.length > 0,
  `junctions: ${bank.skill_work?.length}`);

// Sample first records for correct field names
const s0 = bank.user_skills[0];
assert("skill has skill_id field",        !!s0.skill_id,    `got keys: ${Object.keys(s0).join(",")}`);
assert("skill has skill_name field",      !!s0.skill_name);
assert("skill has description field",     !!s0.description);
assert("skill does NOT have old 'skill' field", s0.skill === undefined);
assert("skill does NOT have old 'evidence' field", s0.evidence === undefined);

const p0 = bank.user_projects[0];
assert("project has project_id field",   !!p0.project_id,  `got keys: ${Object.keys(p0).join(",")}`);
assert("project has project_name field", !!p0.project_name);
assert("project does NOT have old 'name' field", p0.name === undefined);

const w0 = bank.user_work_experience[0];
assert("work has work_id field",       !!w0.work_id,   `got keys: ${Object.keys(w0).join(",")}`);
assert("work has job_title field",     !!w0.job_title);
assert("work has responsibilities",    Array.isArray(w0.responsibilities));
assert("work does NOT have old 'title' field",   w0.title   === undefined);
assert("work does NOT have old 'bullets' field",  w0.bullets === undefined);

const c0 = bank.user_certifications[0];
assert("cert has cert_id field",  !!c0.cert_id,  `got keys: ${Object.keys(c0).join(",")}`);
assert("cert has title field",    !!c0.title);

// ── SECTION 3: Live API tests ────────────────────────────────────────────────
console.log("\n▶ 3. Live API tests (server must be running on :3000)");

async function runApiTests() {
try {
  // 3a. Health
  const health = await get("/health");
  assert("/health responds", health.status === "ok", JSON.stringify(health).slice(0, 80));
  assert("/health shows correct skill count",
    health.skillChunks === bank.user_skills.length,
    `got ${health.skillChunks}, expected ${bank.user_skills.length}`);

  // 3b. /skill-bank
  const sb = await get("/skill-bank");
  assert("/skill-bank success", sb.success === true);
  assert("/skill-bank returns user_skills",
    Array.isArray(sb.user_skills) && sb.user_skills.length > 0,
    `length: ${sb.user_skills?.length}`);
  assert("/skill-bank returns user_projects",
    Array.isArray(sb.user_projects) && sb.user_projects.length > 0,
    `length: ${sb.user_projects?.length}`);
  assert("/skill-bank returns user_work_experience",
    Array.isArray(sb.user_work_experience) && sb.user_work_experience.length > 0,
    `length: ${sb.user_work_experience?.length}`);
  assert("/skill-bank skill has skill_id",
    sb.user_skills[0]?.skill_id !== undefined);
  assert("/skill-bank project has project_id",
    sb.user_projects[0]?.project_id !== undefined);
  assert("/skill-bank work has work_id",
    sb.user_work_experience[0]?.work_id !== undefined);

  // 3c. /cv-selector-data
  const jd = "SAP BTP developer Node.js working student position";
  const sel = await post("/cv-selector-data", { jdText: jd });
  assert("/cv-selector-data success", sel.success === true, sel.error || "");
  assert("/cv-selector-data has work_experience",
    Array.isArray(sel.work_experience) && sel.work_experience.length > 0,
    `length: ${sel.work_experience?.length}`);
  assert("/cv-selector-data has projects",
    Array.isArray(sel.projects) && sel.projects.length > 0,
    `length: ${sel.projects?.length}`);

  // Work items must have id field (set from work_id)
  const we0 = sel.work_experience[0];
  assert("/cv-selector-data work item has id (from work_id)",
    !!we0?.id, `keys: ${Object.keys(we0||{}).join(",")}`);
  assert("/cv-selector-data work item has title (from job_title)",
    !!we0?.title, `got: ${we0?.title}`);

  // Project items must have id field (set from project_id)
  const pr0 = sel.projects[0];
  assert("/cv-selector-data project item has id (from project_id)",
    !!pr0?.id, `keys: ${Object.keys(pr0||{}).join(",")}`);
  assert("/cv-selector-data project item has name (from project_name)",
    !!pr0?.name, `got: ${pr0?.name}`);

  // 3d. aiPickWE / aiPickProjects are valid IDs
  assert("/cv-selector-data aiPickWE contains valid work IDs",
    (sel.aiPickWE || []).every(id => id.startsWith("WE")),
    `got: ${JSON.stringify(sel.aiPickWE)}`);
  assert("/cv-selector-data aiPickProjects contains valid project IDs",
    (sel.aiPickProjects || []).every(id => id.startsWith("PJ") || id.startsWith("MPJ")),
    `got: ${JSON.stringify(sel.aiPickProjects)}`);

  // 3e. /skill-bank/search
  const search = await get("/skill-bank/search?q=sap+btp");
  assert("/skill-bank/search success", search.success === true);
  assert("/skill-bank/search returns results", search.results.length > 0, `got ${search.results.length}`);
  assert("/skill-bank/search result has skill_id or id",
    search.results[0]?.id !== undefined);

} catch (e) {
  console.log(`  ${FAIL} API test crashed: ${e.message}`);
  console.log("       Is the server running? (node server.js)");
  failures++;
}
} // end runApiTests

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════════");
runApiTests().then(() => {
  if (failures === 0) {
    console.log(` \x1b[32m ALL TESTS PASSED\x1b[0m — v4.0 migration is clean`);
  } else {
    console.log(` \x1b[31m ${failures} TEST(S) FAILED — fixes required\x1b[0m`);
  }
  console.log("═══════════════════════════════════════════════════\n");
  process.exit(failures > 0 ? 1 : 0);
});
