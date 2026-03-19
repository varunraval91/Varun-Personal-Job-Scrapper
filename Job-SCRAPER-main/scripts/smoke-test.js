/**
 * Smoke Test Script — Investor Demo Readiness
 *
 * Tests critical endpoints to verify the server is healthy
 * and the main pipeline is reachable.
 *
 * Usage:
 *   1. Start the server:  node server.js
 *   2. Run this script:   node smoke-test.js
 *
 * Optional env:
 *   BASE_URL  — server origin (default: http://localhost:3000)
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const results = [];

async function jsonPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function jsonGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  return { status: res.status, data };
}

function record(name, passed, detail) {
  const tag = passed ? "PASS" : "FAIL";
  results.push({ name, passed, detail });
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}

// ───────────────────────────── Tests ─────────────────────────────

async function testHealth() {
  try {
    const { status, data } = await jsonGet("/health");
    const ok = status === 200 && data.status === "ok";
    record("/health", ok, `status=${data.status}, ai=${data.aiProvider}, browser=${data.browserUp}`);
  } catch (e) {
    record("/health", false, e.message);
  }
}

async function testSkillBank() {
  try {
    const { status, data } = await jsonGet("/skill-bank");
    const ok = status === 200 && data.success !== false;
    record("/skill-bank", ok, `chunks=${data.skill_chunks?.length ?? "?"}`);
  } catch (e) {
    record("/skill-bank", false, e.message);
  }
}

async function testSkillBankStats() {
  try {
    const { status, data } = await jsonGet("/skill-bank/stats");
    const ok = status === 200;
    record("/skill-bank/stats", ok, `total=${data.totalChunks ?? "?"}, categories=${data.categories ?? "?"}`);
  } catch (e) {
    record("/skill-bank/stats", false, e.message);
  }
}

async function testJdSummary() {
  // Sends a minimal JD text — should respond even if AI is slow
  try {
    const { status, data } = await jsonPost("/jd-summary", {
      jdText: "Software Engineer at SAP, Walldorf. Must know Java, Spring Boot, SQL. Nice to have: Kubernetes, CI/CD.",
    });
    const ok = status === 200 && data.summary;
    record("/jd-summary", ok, ok ? `summary length=${data.summary.length}` : JSON.stringify(data).slice(0, 120));
  } catch (e) {
    record("/jd-summary", false, e.message);
  }
}

async function testDachCheck() {
  try {
    const sampleCV = "I am a software engineer with 5 years of experience in Java and Spring Boot. I have a Bachelor's degree in Computer Science.";
    const { status, data } = await jsonPost("/dach-check", { text: sampleCV, docType: "cv" });
    const ok = status === 200;
    record("/dach-check", ok, ok ? `issues=${data.issues?.length ?? 0}` : JSON.stringify(data).slice(0, 120));
  } catch (e) {
    record("/dach-check", false, e.message);
  }
}

async function testGenerateEndpoint() {
  // Minimal payload — we expect a 200 or a meaningful error (not 500)
  try {
    const { status, data } = await jsonPost("/generate", {
      jdText: "Software Engineer at SAP, Walldorf. Must know Java, Spring Boot.",
      selectedCVs: [],
      docType: "cv",
    });
    // Even if it rejects due to missing CVs, a non-500 response is ok
    const ok = status < 500;
    record("/generate (reachable)", ok, `status=${status}`);
  } catch (e) {
    record("/generate (reachable)", false, e.message);
  }
}

async function testExportPdf() {
  // Send minimal LaTeX to /export-pdf — expect either 200 (PDF) or 4xx (missing deps)
  try {
    const res = await fetch(`${BASE_URL}/export-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latex: "\\documentclass{article}\\begin{document}Hello\\end{document}" }),
    });
    const ok = res.status < 500;
    record("/export-pdf (reachable)", ok, `status=${res.status}`);
  } catch (e) {
    record("/export-pdf (reachable)", false, e.message);
  }
}

async function testLibraryIndex() {
  try {
    const { status, data } = await jsonGet("/library-index");
    const ok = status === 200 && data.success === true;
    record("/library-index", ok, `documents=${data.documents?.length ?? "?"}`);
  } catch (e) {
    record("/library-index", false, e.message);
  }
}

// ───────────────────────────── Runner ─────────────────────────────

async function run() {
  console.log(`\n🔬  Smoke Tests — ${BASE_URL}\n`);

  await testHealth();
  await testSkillBank();
  await testSkillBankStats();
  await testLibraryIndex();
  await testJdSummary();
  await testDachCheck();
  await testGenerateEndpoint();
  await testExportPdf();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\n─────────────────────────────`);
  console.log(`  Total: ${results.length}  |  Passed: ${passed}  |  Failed: ${failed}`);
  console.log(`─────────────────────────────\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
