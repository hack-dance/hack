# M3 continuation checkpoint

Continue the private candidate on branch `codex/v5-candidate` in the saved `hack-m3` project,
`<saved-hack-m3-checkout>`. Read `work-units.md`, `development.md`, and
`real-project-checkpoints.md` in this directory before implementation. Preserve stable Hack and
existing workloads. The user authorizes running Event Agent on M3 with its existing Hack env.
Use managed environment injection and native credential approvals; do not print or copy secrets.
Confirm any destructive database operation targets the intended disposable environment.

## Existing live fixture and evidence

The qualification checkout is `<qualification-root>/hack`; its sibling
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
the outstanding publication/cache/output controls in the work units.
Supervisor-loss containment, identical publication reuse and ephemeral output bounds now pass in the saved checkout; see the September 13 saved-checkout
entry in `real-project-checkpoints.md`. Concurrent engine observation versus supervisor lock
ownership still needs scheduling work before graph acceptance.
Source transfer ENOSPC, interrupted-rename repair, verifier-cache corruption repair and the
container observer now also pass in the saved checkout. `project sync-status` was repaired;
batched transfers with a verified prior-script cache reduced warm acknowledgements to roughly
0.96–0.98 seconds in one run. Native 512-file burst inventory and callback saturation controls
now pass. Actual kernel-overflow recovery and full application performance acceptance remain open.
Immutable publication now verifies staging before its final rename; staged interruption and
missing/corrupt verifier controls passed in `live-1789326499355320000`. Failed staging remains
preserved and ordinary retries refuse it. Interrupted cleanup/recovery is still an open gate.
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

The managed Event Agent injection probe succeeded for `DATABASE_URL` and `AWS_PROFILE` (presence
only). The installed CLI automatically migrated its legacy env config: `.gitignore` and
`.hack/hack.config.json` changed, and default/production env YAML files were created. Preserve
these uncommitted managed changes; they are outside this branch and did not run database migrations.
The current managed checkout has 12 services, distinct from the preserved 14-service capture.
