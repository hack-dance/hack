# Retained graph volume inventory — September 16

`graph storage-inventory --json` joins all receipts in the current candidate's
retained graph store with private engine volume usage. It holds the graph mutation
lease, validates each receipt and each named volume's ownership, and reports exact
volume names, observed bytes, container-reference counts and graph intent.

The store is bounded at 64 attempts, with up to eight volumes each. Unknown entries,
unsafe directories, invalid receipts, foreign resource labels, and inconsistent
volume-presence observations refuse the report. A pending journal remains marked
as requiring recovery. Ten seconds between operations bounds the scan; an in-flight
engine request retains the existing 40-second timeout. The command never boots a
stopped VM, starts containers, probes service health, or deletes guest resources.

All current graph volumes are persistent data and remain retained even with zero
container references. Unmatched engine volumes also remain retained: their ownership
or non-graph references are unclassified. A missing receipt is not evidence that a
volume is disposable. The report names its incomplete scope explicitly: archived
removed graphs and a future branch registry are not scanned. Engine activity can
change during observation, so this is not an atomic engine snapshot.

This is an inventory for retention decisions, not a collection implementation.
`deletion_candidates` is empty and `cleanup_authorized` is false. Disposable-cache
policy, branch leases, export retention and host physical-space recovery remain
separate open work.

Rust default/all-feature tests and strict Clippy passed; the default release build,
Bun typecheck/check/test (940 passed, 5 skipped), and CLI reference generation passed.
Regression coverage checks the 64-entry boundary, unknown entries, symlink refusal,
zero-reference persistent data, unknown volumes and changed presence.

Live evidence:
`.hack-local/review/wu07/graph-storage-inventory-1789596197520672000/`.
Candidate SHA-256:
`2adccebaf4f3f472b1b494a60c7124ed8fc16fe0bb641087a79108ac78086a8c`.
Two graph instances were started and ordinarily cleaned up in sequence. The joined
inventory contained four retained-store receipts (including prior removed attempts)
and two present 36-byte volumes. Both had zero container references and were
`retained_for_restore`. Restoring the first preserved its original token while the
second remained retained. Explicit cleanup removed both volumes; final inventory
confirmed their absence. Both attempts were archived and exported, the reusable
image remained cached, and the VM was stopped. An additional stopped-state inventory
call refused without booting it. Protected global hashes were unchanged.

Six watchdog samples maintained normal pressure and unchanged swapouts. The joined
scan reported 1 ms after connecting to the engine; this excludes connection and
ownership-audit time and is not an end-to-end performance benchmark. General branch
parity and host disk recovery are not established by this test.
