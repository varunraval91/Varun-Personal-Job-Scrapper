# Skill Data Bank Rebuild — Claude Session Plan

## Current Problems (Audit Results)

| Problem                         | Count      | Example                                                         |
| ------------------------------- | ---------- | --------------------------------------------------------------- |
| Paragraph evidence (50+ words)  | 45 skills  | SK041: 57 words of dense text                                   |
| Weak evidence (3-7 words)       | 4 skills   | SK087: "using in my profestional workin ana analytics"          |
| Duplicate skills                | \~8 pairs  | Git×2, JavaScript×2, MS Excel×2, Figma×2, HTML/CSS×2, Node.js×2 |
| Domain\_Professional overloaded | 37 items   | Mix of actual skills, tools, and domain knowledge               |
| Tools\_Platforms underloaded    | 9 items    | Many tools mis-categorized under other categories               |
| Typos in evidence               | Several    | "profestional workin ana analytics"                             |
| Only 3/14 CVs OCR'd             | 11 missing | No cover letters OCR'd                                          |

## What We Need From Claude

Claude will process ALL your source documents and produce a **clean, deduplicated, standardized** `skill_data_bank.json` with:

* **Every tool/skill extracted** from documents with proper evidence
* **Consistent evidence**: 15-25 words per skill, factual, third-person
* **No duplicates**: One entry per distinct skill/tool
* **Proper categorization**: 7 categories, correct assignments
* **type field**: `"tool"` vs `"skill"` distinction

## Schema (What Claude Must Output)

Each skill chunk:

```JSON
{
  "id": "SK001",
  "type": "tool",           // NEW: "tool" | "skill"  
  "category": "SAP_Technical",
  "skill": "SAP BTP",
  "level": "Intermediate",  // Beginner | Intermediate | Advanced | Expert
  "evidence": "Built CAP Node.js OData V4 service. Configured BTP environment, API routing, OData wrappers. M.Sc. coursework module.",
  "phase": "SAP_Masters",   // CS_Foundations | Design | Creative_Production | SAP_Professional | SAP_Masters
  "source_refs": ["WE001", "PJ002", "EDU001"]  // NEW: which WE/PJ/EDU mentioned this
}
```

### Type Definitions

* **tool**: Something you open/install/run on a computer. Software, platform, framework, language.
  * Examples: Figma, SAP BTP, Python, DaVinci Resolve, Excel, Node.js, Git, HANA
* **skill**: A capability, methodology, or domain expertise. Not tied to one software.
  * Examples: Video Editing, UX Research, Analytics, Communication, Agile, Design Thinking

### Categories (Keep existing 7)

| Category             | For                                          |
| -------------------- | -------------------------------------------- |
| SAP\_Technical       | SAP-specific tools & skills                  |
| Engineering\_Dev     | Programming languages, frameworks, dev tools |
| Data\_Analytics      | Data analysis, BI, ETL, statistics           |
| Design\_UX           | Design tools & UX methodology                |
| Creative\_Media      | Video/photo/audio production tools & skills  |
| Tools\_Platforms     | General software, office tools, platforms    |
| Domain\_Professional | Soft skills, methodologies, domain knowledge |

***

## Step-by-Step Plan (3 Claude Sessions)

### Pre-work (You do this first)

1. Run the prep script: `node scripts/prepare_claude_input.js`
2. This creates `generated/claude_input_part1.txt` and `generated/claude_input_part2.txt`
3. Also OCR your remaining CVs/CLs if possible (or skip — we have 3 OCR'd + full DB already)

***

### Session 1: Extract & Categorize (Main work)

**Token budget**: \~80K input, \~15K output

**What to upload/paste**:

* `generated/claude_input_part1.txt` (profile, education, work experience, projects, OCR'd CVs)
* The system prompt below

**Expected output**: Complete `skill_chunks` array (JSON)

***

### Session 2: Evidence Review & Gap Fill

**Token budget**: \~30K input, \~8K output

**What to upload/paste**:

* `generated/claude_input_part2.txt` (current 125 skills for reference)
* Output from Session 1
* The review prompt below

**Expected output**: Refined `skill_chunks` array with fixes

***

### Session 3: Final Assembly (Quick)

**Token budget**: \~10K input, \~3K output

**What to paste**:

* Refined skill\_chunks from Session 2
* Quick validation prompt

**Expected output**: Final validated JSON ready to drop into `data/skill_data_bank.json`

***

## Prompts

### SESSION 1 PROMPT (Copy this exactly)

```
You are a career data engineer. I will give you ALL source documents for one person's career. Your ONLY task: extract every distinct tool and skill into a standardized JSON array.

RULES:
1. Output ONLY valid JSON array. No commentary, no markdown, no explanation.
2. Each entry = one atomic tool or one atomic skill (never combine two tools into one entry).
3. Evidence must be 15-25 words, factual, third-person, citing specific projects/roles/deliverables.
4. No duplicates — if "JavaScript" appears in 5 documents, ONE entry with consolidated evidence.
5. Assign type: "tool" (software/platform/language you install/open/run) or "skill" (capability/methodology).
6. ID format: SK001, SK002, ... sequential.
7. Level: Beginner (mentioned/basic use) | Intermediate (used in projects) | Advanced (professional/recurring use) | Expert (deep, taught others).
8. Phase = most recent career phase where this was actively used.

CATEGORIES (assign exactly one):
- SAP_Technical: SAP-specific (BTP, HANA, UI5, Fiori, S/4HANA, SAC, Signavio, etc.)
- Engineering_Dev: Programming languages, frameworks, dev tools, CI/CD
- Data_Analytics: Data analysis, BI dashboards, ETL, statistics, SQL
- Design_UX: Design tools (Figma, Adobe XD) and UX methods (research, wireframing)
- Creative_Media: Video/photo/audio production, VFX, animation, editing tools
- Tools_Platforms: General software (Office, CMS, CRM), collaboration platforms
- Domain_Professional: Methodologies, soft skills, domain knowledge, communication

PHASES:
- CS_Foundations (2010-2013, B.Eng)
- Design (2015-2018, M.Des)
- Creative_Production (~2018-2023, freelance/production)
- SAP_Professional (Aug 2023 – Mar 2025, SAP Walldorf)
- SAP_Masters (Oct 2025 – present, M.Sc.)

OUTPUT FORMAT (array only, no wrapping):
[
  {
    "id": "SK001",
    "type": "tool",
    "category": "SAP_Technical",
    "skill": "SAP BTP",
    "level": "Intermediate",
    "evidence": "Built CAP Node.js OData V4 service. Configured API routing and BTP environment. M.Sc. coursework module.",
    "phase": "SAP_Masters",
    "source_refs": ["WE001", "EDU001"]
  }
]

Now extract from these documents:
```

*Then paste the content of* *`generated/claude_input_part1.txt`* *below the prompt.*

***

### SESSION 2 PROMPT (Copy this exactly)

```
Review this skill_chunks JSON for quality. I'm also giving you the PREVIOUS version (125 entries) for reference — don't lose any real skill that existed before.

TASKS (output ONLY the corrected JSON array, no commentary):
1. DEDUP: Merge any duplicates (e.g., "JavaScript" + "JavaScript (ES6+)" → one entry).
2. EVIDENCE: Any evidence <15 words or >25 words → rewrite to 15-25 words.
3. TYPOS: Fix any spelling/grammar in evidence strings.
4. GAPS: If the old version had a skill that's missing from new version AND it's legitimate → add it back.
5. LEVEL: Verify levels against evidence — if evidence shows only coursework, max is Intermediate.
6. CATEGORY: Verify assignments — tools in Tool category, SAP stuff in SAP_Technical, etc.
7. RENUMBER: Final IDs must be SK001..SK{N} sequential, no gaps.

Output ONLY the corrected JSON array.

=== NEW VERSION (from Session 1) ===
[paste Session 1 output here]

=== OLD VERSION (125 entries, for reference) ===
[paste content of claude_input_part2.txt here]
```

***

### SESSION 3 PROMPT (Copy this exactly)

```
Validate this skill_chunks array. Check:
1. All IDs sequential SK001..SK{N}
2. No duplicate skills
3. Every evidence is 15-25 words
4. Every type is "tool" or "skill"
5. Every category is one of: SAP_Technical, Engineering_Dev, Data_Analytics, Design_UX, Creative_Media, Tools_Platforms, Domain_Professional
6. Every level is one of: Beginner, Intermediate, Advanced, Expert
7. Every phase is one of: CS_Foundations, Design, Creative_Production, SAP_Professional, SAP_Masters

If ALL checks pass, output: {"status":"valid","count":N}
If ANY check fails, output the corrected array.
```

***

## After Claude: Drop-in Replacement

Once you have the final JSON array from Session 3:

1. Run: `node scripts/apply_claude_output.js` (paste the array when prompted)
2. This will:
   * Back up current `skill_data_bank.json`
   * Replace `skill_chunks` in the file
   * Update `last_updated` timestamp
   * Rebuild vector store
3. Restart server: `node server.js`
4. Hard-refresh browser (Ctrl+F5)

***

## Token Savings Tips

| Tip                                                 | Saves                          |
| --------------------------------------------------- | ------------------------------ |
| "Output ONLY JSON array, no commentary"             | \~2K output tokens             |
| Upload as file attachment (not paste)               | Faster processing              |
| Split into 2 sessions (extract → review)            | Avoids re-processing on errors |
| Don't ask Claude to explain decisions               | \~3K output tokens             |
| Use "No markdown wrapping" instruction              | \~500 tokens                   |
| Paste current skills as reference in Session 2 only | Avoids duplicate context       |

