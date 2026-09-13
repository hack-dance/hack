# Checkpoint 04: durable fixture jobs and cancellation

Candidate `5.0.0-dev.4` adds a checkout-owned SQLite journal, versioned local socket protocol and
independent job supervisors. A client can disconnect or the node can restart without rerunning
accepted work. Execution is limited to four bounded host fixtures; enrolled project execution,
source publication, Compose orchestration and terminals remain later work.

## Implemented boundary

The [WU04 contract](wu04-contract.md) and [version 1 schema](../../../packages/runtime-core/node-protocol-v1.schema.json)
fix request identity, generations, capabilities, receipts, capacity and recovery behavior before a
TypeScript consumer is introduced. The CLI exposes explicit `node serve/status/inspect/request`.
Offline inspection uses a read-only SQLite connection. No launch agent or global daemon is installed.

Acceptance and queued intent commit together before launch. Identical retries return the original
acceptance; conflicting ID reuse, digests, generations, targets and capability requirements are checked before
effects. A new journal incarnation cannot accept an old target. A copied journal cannot adopt
another directory. Receipts and retry history do not expire automatically.

A supervisor holds the job lock, owns its unreaped child and persists native boot/start identity.
Cancellation escalates TERM to KILL and verifies group absence before its terminal receipt.
Recovery never signals stored PIDs or replays an ambiguous launch. Failed or uncertain cleanup is
quarantined and blocks new execution. Completion and cancellation cannot overwrite a terminal result.

## Local evidence

On Apple Silicon macOS with Rust/Cargo 1.97.1:

- All 67 Rust tests passed fresh. The manual provider-loss test was not run; the other ignored test
  is a subprocess entrypoint invoked by the node integration suite.
- Formatting, Clippy with warnings denied, and the release build passed. Dependency metadata
  declares no MSRV above 1.85; the exact CI compiler and native Linux runtime were not exercised.
- Cases include lost acknowledgement and single observed launch, same-ID conflict, daemon restart,
  queued cancellation/expiry, stale identity/generation, digest/capability refusals, bounded output,
  malformed/oversized frames, failed acceptance and terminal publication, and supervisor loss.
- The SQLite capacity test forces actual `SQLITE_FULL`; acceptance, generation and job insertion
  roll back together, and the original request remains safe to retry after capacity is restored.
- Native cancellation tests verify both parent and descendant absence while an independent sentinel
  survives. Synthetic `preparing`/`finishing` crash records with a sentinel PID are quarantined
  without signalling that PID. An actually killed supervisor is never relaunched.
- Repository typecheck, check and test passed using Bun 1.3.9 with cached Turbo results. Those cached
  results are separate from the fresh Rust tests and release demonstrations.

The built release CLI retained three real receipts: `succeeded`, `timed_out` across a node restart,
and `cancelled`. The latter recorded SIGKILL after TERM resistance. Independent PID probes and `ps`
confirmed both owned processes absent and the unrelated sentinel alive. That sentinel was then
stopped by its owner. The node was stopped, offline inspection matched its final status, and a
subsequent status command did not restart it.

Draft 2020-12 validation checked the release requests, acceptances and receipts against the schema.
A Python caller's canonical digest agreed with Rust; an explicitly wrong digest produced CLI exit
code 2. The report helper's plain-text version parsing was corrected after those demonstrations;
its report was regenerated from retained evidence without rerunning the jobs.

The installed Hack 4.2.0 executable and the real project's original Compose file retained their
before/after hashes. Private receipts, process readbacks, check logs, source manifest and release
binary digest remain under candidate review state. No VM, project service, source copy, environment
secret, remote host, commit, push or Hack installation was part of this checkpoint.

## Remaining gates

These results establish the bounded local fixture adapter, not arbitrary project execution,
hostile-process containment or exactly-once application effects. SQLite stalls and scheduler delays
can delay observed deadlines; a killed supervisor can leave a self-expiring fixture and an uncertain
receipt. Quarantine reconciliation is not implemented. Hosted CI, exact-MSRV compilation and native
Linux qualification remain unproven. WU05 adds source convergence; WU06–07 connect immutable inputs
and real service graphs. WU02's historical provider qualification is unchanged.

## Real-project acceptance correction

The subsequent [real-project attempt](real-project-checkpoints.md) tested Event Agent's actual
14-service Hack configuration. It does not currently plan or run in the candidate. The earlier
root-Compose enrollment and host-fixture results remain component evidence only. Full application
startup, host lifecycle, standard Hack workflows and data-preserving cleanup remain blocked.
Every following checkpoint must repeat and report this real-project gate.
