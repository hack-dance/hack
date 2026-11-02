# Historical public reference coverage

V4 remains at v4.2.4. Current v5 is released next.6 (`44aaf5156426dfcbb1c8a189b8e20531e5b95613`); its generated CLI and runtime support snapshots are refreshed. The table below records the prior next.5 field audit only, not next.6 totals. See the published next.6 release-contract page for changed APIs. Exhaustive next.6 nested-field and diagnostic reconciliation remains open.

| Surface | v4 | v5 next.5 | Evidence and limits |
| --- | --- | --- | --- |
| Legacy public config schema rows | 85 | 86 | `reference/configuration-fields`; requiredness is relative to object/union variant, with schema pointers. Retired and legacy backend strategy families excluded from the supported table. |
| Managed YAML fields | 7 | 7 | Same page; v4 rejects null, v5 null removes; parser defaults and key/scope constraints explicit. |
| Branch registry fields | 8 | 8 | Same page; CLI-owned metadata, schema/reader differences explicit. |
| MCP registered tools | 10 | 15 | `reference/mcp-fields`; 74/102 per-tool input rows, prompt args, common results, projections and 24 log event/entry field rows per version. Open nested results remain explicit. |
| Authored native schema properties | — | 168 | `reference/authored-schema-fields`: 153 project +15 local; types/refs, containing-object requiredness, defaults and constraints. Shape is not runtime admission. |
| Recommended public command leaves | 84 | 84 | Pinned source audit: v4 284 own/536 effective option occurrences. V5 source inventory remains 92 leaves, 335 own/611 effective occurrences; the recommended selection has 84 leaves, 288 own/540 effective after eight retiring leaves and init handoff are excluded. Parent options are not inherited. The command/output supplement adds all three v4 and six v5 missing leaf sections; generic placeholder differences resolve the apparent flag mismatches. |
| Diagnostic/public report rows | 74 | 283 | 12/60 object variants and 1/18 scalar or collection aliases after excluding the opaque private Plan closure; `reference/diagnostic-reports`. |
| Project/env metadata declarations | 22 | 22 | Version-pinned source declarations plus typed CLI projection tables; `reference/project-env-reports`. |

These are distinct inventories, not an overall completion percentage. A schema row or matching token is not a demonstrated scenario, handler default, client qualification or full nested payload contract.

Doctor diagnostic subtypes, optional provisioning reports, host telemetry, controlled project/meta and env-list/apply projections now have dedicated public field/type references. Engine-provided raw ps rows, application log maps, permissive unknown legacy keys and shared error.detail remain intentionally open. The compiler-owned plan record is opaque at its public CLI boundary; its private producer closure is excluded. Exhaustive effective handler/config fallback semantics and runtime/client qualification remain separate work. Internal daemon/guest/provider/compiler transports, retired hosted account/team/dashboard/Tickets surfaces, and unsupported gateway/node/dispatch are not promoted to public APIs. Cloud/provider executions and actual agent client loading were not performed for this editorial pass.

Source recovery and editorial decisions remain in `content-decisions.md` and `versioned-content.md`; originals under each version are preserved. Audit drafting artifacts are retained under `/tmp/hack-versioned-*-coverage.*` and `/tmp/hack-command-contracts-evidence.md` on the working machine, rather than published as raw notes.

V5 setup-sync target/status report tables are intentionally excluded (13 field rows,
3 object variants and 5 aliases); see the short historical agent compatibility
boundary for source availability. Those counts describe next.5; next.6 ships retirement refusals and explicit opt-in setup. V4 and hashed originals are unchanged. No client-load evidence
is inferred from the seven shipped skills or local marketplace registration.
