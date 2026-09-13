# M3 continuation checkpoint

Continue the private candidate on branch `codex/v5-candidate` in the saved `hack-m3` project,
`/Users/hack/dev/hack-dance/hack-cli`. Read `work-units.md`, `development.md`, and
`real-project-checkpoints.md` in this directory before implementation. Preserve stable Hack and
existing workloads. The user authorizes running Event Agent on M3 with its existing Hack env.
Use managed environment injection and native credential approvals; do not print or copy secrets.
Confirm any destructive database operation targets the intended disposable environment.

## Existing live fixture and evidence

The qualification checkout is `/Users/hack/dev/hack-v5-qualification-20260913/hack`; its sibling
`event-agent` is a verified 53,840,094-byte source capture and `inputs` holds pinned provider and
Bun image archives. Preserve this checkout and its evidence. Its VM is stopped. The candidate
executable binds its build checkout: rebuild after changing paths, never copy a binary as setup.
Use installed Rust with `cargo +1.97.1` without changing M3's default 1.75 toolchain; use pinned
Bun 1.3.9 for TypeScript.

Private reproducibility scripts remain in that checkout's `.hack-local/review/wu05/`:
`build-m3.py`, `live-m3.py`, `live-cli-m3.py`, and `live-observer-m3.py`. They are not in Git.
Inspect paths before reuse. They enforce normal memory pressure, unchanged swapouts, at least
2 GiB headroom, at most 8 GiB provider footprint and a 600-second watchdog. Do not weaken guards.

Latest evidence: `live-1789315575589931000` covers cancellation, timeout and post-admission tamper;
`live-1789319093412185000` covers public CLI lost reply, exact retry and node restart;
`live-1789319135335366000` covers live inotify replacement/deletion/restoration. See the checkpoint
ledger for earlier source A/B, stale/unpublished rejection, reconciliation and real project tests.
All are under the private scripts directory.

## Remaining acceptance

WU05 and WU06 are still in progress: finish the source-sync failure/performance matrix and
supervisor-loss containment, plus outstanding publication/cache/output controls in the work units.
Do not rerun already passing cases without changed code or an unresolved concern.

WU07 service graph startup is not implemented. Build graph execution, readiness, isolated
networking, persistent volumes, managed environment delivery, image/build handling, lifecycle
and routing, then prove the real Event Agent app works and preserves intended data. The captured
14-service Compose configuration still references old external networks, labels and host credential
mounts; do not adopt those resources implicitly. Inspect M3's existing managed Hack environment.
WU08 through WU11 remain governed by the work-unit ledger. Passing four real unit tests does not
prove app startup, reload, endpoints, persistence, Linux parity or release readiness.

Continue implementing and testing against the ledger until the requested working runtime is
actually demonstrated. Keep concrete remaining gates visible. This checkpoint does not authorize
merging or publishing a release.
