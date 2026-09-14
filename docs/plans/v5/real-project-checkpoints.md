# Real-project checkpoint requirement

Every candidate checkpoint must attempt the current Event Agent development workflow using that
checkpoint's built candidate. Unit tests and small fixtures establish component behavior; they do
not establish that a real project runs. Record component verification and real-project acceptance
separately. A blocked run is useful evidence and must remain visibly blocked.

Use Event Agent's actual `.hack/docker-compose.yml` and `.hack/hack.config.json`. Its root
`docker-compose.yml` contains only Redis and a monitor and cannot substitute for the application.
Use the current local project checkout, recording its commit and dirty-state fingerprint; do not
reset it or fetch/replace its source implicitly. Record candidate source identity, version and
executable digest. Run the workflow again after each checkpoint's relevant changes.

## Required workflow

| Check | Acceptance evidence |
| --- | --- |
| Review and enrollment | Actual service graph, source selection, compatibility findings and accepted candidate identity |
| Start and readiness | Successful dependencies/setup, ready application services, distinct candidate endpoints, host HTTP/browser response |
| Host lifecycle | Setup hooks complete; persistent proxy/session helpers start once; owned versus adopted processes are explicit |
| Environment delivery | Overlay/service/host/worktree precedence and authorized credential delivery work without exposing values |
| Status, diagnostics and logs | Actual service and host-process state, useful failed-start diagnosis, bounded application logs |
| Run, exec and sessions | A harmless real application command completes with output/exit status; session detach/reconnect preserves identity |
| Editing and tests | A source edit triggers the application watcher; a real project test/build executes against identified source |
| Restart and failure | Scoped and whole-project restart, failed setup, unhealthy service and helper failure produce correct recovery/state |
| Down and up again | Owned processes/containers stop, adopted resources survive, persistent data survives restart and source remains intact |
| Routing and isolation | Candidate URL/ports/TLS behave as declared without adopting v4 endpoints, volumes, contexts or runtime sockets |
| Final readback | Independent resource inventory and data/source checks; no leaked owned descendants or changed unrelated environment |

Mark each row `passed`, `failed`, `blocked` or `not exercised`, with the exact command, result and
reason in private evidence. Unsupported commands are blockers, not successful smoke tests. A VM
boot alone is not application readiness. A ready homepage alone is not lifecycle or persistence
proof. Preserve failures, cleanup evidence and the precise feature still needed.

Before effects, verify current admission, explicit candidate ownership, intended endpoints and
credential boundary. Use native authorization when needed. Do not bypass resource admission,
mount host credential directories, reuse the active v4 environment or switch to installed Hack to
make a candidate test pass. Shared remote hosts require an explicitly scoped run. Do not start
production migrations, broad cleanup or project resets as part of this workflow.

## Checkpoint review rule

A checkpoint review must include this matrix even when early implementation blocks startup.
Record the earliest real failure and every downstream unexercised feature. Assign each actionable
gap to an owning work unit and make its reproduction a required regression/acceptance case there.
Carry unresolved gaps into the next checkpoint; do not wait until WU07 or WU11 to attempt the real
workflow. Full standard-workflow acceptance is required before calling the candidate usable for
Event Agent. Historical component passes remain valid within their original scope.

## Current attempt: WU04 / candidate 5.0.0-dev.4

The actual project has 14 declared services, dependency-completion edges, an external Hack network,
routing labels and credential-directory references. Its lifecycle configuration declares `aws`
setup plus persistent `proxy` and `session-issuer` hooks. None of those hooks was executed.

| Check | Observed result |
| --- | --- |
| Actual application plan | Blocked: exit 2, `invalid_identifier`; no executable enrollment plan |
| Root Compose comparison | Compatible two-service Redis/monitor plan only; not Event Agent acceptance |
| Candidate runtime start | Blocked: exit 2, `admission_rejected`; free RAM below 16 GiB, abnormal memory pressure and load above the research ceiling |
| Candidate runtime status | Uninitialized before/after; no candidate VM or engine socket |
| Project start | Both `project up` and standard `up` refused with `unsupported_command` |
| Restart/down/status/logs/open/doctor/env/exec/host/session | Current standard command attempts refused with `unsupported_command` |
| Enrollment status | Existing root-Compose receipt remains readable; this is metadata, not a running application |
| Readiness, reload, real jobs, lifecycle helpers, routing and persistence | Not exercised because planning/execution are blocked |
| Preservation | Project commit, dirty-state fingerprint, both Compose files and Hack configuration unchanged |

Private command outputs, structural inventory, before/after identities and synthetic controls are
retained in the checkout's real-project checkpoint review directory. The application was not spun
up, and no stable-Hack fallback was used.

## Required follow-up acceptance

| Gap | Owning units | Required demonstration |
| --- | --- | --- |
| Credential-reference mount reports a generic identifier error | WU03 / environment compatibility | A `${HOME}` credential-directory mount receives a precise redacted refusal and supported delivery path; never resolve it by mounting host credentials |
| YAML environment merge is not normalized | WU03 | Bounded merge/anchor semantics and explicit precedence; malformed/recursive/oversized merges remain refused |
| Actual 14-service graph lacks a compatible plan | WU03, WU05, WU07 | Plan the actual configuration with source, external-network replacement, labels and dependencies accounted for; enumerate all remaining diagnostics |
| No project start/restart/down path | WU05–07 | Start the real application, observe readiness, restart it, preserve its data and verify owned cleanup |
| Hack lifecycle configuration has no candidate adapter | WU07 / WU11 | Execute setup and persistent helpers through supported authority/env delivery; test singleton/adoption and stop/recovery |
| Standard env/logs/doctor/open/exec/host/session parity absent | WU04–08 / WU11 | Exercise each workflow against the running application and preserve its failure/reconnect semantics |
| Local VM admission currently fails | WU02 runtime preflight | Repeat on an admitted host; do not relax the floor or infer a provider defect from host pressure |

Synthetic controls confirmed that an ordinary project bind plans successfully while a
`${HOME}/.aws` bind produces `invalid_identifier`. A plain environment mapping plans successfully
while a merge mapping produces `invalid_compose_field`. These isolate parser/diagnostic gaps;
fixing them alone will not implement project execution or credential delivery.

## WU05 development progress (application acceptance remains open)

The bounded YAML parser now normalizes environment merges. The actual 14-service configuration
produces a complete structural plan with specific diagnostics for credential-directory references,
external networks and existing route/ownership labels. Those diagnostics still prevent executable
enrollment; source capture can proceed independently under its own selection review.

An admitted development-profile VM has published the actual selected Event Agent source. A
separate, read-only container verified the captured file hashes and rejected an input write.
Container/image absence and clean VM stop were read back. This establishes source transport, not
application startup. The profile and resource evidence are separate from the research benchmark.

Native notifications and guest delta application have passed atomic replacement, nested rename,
delete/restore, competing-writer refusal and interrupted-client reconciliation in isolated source
fixtures. Quoted and Unicode paths and a safe file symlink passed. The stable guest root inode
survived these updates. A container kernel-event observer over actual project source subsequently
passed atomic replacement, deletion and restoration. Its reads consumed materialized callback
output, and registration was checked through the kernel's inotify file-descriptor metadata.
Protected source/configuration and installed stable Hack fingerprints were unchanged after cleanup.
The run observed 3.7–6.5-second delta acknowledgement latency; it does not establish fast reload.

Graph startup, managed environment delivery, lifecycle hooks, host endpoints, application reload,
real jobs, sessions and persistent application data remain blocked or unexercised. Their owning
work units and required workflow above still apply.

## WU06 implementation checkpoint (live acceptance blocked)

Candidate `5.0.0-dev.6` builds with durable immutable-source job admission, launch-time input
verification, bounded container execution/output, and owned cleanup. The offline Rust suite passes
90 tests; three provider tests and one subprocess helper are intentionally ignored in that run.
These checks do not establish live source-job execution.

The prepared live case accepts source A, synchronizes B, retries the original acceptance, launches
A, and checks independent engine events for rejected stale/unpublished requests. A subsequent job
uses the actual project's pinned ARM64 Bun image to run its inventory-bucket-key unit tests.
Neither live job has run: the latest preflight refused VM startup because macOS memory pressure
was not normal. The candidate remains stopped, and the resource guard remains unchanged.

Resume with that live case on an admitted host before marking WU06 accepted or using it as evidence
for graph startup. WU05 performance/negative-case coverage and WU07 application acceptance remain
open; image acquisition and a successful release build are not runtime proof.

## M3 live source-job checkpoint — September 13

The user-selected M3 runs the candidate in `<qualification-root>/hack`.
The separate Event Agent source copy has revision
`586ff66ea551ad0d389d2425773e633a6988837e0a8517b909db062a7c6c952d`, matching the selected
local capture. Runtime state and credentials were not copied. The binary was rebuilt for that
checkout with Rust 1.97.1; local and remote candidate source hashes matched.

The first live attempt found that the publication loader incorrectly required its JSON receipt
to be a directory. The corrected loader checks parent directories separately and uses the guarded
regular-file reader for the receipt. Its regression test covers ordinary, symbolic-link and
hard-link receipts.

The subsequent live run passed these checks:

- Accept A, synchronize B, retry the original acceptance, execute A with read-only source and
  separated stdout/stderr. Engine events show one create/start/die/destroy sequence.
- Reject new stale A and unpublished B requests. Both have no engine container events.
- Refuse reconciliation while the job supervisor lock is held, then remove the owned unstarted
  container. Events show create/destroy without start; the receipt remains `reconciled_unknown`,
  and retrying reconciliation returns the identical acknowledgement.
- Run the actual Event Agent `inventory-bucket-key.test.ts` file in its pinned Bun image:
  four passes, zero failures, seven assertions, and exit zero.
- Confirm owned cleanup, clean VM stop, unchanged protected source/configuration, normal memory
  pressure and unchanged swapouts. Maximum observed provider physical footprint was 1,066,993,560 bytes.

Evidence is retained at `.hack-local/review/m3-20260913/live-1789315290651042000/` locally and
`.hack-local/review/wu05/live-1789315290651042000/` in the M3 checkout. The full offline Rust suite
subsequently passed 92 tests on both hosts. Live cancellation, timeout and post-admission source
mutation are the next controls. This checkpoint runs real project tests, but does not start the
Event Agent service graph or prove routing, environment delivery, lifecycle or persistence.

A later M3 run at `.hack-local/review/wu05/live-1789315575589931000/` also passed real
cancellation, a 100 ms execution deadline, and deliberate insertion of an unexpected guest-source
file after acceptance. The stopped jobs had one start and confirmed container absence; the
mutated-source job failed before any container event. Source was restored and the four real project
tests passed again. Running-container cancellation/timeout receipts now leave exit code unknown
instead of copying the engine's pre-exit placeholder zero.

The public CLI lost-acknowledgement test then exposed a separate client deadline bug: its 500 ms
socket timeout expired during immutable-input admission. The client now allows 30 seconds for the
first response byte while keeping the one-second frame transfer deadline. A regression test
covers delayed replies and stalled partial frames. The live CLI rerun remains required; this local
fix is not yet evidence of public CLI acceptance.

The final local Rust suite passes 93 tests, and Clippy/format checks pass. Repository typecheck,
check and test tasks also pass with pinned Bun 1.3.9 using valid Turbo cache entries for unchanged
TypeScript inputs. The M3 transfer of the CLI deadline fix was blocked when the native SSH agent
failed to sign and then reported no loaded identities. The last candidate VM stop was clean.
Restore native SSH authorization before transferring the fix and rerunning the live CLI case.

On resumption, the configured M3 `IdentityAgent` was verified separately from the shell's default
agent. The configured 1Password agent exposed keys and SSH succeeded. The earlier observation of
no identities applied to the default shell agent, not the configured M3 agent. The corrected source
was transferred, rebuilt, and all 93 offline Rust tests passed on the M3.

## M3 public CLI and observer completion — September 13

The corrected public CLI passed the lost-acknowledgement/retry case and node restart case in
`live-1789319093412185000`. A retry returned the identical acceptance, the real project test file
passed all four tests, and engine events proved one start. A separate three-second Bun job survived
node shutdown/restart, returned `survived-node-restart`, and also started exactly once. This proves
node restart survival, not supervisor-loss recovery. The owned node and VM stopped cleanly.

The container inotify observer passed atomic replacement, deletion and restoration in
`live-1789319135335366000`. The guest root inode stayed 393220; five sync receipts measured
1324, 1107, 1122, 1117 and 1123 ms. Source was restored and owned resources were absent after cleanup.
This is a container filesystem observer, not framework reload or full service-graph acceptance.
Both evidence directories exist under the M3 checkout's `.hack-local/review/wu05/` and the local
`.hack-local/review/m3-20260913/`.

The checkpoint has 93 passing Rust tests on both hosts, passing format/Clippy checks and successful
release builds. TypeScript repository gates passed using cached unchanged inputs. CI now pins the
validated Rust 1.97.1 compiler; hosted CI and Linux runtime qualification remain unverified.

The user requested continuation in the saved `hack-m3` project and confirmed that M3 may run
Event Agent using its existing Hack environment. Resolve configuration through managed injection;
do not expose credentials or infer permission for production database mutations.

## Saved M3 checkout: supervisor-loss control — September 13

The saved checkout now tracks `codex/v5-candidate` and includes checkpoint `4b9fd30`.
Its candidate was rebuilt locally with Rust 1.97.1; the existing qualification checkout and
captured source were preserved. A separate development VM in this checkout used the same pinned
provider, engine and Bun image inputs.

The live supervisor-loss control passed in
`.hack-local/review/wu05/live-1789319934893524000/`. After the fixture-owned supervisor was killed
and reaped, the container ran the Bun workload and its child, then exited under its independent
8-second deadline (8.016 seconds observed after supervisor loss, exit 137, guest PID zero).
The restarted node quarantined the job. Retrying returned the original acceptance; explicit
reconciliation and its retry confirmed container absence and retained `reconciled_unknown`,
unknown exit code and one start. Independent engine events were create/start/die/destroy.
The VM stopped cleanly, protected source/configuration fingerprints matched, memory pressure
remained normal and swapouts did not increase. This is supervisor-loss containment, not app readiness.

Two earlier harness failures are retained: the first selected the Rust test executable instead
of the checkout CLI; the second observer contended for the supervisor's exclusive provider lock.
The corrected test observes the journal start, kills its owned child, and then inspects the engine.
Both retained jobs were explicitly reconciled without replay. Concurrent engine observations and
execution still require scheduling work before multi-service graph acceptance.

The actual managed M3 Event Agent checkout was also replanned read-only at commit
`8baf4757dca16cff0dc0c688c9f8624c6231efcb`, on `codex/hack-env-overlays-and-generate` (two local
commits ahead, preserved). This configuration has 12 services; it is distinct from the captured
14-service qualification source. External-network, existing route-label and interpolated mount
refusals still block enrollment. Managed base/core env inspection listed 150 variables and no
missing declared required variables, but `DATABASE_URL` was unavailable in that scope. No secret
values were exposed and no database operation ran. Managed delivery and full graph acceptance
remain open; the available-variable inventory does not prove usable credentials.

The separate output/reuse run `live-1789320176582870000` also passed. Repeated publication
preserved the source directory and package-file device/inode identities. The job wrote/read its
separate output mount, observed `EROFS` on input writes and `ENOSPC` beyond the 64 MiB output
budget, then wrote successfully after removing its oversized output file. Both 40,000-byte log
streams were retained within 16 KiB each with truncation reported. The job exited zero, started
once and had create/start/die/destroy events; container absence and clean VM stop were confirmed.
This qualifies ephemeral output bounds and identical-content reuse, not durable artifact export,
cache-collision recovery or interrupted-publication cleanup.

Fresh saved-checkout verification exposed two TypeScript test-environment issues hidden by the
previous cache-only evidence. Installing the committed lockfile supplied the missing conventional
commit preset. Project-view tests now isolate their global config path so operator extensions do
not leak into fixture expectations. No stable Hack configuration was changed.

Final checkpoint gates: 93 offline Rust tests passed (manual live controls run separately),
format and Clippy passed, release builds passed, and pinned Bun 1.3.9 typecheck/check passed
without cache reuse. The CLI suite ran 932 passing tests with five existing skips; the unchanged
database suite used its valid Turbo cache. Hosted CI and Linux runtime remain unverified.

## M3 source-status repair and transfer qualification — September 13

The public `project sync-status` command failed on an existing receipt with `invalid_state` because
it treated `state.json` as a directory. It now validates parent directories separately and reads the
receipt through the existing bounded, private regular-file reader. The regression covers missing
state without allocation, ordinary read-only receipt access, symlink/hardlink receipts and an
aliased parent. The rebuilt CLI read the actual captured-source acknowledgement with the VM stopped.

Source sync now batches its delta and control scripts into one hash-verified envelope. After a
successful apply, it retains the complete verifier outside the watched tree. A subsequent update
reuses that prior verifier only after checking its expected hash, with another hash check before
execution. Every before/after whole-tree check remains. Corrupted caches fail closed; explicit
reconciliation reconstructs them from the recorded manifests.

The live run `live-1789321210305920000` passed forced source-transfer ENOSPC in a private 1 MiB
tmpfs, refusal to silently retry pending transfer, explicit repair after resizing that owned tmpfs,
corrupted-verifier refusal and repair, interrupted-rename refusal and repair, stable watched-root
identity, complete guest-manifest verification and owned tmpfs removal. This tests a bounded
filesystem-full failure, not exhaustion of the shared persistent disk. Earlier unsuccessful
harness attempts remain in private evidence, including an evidence-directory permission mismatch
and a disk-usage formatting assumption corrected with POSIX output.

The same run passed actual-source container inotify replacement/deletion/restoration. The initial
uncached acknowledgement took 1307 ms. The four warm acknowledgements took 966, 959, 982 and
969 ms, versus the earlier checkpoint's 1107, 1122, 1117 and 1123 ms. Warm compressed payloads
fell from approximately 619 kB to approximately 310 kB
(619,327–619,645 versus 309,733–309,962 bytes); transfer time fell from 440–442 to 195–205 ms.
These are per-stage observations from individual runs, not a matched performance cohort, p95
qualification or application reload proof. Full-tree verification still takes approximately 560 ms.
The VM stopped cleanly and the captured source/configuration fingerprints remained unchanged.

### Managed environment readback and automatic migration

The earlier base/core `DATABASE_URL` unavailability was resolved by an authorized `hack host exec`
managed-injection probe. The child reported only booleans: `DATABASE_URL` and `AWS_PROFILE` were
present. A subsequent redacted `env explain` confirmed global-scope delivery to Compose.
No secret values were printed, and no database connection or migration command ran.

The installed Hack command automatically migrated legacy env configuration in the separate managed
Event Agent checkout. Its `.gitignore` and `.hack/hack.config.json` changed, and
`.hack/hack.env.default.yaml` plus `.hack/hack.env.production.yaml` were created. These changes are
preserved, uncommitted, and excluded from the v5 branch. This was managed env-format migration,
not a database migration or proof of graph startup. Do not report that managed checkout as clean.
The separate qualification capture remained unchanged.

The final source-sync revision then passed the full immutable-source live control again in
`live-1789321275811362000`: A/B execution, stale/unpublished rejection, cancellation, timeout,
tamper rejection, explicit unknown-outcome reconciliation and the actual Event Agent test file
(four passes). Final offline Rust verification passed 95 tests; format, Clippy and release build
passed. The earlier 932-test CLI run, typecheck and lint remain valid for unchanged TypeScript
inputs. The final candidate VM stop was clean. WU05/WU06 remain in progress; graph startup,
application readiness, persistence and Linux parity have not been accepted.


### September 13 publication staging and watcher failure controls

The saved candidate now uploads and verifies the full immutable verifier before the final directory
rename. Reuse rejects missing/corrupt final verifiers without rebuilding them. The live run
`live-1789326499355320000` passed deterministic interruption after staging upload, corrupt staged
verifier rejection, ordinary retry refusal with staging preserved, and missing/corrupt final verifier
rejection with the existing host receipt unchanged. The same run passed identical-publication reuse,
ephemeral output/log limits, the immutable A/B/cancel/timeout/tamper controls and four Event Agent
unit tests. Source fingerprints were unchanged, pressure stayed normal, swapouts stayed at 4,132,
peak provider footprint was approximately 1.17 GB, and the candidate VM stopped cleanly.

The first attempt (`live-1789326360428894000`) stopped before publication because the synthetic
fixture used an invented selection digest. It was corrected to use the planner's current digest;
that failed attempt and its clean-stop evidence remain preserved. These are deterministic staging
failure controls, not an OS process-kill experiment or proof of interrupted cleanup recovery.

The final Rust suite passed 98 tests with formatting, Clippy and release build passing. Native
macOS notifications observed a 512-file burst of creation, atomic replacement, rename and deletion;
a fresh inventory contained exactly the 256 remaining files and their final bytes. Separate
100,000-event callback saturation tests retained injected rescan/error signals despite the full
one-slot queue. These establish burst inventory and callback behavior, not an actual kernel queue
overflow or framework reload performance. The burst test initially reused the pre-edit selection
digest; it now also asserts that this stale selection is rejected before capturing the fresh plan.
Existing TypeScript verification remains applicable because its inputs are unchanged.


### September 14 explicit publication recovery

`project publish-source --reconcile` now binds new staging to a durable private publication intent
and guest ownership marker. It retains interrupted staging before retrying, without deleting source
or failure evidence, and refuses foreign markers or an exhausted eight-copy retention limit.
`live-1789399037913060000` passed staged interruption/corruption repair and those refusal controls,
plus unchanged immutable-job and output controls. `live-1789399208758465000` additionally killed the
owned publisher process after upload and recovered through the public CLI with its reviewed plan.
No accepted receipt existed before repair; final guest verification and retained staging were checked.
Both runs stopped the candidate VM cleanly and preserved the selected application source fingerprints.
The Rust suite passed 99 tests; Clippy passed after adding the process-kill helper. The CLI reference
generator ran with no generated change because the public TypeScript CLI surface is unchanged.

Remaining boundaries: legacy partials without an ownership marker remain refused; a crash between
staging directory creation and its marker remains fail-closed. Retained-copy garbage collection and
crash tests during retention/cleanup are still open. This checkpoint does not qualify graph startup.


### September 14 concurrent read-only engine inspection

`runtime engine-info` now uses an observation-only connection with provider identity checks around
its fixed version read. It does not acquire or bypass the mutation lease to execute guest scripts.
`live-1789399457252864000` proved the public CLI read succeeds while the live job supervisor holds
the mutation lock, while a second mutation connection still receives `provider_busy`. Supervisor
loss, independent deadline containment and explicit unknown-outcome reconciliation still passed;
the VM stopped cleanly. The Rust suite passed 100 tests. This closes the engine-version inspection
contention case, not service-status/readiness APIs or concurrent graph mutation scheduling.


### September 14 WU07 network and persistence probe

`live-1789400597261589000` passed the synthetic init → SQLite-backed web → HTTP check pipeline,
including service-name DNS and the same stored token after a subsequent VM restart. Each phase
uses the pinned Bun image, an internal candidate-owned bridge and a labelled persistent volume.
Exact container/network/volume absence and restoration of the original guest package inventory
were verified; the outer watchdog confirmed final VM stop and unchanged application fingerprints.
This proves internal network/data mechanics, not the application executor or Event Agent startup.

Earlier probes created their network/volume and initialized the database, but service DNS failed
while HTTP over the container IP succeeded. Explicit aliases did not fix it. A trial nftables daemon
flag failed at engine startup with a fixed `not found` diagnostic and was reverted. The working
probe hash-checks four Alpine APKs, verifies their signatures, installs them offline, and restarts
before creating networks; installing into an already-running daemon did not repair cached tool
discovery. The guest kernel supports the resulting rules. Packages are removed after the test;
normal product bootstrap still needs this dependency provisioning.

Preserved failed evidence includes `live-1789399672754265000`, `live-1789399825295701000`,
`live-1789399906894276000`, `live-1789400056197384000`, `live-1789400191452678000`, and
`live-1789400468804275000`. Failed boots were explicitly recovered before reuse; no resource guard
was relaxed. Source and owned disk identities were preserved.

Final verification after this probe passed 100 Rust tests, formatting, Clippy and the release build.
The successful run kept normal memory pressure, unchanged swapouts and an observed peak provider
footprint of approximately 861 MB. These are resource-safety observations, not a matched performance
cohort. The candidate VM is stopped; installed Hack and managed application env changes remain outside
this patch. WU09 still needs an explicitly selected Linux fixture; the host-selection question is open.


## September 14 — Candidate networking bootstrap

Candidate boot now installs the four pinned, signed Alpine networking APKs before starting Docker.
It retains private owner/package identity, installed-file checksums and package-inventory receipts
inside the candidate guest, verifies them on reuse, and refuses unowned or incomplete installations.
The graph probe no longer installs/removes packages or performs a capability-discovery restart.
Immutable provider artifacts and stable Hack remain unchanged.

`live-1789401520524709000` proves initial installation through public runtime startup, service-name
HTTP, SQLite readback after VM restart with receipt reuse, foreign-owner and incomplete-receipt
refusals, and removal of the exact labelled graph resources. Final state is stopped with no provider
process. Pressure remained normal, swapouts stayed at 4132 and peak provider footprint was
930,465,400 bytes. Protected source inputs were unchanged. The earlier attempt
`live-1789401310889616000` was refused before VM startup by the unchanged host-load admission gate.

Validation: 101 Rust tests pass, plus the ignored live graph control; release build, rustfmt and
all-target clippy pass. Host-input regression covers corrupt hashes, symbolic/hard links and public
file modes. This establishes candidate bootstrap and synthetic graph behavior, not actual Event
Agent startup or an application performance improvement. WU07 stays open. Explicit interrupted
installation recovery and a distribution input-preparation interface remain tracked alongside the
actual graph executor, managed environment, lifecycle and loopback-routing work.
