# Graph storage references — September 16

`graph inspect --run-id RUN --json` now includes `storage_references` alongside
its existing receipt and verified engine observations. This connects persistent
volume names to a particular graph's durable intent, complementing the engine
container-reference counts in `runtime guest-disk-usage`.

Every current graph volume is persistent data. The graph driver has no disposable
cache declaration, so this report never permits automatic collection. It does not
inspect other graphs or grant deletion authority. Existing inspection verifies the
pool incarnation, resource ownership labels, name and driver before producing the
report; a foreign replacement still fails inspection.

| Durable intent and observation | Classification |
| --- | --- |
| Ready graph, created volume present | `referenced_by_graph` |
| Ordinary cleanup complete, created volume present | `retained_for_restore` |
| Ready or retained graph, expected created volume absent | `expected_data_missing` |
| Explicit removal complete, volume confirmed absent | `confirmed_removed` |
| Pending journal, interrupted operation, or inconsistent state | `recovery_required` |

A volume with zero engine container references can still be `retained_for_restore`.
Missing data is a recovery problem, not a disposable-volume signal. A pending
journal takes precedence even over apparent completed removal. Reports are scoped
to a single graph and are not an atomic inventory across the whole runtime.

Verification: focused regression cases cover retained intent, missing data,
interrupted creation/cleanup/restore, pending journals and contradictory removal
observations. Rust default/all-feature tests and strict Clippy passed, as did the
default release build and Bun typecheck/check/test (940 passed, 5 skipped).

Isolated live evidence:
`.hack-local/review/wu07/graph-storage-references-1789595820938130000/`.
Candidate SHA-256:
`270830cee7aef98182bd65ee5d3fed5a5e6916f1de92617182eebae3d8d026fe`.
The two-service graph reported `referenced_by_graph`, then ordinary cleanup left
its volume at zero engine container references while reporting
`retained_for_restore`. Restore reported `referenced_by_graph` again and preserved
the original data token. Explicit data removal reported `confirmed_removed` and
the engine inventory confirmed absence. The reusable image remained cached.
Six watchdog samples stayed at normal memory pressure with unchanged swapouts and
more than 2 GiB headroom. Owned graph evidence was archived/exported, the VM was
stopped, and protected global hashes were unchanged. This qualifies the reference
report; it is not a performance improvement or cross-branch retention result.

Next: combine these references with a bounded inventory of all retained graph and
branch intents; classify unknown ownership and incomplete recovery conservatively;
then produce a retention preview with exact IDs and reasons. Cache declarations,
cross-branch leases, retention budgets and measured host reclamation remain open.
