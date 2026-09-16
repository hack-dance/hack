# Explicit relay recovery across VM restart

A deliberately partial guest fence, missing process receipt or dead relay without socket identity
continues to block same-boot release. The candidate does not guess identities or automatically
restart the shared VM. An explicit owned VM restart is now qualified as a recovery route for these
cases with persistent application data preserved.

The live test exposed a separate graph restart defect: native HTTP readiness tried to reset probe
tmpfs storage that disappeared with the previous VM boot. Probe preparation already verifies the
recorded container is stopped and its prior exec is not running. Reset now recreates only a missing
probe allocation, with its exact recorded identity. Existing allocations still require owner and
mount validation; a symlink is refused before the creation branch. The published probe executable
and application volumes remain persistent. This also permits reconstruction after an explicitly
removed temporary allocation within the same boot; no new boot field or inferred identity is needed.

## Live qualification

Evidence: `.hack-local/review/wu07/relay-fallback-1789581382560205000/`.
Candidate SHA-256: `a48d907450f308f5d6c8561542ebf093e8ba2afa5ce5784d454b2a04404ea30c`.

A Bun HTTP fixture generated a random token into a named volume and served that token. Each of three
faults made ordinary release refuse. For the two still-live relay cases, HTTP continued serving the
same token after refusal. The dead-relay injection used a pidfd after verifying start time and
executable identity. No uncertain process or socket was adopted or manually deleted.

For each fault the test explicitly ran runtime down/up, verified the new boot ID, released the old
bridge reservation, restarted the unchanged graph, and allocated a fresh bridge. All three recovered
HTTP responses matched the original persisted token. The engine's entire named-volume inspection
record was unchanged, and all three graph restarts retained the original container ID. This is a
file-token persistence qualification, not a claim about interrupted database transactions or
physical host power loss.

All 18 resource-watchdog samples passed. Final graph cleanup with explicit fixture-data removal,
archive/export/reconciliation and VM shutdown passed; protected global configuration was unchanged.
Both earlier failed attempts were also cleaned and subsequently archived/exported: one caught a
harness receipt-shape error, and the second exposed the probe restart defect fixed here. No running
fixture or pending fixture retirement remains from those attempts.

The focused shell regression executes the production allocation branch: reset creates missing
storage, reset preserves existing contents, and create refuses an existing allocation. The existing
opt-in native HTTP lifecycle test now also removes owned probe storage from a stopped container
before restart and checks container/allocation identity preservation. That opt-in test is compiled
by the full suite; the actual reboot proof in this unit is the isolated CLI fixture above.

Default/all-feature Rust suites, strict Clippy, default release, repository typecheck/check/test
(940 passes, five skips), changed-document links and privacy checks passed. Logs are retained with
the live evidence. No comparative performance benchmark was added by this correctness fix.

## Operating boundary and next work

This fallback stops every application in the shared VM. It must remain an explicit operation with
that scope; ordinary release must not trigger it. Same-boot recovery of ambiguous partial records
and missing identities remains an improvement opportunity, with current safe refusals retained.
The fallback is sufficient to proceed with bounded loopback publication qualification rather than
blocking all routing work on automatic reconstruction of every crash state.

Next qualify an explicitly owned loopback publisher: exact reservation/generation binding, local
port conflict refusal, bounded connections/buffers, target exit and slot reuse invalidation, idle
CPU, and complete listener/process cleanup. A reused transport slot must never redirect an old
publisher to a newer reservation. TLS/routing integration, scoped QA delivery, full application
parity, matched resource benchmarks, disk policy and many-branch idling remain open.
