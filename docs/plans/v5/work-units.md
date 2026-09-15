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
| WU07 | Real graph, persistent data, and loopback endpoints | WU03–06 | In progress; owned graph, persistent restore, process-loss recovery, evidence retention and [immutable source mounts](source-graphs-20260914.md) pass; real application acceptance open |
| WU08 | Durable terminals and bounded event/log streams | WU04, WU07 | Planned |
| WU09 | Native Linux and private SSH parity | WU05–08 | Planned; Hetzner fixture host selected and access verified; adapter qualification open |
| WU10 | Measured speed, footprint, and reclamation | WU07–09 | In progress; [current latency and matched-resource comparison](performance-refresh-20260914.md) extends the earlier cohorts; full application, transient-helper accounting and remote qualification open |
| WU11 | Env/TLS/slim compatibility and migration packaging | WU07–10 | Planned; not a release authorization |

The sequence starts with Mac runtime mechanics, but protocol and source decisions must accommodate
Linux from WU01 onward. Performance instrumentation starts with each unit; WU10 consolidates the
matched end-to-end qualification. A narrow improvement can be reviewed and used before every
release capability exists, provided the CLI advertises the actual supported checkpoint.

WU10's next provider-specific controls are captured in the
[pinned SmolVM optimization audit](smolvm-optimization-audit-20260914.md): API-only attribution,
macOS memory reclamation with reuse verification, a controlled vCPU sweep and launch-path profiling.
These remain qualification work; no unmeasured provider setting is adopted as a performance win.
The [runtime alternatives checkpoint](runtime-alternatives-20260915.md) adds a bounded crun
comparison and persistent HTTP probing. crun performance is gated on OCI/kernel compatibility;
probe batching requires explicit health semantics and supervisor recovery before product adoption.

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
   redacted saved reviews/journals. Bounded command-string word splitting now passes a Compose reference corpus and a live
   graph; unquoted control syntax remains refused. Complete interpolation operators and
   build/env_file delivery. The production driver and public graph
   run/inspect/restart/cleanup commands pass `live-1789405445903018000`, including stable IDs/data
   across VM restart, named-data retention, simulated missing-create receipts and foreign-name refusal.
   Cleanup-only journal reconciliation and actual create/start process-kill controls pass
   `live-1789406422649192000`: interrupted bytes retained, replay/allocation refused and all
   owned resources removed. Graph/source admission now checks retained receipts and containers
   under the provider mutation lease before allocation. Bidirectional refusals and post-cleanup
   source success pass `live-1789406782847250000`. Same-plan `graph restore` after ordinary
   cleanup and `graph archive` after explicit data removal pass `live-1789410072250672000`.
   Restore recreates compute while preserving a database-generated random token; missing data
   is refused. Archive preserves receipt bytes and refuses attempt-ID reuse. Restore histories
   are bounded at eight; archives at 256. Restore-specific SIGKILL controls at committed intent,
   after create and after start pass `live-1789411660314640000`, including explicit recovery
   with the original database token. Bounded local `graph export` passes byte/hash comparison,
   overwrite refusal and consumed-ID preservation. Export reconciliation, verified archive pruning
   with durable consumed-ID records, retry of partial consumed-ID publication, and abrupt owned-VM
   loss with committed database-token readback pass `live-1789412593555594000`. Export bundles and
   consumed IDs are retained; physical host power loss and torn-write/filesystem fault injection
   remain outside this bounded qualification. Changed-graph data adoption remains separate; review-plan redactions are not
   executable input.
   Capture concurrent graph/source resource accounting as a separate follow-up: the initial
   guard intentionally admits one workload and does not provide concurrent scheduling.
3. Deliver managed environment values without persisting secrets, handle image/build inputs and
   lifecycle processes, and add service-level observation plus isolated host-loopback routing.
   The [immutable source slice](source-graphs-20260914.md) now binds read-only application mounts
   to verified publications, persists that identity with graph intent, and revalidates initial
   creation, restart and restore. Missing, altered and foreign publication controls pass before
   allocation. Owned VM restart preserves the publication identity; restored compute retains the
   same database token. Fresh admission requires the acknowledged revision and retains existing
   graph/source-job exclusion. Restore still requires an unchanged review: following a newer
   working tree or restoring across arbitrary edits needs a separate contract.
   The [build-output fixture](build-outputs-20260914.md) now verifies a completed native build
   producer, read-only artifact consumption, same-data restore with verified output reuse, and
   compile/interruption/tamper failures that block dependent creation. This is a maintained fixture
   over existing graph primitives; Dockerfile/dependency builds, general output quotas/manifests,
   cross-project cache reuse, managed secrets and publication GC remain open. Next connect managed
   environment delivery and source update/reload to the real application compatibility work.
   The [service-scoped input compiler](development.md#service-scoped-environment-compilation)
   now separates managed values from public executable configuration and refuses cross-service
   fallback, conflicting owners and secret interpolation. Graph preparation retains a delivery
   refusal even if the caller discards the managed map. This closes the input-isolation slice;
   native provider leases, ephemeral delivery, restart/redelivery and live credential qualification
   remain open. Existing resource/latency results are unchanged; this slice makes no performance claim.
   [Guest transport hardening](development.md#guest-transport-before-managed-delivery) removes
   reflected guest output from errors, bounds request encoding before connection, and handles
   complete replies followed by peer closure under the response deadline. Managed-credential
   delivery remains disabled; the subsequent component qualification is recorded below.
   M3 boot/status/shutdown smoke `agent-transport-1789423407597955000` passes with normal memory
   pressure, unchanged swapouts, a stopped owned VM and unchanged global config/installed binary.
   The first smoke attempt stopped on a watchdog-parser error and cleaned up; it is not counted.
   Validation: 135 Rust tests and 940 CLI tests pass, plus typecheck, lint and release build.
   The [pinned agent audit and synthetic tmpfs probe](environment-delivery-20260914.md) identify
   argv info logging and response debug logging as delivery constraints.
   The fixed-output component now stages at most 8 KiB per service into one of eight current-boot
   tmpfs slots, with service/boot binding, expiry refusal and explicit cleanup. Live lease controls
   pass `environment-lease-1789427425288311000`. Native provider authorization, graph handoff,
   active-process expiry behavior and application restart/redelivery remain open. Expiry does not
   promise automatic deletion or stop a running app.
   Immutable, value-free allocation intents now authorize explicit interrupted-stage cleanup and
   old-boot empty-directory retirement. Live recovery passes `environment-recovery-1789428814471630000`;
   all nine pre-intent pilot directories were individually verified and removed in
   `environment-legacy-cleanup-1789428106505741000`. Retired-intent pruning remains open; intent
   records authorize cleanup only, not renewed use or automatic retirement of active allocations.
   Validation: 142 regular Rust tests, 940 CLI tests, typecheck, lint, privacy and release build pass.
   The Rust gate also exposed an enrollment lock lifetime defect; explicit unlock now passes a
   regression that retained a duplicated descriptor and failed under the previous close-only release.
   Delivery can now borrow the graph engine's existing mutation guard, with service matching and
   cleanup-only refusal. Retirement bypasses allocation admission without releasing that lock.
   Live run `environment-handoff-1789430822574659000` passes engine/lease interleaving, retained lock
   exclusion, forced admission-refusal cleanup and the prior lease/restart recovery controls.
   The subsequent attachment checkpoint addresses graph-to-slot cleanup ownership; normal graph
   startup still refuses managed environment inputs.
   Experimental attachment now records graph/container ownership before staging. Graph cleanup
   validates those bindings and removes containers before retiring their slots; container existence
   blocks standalone retirement. Attached graphs refuse restart, restore and export pending qualified
   redelivery. The next checkpoint addresses startup and numeric non-root behavior; native
   authorization remains open. Live attachment and independent-process cleanup pass
   `environment-attachment-1789431561987618000`, including mismatched-binding refusal, exact
   synthetic child values, metadata omission and read-only mounting. These are retained phase
   snapshots, not SIGKILL injection. Validation: 144 Rust tests, 940 CLI tests and required checks.
   The `environment-launcher` build feature now connects explicit scoped values to normal graph
   scheduling through `run_with_environment`. The static launcher replaces itself with the app,
   supports explicit numeric non-root UID:GID, and leaves values out of engine metadata. Separate
   health execs and inherited health checks cannot silently bypass delivery. Native credential
   authorization, CLI exposure, named users and attached-graph redelivery remain open.
   Live `environment-startup-1789433610282575000` passes root exec, UID/GID 1001/1002 delivery,
   Docker-init SIGTERM/SIGINT forwarding, exit-code preservation and native expiry refusal, plus
   all prior delivery/recovery controls. Validation: 146 Rust tests in both build configurations,
   eight live controls, 940 CLI tests and required checks. No new performance comparison is claimed.
   Explicit absolute CMD health checks now receive scoped values with silent output and independent
   expiry validation. Live `environment-startup-1789434169172839000` passes non-root health readiness,
   output suppression and expiry-to-unhealthy while the application remains running.
   `restore_with_environment` adds fresh explicit delivery after completed cleanup, retaining named
   data and requiring new container allocations. Native provider tools are unavailable in this
   session; native authorization and CLI credential exposure remain unverified.
   Live `environment-redelivery-1789434460004136000` verifies fresh container IDs and slots, changed
   values, preserved named-volume data and refusal of restore while running. Validation: 147 Rust
   tests in both configurations, 940 CLI tests and required checks. In-place restart,
   shell health checks and real-application/crash acceptance remain open.
   Managed driver-loss controls now kill an owned helper at seven startup/restore boundaries,
   including staged leases without containers and unacknowledged create/start replies.
   Live `environment-crash-1789434858915391000` passes replay refusal, unchanged refusal receipts,
   repeated cleanup and fresh restore after each actual SIGKILL. This closes those driver-process
   interruption controls; application crash and host power-loss acceptance remain open.
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

**Goal:** accept, optimize, or replace the provider using comparable usable workloads. Reduce
steady idle CPU, CPU per correct task, working-set/peak memory and retained footprint while
preserving responsiveness, correctness and the declared capacity/feature envelope.
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

**September 14 checkpoint:** eight rotated rounds against direct Compose, preserved Hack 4.1.1 and
updated 4.2.0 pass the same bounded init/SQLite/web/check workload. Candidate readiness is faster;
direct Compose teardown and the internal HTTP probe are faster. See the
[protocol, samples and limits](benchmark-20260914.md). This closes the warm component comparison,
not the full WU10 acceptance criteria. Carry the HTTP latency difference into application-load work.

**Resource follow-up:** native CPU timebase calibration and current-descendant accounting pass;
the ten-minute empty-pool window and matched 100 ms health-check graphs show lower candidate idle
footprint/CPU but higher graph CPU. An explicit startup-fast/steady-slow cadence reduced candidate
graph CPU by 76.6% in an A/B/A control, with readiness inside the observed control range. Graph
cleanup returns CPU close to idle but retains VM footprint until pool stop. See the
[resource report and caveats](resources-20260914.md). The
[current refresh](performance-refresh-20260914.md) repeats the frozen 32-trial latency protocol and
integrates the persistent sampler into matched candidate/Compose health-cadence windows, including
selected daemon descendants from their first samples. Remaining work: profile container/guest CPU
against host VM CPU per completed probe, account for transient helpers and safety-observer cost,
and qualify idle reclamation against active-work/data and restart-latency requirements. The
higher candidate CPU at matched requested cadence is an optimization target, not a closed gate.
User defaults remain unchanged. The [cleanup and CPU checkpoint](cleanup-cpu-20260914.md)
reduces cleanup journal commits, qualifies interrupted absence updates with actual SIGKILL, and
repeats all 32 latency trials. Archiving 64 fully removed attempts resolved active-journal admission
pressure while preserving evidence; retired environment intent pruning and archive retention remain
open. A container/host CPU pilot confirms that web cgroup counters alone do not explain the higher
candidate host CPU. An A/B/A experiment using identical `runc` bytes in guest memory reduced host
CPU by 13.5% against the two original-file controls. The implementation now provisions a pinned,
read-only 32 MiB execution cache before starting Docker. Eleven live controls pass, including
cache digest/replacement refusal and prior-boot recovery; completed-probe normalization, transient
helper accounting, full-application load and further CPU reduction remain open.

September 15 update: [intent retention](cpu-launch-retention-20260914.md) is qualified for removed
graphs and already-retired standalone slots. The historical sweep exported/pruned 181 graphs and
exported 247 standalone intents, preserving evidence and consumed IDs; the active intent inventory
is empty. Fixed-work diagnostics now count completed operations. The
[runtime alternatives checkpoint](runtime-alternatives-20260915.md) demonstrates 24–25% lower
candidate gross engine CPU than OrbStack for persistent HTTP probing in both lane orders, and
successful disabled/enabled synthetic memory release/reuse. Persistent probing remains diagnostic.
Six live graph reclamation cycles also pass scoped delivery, signals and fresh data restore.
The launch-path audit corrected the prior default claim: SmolVM already enabled reclamation with
its idle policy. That policy is now explicit and recorded per boot; no new default-to-default
memory improvement is claimed.
The [native HTTP supervisor](native-http-probe-20260915.md) now passes host failure controls and
owned ARM64 timeout/recovery/termination tests. A guest tmpfs bind mount makes its status observable
without per-read execs. Explicit native declarations now drive graph readiness with durable probe
intent, supervisor-loss detection, same-container restart, fresh restore and owned cleanup. Three
serial live controls pass, including scoped non-root environment delivery and driver interruption.
The [integrated benchmark](native-graph-performance-20260915.md) passes both lane orders: 84.8–85.5%
lower gross engine CPU and 68.5–68.6% lower footprint than Compose CMD health on this host.
Startup/restore are faster in the two observations; cleanup is slightly slower. Counts and unequal
VM capacities remain explicit caveats.
Open work: automatic idle reclamation and real-application recovery,
crun OCI/kernel compatibility, vCPU sweeps, launch profiling and the existing application gates.

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
