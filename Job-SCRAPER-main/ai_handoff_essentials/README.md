# SAP Job Scraper

Search, filter, and track job listings from the SAP career portal.

## Features

- **Multiple keywords** — search for several terms at once (comma-separated), e.g. `BTP, SAP Analytics Cloud, SAP Datasphere`
- **Career status filter** — Student Job / Internship, Graduate, Professional
- **Location & country** — target specific cities and countries
- **Date filtering** — posted today, last week, 2 weeks, etc.
- **Deduplication** — no duplicate listings across keyword searches
- **Select & track** — pick jobs and generate documents (Gemini AI integration planned)

## API Usage (Short Brief)

This project uses a local Express API (`server.js`) as the single backend for the frontend (`index.html` + `js/`).

- **Job intake APIs**: `/scrape`, `/fetch-jd`, `/jd-summary`
- **Document generation APIs**: `/cv-selector-data`, `/generate`, `/export-pdf`
- **Skill bank APIs**: `/skill-bank`, `/skill-bank/add`, `/skill-bank/update`, `/skill-bank/delete`, `/skill-bank/rephrase`, `/skill-bank/suggest`, `/skill-bank/query`, `/skill-bank/stats`
- **Quality and utility APIs**: `/dach-check`, `/dach-fix`, `/humanize`, `/index-library`, `/library-index`, `/health`

External AI APIs are used server-side only (Gemini, Anthropic/Claude, and Groq), so API keys stay in `.env` and are never exposed directly in browser code.

Typical flow: frontend sends JSON request → Express route validates and processes data (scraping, RAG, generation, formatting) → JSON response is returned to the UI.

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

```
server.js    — Express backend + Playwright scraper
index.html   — Frontend UI (served by Express)
package.json — Dependencies and scripts
.gitignore   — Ignores node_modules, .env, data/
```
