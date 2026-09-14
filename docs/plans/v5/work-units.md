# V5 work units and review checkpoints

Work from the [specification](spec.md). Complete one observable slice at a time. Every runtime unit
uses fresh admission, an owned fixture, explicit endpoints, a bounded deadline/watchdog, and final
resource readback. Preserve unsuccessful attempts. Do not keep extending a unit after its checks
pass unless a new failure or unresolved boundary justifies it.

## Real-project gate at every checkpoint

Follow the [real-project checkpoint requirement](real-project-checkpoints.md). Build the current
candidate and attempt Event Agent's actual Hack configuration, including the standard startup,
lifecycle, environment, logs, execution, restart and cleanup workflows. Record passed, failed,
blocked and unexercised behavior separately. Component tests or the small root Compose file do
not satisfy application acceptance. Carry every gap into the next checkpoint's acceptance criteria.

## Ledger

| Unit | Deliverable | Depends on | Current state |
| --- | --- | --- | --- |
| WU00 | Coherent candidate spec and evidence boundaries | Prior design/research | Written; review with this branch |
| WU01 | Rust core and checkout-local read-only CLI | WU00 | Implemented; see [checkpoint evidence](checkpoint-01.md) |
| WU02 | Private SmolVM lifecycle and recovery | WU01 | Implemented; bounded M3 lifecycle/recovery passed; broader limits in [checkpoint 02](checkpoint-02.md) |
| WU03 | Compose compatibility plan and real-project enrollment | WU02 | Component implemented; root-Compose receipt/readback passed; actual application plan blocked; see [checkpoint 03](checkpoint-03.md) and [real-project gaps](real-project-checkpoints.md) |
| WU04 | Durable operations, receipts, jobs, and cancellation | WU02–03 | Component implemented for bounded host and immutable-source jobs; full application execution remains open; see [checkpoint 04](checkpoint-04.md) and [real-project gaps](real-project-checkpoints.md) |
| WU05 | Native source and incremental development sync | WU03–04 | In progress; actual source-to-container proof passed, sync acceptance pending |
| WU06 | Immutable job input and generation enforcement | WU04–05 | In progress; M3 immutable-source execution, real project tests and explicit reconciliation pass; supervisor-loss containment and killed-publisher reconciliation pass; remaining cleanup/cache controls pending |
| WU07 | Real graph, persistent data, and loopback endpoints | WU03–06 | In progress; owned graph driver, readiness, restart/data and process-loss recovery pass; real application acceptance open |
| WU08 | Durable terminals and bounded event/log streams | WU04, WU07 | Planned |
| WU09 | Native Linux and private SSH parity | WU05–08 | Planned; requires a selected Linux fixture host |
| WU10 | Measured speed, footprint, and reclamation | WU07–09 | Planned; corrected research cohort incomplete |
| WU11 | Env/TLS/slim compatibility and migration packaging | WU07–10 | Planned; not a release authorization |

The sequence starts with Mac runtime mechanics, but protocol and source decisions must accommodate
Linux from WU01 onward. Performance instrumentation starts with each unit; WU10 consolidates the
matched end-to-end qualification. A narrow improvement can be reviewed and used before every
release capability exists, provided the CLI advertises the actual supported checkpoint.

## WU00 — Agree on the product and evidence

**Goal:** make speed, resource cost, local/remote ergonomics, and compatibility drive the design.
**Inputs:** the September design, M3 failures and qualification fixtures, existing runtime safety
contracts. **Output:** this directory. **Acceptance:** one maintained spec; SmolVM selected as a
candidate rather than a measured winner; Docker replacement deferred; unsupported capabilities
and real-machine test gates explicit. **Review:** read README → spec → evidence → this ledger;
cross-check that no work unit quietly drops source identity, ownership, persistence, or portability.

## WU01 — Build and inspect an isolated candidate

**Goal:** create a usable local development lane without replacing or invoking stable Hack.
**Output:** `packages/runtime-core`, root `hack-local`, build script, Rust contract/integration tests.
**Demo:** build; run `hack-local info --json` from another directory; preview a separate real project.
**Acceptance:** output identifies checkout, binary, checkpoint, planned paths, and lack of runtime
execution. Planning changes no project files and does not read secrets or global runtime config.
Candidate builds stay under `.hack-local`; no installer or shell-profile change.
**Negative cases:** missing build cannot fall back to `hack`; foreign checkout binary is rejected;
unknown/mutating commands fail; aliased state, invalid source, and recursive source/state overlap
are rejected. **Verification:** Rust tests, fmt/clippy, release launcher smoke, stable binary hash
before/after, and a real project read-only preview. **Limits:** no VM, container, or source sync.

## WU02 — Own a private SmolVM lifecycle

**Goal:** boot, inspect, stop, and recover one candidate-owned capacity pool.
**Inputs:** current pinned SmolVM packaging and restart research; WU01 namespace/path contract.
**Output:** provider process adapter, artifact manifest, platform capability probe, owner records,
explicit proposed `runtime up/status/down` commands and executable fixture.
**Acceptance:** no global Docker context, default SSH config, stable socket, HOME, CA, or launchd
mutation; audited mounts; verified artifact and guest handshake; deterministic private state path.
Use ephemeral guest PID/socket state and persistent native data mounts. Verify mount identity after
each boot; fail before Docker starts if the data disk is wrong. Stop requests guest quiescence and
flush before provider shutdown. Report failed/uncertain stop.
**Demo:** fresh boot → engine ping → owned data marker → stop → second boot → same marker → stop.
**Negative cases:** wrong artifact digest, stale/reused PID, short socket-path collisions, missing
mount, partial boot, unavailable resources, helper crash, and rejected native authorization.
**Evidence:** exact process/disk ownership, command/handshake receipts, before/after stable-runtime
inventory, two clean restarts and a separate crash-recovery fixture. No fast-start claim from a ping.

## WU03 — Enroll a real project through a reviewable plan

**Goal:** a developer can see what v5 would execute without rewriting a working project.
**Output:** bounded Compose import, typed internal plan, redacted diff, explicit enrollment.
**Demo:** plan one fixture, then a separate real project; enroll into fresh candidate state.
**Acceptance:** validate profiles, images/builds, argv, health/completion dependencies, ports, mounts,
env references, and limits. Show source inclusion/exclusions and expected data lifetime. Existing
v4 files, containers, volumes, and routes are not adopted or edited.
**Negative cases:** unsupported/privileged fields, dependency cycles, external volumes, host root
mounts, symlink escapes, credential-file inclusion, and conflicting environment owners.
**Evidence:** exact compatibility report, unchanged source/global sentinels, reviewed plan identity.
Preview-only WU01 output must never be accepted as an executable WU03 plan.

## WU04 — Make jobs durable and cancellation real

**Goal:** submit work once, retrieve its result after client loss, and stop owned descendants.
**Output:** node-local journal, versioned transport, job adapter, typed receipts, status/result/cancel.
**Demo:** submit a bounded job; disconnect after acceptance; reconnect and retrieve the same job;
cancel a TERM-resistant process tree while a separate sentinel survives.
**Acceptance:** persist intent before effect; serialize generation changes; retry same ID safely;
retain failure, exit code, bounded output, and terminal state. Read-only inspection never starts
the service. Freeze contract/schema before adding a TypeScript consumer.
**Negative cases:** same ID/different request, lost acknowledgement, disk-full journal, crash around
spawn/result persistence, reused PID, queue timeout, conflicting terminal completion and cancel.
**Evidence:** independent process inventory, durable receipts across daemon restart, no duplicate
effect or false successful cancellation. Host process groups are not hostile-process containment.

## WU05 — Make editing fast and source convergence visible

Checkpoint: actual Event Agent source publication and read-only container hash verification passed.
Native watcher, guest delta/reconciliation and actual-source container event-observer checks pass.
The complete negative-case matrix and reload performance remain open; this checkpoint does not
establish Event Agent app readiness.

**Goal:** local edits reliably reload guest-native services without image publication per edit.
**Output:** declared single-writer sync, bounded delta protocol, revision/status view, reconciliation.
**Demo:** normal edit, atomic editor save, nested rename, deletion/restoration, missed event, reconnect.
**Acceptance:** watcher-driven application output reflects acknowledged content; show sync lag and
conflicts. Keep native working/build data separate from host source. Validate permissions, safe
symlinks, Unicode/case collisions, exclusions, and large-tree limits. Preserve stable watcher roots.
**Negative cases:** partial transfer, overflow, escaping paths, competing writer, disk full, and
sync interruption during rename. Do not hide stale content with request-time reads or global polling.
**Evidence:** host intent → guest manifest → application watcher observation, per-stage latency,
idle CPU, bounded queue/memory, and repair after deliberately omitted delta.

## WU06 — Bind jobs to the revision that was accepted

**Goal:** tests and qualification run on immutable identified source while development continues.
**Output:** immutable publication, explicit expected revision/generation, snapshot-bound job receipt.
**Demo:** accept revision A; edit/sync B; launch accepted A and read A; reject a new stale A request.
**Acceptance:** wrong/unready/partial revisions fail before workload start; output has a separate
writable mount; identical content can reuse a qualified snapshot without copying all files per job.
**Negative cases:** mutation between validation and launch, replayed ticket, partial publication,
cache collision, incompatible architecture/toolchain, and interrupted cleanup.
**Evidence:** independent absence of start markers/events for rejects, positive observer control,
whole-tree identity inside actual launched job, immutable input write failure, exact owned cleanup.

### Remaining WU05/WU06 gates

- WU05: actual native event-overflow recovery; application watcher/reload evidence; matched latency
  and idle/resource measurements against the stated budgets.
- WU06: qualify explicit partial-publication retention/retry, crash boundaries and interrupted job
  cleanup; cache identity/collision and incompatible-toolchain controls must remain visible.
- New recovery work: bounded retained-publication garbage collection needs ownership and restart
  evidence before it can remove failed attempts. Legacy partials without ownership proof remain
  refused. Retaining failed attempts is not disk reclamation acceptance.
- Integration dependency: replace the supervisor-wide exclusive engine observation boundary with
  scheduling that allows graph status/readiness without unsafe concurrent mutations.

## WU07 — Run a useful project without losing its data

**Goal:** one web/database/setup/job graph works in the candidate with clear readiness and endpoints.
**Output:** graph orchestration, persistent-volume ownership, loopback endpoint registry, recovery.
**Demo:** ready database → successful init → web readiness → test job; open the candidate web page;
edit/reload; crash web; recover with same database token; down/up; verify data; cleanup disposable data.
**Acceptance:** failed init prevents dependent launch; ordinary down preserves persistent volumes;
candidate endpoint identity differs from v4; no runtime socket exposed to application containers.
**Negative cases:** readiness timeout, port conflict, partial graph, missing disk, crash versus clean
restart, orphan resource, restart after cleanup, and explicit migration failure.
**Evidence:** browser/host HTTP plus database readback, graph receipts, before/after v4 inventory,
and restart readback proving deleted owned resources stay deleted. No production project mutations.

### WU07 implementation queue after infrastructure qualification

1. Candidate bootstrap now provisions signed, pinned networking APKs before daemon startup and
   verifies its owner/package/file/inventory receipt on reuse. First installation, restart reuse,
   foreign-owner and incomplete-receipt refusals pass in `live-1789401520524709000`.
   Interrupted installation is retained and blocks startup; add explicit owned recovery
   and an input-preparation interface before distribution. Never adopt preexisting packages.
2. Shared dependency/readiness execution core passes `live-1789402358407299000`: init completion,
   web health and check completion order, failed-init dependent absence, restart and cleanup.
   It compiles reviewed dependency conditions and requires explicit readiness goals and durable
   driver intent before start. Exact-review executable argv/environment/healthcheck compilation
   passes `live-1789403260125753000`, including explicit non-secret environment delivery and
   redacted saved reviews/journals. Complete command-string tokenization,
   interpolation operators and build/env_file delivery. The production driver and public graph
   run/inspect/restart/cleanup commands pass `live-1789405445903018000`, including stable IDs/data
   across VM restart, named-data retention, simulated missing-create receipts and foreign-name refusal.
   Cleanup-only journal reconciliation and actual create/start process-kill controls pass
   `live-1789406422649192000`: interrupted bytes retained, replay/allocation refused and all
   owned resources removed. Finish retained-data reattachment after cleanup, receipt archival
   and graph/source-job admission coordination;
   review-plan redactions are not executable input.
3. Deliver managed environment values without persisting secrets, handle image/build inputs and
   lifecycle processes, and add service-level observation plus isolated host-loopback routing.
4. Run the managed Event Agent application, edit/reload it, and verify data across restart/down/up,
   failures and owned cleanup. The synthetic SQLite probe does not replace this gate.
5. Qualify the guest base and networking package versions for distribution in WU11; the current
   pins match the existing Alpine 3.19 fixture and are not a release support promise.

## WU08 — Keep terminals and observations useful after detach

**Goal:** reconnect to the same shell and logs without rerunning work or leaking resources.
**Output:** durable terminal supervisor, writer lease, bounded events/log retention, stable IDs.
**Demo:** set a shell variable, detach/kill only attach client, reconnect, verify PID/value; resize;
observe from a second client; cancel and confirm descendants absent.
**Negative cases:** supervisor/API crash, stale writer generation, Unicode/binary output boundaries,
slow subscriber, replay gap, output disk full, and concurrent cancellation.
**Evidence:** PTY-level tests and a real terminal session; ordinary piped process success is not
PTY proof. Provider model conversations and credentials remain owned by their integration.

## WU09 — Preserve the workflow on native Linux and over SSH

**Goal:** same execution/source/job/terminal contracts on Linux arm64/amd64 and a private remote node.
**Inputs:** an explicitly selected host and resource envelope, existing authorized runtime endpoint.
**Selected target (September 14):** user authorized the existing Hetzner tailnet instance.
The configured `hetzner-ubuntu` alias connects as `hack`; strict known-host SSH succeeded.
Observed Linux x86_64, 16 logical CPUs, about 27 GiB available RAM and 70 GiB free root disk;
Docker 29.8.0 and user Cargo 1.97.1 are present. Existing OpenClaw, routing and tunnel containers
are active. Start with a separate owned fixture capped at 2 CPUs, 2 GiB RAM and 5 GiB retained
artifacts; recheck headroom before effects. Do not reuse or stop existing services. This is access
and capacity evidence only, not Linux adapter or SSH execution qualification.
**Output:** Linux adapter, authenticated transport, capability negotiation, reconnect/lease behavior.
**Demo:** plan → sync → web/database/job → tunnel → terminal detach/reattach → cancel → clean readback.
**Acceptance:** separate transport overhead from executor time; no duplicate work after lost reply;
source convergence and data survive reconnect. New effects require current authority. Test node
reservation/drain before claiming shared-runner takeover. No guessed hosts or copied credentials.
**Negative cases:** network loss around acceptance, expired grant, stale generation, incompatible
architecture/protocol, cross-node retry, denied path and runtime socket, conflicting data writer.
**Evidence:** real Mac-remote and native Linux receipts, workload hashes, bounded logs, tunnel reopen,
owned-resource absence. Cross-principal hostile isolation remains a separate capability gate.

## WU10 — Decide whether this is fast and light enough

**Goal:** accept, optimize, or replace the provider using comparable usable workloads.
**Output:** frozen protocol, raw sample cohort, resource attribution, ergonomic review, decision.
**Demo:** perform the same real-project workflow from fresh capacity and warm capacity, locally and
remotely. Compare stable baseline, candidate, and VZ reference where supported.
**Acceptance:** meet spec budgets or record a reviewable change/remaining blocker. Separate boot,
transport, queue, admission, app readiness, reload, build/test, idle, load, reclaim, and retained disk.
Use release binaries; measure all helpers. Do not mix debug, patched lifecycle, or different storage
profiles silently. Leave shared OrbStack accounting incomparable where attribution is unavailable.
**Negative cases:** background contention, low headroom, failed correctness, observer undercount,
cache/order bias, stalled output subscriber, and repeated create/cancel leakage.
**Evidence:** raw per-run timing/identity/failure records; five rotated lifecycle runs at minimum;
longer idle/resource windows; actual reviewer-driven local and remote DX. No single-number winner.

## WU11 — Preserve compatibility and qualify distribution

**Goal:** a reviewable candidate can become a release without harming working v4 environments.
**Output:** env/host/slim/TLS compatibility, pinned package manifest, upgrade/rollback plan and tests.
**Demo:** existing overlay/worktree behavior, offline/slim inspection, host-native job, candidate TLS
after explicit trust setup, isolated v4 migration fixture, packaged install in a disposable profile.
**Acceptance:** no surprise client/plugin config writes; generated guidance matches actual commands;
native signatures, ABI, assets, protocol, and exact installed executable verified per platform.
**Negative cases:** partial/corrupt downloads, old client/node, expired secret lease, interrupted
migration, stale state backup, data rollback incompatibility, CA rotation with existing mounts.
**Evidence:** packaged end-to-end workflows, full gates, migration data readback, explicit unsupported
platform/capability list. Publishing and changes to the user's official installation are separate.

## Review record for each completed unit

Store a compact checkpoint report with: code revision and dirty patch identity; exact commands;
host/platform and runtime versions; fixture/source identity; positive and negative results;
measurements with their boundaries; resource cleanup readback; known gaps; and a five-minute demo.
Use project-scoped docs/tests for reusable findings. Keep raw personal host inventories, credential
material, and private project traces out of tracked artifacts.
