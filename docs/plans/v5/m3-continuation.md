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
entry in `real-project-checkpoints.md`. Read-only engine-version inspection now succeeds while the supervisor retains its mutation lock;
service-level observation and graph mutation scheduling remain open.
Source transfer ENOSPC, interrupted-rename repair, verifier-cache corruption repair and the
container observer now also pass in the saved checkout. `project sync-status` was repaired;
batched transfers with a verified prior-script cache reduced warm acknowledgements to roughly
0.96–0.98 seconds in one run. Native 512-file burst inventory and callback saturation controls
now pass. Actual kernel-overflow recovery and full application performance acceptance remain open.
Immutable publication now verifies staging before its final rename; staged interruption and
missing/corrupt verifier controls passed in `live-1789326499355320000`. Failed staging remains
preserved and ordinary retries refuse it. Explicit publication reconciliation now retains owned
staging and retries; September 14 live tests include a killed publisher recovered via the public
CLI. Retained-copy cleanup and the remaining crash boundaries stay open.
Do not rerun already passing cases without changed code or an unresolved concern.

WU07 has an owned graph executor; real application startup remains unqualified. A September 14 synthetic init/SQLite/web/HTTP
probe passes service DNS, VM restart/data readback and owned cleanup. Candidate bootstrap now
incorporates signed, pinned networking packages before daemon startup; the updated live probe
passes in `live-1789401520524709000`, including foreign-owner and incomplete-receipt refusals. Packages persist in the owned guest with receipt checks, and the probe no longer installs
or removes them. Interrupted-install recovery and distribution input preparation remain open. Build graph execution, readiness, isolated
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


September 14 continuation: `project::execution` now compiles dependency intent and runs explicit
started/healthy/completed readiness goals through a durable-intent driver contract. The updated
owned Docker probe uses it rather than hand-written ordering. `live-1789402358407299000` passes
both successful generations across VM restart and a failed-init control with no dependent
containers. 107 Rust tests, release build, rustfmt and clippy pass. Executable input compilation
and the production ownership/recovery driver remain open; actual Event Agent execution is not
qualified. The user selected the existing `hetzner-ubuntu` tailnet host for WU09; SSH and capacity
were verified read-only. See its shared-host resource envelope in `work-units.md`.


`project::inputs` now compiles active-service argv, entrypoint, environment, user and health-test
values from exact reviewed Compose bytes using an explicitly supplied map. It preserves null versus
empty overrides, rejects stale reviews, absent inputs, unsupported operators/string commands,
NUL and excessive expansion, and does not serialize executable values. `live-1789403260125753000`
passes the graph through this compiler across restart, with a non-secret environment sentinel and
redacted saved reviews/events. 111 Rust tests, release build, formatting and clippy pass. Next:
production graph ownership/recovery driver, then remaining command/build/interpolation support,
managed-secret delivery and actual application startup. No Event Agent credentials were used.


The public `graph run|inspect|restart|cleanup` driver now passes
`live-1789405445903018000`: pinned images, owned resources, dependency readiness, stable container
IDs and SQLite data across VM restart, retained named data on cleanup, missing-create-ID inspection,
foreign-name refusal and final removal. 114 Rust tests and all-target clippy pass; CLI reference
generation has no TypeScript surface drift. `graph restart` is explicit and requires acknowledged
prior success, identical plan/readiness and stopped containers. Cleanup-only journal reconciliation and actual child-process SIGKILLs after create/start before
acknowledgement now pass `live-1789406422649192000`. Partial bytes are retained; replay and
competing graph allocation are refused, and cleanup confirms resource absence. 116 Rust tests
pass; the VM is stopped, pressure stayed normal and protected inputs are unchanged. Next are
retained-data reattachment and receipt archival. The initial single-workload graph/source
admission guard passes `live-1789406782847250000`, including source success after graph cleanup;
concurrent resource accounting remains separate. These
do not close Event Agent,
source/build, managed-secret, routing or Linux-adapter acceptance.


Same-plan restore after ordinary cleanup and receipt archival now pass
`live-1789410072250672000`. New container IDs retain the database-generated random token; missing
volumes are refused, prior restore receipts are retained, and archived attempt IDs cannot replay.
117 Rust tests, release build, rustfmt, all-target clippy and CLI reference generation pass. The
VM is stopped, pressure stayed normal, swapouts stayed 4132, and protected inputs are unchanged.
Next: restore-specific process-loss qualification, bounded archive export with consumed-ID
preservation, source/build and managed-secret delivery, lifecycle/routing and real application
acceptance. The existing SIGKILL controls exercise fresh graph create/start, not restore history
publication or archive power loss.


`live-1789411660314640000` now qualifies three restore-specific SIGKILL boundaries: committed
restore intent, create reply and start reply. Direct replay is refused; explicit ordinary cleanup
and restore preserve the original random database token in all three cases. The two fresh-run kill
controls still pass. Local archive export preserves every regular file byte-for-byte, returns a
verified bundle hash, refuses overwrite and leaves the original consumed-ID reservation intact.
118 Rust tests, release build, rustfmt, all-target clippy and CLI reference generation pass. The
VM is stopped, pressure stayed normal and swapouts stayed 4132. Partial-export reconciliation,
archive pruning/retention with durable ID reservations, filesystem/power-loss testing and actual
application qualification remain open.


Retention follow-ups now pass `live-1789412593555594000`: explicit partial-export reconciliation,
verified pruning with retained export and durable consumed ID, partial consumed-ID publication
recovery, and abrupt development-VM SIGKILL followed by committed data readback. Full 118-test
validation passes after making test-owned enrollment lock release explicit. Physical host power
loss/torn filesystem writes remain a separate test boundary. Benchmark qualification now targets
installed stable 4.1.1, updated 4.2.0, direct Docker Compose and the candidate with matched isolated
workload/resource settings; pilot measurements are not the final cohort.
