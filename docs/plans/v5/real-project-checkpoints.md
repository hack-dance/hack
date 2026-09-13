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

The user-selected M3 runs the candidate in `/Users/hack/dev/hack-v5-qualification-20260913/hack`.
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
