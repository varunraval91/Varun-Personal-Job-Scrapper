# SAP Job Scraper

Search, filter, and track job listings from the SAP career portal.

## Features

- **Multiple keywords** — search for several terms at once (comma-separated), e.g. `BTP, SAP Analytics Cloud, SAP Datasphere`
- **Career status filter** — Student Job / Internship, Graduate, Professional
- **Location & country** — target specific cities and countries
- **Date filtering** — posted today, last week, 2 weeks, etc.
- **Deduplication** — no duplicate listings across keyword searches
- **Select & track** — pick jobs and generate documents (Gemini AI integration planned)

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
