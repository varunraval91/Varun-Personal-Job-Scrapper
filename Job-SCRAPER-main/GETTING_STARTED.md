# Getting Started — SAP Job Automator

This is a skeleton of the project. All features are intact; you supply your own credentials, CVs, and skill data.

***

## What you need before starting

| Requirement                                         | Where to get it             | Cost                  |
| --------------------------------------------------- | --------------------------- | --------------------- |
| **AI API key** (one of three options)               | See Step 4                  | Free tiers available  |
| **Firebase project**                                | console.firebase.google.com | Free Spark plan works |
| **Node.js 18+**                                     | nodejs.org                  | Free                  |
| **Your CV(s) as PDF**                               | Export from Word/Canva/etc. | —                     |
| **Cover letters as PDF** (optional but recommended) | Your existing letters       | —                     |

***

## Step 1 — Clone and install

```Shell
git clone <repo-url>
cd Job-SCRAPER-main
npm install
npx playwright install chromium
```

***

## Step 2 — Run the setup script

This creates all required directories and empty data files:

```Shell
node scripts/setup.js
```

You will see `data/`, `library/foundation/cvs/`, `library/foundation/cover_letters/`, and other folders created automatically.

***

## Step 3 — Upload your personal documents

* Copy your **CV PDF(s)** into `library/foundation/cvs/`
* Copy your **cover letter PDFs** (if you have any) into `library/foundation/cover_letters/`

These files are gitignored — they never leave your machine.

> **Tip:** The more cover letters you provide, the better the AI learns your writing style. Even 2–3 is enough to start.

***

## Step 4 — Get an AI API key

You only need **one** of these:

### Option A — Google Gemini (Recommended for free start)

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Sign in with Google → click **Get API key**
3. Copy the key (starts with `AIza...`)

### Option B — Groq (Free, fast)

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up → API Keys → Create key
3. Copy the key (starts with `gsk_...`)

### Option C — Claude / Anthropic (Best quality, paid)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Add credits (\~\$5 minimum) → API Keys → Create key
3. Copy the key (starts with `sk-ant-...`)

***

## Step 5 — Configure your environment

```Shell
cp .env.example .env
```

Open `.env` and uncomment the block for the API provider you chose:

```env
# Example for Gemini:
GEMINI_API_KEY=AIzaSy...your-key-here
GEMINI_MODEL=gemini-2.0-flash
```

***

## Step 6 — Set up Firebase

The app uses Firebase for authentication and storing your job applications in the cloud.

### 6a — Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → give it any name → Continue
3. Disable Google Analytics if you don't need it → **Create project**

### 6b — Enable Authentication

1. In your project → **Build** → **Authentication** → **Get started**
2. Under **Sign-in method** → Enable **Email/Password**

### 6c — Enable Firestore

1. **Build** → **Firestore Database** → **Create database**
2. Choose **Start in test mode** (you can add rules later)
3. Pick any region → **Enable**

### 6d — Get your config keys

1. Click the gear icon (**Project settings**) → scroll to **Your apps**
2. Click the **\</>** (web) icon → register a name → **Register app**
3. Copy the `firebaseConfig` object shown

### 6e — Paste into the project

Open `js/firebase-config.js` and replace the placeholder block at the top:

```JavaScript
const defaultFirebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",          // ← paste values here
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};
```

> Do the same for `ai_handoff_essentials/js/firebase-config.js` if you use that module.

***

## Step 7 — Generate your writing style profile

If you added cover letter PDFs in Step 3, run:

```Shell
node scripts/extract_style.js
```

This reads your letters, detects your tone and patterns, and saves `data/writing_style_profile.json`. The AI uses this to write in your voice. Skip this step if you have no cover letters — the AI will use a neutral style.

***

## Step 8 — Start the app

```Shell
npm start
```

Open <http://localhost:3000> in your browser.

***

## Step 9 — Build your Skill Bank

The Skill Bank is the core of the AI's document generation. Without it, the AI has no material to pull from.

1. Click the **Skill Bank** tab in the app
2. Add your skills one by one:
   * **Skill name** — e.g. "Python", "SAP BTP", "Project Management"
   * **Category** — pick from the dropdown
   * **Level** — Beginner / Intermediate / Advanced
   * **Evidence** — one sentence describing where/how you used this skill
3. Add as many as you have — 20+ gives good results, 50+ is great

You can also add:

* **Projects** — side projects, university work, freelance
* **Work experience** — past jobs with responsibilities
* **Certifications**

All of this is stored locally in `data/skill_data_bank.json` (gitignored, only on your machine).

***

## Step 10 — Scrape jobs and generate documents

1. Go to the **Scraper** tab → enter keywords (e.g. `SAP BTP, Internship`) → click **Scrape**
2. Select a job from results → click **Generate CV + Cover Letter**
3. The AI matches your skills to the job and writes tailored documents
4. Download or copy the output

***

## Data files (all gitignored, all local)

| File                                | What it contains                  | How it gets created              |
| ----------------------------------- | --------------------------------- | -------------------------------- |
| `data/skill_data_bank.json`         | Your skills, projects, experience | Via Skill Bank UI or `setup.js`  |
| `data/writing_style_profile.json`   | Your writing patterns             | `node scripts/extract_style.js`  |
| `data/vector_store.json`            | TF-IDF index of your skills       | Auto-updated when you add skills |
| `data/job_tracker_by_company.json`  | Your application history          | Auto-updated by the app          |
| `library/foundation/cvs/`           | Your CV PDFs                      | You add manually                 |
| `library/foundation/cover_letters/` | Your cover letter PDFs            | You add manually                 |

***

## Troubleshooting

**App starts but AI generation fails**

* Check `.env` has a valid API key with no extra spaces
* Gemini/Groq: verify the key works at their respective consoles

**Firebase errors on login**

* Confirm Email/Password auth is enabled in Firebase console
* Double-check all 7 values in `firebase-config.js` are pasted correctly

**Playwright / scraper errors**

* Run `npx playwright install chromium` again
* On Linux: `npx playwright install-deps`

**`data/skill_data_bank.json`** **not found**

* Run `node scripts/setup.js` again

***

## Project structure (quick reference)

```
server.js                   — Express backend + Playwright scraper
index.html                  — Main UI
js/
  app.js                    — Frontend logic
  auth.js                   — Firebase auth
  firebase-config.js        — Firebase credentials (you fill this in)
  generate.js               — Document generation UI
  skill-bank.js             — Skill Bank UI
src/
  skill_bank_manager.js     — Skill Bank CRUD
  local_vector_store.js     — TF-IDF RAG engine
  humanizer.js              — Writing style post-processor
scripts/
  setup.js                  — First-time setup (run once)
  extract_style.js          — Generates writing style profile from your cover letters
data/                       — Your personal data (gitignored, local only)
library/foundation/         — Your CV and cover letter PDFs (gitignored, local only)
```

