# Persisted provider capability audit

The candidate now audits SmolVM's persisted VM record before starting a guest, when `runtime up`
encounters an already-running guest, and alongside the retained boot audit before guest observation
or mutation. This closes a gap in pinned SmolVM 1.14.3: `agent.config.json` omits published sockets,
SSH forwarding and several launch-time inputs.

The read-only SQLite query requires exactly one VM with the expected name and exact owner label.
It rejects unrecorded published sockets, SSH forwarding, staged/remote mounts, init commands/environment,
secret references, workload image/command/user/workdir overrides, health commands, and network
backend/name/DNS overrides. Ordinary mount, port, capacity and device checks remain in the retained
boot audit. No socket forwarding is enabled by default. The subsequent [explicit bridge capacity](application-bridge-intent-20260916.md)
adds durable opt-in intent whose exact mappings are checked by this audit.

The database and existing sidecars must be regular files owned by the current user, without group
or world write permissions or hard links, and at most 16 MiB each. Parent symlinks and SQLite
symlink opening are refused. Record data is capped at 64 KiB, names at 129 characters, and the query reads
at most two rows. A 200-ms SQLite busy timeout bounds lock waiting; it is not a whole-query deadline.
The database inode is checked around the read. Database and validation errors return a fixed
`unaudited_provider_config` message without serializing record contents. SQLite's read-only mode
may participate in normal shared-memory locking; this is not an immutable database snapshot.

This is persisted configuration validation, not independent attestation of every live provider
capability or protection against a hostile same-user process racing the audit. Runtime status and
owned shutdown remain available for diagnosis and recovery; they do not imply configuration
acceptance. Long-lived routing still needs continuous ownership/lifecycle handling and stale-target
invalidation, in addition to this precondition.

## Verification

Unit controls cover expected ownership, valid-shaped unexpected socket/SSH declarations, missing
required fields, hidden launch inputs, redacted failures, committed WAL data, duplicate/foreign
VMs, malformed/oversized records, unsafe permissions and database/sidecar symlinks.

An isolated source copy deliberately added `--expose-socket /run/hack-local/route-probe.sock` to VM
creation. The candidate refused it with `unaudited_provider_config` before boot; no guest boot identity or provider PID file existed, and an independent process scan found no
matching provider executable. The initial harness incorrectly required `process_alive: false`;
status returned `null` because no process identity had ever been recorded. This also exposed a
misleading `creating` phase; pre-boot audit refusal now records `stopped-before-engine`. The provider database was
created through its CLI and was not hand-edited. Evidence:
`.hack-local/review/wu07/config-audit-refusal-1789530704560537000/`.

The corrected final control refused the same unaccepted socket mapping twice, retained
`stopped-before-engine`, and never produced a guest boot identity, provider PID file or matching
provider process. A retry re-ran validation rather than requiring recovery. Evidence:
`.hack-local/review/wu07/config-audit-refusal-final-1789530954303423000/`.

The normal graph control passed 32 healthy services, endpoint identity checks, deliberate detach
refusal, cleanup, fresh restore, archive/export reconciliation and VM shutdown. All 24 host
pressure/swapout/reserve samples passed. Evidence:
`.hack-local/review/wu07/config-audit-live-1789530709891612000/`.
Executable SHA-256: `91699cf25645c020fe11a5476a99704ec83cf38ec28f05f7f9741933a4613aa9`.
This graph run preceded the final correction to the pre-boot rejection phase; the final negative
control exercises that correction separately.

Twenty inspections per executable were interleaved in before/after/after/before order across the
two live graph generations. Combined median wall time was 71.92 ms before versus 72.20 ms after;
mean command CPU was 19.5 versus 20.0 ms. The CPU timer has coarse resolution and this small sample
is not evidence of a significant performance change. No daemon or background polling was added.
There was no Compose/OrbStack or full-application benchmark in this unit.

Local default/all-feature Rust suites, strict Clippy, release builds and repository
typecheck/check/test passed (940 tests passed, five skipped). The final rejection-state correction
received a fresh release build, strict Clippy and the repeated pre-boot refusal control. Application source and
configuration, installed Hack, and QA credential delivery were not changed by this unit.
