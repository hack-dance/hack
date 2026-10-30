# Pinned public reference coverage

The public site uses v4.2.4 (`91b14bf0abb17602142425de0d02628a3e8a2615`) and published next.5 (`28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc`). Newer working-next interfaces must not be backported into these docs.

| Surface | v4 | v5 next.5 | Evidence and limits |
| --- | --- | --- | --- |
| Legacy public config schema rows | 85 | 86 | `reference/configuration-fields`; requiredness is relative to object/union variant, with schema pointers. Retired and legacy backend strategy families excluded from the supported table. |
| Managed YAML fields | 7 | 7 | Same page; v4 rejects null, v5 null removes; parser defaults and key/scope constraints explicit. |
| Branch registry fields | 8 | 8 | Same page; CLI-owned metadata, schema/reader differences explicit. |
| MCP registered tools | 10 | 15 | `reference/mcp-fields`; 74/102 per-tool input rows, prompt args, common results, projections and 24 log event/entry field rows per version. Open nested results remain explicit. |
| Authored native schema properties | — | 168 | `reference/authored-schema-fields`: 153 project +15 local; types/refs, containing-object requiredness, defaults and constraints. Shape is not runtime admission. |
| Recursive public command leaves | 84 | 92 | Independent static source audit; 284/335 own option occurrences and 536/611 effective occurrences including global/built-in flags. Parent options are not inherited. The command/output supplement adds all three v4 and six v5 missing leaf sections; generic placeholder differences resolve the apparent flag mismatches. |
| Diagnostic/setup/public report rows | 74 | 296 | 12/63 object variants and 1/22 scalar or collection aliases after excluding the opaque private Plan closure; `reference/diagnostic-reports`. |
| Project/env metadata declarations | 22 | 22 | Version-pinned source declarations plus typed CLI projection tables; `reference/project-env-reports`. |

These are distinct inventories, not an overall completion percentage. A schema row or matching token is not a demonstrated scenario, handler default, client qualification or full nested payload contract.

Doctor diagnostic subtypes, setup target variants, optional provisioning reports, host telemetry, controlled project/meta and env-list/apply projections now have dedicated public field/type references. Engine-provided raw ps rows, application log maps, permissive unknown legacy keys and shared error.detail remain intentionally open. The compiler-owned plan record is opaque at its public CLI boundary; its private producer closure is excluded. Exhaustive effective handler/config fallback semantics and runtime/client qualification remain separate work. Internal daemon/guest/provider/compiler transports, retired hosted account/team/dashboard/Tickets surfaces, and unsupported gateway/node/dispatch are not promoted to public APIs. Cloud/provider executions and actual agent client loading were not performed for this editorial pass.

Source recovery and editorial decisions remain in `content-decisions.md` and `versioned-content.md`; originals under each version are preserved. Audit drafting artifacts are retained under `/tmp/hack-versioned-*-coverage.*` and `/tmp/hack-command-contracts-evidence.md` on the working machine, rather than published as raw notes.
