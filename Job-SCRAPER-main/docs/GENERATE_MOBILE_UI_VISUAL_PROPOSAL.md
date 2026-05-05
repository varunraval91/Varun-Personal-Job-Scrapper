# Generate Tab Mobile UI Proposal (No Horizontal Scroll)

Date: 2026-04-24
Target: iPhone mobile widths only
Scope: Generate tab including JD analysis + CV/CL editing

## 1) Problem Summary

Current mobile pain points:
- Horizontal scroll appears inside JD analysis blocks.
- Skill coverage and requirement rows use table-like layouts that overflow narrow screens.
- CV/CL toolbars have too many inline controls for one row.
- Result action buttons and badges compete for width.

Primary rule for this proposal:
- No horizontal drag required to read or complete Generate flow on mobile.

## 2) Mobile Information Architecture

Generate on mobile should read top-to-bottom in one content lane:

```text
+----------------------------------+
| Task Header (active job)         |
| role + req id + match chip       |
+----------------------------------+
| JD Analysis (accordion)          |
| summary + must/nice/skills/tools |
| skill coverage bars              |
+----------------------------------+
| CV Panel                         |
| toolbar wraps to multiple rows   |
| editor textarea full width       |
+----------------------------------+
| Cover Letter Panel               |
| toolbar wraps to multiple rows   |
| editor textarea full width       |
+----------------------------------+
| Action Stack                     |
| Applied / Wishlist / Export /    |
| DACH check in 1-column buttons   |
+----------------------------------+
```

## 3) Visual Wireframes

### A) Generate Workspace (Mobile)

```text
+----------------------------------+
| Generate                         |
| [Task 02] SAP ... (66% match)    |
| Req 451961 · Walldorf            |
+----------------------------------+
| JD Analysis                      |
| [GOOD FIT] 6 matches · avg 52%   |
|----------------------------------|
| What you'll do                   |
| - item                           |
| - item                           |
|----------------------------------|
| Requirements                     |
| Must: [chip] [chip]              |
| Nice: [chip] [chip]              |
| Skills: [chip] [chip]            |
| Tools: [chip] [chip]             |
|----------------------------------|
| Skill Bank Coverage              |
| SK054 Accessibility              |
| [======------] 29%               |
| SK099 Instructional Design       |
| [=====-------] 23%               |
+----------------------------------+
```

### B) CV Editor (Mobile)

```text
+----------------------------------+
| CV                               |
| [regen] [A-] [A+] [copy] [full] |
| [clear]                          |
|----------------------------------|
| textarea                         |
| full-width, no side clipping     |
| min-height ~ 240px               |
+----------------------------------+
```

### C) Cover Letter Editor (Mobile)

```text
+----------------------------------+
| Cover Letter                     |
| [regen] [A-] [A+] [copy] [full] |
| [clear] [bold]                   |
|----------------------------------|
| textarea                         |
| full-width, no side clipping     |
| min-height ~ 240px               |
+----------------------------------+
```

### D) Action Region (Mobile)

```text
+----------------------------------+
| [Mark Applied]                   |
| [Wishlist]                       |
| [Export CV]                      |
| [Export CL]                      |
| [DACH Check]                     |
+----------------------------------+
```

## 4) Mobile Behavior Rules

- All Generate surfaces use width 100% of content lane.
- No table-style row alignment in JD coverage on mobile.
- Chips wrap naturally; no forced single-line chip rows.
- Toolbars wrap and keep controls tappable (min-height 40-44px).
- Textareas keep full width and `box-sizing: border-box`.
- Action buttons stack to one column on narrow widths.
- Apply only under mobile breakpoints; desktop unchanged.

## 5) Implementation Mapping (Mobile-Only)

Planned files:
- css/iphone-overrides.css

Planned selector groups:
- `#generateView .gqi-jd-*` (analysis section)
- `#generateView .gqi-match-*` (coverage rows)
- `#generateView .gqi-panel-toolbar`, `.gen-panel-controls`
- `#generateView .gqi-result-actions`, `.gqi-result-actions-secondary`
- `#generateView .gqi-result-textarea`

## 6) Acceptance Criteria

- No horizontal scrollbar in Generate screen at iPhone widths.
- JD analysis fully readable without side-scroll.
- CV and CL editors fully usable with wrapped controls.
- Export and status actions accessible in one thumb lane.
- Desktop layout untouched.
