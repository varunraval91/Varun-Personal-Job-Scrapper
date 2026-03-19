# SAP Job Automator — Technical Deep Dive (Current State)

Version: March 2026 (post CV-selector + JD skills/tools + data cleanup)

This document explains how the project works today, from request flow to data model to AI pipeline, so you can reason about it confidently and use Claude for deeper analysis/productization.

---

## 1) What this product is (today)

A single-user AI-assisted job-application system that:

1. Scrapes SAP jobs (`/scrape` + Playwright)
2. Fetches and summarizes job descriptions (`/fetch-jd`, `/jd-summary`)
3. Generates CV + cover letter via local RAG + LLM (`/generate`)
4. Lets you manually constrain CV content with a selector (`/cv-selector-data` + Generate UI drawer)
5. Runs DACH-compliance checks and automatic rewrite (`/dach-check`, `/dach-fix`)
6. Exports PDF using LaTeX + `pdflatex` (`/export-pdf`)
7. Tracks pipeline + outcomes in Firebase (Wishlist → Offer)

Core design principle: **personalized generation from your own skill bank and style profile**, not generic web knowledge.

---

## 2) Runtime architecture

## 2.1 Frontend (browser)

Single-page app in `index.html` with JS modules:

- `js/app.js` — app shell, search view, tracker view, analytics view, navigation, state orchestration
- `js/generate.js` — generation queue UI, JD intelligence panel, CV selector drawer, regen/export/human-in-loop actions
- `js/auth.js` — Firebase email auth and auth screen logic
- `js/firebase-config.js` — Firebase adapter API (Auth + Firestore CRUD)

Views:

- Search
- Generate
- Tracker (kanban)
- Analytics

## 2.2 Backend (Node/Express)

`server.js` is the backend monolith:

- Express API server + static file hosting
- Playwright scraping
- LLM provider routing (Claude > Groq > Gemini)
- RAG orchestration
- Prompt engineering
- JSON-to-display conversion
- JSON-to-LaTeX + PDF export
- skill-bank endpoints

## 2.3 Data stores

- `data/skill_data_bank.json` — canonical profile/skills/projects/work/education/history
- `data/vector_store.json` — local TF-IDF vector collections (`skill_chunks`, `projects`, `work_experience`)
- `data/writing_style_profile.json` — style extraction profile used in prompting
- Firebase Firestore — user apps/library/cache/settings
- `library/foundation/*` — raw PDF corpus for indexing/reference

---

## 3) AI provider and model routing

In `server.js`:

- If `ANTHROPIC_API_KEY` exists → Claude path
- else if `GROQ_API_KEY` exists → Groq path
- else if `GEMINI_API_KEY` exists → Gemini path
- else generation endpoints return 503

Throttle guard:

- `AI_MIN_GAP_MS` is provider-specific (`claude: 1000`, `groq: 2000`, `gemini: 4000`)
- enforced before major AI calls

Practical consequence: generation latency and cost are mostly provider-driven, not UI-driven.

---

## 4) Backend API map (current)

`server.js` exposes:

- `POST /scrape` — SAP job list scrape via Playwright
- `POST /fetch-jd` — full JD scrape for one job URL
- `POST /jd-summary` — structured JD summary JSON (`must`, `nice`, `skills`, `tools`, etc.)
- `POST /cv-selector-data` — score all WE/projects for a JD; return AI pre-picks
- `POST /generate` — CV/CL generation with RAG; supports pinned WE/project IDs
- `POST /export-pdf` — LaTeX build + `pdflatex` compile + PDF stream
- `POST /index-library` — PDF indexing with OCR fallback + cache
- `GET /library-index` — indexed doc list
- `GET /health` — provider/vector/style status
- `GET /skill-bank` — full skill bank payload
- `POST /skill-bank/add`
- `POST /skill-bank/update`
- `POST /skill-bank/query`
- `GET /skill-bank/stats`
- `POST /dach-check`
- `POST /dach-fix`
- `POST /humanize`

---

## 5) End-to-end flow (actual)

## 5.1 Search flow

1. UI calls `POST /scrape` with keyword/location/country/status/period
2. Playwright scrapes jobs.sap.com result rows
3. Server enriches with detail-page date/location if needed
4. If vector is ready, server computes quick skill-bank relevance per job title
5. UI renders job table + match badges

## 5.2 Generate flow (queue item)

1. `generate.js` ensures JD text (queue cache → Firebase cache → `/fetch-jd` fallback)
2. UI requests `/generate` for CV
3. Server does local RAG retrieval (`retrieveContext`) from vector store
4. Optional CV selector constraints are applied (`pinnedWeIds`, `pinnedProjectIds`)
5. Prompt (`buildCvSystemPromptRAG`) enforces schema and domain rules
6. LLM returns JSON; server parses and converts to display text
7. Cover-letter generation runs similarly; optional humanizer pass may modify style
8. UI receives:
   - display text
   - parsed JSON
   - decisions (provider/model/chunks)

## 5.3 CV selector flow

1. User clicks `⚙ CV` in a queue item
2. `generate.js` calls `POST /cv-selector-data` with JD text
3. Server scores each `work_experience` and `project` entry (token overlap scoring)
4. Returns full ranked list + top-3 AI picks
5. Drawer lets user override checkboxes
6. On next generation, selected IDs are sent to `/generate`
7. Server injects hard constraints into CV prompt

## 5.4 PDF export flow

1. UI sends generated content JSON/text to `/export-pdf`
2. Server builds `.tex` source using template logic
3. Runs `pdflatex` twice in temp dir
4. Streams PDF and also saves copy to `generated/`

---

## 6) RAG implementation details

`src/local_vector_store.js` implements a Chroma-like local client:

- tokenization + IDF
- TF-IDF vectors
- cosine similarity
- collections persisted to `data/vector_store.json`

`src/rag_engine.js`:

- loads 3 collections: `skill_chunks`, `projects`, `work_experience`
- `retrieveContext(jobText, {topSkills, topProjects, topWork})`
- returns skills with computed `% relevance`

`src/skill_bank_manager.js`:

- source-of-truth writes to `skill_data_bank.json`
- sync add/update to vector store when available
- logs generation usage into `application_history`

Important architectural reality:

- This is **semantic-ish retrieval by TF-IDF**, not embedding vectors from OpenAI/etc.
- Great for low infra cost and local control
- Less robust on paraphrase-heavy JD language

---

## 7) Data model (important for product decisions)

## 7.1 `skill_data_bank.json`

Contains:

- profile block
- education array
- work_experience array
- projects array
- certifications
- skill_chunks array (large evidence corpus)
- strategy/routing metadata and application history

This file is currently the deepest business asset.

## 7.2 `vector_store.json`

Collections and item structure:

- each item: `id`, `document`, `metadata`
- retrieval returns distance-based ranking

## 7.3 `writing_style_profile.json`

Used to steer writing style and anti-patterns. It can strongly influence output quality and drift. Keep it versioned and reviewed.

## 7.4 Firebase (per-user cloud state)

`users/{uid}` tree includes:

- `applications` collection
- `library/foundation/docs`
- `library/approved/docs`
- `library/insights/domains`
- `cached_jds`
- user settings

---

## 8) Prompt system and quality controls

## 8.1 JD summary prompt (`/jd-summary`)

Strict schema JSON includes:

- snapshot
- what_you_do_summary
- must_have
- nice_to_have
- skills
- tools

Post-filter removes obvious non-requirement branding lines.

## 8.2 CV prompt (`buildCvSystemPromptRAG`)

Hard constraints include:

- factual-only from matched data
- strict JSON schema
- education restrictions (no unfinished programs)
- user-selected WE/project inclusion when pinned IDs provided

## 8.3 Humanizer (`src/humanizer.js`)

Second-pass style cleanup to remove obvious AI phrasing without changing factual content.

## 8.4 DACH checks

- `POST /dach-check` returns issue list with severity and suggestion
- `POST /dach-fix` rewrites document to resolve issues while preserving facts

---

## 9) Frontend Generate module internals

`js/generate.js` key capabilities:

- per-job generation state machine (`idle/generating/done/error/...`)
- incremental progress and thought logs
- JD panel with:
  - what-you-do
  - requirements grouped by `Must/Nice/Skills/Tools`
  - skill bank coverage bars
- CV selector drawer with AI-pre-picks + manual override
- per-document toolbars (copy/font/fullview/regen)
- DACH check + fix integration
- scratchpad tabs in localStorage

This module is now feature-rich but large; candidate for decomposition in productization phase.

---

## 10) Security and compliance posture (current)

Current strengths:

- AI keys are server-side
- Firebase auth present (email/password)
- static SPA with server-side generation

Current risks (must fix before selling):

1. No backend auth middleware for API routes (any caller can hit endpoints if server reachable)
2. No tenant isolation on server data paths (single local data context)
3. No usage quota/rate limiting per user
4. No audit logs for generation/export actions
5. Potential prompt/data injection vectors in free-form text flows
6. Local file-based storage model is not multi-tenant ready

---

## 11) Cost drivers (why your build already costs time/money)

Main cost components today:

- LLM tokens (generation + summary + DACH + humanizer)
- Playwright runtime (scraping + PDF rendering)
- Firebase reads/writes/listeners
- Developer maintenance of prompts/data quality

Operational insight:

- Biggest quality gains come from data hygiene and prompt discipline
- Biggest cost spikes come from repeated regenerations and multi-pass AI features

---

## 12) Why the app still feels “student project” (root causes)

Not because core idea is weak — because productization layers are missing:

- monolithic backend + large frontend module
- no formal test suite
- limited observability
- no tenant model
- no billing/plan enforcement
- no service-level boundaries
- no onboarding/wizardized UX for non-technical buyers

---

## 13) Commercialization blueprint (practical)

## Phase 0 — Hardening (2–4 weeks)

- add API auth middleware (Firebase token verification server-side)
- add per-endpoint validation with schema guards
- add request-rate limits per user
- add centralized error logging
- add e2e smoke tests for core paths

Deliverable: stable private beta for trusted users.

## Phase 1 — Multi-tenant core (4–8 weeks)

- move local JSON stores into tenant-aware database tables/collections
- isolate vector index per user/workspace
- attach all generation actions to user IDs
- background job queue for scrape/generate/export

Deliverable: safe shared SaaS alpha.

## Phase 2 — Product packaging (4–6 weeks)

- onboarding wizard (upload CV corpus, style calibration, first generation)
- plans/limits (jobs per month, generations per month, export quotas)
- billing integration
- admin dashboard (usage, failures, quality metrics)

Deliverable: sellable v1.

## Phase 3 — Competitive moat

- quality feedback loop with explicit outcome scoring
- reusable “application memory graph” per role/domain
- benchmarked prompt versions + A/B tested template variants

Deliverable: defensible product, not a feature clone.

---

## 14) Suggested technical refactor targets

1. Split `server.js` into route modules (`routes/generation`, `routes/scrape`, `routes/pdf`, ...)
2. Introduce service layer (`services/ai`, `services/rag`, `services/pdf`)
3. Move prompt templates to versioned files under `prompts/`
4. Break `js/generate.js` into UI components/modules
5. Add TypeScript incrementally for contracts and payload safety

---

## 15) “Use this with Claude” prompt pack

Use these prompts with Claude to deepen understanding and plan product moves.

## Prompt A — architecture review

"Read TECHNICAL_DEEP_DIVE.md and propose a target SaaS architecture for 1,000 active users/month. Include service boundaries, queue design, storage, and migration sequence from current monolith."

## Prompt B — security gap analysis

"Based on TECHNICAL_DEEP_DIVE.md, produce a prioritized security hardening checklist for a pre-launch beta. Group into must-have before first paying user vs can-wait."

## Prompt C — productization sprint plan

"Turn the commercialization blueprint in TECHNICAL_DEEP_DIVE.md into a 6-week execution sprint with deliverables, acceptance criteria, and technical dependencies."

## Prompt D — unit economics

"Using TECHNICAL_DEEP_DIVE.md cost drivers, model expected infra + AI cost per active user for 3 plan tiers (Starter/Pro/Team) and suggest pricing with 70% gross margin target."

---

## 16) Current-state truth summary

- The project has moved beyond a simple scraper and now has real differentiators (RAG + selector + DACH + humanizer + tracker loop).
- It is still architected as a personal power tool, not yet as a secure multi-tenant SaaS.
- The fastest path to revenue is **hardening + tenantization**, not adding more UI features first.

If you want, next step can be a second document: `COMMERCIALIZATION_EXECUTION_PLAN.md` with week-by-week implementation tasks, team roles, and release gates.