# iPhone Responsive UX Plan (Non-Disruptive)

Date: 2026-04-24
Project: SAP Job Automator
Goal: Make iPhone UX clean, fast, and touch-friendly without changing desktop behavior or brand direction.

## 1) Design Intent

This plan follows a senior UX retrofit approach:

* Keep existing visual identity, spacing language, and components.
* Apply iPhone fixes only inside mobile breakpoints.
* Avoid desktop regressions by isolating overrides in a dedicated mobile layer.
* Improve usability first (readability, tap targets, flow), then polish.

## 2) Current Issue Map (Observed)

Primary friction on iPhone:

* Multi-column layouts still force crowded horizontal patterns.
* Dense filter bars and data tables are hard to scan and tap.
* Hidden desktop sidebar removes navigation context on mobile.
* Generate flow has side panel patterns that need single-column stacking.
* Some elements retain minimum widths that create layout pressure.

## 3) iPhone Experience Blueprint (Drawing)

Current mobile mental model (approx):

```
+--------------------------------------+
| Topbar (title + actions)             |
+--------------------------------------+
| Dense filter row (many inputs)       |
+--------------------------------------+
| Wide table (horizontal scroll)       |
+--------------------------------------+
| No persistent mobile nav             |
+--------------------------------------+
```

Target iPhone model (proposed):

```
+--------------------------------------+
| Compact sticky topbar                |
| Title + primary action               |
+--------------------------------------+
| Quick chips: Portal, Date, Sort      |
| Filter button opens bottom sheet     |
+--------------------------------------+
| Content stack (single column cards)  |
| Search cards / Generate cards / etc. |
+--------------------------------------+
| Sticky bottom tab bar                |
| Search | Generate | Tracker | Skills |
+--------------------------------------+
```

Screen flow drawing:

```
Search tab
   |
   +--> Filter Sheet (modal bottom sheet)
   |       |
   |       +--> Apply filters
   |
   +--> Results list (job cards)
           |
           +--> Select jobs
                   |
                   +--> Generate tab
                           |
                           +--> Task cards + progress
                                   |
                                   +--> Export / Apply
```

## 4) Non-Disruptive Technical Strategy

Implementation boundary:

* Desktop untouched above 900px.
* iPhone-specific rules at 900px and below, with tighter tuning at 640px and 430px.

Safe layering strategy:

1. Add a new stylesheet loaded last: css/iphone-overrides.css
2. Put all new mobile behavior there.
3. Keep existing files mostly unchanged, except tiny hooks if absolutely needed.

Why this is safe:

* Predictable cascade control.
* Easy rollback.
* Clear separation of desktop and iPhone responsibilities.

## 5) Planned UI Changes by Area

### A) Global Navigation

* Introduce a bottom mobile tab bar for key views.
* Keep desktop sidebar as-is.
* Add active state and safe-area padding for iPhone home indicator.

### B) Search View

* Convert filter row into compact chips + bottom-sheet filters.
* Keep result table for desktop; use card list rendering style on iPhone.
* Increase tap target sizes to at least 44px height.

### C) Generate View

* Force one-column layout for task sidebar and workspace.
* Keep progress context visible near the top.
* Move high-priority actions to sticky action strip when needed.

### D) Tracker / Kanban

* Keep column concept but change to horizontal snap lanes or stage sections.
* Ensure cards are readable without zoom.
* Preserve statuses and color semantics.

### E) Skill Bank

* Keep desktop table.
* On iPhone, present row data as stacked cards with key-value pairs.
* Keep quick actions visible and thumb-friendly.

### F) Popups and Drawers

* Convert right-floating popups into full-height bottom sheets on iPhone.
* Enforce max-height and internal scroll for long content.

## 6) File-Level Execution Plan

Primary files involved:

* index.html (mobile nav container and optional filter-sheet trigger hooks)
* css/redesign.css (existing responsive baseline)
* css/automator.css (generate flow and advanced panels)
* css/skill-bank.css (table-heavy mobile conversion)
* new: css/iphone-overrides.css (all targeted iPhone refinements)

Rule of engagement:

* New mobile rules override, not rewrite.
* No broad refactor of desktop selectors.

## 7) Delivery Phases

Phase 1: Foundation and Nav

* Add mobile bottom nav.
* Normalize global spacing and tap targets.
* Lock horizontal overflow issues.

Phase 2: Search and Generate

* Mobile filter sheet.
* Search results card mode.
* Generate single-column workflow optimization.

Phase 3: Tracker and Skill Bank

* Mobile card/lane readability pass.
* Table-to-card adaptation for Skill Bank.
* Final visual polish and motion tuning.

## 8) iPhone QA Matrix

Devices and viewports:

* iPhone 15 / 14 Pro width class (393px)
* iPhone 12/13/14 width class (390px)
* iPhone SE width class (375px)

Validation checks:

* No horizontal page overflow.
* All critical actions reachable by thumb.
* Main task flow completed without pinch-zoom.
* Landscape still usable for dense tables.
* Light and dark themes both pass readability.

## 9) Acceptance Criteria

Success means:

* iPhone layout feels intentional, not compressed desktop.
* Desktop UI remains visually unchanged.
* Core flow Search -> Select -> Generate -> Track remains fast.
* No blocked interactions caused by modals, sticky bars, or keyboard.

## 10) Next Step

Upon approval, implementation starts with Phase 1 in a dedicated mobile override stylesheet and minimal HTML hooks.
