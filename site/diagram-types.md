# Diagram types at Pele 1.9.0

All 32 types below rendered in **Pele 1.9.0**, using the site's
[house theme](lib/diagrams/hackdance.css), with links and images disabled.
No tested type needs a newer Pele. This is a small-example compatibility check,
not a claim that every option in the current online examples works at this pin.

[Minimal sources](diagram-examples.json) preserve the exact syntax tested.
Run `bun scripts/docs/audit-diagram-types.ts <existing-evidence-directory>`
with the repository's pinned Bun and installed `site/` dependencies to recreate
the paired SVGs and JSON results. The renderer uses the same `renderDiagram`
function as site preparation; it refuses an installed version other than 1.9.0.

Both themes were visually inspected from SVG geometry and local rasterizations
with the CSS variables resolved to each theme's palette. The rasterizer used a
system sans-serif fallback; browser font metrics and GitHub appearance remain a
separate review. No tested label was clipped or outside its viewBox. The width
column is the intrinsic SVG width in pixels, not a fixed page width. The site
scales diagrams to fit and provides a fullscreen control; wide charts need that
control to keep small labels legible on narrow screens.

| Type | Opening keyword tested | Renders at 1.9.0 | Both themes read well | Width / observation |
| --- | --- | --- | --- | --- |
| Block | `block-beta` | Yes | Yes | 226; clear borders and arrow |
| C4 | `C4Context` | Yes | Yes | 600; actor, boundary and relation readable |
| Class | `classDiagram` | Yes | Yes | 126; vertical relation clear |
| Entity relationship | `erDiagram` | Yes | Yes | 155; cardinality marks readable |
| Event modeling | `eventmodeling` | Yes | Yes | 406; lane labels and event boxes clear |
| Flowchart | `flowchart` | Yes | Yes | 175; vertical control flow clear |
| Gantt | `gantt` | Yes | Yes, at full size | 800; dates become small when scaled down |
| Git graph | `gitGraph` | Yes | Yes | 186; branch labels and commit IDs readable |
| Kanban | `kanban` | Yes | Yes | 460; columns and cards clear |
| Mindmap | `mindmap` | Yes | Yes | 356; branch text readable |
| Packet | `packet-beta` | Yes | Yes, at full size | 1067; very wide even with two fields |
| Pie | `pie` | Yes | Yes | 389; percentages and legend readable |
| Quadrant chart | `quadrantChart` | Yes | Yes | 500; axes and point label readable |
| Requirement | `requirementDiagram` | Yes | Yes | 173; relation and properties clear |
| Sankey | `sankey-beta` | Yes | Yes | 648; values and flow bands readable |
| Sequence | `sequenceDiagram` | Yes | Yes | 231; messages and step numbers clear |
| State | `stateDiagram-v2` | Yes | Yes | 138; transitions and initial state clear |
| Timeline | `timeline` | Yes | Yes | 636; short event text stays inside boxes |
| User journey | `journey` | Yes | Yes | 372; scores and actor legend readable |
| XY chart | `xychart-beta` | Yes | Yes | 700; grid is faint, axis text readable |
| Agentflow | `agentflow-beta` | Yes | Yes | 260; task/tool shapes and flow boundary clear |
| Architecture | `architecture-beta` | Yes | Yes | 136; group and service labels clear; 1.9.0 rejects class/classDef syntax, so the README generator tags its curated nodes with house classes after rendering |
| Cynefin | `cynefin-beta` | Yes | Yes | 688; domain text and sample cards readable |
| Ishikawa | `ishikawa-beta` | Yes | Yes | 332; cause text and spine clear |
| Radar | `radar-beta` | Yes | Yes | 498; grid is faint, axis text readable |
| Railroad | `railroad-ebnf-beta` | Yes | Yes | 338; optional branch and terminals clear |
| Swimlane | `swimlane-beta` | Yes | Yes | 387; headers, cells and cross-lane arrow clear |
| Tree view | `treeView-beta` | Yes | Yes | 207; filenames and hierarchy clear |
| Treemap | `treemap-beta` | Yes | Yes | 688; values and enclosing label readable |
| Use case | `usecase-beta` | Yes | Yes | 384; actor and system boundary clear |
| Venn | `venn-beta` | Yes | Yes | 375; intersection text readable |
| Wardley map | `wardley-beta` | Yes | Yes, at full size | 877; axis and component labels shrink on narrow screens |

These fixtures use synthetic chart values and generic entities. They are syntax
probes, not measurements, domain models or claims about Hack. Built-in diagram
palettes follow the house CSS variables; authored semantic state colours use only
`live`, `wait`, `ok`, `fail` and `idle`. Avoid custom fills and stroke colours.

Choose a type for the question it answers. In particular, a journey chart includes
numeric satisfaction scores, so it cannot describe a first-run workflow without
inventing data; use a flowchart there. A quadrant cannot express backend
eligibility without inventing axes; use a decision flowchart. Gantt, kanban, pie,
packet, radar, Cynefin, Venn and Wardley diagrams have no supported user-facing
mechanism or measured dataset to explain in the current docs. Rendering support
alone is not a reason to publish them.
