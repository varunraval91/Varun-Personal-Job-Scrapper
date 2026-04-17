# SAP Job Automator — Complete Project Documentation

### Version 1.0 · March 2026 · Developer Reference

***

## TABLE OF CONTENTS

1. [What This Project Is](#1-what-this-project-is)
2. [System Architecture](#2-system-architecture)
3. [Tech Stack](#3-tech-stack)
4. [File & Folder Structure](#4-file--folder-structure)
5. [The 4-Section UI](#5-the-4-section-ui)
6. [Backend API Endpoints](#6-backend-api-endpoints)
7. [The Living Library — Core Concept](#7-the-living-library--core-concept)
8. [Data Models](#8-data-models)
9. [Firebase Architecture](#9-firebase-architecture)
10. [Feature Walkthroughs](#10-feature-walkthroughs)
11. [Security Design](#11-security-design)
12. [Known Constraints & Design Decisions](#12-known-constraints--design-decisions)
13. [Environment Setup](#13-environment-setup)
14. [Glossary](#14-glossary)

***

## 1. WHAT THIS PROJECT IS

A personal AI-powered job application system that:

1. **Scrapes** SAP career portal for job listings matching your filters
2. **Generates** tailored CVs and cover letters using your personal document library + Gemini AI
3. **Tracks** every application through a Kanban pipeline (Wishlist → Offer)
4. **Learns** which document styles get interviews and improves over time

This is NOT a generic tool. It is built for one user (Varun Raval) applying to SAP/German-market positions, with personal LaTeX templates, personal writing style, and personal career data baked in.

### The Core Idea: Personal Knowledge Graph with Feedback Loop

```
YOUR 35 REAL DOCUMENTS (foundation)
         ↓
    AI reads them to learn YOUR voice, YOUR style, YOUR skills
         ↓
    Job posted on SAP portal → system scrapes full job description
         ↓
    AI generates CV + Cover Letter in YOUR style, tailored to THIS job
         ↓
    You review, edit, approve → document saved to your growing library
         ↓
    Months later: "Got interview?" → system learns what worked
         ↓
    Next generation is smarter because it knows what succeeded
```

The system gets better every time you use it. Your 2027 applications will draw on everything you learned in 2026.

***

## 2. SYSTEM ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER (Frontend)                           │
│                                                                     │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ Section 1 │  │ Section 2  │  │ Section 3  │  │ Section 4        │ │
│  │  SEARCH   │  │ GENERATE   │  │ ANALYTICS  │  │ TRACKER (Kanban) │ │
│  │           │  │            │  │            │  │                  │ │
│  │ Filters → │  │ Select job │  │ Charts,    │  │ 6-stage pipeline │ │
│  │ Results   │  │ → AI gen   │  │ insights,  │  │ Drag-drop cards  │ │
│  │ table     │  │ → Review   │  │ outcomes   │  │ + outcome feed-  │ │
│  │           │  │ → PDF      │  │            │  │   back buttons   │ │
│  └─────┬─────┘  └─────┬──────┘  └─────┬──────┘  └────────┬─────────┘ │
│        │              │              │                  │           │
│        └──────────────┴──────────────┴──────────────────┘           │
│                              │                                      │
│                    Firebase SDK (client)                             │
│                    ├── Auth (email/password)                         │
│                    ├── Firestore (applications, library, JD cache)   │
│                    └── Offline persistence                           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                     HTTP API calls
                               │
┌──────────────────────────────┴──────────────────────────────────────┐
│                     EXPRESS SERVER (Backend)                         │
│                     Port 3000                                       │
│                                                                     │
│  Endpoints:                                                         │
│  ├── POST /scrape        → Playwright scrapes SAP search results    │
│  ├── POST /fetch-jd      → Playwright scrapes full job description  │
│  ├── POST /generate      → Gemini AI generates CV + Cover Letter    │
│  ├── POST /export-pdf    → Playwright renders HTML → PDF            │
│  ├── POST /index-library → pdf-parse reads foundation PDFs          │
│  └── GET  /              → serves the frontend (index.html + assets)│
│                                                                     │
│  Shared Resources:                                                  │
│  ├── Playwright browser instance (reused, not per-request)          │
│  ├── Gemini AI client (initialized once with API key)               │
│  └── Library index cache (in-memory copy of foundation text)        │
└─────────────────────────────────────────────────────────────────────┘
```

### Why This Split?

| Concern               | Runs Where           | Why                                                                                            |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| **Scraping**          | Server (Playwright)  | SAP blocks client-side requests (CORS). Playwright needs a real browser.                       |
| **AI Generation**     | Server (Gemini API)  | API key must stay on server — never exposed to browser.                                        |
| **PDF Export**        | Server (Playwright)  | Browser can't generate styled PDFs reliably. Playwright renders HTML → PDF with exact control. |
| **PDF Parsing**       | Server (pdf-parse)   | Browser can't read files from disk. Server reads your foundation PDFs at startup.              |
| **Auth & Data**       | Client (Firebase)    | Firebase SDK handles auth + Firestore directly from browser. No server middleware needed.      |
| **UI & Interactions** | Client (HTML/CSS/JS) | Everything visual runs in the browser.                                                         |

***

## 3. TECH STACK

### Backend

| Technology                | Version | Purpose                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| **Node.js**               | 18+     | JavaScript runtime                                                   |
| **Express**               | 5.x     | HTTP server, API routing, static file serving                        |
| **Playwright**            | 1.58+   | Headless Chromium: scraping SAP portal, fetching JDs, rendering PDFs |
| **@google/generative-ai** | 0.24+   | Gemini API client for CV/CL generation                               |
| **pdf-parse**             | 1.1+    | Extract text from foundation PDF documents                           |
| **dotenv**                | 17+     | Load .env variables (API keys)                                       |
| **cors**                  | 2.8+    | Cross-origin headers                                                 |

### Frontend

| Technology         | Source             | Purpose                                |
| ------------------ | ------------------ | -------------------------------------- |
| **HTML/CSS/JS**    | Custom             | Single-page app, no framework          |
| **Firebase SDK**   | CDN v9.22 (compat) | Auth + Firestore + offline persistence |
| **Chart.js**       | CDN 4.4            | Analytics charts (bar, doughnut)       |
| **SheetJS (xlsx)** | CDN 0.18           | CSV/XLSX import/export                 |
| **Google Fonts**   | CDN                | Cabinet Grotesk + Instrument Sans      |

### External Services

| Service                | Plan                   | Purpose                                            |
| ---------------------- | ---------------------- | -------------------------------------------------- |
| **Google Gemini API**  | Free tier (15 req/min) | AI text generation                                 |
| **Firebase Auth**      | Spark (free)           | Email/password authentication                      |
| **Firebase Firestore** | Spark (free)           | Cloud database for applications, library, JD cache |

***

## 4. FILE & FOLDER STRUCTURE

```
Job-SCRAPER-main/
│
├── .env                                  # Gemini API key + config (gitignored)
├── .gitignore                            # Ignores secrets, PDFs, generated files
├── package.json                          # Dependencies and scripts
├── server.js                             # Express backend — ALL server endpoints
│
├── index.html                            # Main app HTML (single-page)
├── firebase-config.local.js              # Firebase credentials (gitignored)
│
├── css/                                  # Stylesheets (from tracker, adapted)
│   ├── styles.css                        # Base design system + tokens
│   ├── redesign.css                      # UI polish layer
│   └── auth-screen-styles.css            # Login screen styles
│
├── js/                                   # Frontend JavaScript
│   ├── app.js                            # Main app logic (tracker + new sections)
│   ├── auth.js                           # Firebase authentication
│   ├── firebase-config.js                # Firebase init + Firestore CRUD API
│   └── generate.js                       # NEW: Generation UI logic
│
├── library/                              # Personal document library
│   ├── foundation/                       # YOUR original documents (Layer 1)
│   │   ├── cvs/                          # 14 CV PDFs
│   │   │   ├── CV_Data_Analyst_Varun.pdf
│   │   │   ├── Varun Raval_SAP_Analytics.pdf
│   │   │   └── ... (14 files)
│   │   ├── cover_letters/                # 21 Cover Letter PDFs
│   │   │   ├── Cover Letter_Data Analyst_Varun Raval.pdf
│   │   │   ├── Varun Raval Cover Letter_442053.pdf
│   │   │   └── ... (21 files)
│   │   └── README.md                     # Instructions
│   │
│   ├── templates/                        # LaTeX style references
│   │   ├── cv_style_guide.tex            # CV visual style
│   │   └── cover_letter_template.tex     # CL visual style
│   │
│   └── approved/                         # Approved generations (Layer 2)
│       └── (auto-populated over time)
│
├── generated/                            # Output PDFs (gitignored)
│   └── (PDFs saved here per generation)
│
└── data/                                 # Local data cache
    └── (backup exports, etc.)
```

***

## 5. THE 4-SECTION UI

The app has 4 main sections, accessed via sidebar navigation:

### Section 1: SEARCH (Job Scraping)

**Purpose:** Find jobs on SAP career portal.

**What the user sees:**

* Keyword input (comma-separated for multiple: "BTP, SAP Analytics Cloud")
* Location input (e.g., "Walldorf" or blank for all Germany)
* Career status dropdown: Student / Graduate / Professional
* Country dropdown: Germany / Austria / Switzerland
* Posted-within dropdown: Today / 1 Week / 2 Weeks / 3 Weeks / 1 Month / Any
* "Search Jobs" button with loading spinner

**What happens behind the scenes:**

1. Frontend sends POST to `/scrape` with all filter values
2. Server launches Playwright → navigates to jobs.sap.com/search
3. Fills in search form fields, clicks Submit
4. Scrapes all job rows from results page
5. For each job: visits detail page to get exact posted date + location + req ID
6. Filters by date period
7. Returns deduplicated results to frontend

**Results table columns:**
\| Select | Job Title | Keyword | Req ID | Location | Posted | Link |

**Key action:** Checkboxes let user select jobs → selected jobs appear in Section 2 for generation AND can be pushed to Section 4 (Tracker) as Wishlist items.

***

### Section 2: GENERATE (AI Document Generation)

**Purpose:** Generate tailored CV and cover letter for a selected job.

**What the user sees:**

* List of selected jobs (from Section 1 or Section 4)
* For each job: "Generate CV + Cover Letter" button
* After generation:
  * Editable text preview (left: CV, right: Cover Letter)
  * AI Decision Log (what samples were used, why certain skills highlighted)
  * Three action buttons: ✅ Approve & Save | 📝 Save Draft | ❌ Discard
  * "Export PDF" button (only after content is finalized)

**What happens behind the scenes (the generation pipeline):**

```
Step 1: FETCH JOB DESCRIPTION
────────────────────────────
POST /fetch-jd { url: "https://jobs.sap.com/job/..." }
→ Playwright opens the job page
→ Extracts: full description, requirements, responsibilities, team info
→ Caches to Firebase: users/{uid}/cached_jds/{reqId}
→ Returns full JD text

Step 2: SMART SELECTOR (picks best context for AI)
──────────────────────────────────────────────────
Analyzes the JD to determine:
  - Domain: analytics / operations / BTP / management / etc.
  - Required skills: ["Python", "SAP BTP", "data analysis"]
  - Experience level: working student / intern / full-time

Then selects from your library:
  - 1-2 foundation CVs closest to this domain
  - 1-2 foundation CLs closest to this domain
  - 0-2 approved generations with highest weight in this domain
  - Domain insights (if any): "analytics roles respond better to Python skills"

Selection strategy:
  Priority 1: Approved docs that got interviews in same domain
  Priority 2: Foundation docs tagged for this domain
  Priority 3: General/best-rated foundation docs
  Maximum: 5 documents total (quality over quantity)

Step 3: GEMINI GENERATES
────────────────────────
POST /generate {
  jobDescription: "full JD text...",
  selectedSamples: [ ... texts of 3-5 selected docs ... ],
  domainInsights: { bestSkills: [...], avoidPatterns: [...] },
  documentType: "cv" | "cover_letter",
  templateStructure: "from LaTeX template"
}

Gemini receives a carefully constructed prompt:
  SYSTEM: "You are a CV/CL writer. Follow these rules exactly..."
  CONTEXT: Your selected library samples
  TEMPLATE: The section structure from your LaTeX template
  JOB: The full job description
  INSTRUCTIONS: "Generate a CV/CL that..."

Returns: structured text matching your template sections.

Step 4: USER REVIEWS & EDITS
────────────────────────────
- Text displayed in editable text areas
- User makes 2-3 human edits (fixes wording, adds personal touch)
- This is critical: the EDITED version is what gets saved,
  preventing AI voice pollution

Step 5: USER DECIDES
────────────────────
✅ Approve & Save:
   → Edited text saved to Firebase: users/{uid}/library/approved/{genId}
   → Tagged with: domain, knowledge level, date, requisition ID
   → Weight set to 1.0 (neutral — will be adjusted by outcomes later)
   → PDF generated and saved to generated/ folder
   → Tracker card (if exists) status updated to "CV Generated"

📝 Save Draft:
   → Text saved locally in sessionStorage
   → NOT added to library (doesn't influence future generations)
   → User can come back and finalize later

❌ Discard:
   → Nothing saved
   → Generation attempt logged (for analytics: "generated but discarded")

Step 6: PDF EXPORT
──────────────────
POST /export-pdf { content: "...", type: "cv" | "cover_letter" }
→ Server builds HTML page styled exactly like your LaTeX template
→ CV: matches cv_style_guide.tex (colors #111/#333/#666, sections, bullets)
→ CL: matches cover_letter_template.tex (margins, spacing, centered title)
→ Playwright opens the HTML, calls page.pdf()
→ Returns PDF binary → saved to generated/ folder + Downloads
```

***

### Section 3: ANALYTICS (Dashboard & Insights)

**Purpose:** Visualize your application pipeline and document performance.

**What the user sees:**

* **Stats cards:** Total applications, Response rate, Active pipeline, Offers
* **Pipeline chart:** Bar chart showing count per stage (Wishlist → Offer)
* **Outcome chart:** Doughnut showing Interview/Rejected/Offer distribution
* **Domain insights:** "Your analytics CVs get 2x more interviews than operations CVs"
* **Filter sidebar:** Date range, stage, company, keyword
* **Data table:** All applications with sortable columns
* **Export button:** Download filtered data as CSV

**Where the data comes from:**

* Application data: Firebase `users/{uid}/applications/`
* Library performance: Firebase `users/{uid}/library/insights/`
* Generation history: Firebase `users/{uid}/library/approved/`

**Analytics calculated:**

| Metric                 | Formula                                                 |
| ---------------------- | ------------------------------------------------------- |
| Response Rate          | (Interview + Offer) / Total Applied × 100               |
| Offer Rate             | Offer / Total Applied × 100                             |
| Domain Performance     | interviews\_in\_domain / generations\_in\_domain × 100  |
| Best Skills per Domain | Skills from highest-weight approved docs                |
| Avoid Patterns         | Skills from lowest-weight docs (rejections/no response) |

***

### Section 4: TRACKER (Kanban Board)

**Purpose:** Track every application through its lifecycle.

**What the user sees:**

* 6-column Kanban board:

```
┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│ Wishlist │ Applied  │ OA/Test  │ Interview│ Rejected │  Offer   │
│          │          │          │          │          │          │
│  Card    │  Card    │  Card    │  Card    │  Card    │  Card    │
│  Card    │  Card    │          │          │          │          │
│  Card    │          │          │          │          │          │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
```

* Each card shows: Company, Role, Location, Deadline, Urgency color
* Drag-and-drop between columns
* Click card to edit details
* Search bar + Stage filter chips + Company shortcut buttons
* Sort by: Deadline / Date added / Company / Fit rating
* Weekly goal widget with progress bar
* "New Application" button (manual entry or paste URL for auto-fill)

**The Outcome Feedback Bridge (NEW):**

When a card moves to **Interview**, **Rejected**, or **Offer**, the system prompts:

```
┌──────────────────────────────────────────────────────┐
│  📊 Outcome Feedback                                  │
│                                                       │
│  You moved "Working Student - Analytics" to Interview │
│                                                       │
│  Did you use an AI-generated CV for this application? │
│                                                       │
│  [Yes — from generation G001]  [No — used manual CV]  │
│  [Skip]                                               │
│                                                       │
│  If Yes → Library weight for G001 increases            │
│  If Rejected later → weight decreases                  │
│  This data improves future generations.               │
└──────────────────────────────────────────────────────┘
```

This closes the feedback loop. The tracker feeds performance data back into the library, making future generations smarter.

***

## 6. BACKEND API ENDPOINTS

### POST /scrape

**Purpose:** Search SAP career portal for job listings.

| Field        | Type   | Required | Example    |
| ------------ | ------ | -------- | ---------- |
| keyword      | string | Yes      | "BTP"      |
| location     | string | No       | "Walldorf" |
| country      | string | Yes      | "DE"       |
| careerStatus | string | Yes      | "Student"  |
| period       | string | Yes      | "1week"    |

**Response:** `{ success: true, jobs: [...] }`

**How it works:**

1. Launches shared Playwright browser page
2. Navigates to `https://jobs.sap.com/search/`
3. Fills keyword, location, selects career status & country
4. Clicks submit, waits for results
5. Parses each result row: title, URL, date, location
6. Opens each job's detail page for exact posted date + req ID
7. Filters by period (today, 1week, 2weeks, etc.)
8. Returns deduplicated array

***

### POST /fetch-jd

**Purpose:** Fetch full job description from a SAP job detail page.

| Field | Type   | Required | Example                                                   |
| ----- | ------ | -------- | --------------------------------------------------------- |
| url   | string | Yes      | "<https://jobs.sap.com/job/walldorf/working-student/>..." |

**Response:** `{ success: true, jd: { title, fullText, requirements, responsibilities, location, department } }`

**How it works:**

1. Opens URL in Playwright page
2. Extracts:
   * Job title from `h1` or `[data-careersite-propertyid="title"]`
   * Full description from job content area
   * Requirements/qualifications section
   * Location, department, posted date
3. Cleans HTML tags, normalizes whitespace
4. Returns structured JD object

**Why this matters:** Job descriptions disappear from SAP portal after HR finalizes candidates. By fetching and caching immediately, the user always has the JD available — even months later before an interview.

***

### POST /generate

**Purpose:** Generate a CV or cover letter using Gemini AI.

| Field           | Type   | Required | Example                       |
| --------------- | ------ | -------- | ----------------------------- |
| jobDescription  | string | Yes      | "Full JD text..."             |
| documentType    | string | Yes      | "cv" or "cover\_letter"       |
| selectedSamples | array  | Yes      | \[{text, type, weight}...]    |
| domainInsights  | object | No       | {bestSkills: \[...]}          |
| userEdits       | string | No       | Previous draft for refinement |

**Response:** `{ success: true, content: "generated text...", decisions: { samplesUsed: [...], skillsHighlighted: [...], reasoning: "..." } }`

**How it works:**

1. Constructs a prompt with:
   * System instructions (role, style rules, template structure)
   * Selected library samples as context
   * The full job description
   * Domain insights (if available)
   * Template structure from LaTeX files
2. Calls Gemini API (`gemini-2.0-flash`)
3. Parses response into sections matching the template
4. Returns content + AI decision metadata

**Prompt structure (simplified):**

```
SYSTEM:
You are writing a CV for Varun Raval. Follow these rules:
- Match the EXACT section structure provided in the template
- Use the voice and tone from the provided foundation samples
- Highlight skills that match the job requirements
- Do NOT invent experiences. Only use what appears in the samples.
- Keep to 1 page (CV) or 1 page (cover letter)

TEMPLATE STRUCTURE:
[Extracted from cv_style_guide.tex / cover_letter_template.tex]

FOUNDATION SAMPLES (your real documents — learn the voice):
[2-3 most relevant foundation docs]

APPROVED HIGH-PERFORMERS (these styles got interviews):
[0-2 approved generations with high weight]

DOMAIN INSIGHT:
[e.g., "Analytics roles respond better to Python and data viz skills"]

JOB DESCRIPTION:
[Full JD text]

GENERATE:
A complete CV in the exact template structure, tailored to this job.
```

**Rate limiting:** Minimum 4-second gap between API calls. Queue concurrent requests.

***

### POST /export-pdf

**Purpose:** Render finalized content as a styled PDF.

| Field    | Type   | Required | Example                            |
| -------- | ------ | -------- | ---------------------------------- |
| content  | string | Yes      | "The CV/CL text content"           |
| type     | string | Yes      | "cv" or "cover\_letter"            |
| filename | string | No       | "Varun\_Raval\_CV\_SAP\_Analytics" |

**Response:** PDF binary file (Content-Type: application/pdf)

**How it works:**

1. Takes the user's finalized text content
2. Wraps it in an HTML page styled to match the LaTeX template:
   * **CV:** Replicates cv\_style\_guide.tex — colors (#111, #333, #666, #003366), fonts (Latin Modern → system serif), margins (1.8cm), section format, bullet style
   * **CL:** Replicates cover\_letter\_template.tex — wider margins (2.8cm), centered title, justified paragraphs, 1.15× line height
3. Opens HTML in Playwright headless browser
4. Calls `page.pdf({ format: 'A4', printBackground: true })`
5. Saves to `generated/` folder AND returns as download

***

### POST /index-library

**Purpose:** Parse foundation PDFs and return extraction results.

| Field  | Type | Required | Example |
| ------ | ---- | -------- | ------- |
| (none) | —    | —        | —       |

**Response:** `{ success: true, indexed: [{ filename, type, charCount, preview }...], errors: [...] }`

**How it works:**

1. Reads all PDFs from `library/foundation/cvs/` and `library/foundation/cover_letters/`
2. Uses `pdf-parse` to extract text from each
3. Returns extraction report with character counts
4. Frontend displays: "✓ file.pdf — 2,340 chars" or "⚠ file.pdf — 0 chars"
5. Extracted text is cached in memory for generation use
6. Text is also sent to Firebase for cloud persistence

***

## 7. THE LIVING LIBRARY — CORE CONCEPT

This is the heart of the system. Understanding it deeply is essential.

### Three Layers

```
LAYER 1: FOUNDATION (immutable)
════════════════════════════════
Your 35 original PDFs. These NEVER change. They represent your
authentic writing voice and real experiences at this point in time.

Purpose: Voice anchor. The AI always has your real tone to reference.
Storage: Text extracted from PDFs → Firebase users/{uid}/library/foundation/
Count: 14 CVs + 21 cover letters = 35 documents
Locked: true — cannot be modified or deleted through the UI

LAYER 2: APPROVED GENERATIONS (grows over time)
════════════════════════════════════════════════
Every CV/CL you generate, edit, and click "Approve" on.
Each one is tagged with metadata for future retrieval.

Purpose: Evolving repertoire. Your improving document library.
Storage: Firebase users/{uid}/library/approved/
Tags: domain, knowledgeLevel, skills, date, requisitionId, outcome
Weight: Starts at 1.0. Adjusted by outcomes (+0.5 for interview, -0.3 for rejection)

LAYER 3: OUTCOME MEMORY (domain insights)
═════════════════════════════════════════
Aggregated performance data per domain.
Not individual documents — statistical patterns.

Purpose: Intelligence. "Analytics CVs with Python get interviews."
Storage: Firebase users/{uid}/library/insights/{domain}
Updated: Automatically when user reports an outcome in the tracker
Structure: {
  domain: "analytics",
  bestPerformingSkills: ["Python", "SAP BTP", "data visualization"],
  avoidPatterns: ["generic communication skills"],
  interviewRate: 0.4,
  totalGenerated: 5,
  totalInterviews: 2
}
```

### The Smart Selector Algorithm

When generating a document, the system picks the best samples:

```
INPUT: Job description + domain + required skills

STEP 1: Classify the JD
  → domain: "analytics" (from keywords: data, dashboard, metrics)
  → level: "working_student" (from title/requirements)
  → skills: ["Python", "SAP Analytics Cloud", "data modeling"]

STEP 2: Score each library document
  For each doc in (foundation + approved):
    score = 0
    if doc.domain == jd.domain:        score += 3
    if doc.level == jd.level:          score += 2
    for each skill in jd.skills:
      if skill in doc.text:            score += 1
    score *= doc.weight                  (approved docs with high weight get boosted)

STEP 3: Select top documents
  - Pick top 2 foundation docs (1 CV + 1 CL minimum — voice anchor)
  - Pick top 2 approved docs (if any exist with score > threshold)
  - Include domain insights for the matched domain
  - Maximum 5 documents total

STEP 4: Return selected context for Gemini prompt
```

### The Feedback Loop

```
GENERATE → APPROVE → TRACK → OUTCOME → LEARN → GENERATE BETTER

Month 1: Generate CV for analytics role → Approve → Apply
Month 2: Got interview! → Mark in tracker → System learns:
  "Generation G001 for analytics domain got an interview"
  → G001 weight: 1.0 → 1.5
  → Domain insight updated: analytics.interviewRate improved
Month 3: Generate CV for another analytics role →
  Smart Selector now PRIORITIZES G001 as context
  → New generation inherits the style that worked
```

### Anti-Pollution Rule

**CRITICAL:** Only HUMAN-EDITED, APPROVED documents enter Layer 2.

```
BAD (what we prevent):
  AI generates → auto-saved → AI reads own output → generates → ...
  → After 6 months, everything sounds like AI, not like you

GOOD (what we enforce):
  AI generates → YOU edit → YOU approve → saved with YOUR edits
  → Your human voice is baked into every approved document
  → AI learns from you, not from itself
```

***

## 8. DATA MODELS

### Job (from scraping)

```JavaScript
{
  title: "Working Student (f/m/d) - Revenue Operations",
  url: "https://jobs.sap.com/job/walldorf/working-student-revenue-ops/...",
  date: "March 4",               // display format
  rawDate: "Mar 4, 2026",        // original for filtering
  location: "Walldorf",
  requisitionId: "1372686533",
  keyword: "BTP",                // which search keyword found this
  status: "Not Started"
}
```

### Application (tracker card)

```JavaScript
{
  id: "a1b2c3d4-...",            // crypto.randomUUID()
  company: "SAP",
  role: "Working Student - Revenue Operations",
  link: "https://jobs.sap.com/job/...",
  location: "Walldorf",
  reqId: "1372686533",
  postingDate: "2026-03-04",
  stage: "Wishlist",             // Wishlist|Applied|OA/Test|Interview|Rejected|Offer
  deadline: "2026-03-20",        // self-imposed
  contactType: "HR",
  contactName: "",
  notes: "",
  generationId: null,            // links to library approved doc if AI-generated CV used
  createdAt: "2026-03-12T...",
  updatedAt: "2026-03-12T..."    // Firestore server timestamp
}
```

### Foundation Document (library Layer 1)

```JavaScript
{
  id: "f001",
  filename: "Varun Raval_SAP_Analytics.pdf",
  type: "cv",                    // "cv" | "cover_letter"
  text: "extracted text content...",
  charCount: 2340,
  domain: "analytics",           // auto-detected, user can override
  tags: ["SAP", "Python", "data analysis"],
  indexedAt: "2026-03-12T...",
  locked: true                   // foundation docs are immutable
}
```

### Approved Generation (library Layer 2)

```JavaScript
{
  id: "g001",
  type: "cv",                    // "cv" | "cover_letter"
  text: "the approved, human-edited content...",
  jobTitle: "Working Student - Revenue Operations",
  company: "SAP",
  requisitionId: "1372686533",
  domain: "business_operations",
  knowledgeLevel: "masters_year1",
  skillsHighlighted: ["Excel", "CRM basics", "process thinking"],
  generatedAt: "2026-03-12T...",
  approvedAt: "2026-03-12T...",
  outcome: null,                 // null | "interview" | "rejected" | "no_response" | "offer"
  outcomeDate: null,
  weight: 1.0,                   // adjusted by outcomes: +0.5 interview, -0.3 rejection
  samplesUsed: ["f003", "f012"]  // which foundation docs informed this generation
}
```

### Cached Job Description

```JavaScript
{
  id: "1372686533",              // requisition ID
  title: "Working Student (f/m/d) - Revenue Operations",
  url: "https://jobs.sap.com/job/...",
  fullText: "complete job description text...",
  requirements: "...",
  responsibilities: "...",
  department: "Revenue Operations",
  location: "Walldorf, Germany",
  cachedAt: "2026-03-12T...",
  company: "SAP"
}
```

### Domain Insight (library Layer 3)

```JavaScript
{
  domain: "analytics",
  bestPerformingSkills: ["Python", "SAP BTP", "data visualization"],
  avoidPatterns: ["generic communication"],
  interviewRate: 0.4,
  totalGenerated: 5,
  totalInterviews: 2,
  totalRejections: 1,
  totalNoResponse: 2,
  lastUpdated: "2026-06-15T..."
}
```

***

## 9. FIREBASE ARCHITECTURE

### Firestore Collections

```
users/
└── {userId}/
    │
    ├── (document: user settings)
    │   { settings: { theme: "dark", weeklyGoal: 10 } }
    │
    ├── applications/              (existing from tracker)
    │   ├── {appId_1}
    │   ├── {appId_2}
    │   └── ...
    │
    ├── library/                   (NEW)
    │   ├── config                 { foundationIndexedAt, totalFoundation, totalApproved }
    │   ├── foundation/
    │   │   ├── {docId_1}          { filename, type, text, charCount, domain, tags }
    │   │   └── ...
    │   ├── approved/
    │   │   ├── {genId_1}          { type, text, jobTitle, domain, weight, outcome }
    │   │   └── ...
    │   └── insights/
    │       ├── analytics          { bestPerformingSkills, interviewRate, ... }
    │       ├── operations         { bestPerformingSkills, interviewRate, ... }
    │       └── ...
    │
    └── cached_jds/                (NEW)
        ├── {reqId_1}             { title, fullText, cachedAt, ... }
        └── ...
```

### Security Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;

      match /applications/{appId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
      match /library/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
      match /library/{collection}/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
      match /cached_jds/{jdId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

**Why these rules work:** Every document is scoped to `users/{userId}`. Only the authenticated user matching that `userId` can read or write their own data. No one else can see your library, your applications, or your cached JDs.

### Firestore Limits (Spark Plan)

| Resource            | Free Limit | Our Usage           | Safe? |
| ------------------- | ---------- | ------------------- | ----- |
| Document reads      | 50,000/day | \~500/day max       | ✅     |
| Document writes     | 20,000/day | \~100/day max       | ✅     |
| Storage             | 1 GB       | \~50 MB (text only) | ✅     |
| Document size limit | 1 MB       | \~5-10 KB per doc   | ✅     |

***

## 10. FEATURE WALKTHROUGHS

### Walkthrough A: First-Time Setup

```
1. User opens http://localhost:3000
2. Auth screen appears → user signs in with Firebase email/password
3. App loads → detects no library indexed yet
4. Shows "Welcome! Let's index your foundation library."
5. Calls POST /index-library
6. Server reads all 35 PDFs → extracts text → returns report
7. UI shows:
   "✓ Varun Raval_SAP_Analytics.pdf — 2,340 chars"
   "✓ Cover Letter_Data Analyst_Varun Raval.pdf — 1,890 chars"
   ... (35 entries)
8. User confirms → text uploaded to Firebase foundation collection
9. Auto-detection tags each doc with domain:
   "Varun Raval_SAP_Analytics.pdf → domain: analytics"
   "Varun Raval_SAP_BTP_Project_Management.pdf → domain: btp"
10. User can review/override tags (optional)
11. Library indexed. Ready to generate.
```

### Walkthrough B: Search → Generate → Apply

```
1. Section 1: User enters "SAP Analytics Cloud" → clicks Search
2. Server scrapes SAP portal → returns 8 jobs
3. User checks 2 interesting jobs
4. Clicks "Generate" on first job
5. System calls /fetch-jd → gets full JD text → caches to Firebase
6. Smart Selector picks: foundation/cv_analytics + foundation/cl_analytics
7. Calls /generate → Gemini produces CV text
8. UI shows editable CV preview + AI decision log:
   "Used: Varun Raval_SAP_Analytics.pdf (foundation, domain match)"
   "Highlighted: Python, SAP AC, data modeling (matched JD requirements)"
9. User edits 2 sentences, changes a bullet point
10. Clicks "Approve & Save" → saved to Firebase approved collection
11. Clicks "Export PDF" → server renders HTML→PDF → downloaded
12. User adds job to Tracker (Section 4) as "Applied"
13. Later: same flow for cover letter
```

### Walkthrough C: Outcome Feedback Loop

```
1. Two months later: user gets interview call for the analytics role
2. Opens Section 4 (Tracker) → drags card to "Interview" column
3. System detects stage change → shows outcome prompt:
   "Did you use an AI-generated CV? [Yes — G001] [No] [Skip]"
4. User clicks "Yes — G001"
5. System updates:
   - G001.outcome = "interview"
   - G001.weight = 1.0 → 1.5
   - insights/analytics.totalInterviews += 1
   - insights/analytics.interviewRate recalculated
6. Next time user generates for an analytics role:
   - G001 is prioritized by Smart Selector (higher weight)
   - Domain insight says "Python + SAP AC works for analytics"
   - New generation inherits the winning style
```

### Walkthrough D: Viewing a Cached Job Description

```
1. User got an interview call — wants to review the JD
2. Opens Section 4 (Tracker) → clicks the job card
3. Card detail shows "View Job Description" button
4. System looks up Firebase: cached_jds/{reqId}
5. Displays the full JD text as cached when user first selected the job
6. Even if SAP has removed the posting: user still has the full JD
```

***

## 11. SECURITY DESIGN

### Credentials & Secrets

| Secret          | Stored Where               | Protection                                                            |
| --------------- | -------------------------- | --------------------------------------------------------------------- |
| Gemini API key  | `.env` file (server-side)  | gitignored, never sent to browser                                     |
| Firebase config | `firebase-config.local.js` | gitignored, client-side (okay — Firebase security rules protect data) |
| User password   | Firebase Auth              | Handled entirely by Firebase, never touches our code                  |

### XSS Prevention

All dynamic content rendered in the UI uses `escapeHtml()`:

```JavaScript
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

This applies to: job titles, company names, role names, any text from scraping or user input. No `innerHTML` with unsanitized content.

### API Security

* Gemini API key stays on server — browser never sees it
* `/scrape`, `/fetch-jd`, `/generate`, `/export-pdf` are server-only endpoints
* Rate limiting on `/generate`: 4-second minimum gap, queue concurrent requests
* Input validation on all endpoints: reject missing/malformed parameters

### Firestore Security

* Rules enforce: `request.auth.uid == userId` — users can only access their own data
* No public collections, no shared data
* Offline persistence enabled — works without internet, syncs when back online

***

## 12. KNOWN CONSTRAINTS & DESIGN DECISIONS

### Why Playwright for PDFs instead of LaTeX?

| LaTeX (pdflatex)                   | Playwright (HTML → PDF)                        |
| ---------------------------------- | ---------------------------------------------- |
| Pixel-perfect to .tex template     | Very close visual match                        |
| Requires TeX installation (\~2 GB) | Already installed (Playwright is a dependency) |
| Complex to debug                   | Simple HTML/CSS debugging                      |
| Hard to integrate with Node.js     | Native Node.js integration                     |

**Decision:** Use Playwright. The visual difference is negligible. The developer experience is dramatically better.

### Why Firebase instead of local JSON?

| Local JSON                  | Firebase Firestore             |
| --------------------------- | ------------------------------ |
| Works offline immediately   | Works offline with persistence |
| Zero setup                  | Requires Firebase project      |
| Lost if browser/disk clears | Survives everything            |
| Single device only          | Syncs across devices           |
| No auth needed              | Auth required                  |

**Decision:** Firebase. The library is too valuable to risk losing. Cloud persistence is non-negotiable for data that grows over months.

### Why no guest mode?

Guest mode stores data in localStorage → clears when browser resets → entire library lost.
For a system designed to grow over months/years, this is an unacceptable risk.
Firebase-only authentication ensures data is always cloud-backed.

### Why Smart Selector picks only 3-5 docs (not all 35)?

* **Token cost:** 35 docs ≈ 50K tokens per call. 5 docs ≈ 8K tokens. 6× cheaper.
* **Quality:** Gemini performs better with focused, relevant context than with diluted mega-context.
* **Speed:** Smaller context = faster response time.
* **Relevance:** An operations CV sample actively confuses the AI when generating for an analytics role.

### Why cache JDs immediately?

SAP removes job postings after finalizing candidates. This can happen within days.
If user selects a job Monday, generates CV Wednesday, and the posting is gone by Tuesday:

* Without cache: `/fetch-jd` fails → no generation possible
* With cache: JD was saved Monday → generation works perfectly

### Gemini rate limiting (free tier)

15 requests per minute. Each generation = 2 calls (1 for CV, 1 for CL).
Maximum safe throughput: \~7 jobs per minute.
For typical usage (1-3 jobs per session): no issue.
Safety: 4-second gap between API calls + request queue.

***

## 13. ENVIRONMENT SETUP

### Prerequisites

* Node.js 18+
* npm
* A Firebase project with Auth + Firestore enabled
* A Gemini API key

### Installation

```Shell
cd Job-SCRAPER-main
npm install
npx playwright install chromium
```

### Configuration

**.env file:**

```
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-2.0-flash
```

**firebase-config.local.js:** (already created, gitignored)

```JavaScript
window.__FIREBASE_CONFIG__ = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  // ...
};
```

**Firestore rules:** Update in Firebase Console with the rules from Section 9.

### Running

```Shell
npm start
# → Server running at http://localhost:3000
```

***

## 14. GLOSSARY

| Term                    | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **Foundation**          | Your original 35 PDFs. Layer 1. Immutable. Your authentic voice.                      |
| **Approved Generation** | A CV/CL that you generated, edited, and clicked "Approve" on. Layer 2.                |
| **Domain**              | A category of job roles: analytics, operations, BTP, management, etc.                 |
| **Domain Insight**      | Statistical knowledge about what works per domain. Layer 3.                           |
| **Smart Selector**      | Algorithm that picks the 3-5 best library samples for each generation.                |
| **Weight**              | A number (0.5-2.0) on approved docs. Higher = prioritized more. Adjusted by outcomes. |
| **Outcome**             | What happened after applying: interview, rejected, no\_response, offer.               |
| **Feedback Loop**       | Outcome data flows back into the library, improving future generations.               |
| **JD**                  | Job Description — the full text of a job posting.                                     |
| **Voice Pollution**     | When AI repeatedly reads its own output, losing the user's authentic style.           |
| **Context Injection**   | Sending relevant library samples with each Gemini API call (not model training).      |
| **Playwright**          | Headless browser automation. Used for: scraping, JD fetching, PDF rendering.          |
| **Req ID**              | Requisition ID — SAP's unique identifier for each job posting.                        |

***

*Document created: March 12, 2026*
*Project: SAP Job Automator v1.0*
*Developer: Built with Varun Raval*
