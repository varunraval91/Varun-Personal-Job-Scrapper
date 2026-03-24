# PROMPT\_ADD\_MEDIA\_PROJECTS

I need to add a `media_projects` section to my project database. These projects are separate from SAP technical projects and must be grouped into:

1. **SAP Media Projects** (`sap_media`) — projects completed at SAP
2. **Creative Media Projects** (`creative_media`) — projects completed before/outside SAP

## Required schema

```JSON
{
  "id": "MPJ001",
  "title": "Project Title",
  "sub_category": "SAP_Client_Film | SAP_Video_Series | SAP_Event_Production | SAP_Studio_Production | UX_App_Design | Graphic_Design | Illustration | TV_Commercial | Documentary | Music_Video | E_Learning | Corporate_Film | Brand_Campaign",
  "tech": "Tools used",
  "date": "Date or range",
  "client": "Client name if applicable",
  "description": "2-4 sentence context and outcome",
  "responsibilities": ["Role 1", "Role 2"],
  "impact": "One sentence outcome",
  "phase": "SAP_Professional | Creative_Production | Design",
  "source_refs": ["WE001", "PJ_IX_PORTFOLIO"]
}
```

## Rules

* IDs are sequential `MPJ001..MPJ027`
* `MPJ001..MPJ011` belong to SAP Media
* `MPJ012..MPJ027` belong to Creative Media
* Keep technical projects (`PJ001+`) as separate existing projects
* Keep `sub_category` for CV Selector filtering

## UI requirement (CV Selector → Projects tab)

Add sub-filters:

* `All Projects` (default)
* `SAP & Technical`
* `SAP Media`
* `Creative Media`

When `All Projects` is active, show grouped sections in this order:

1. SAP & Technical
2. SAP Media
3. Creative Media

## Source data

Use [data/media\_projects\_bank.json](data/media_projects_bank.json) as the source of truth for MPJ001–MPJ027.
