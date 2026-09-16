# Isolated candidate development

The installed `hack` remains the supported v4 executable. `hack-local` is a repository script that
executes only the Rust candidate built for that physical checkout. It has no fallback to `hack`,
`dist/hack`, an installed daemon, a default Docker context, or an existing project runtime.

## Build and inspect checkpoint WU01

Prerequisites: the validated Rust 1.97.1 toolchain, Cargo, and a
POSIX shell. Dependencies are locked in `packages/runtime-core/Cargo.lock`. Build uses the existing
Cargo cache; it does not install a toolchain, provider, service, or Hack binary. Use the repository's
pinned Bun 1.3.9 for existing TypeScript checks.

From the candidate checkout:

```sh
./scripts/build-hack-local.sh
./hack-local --version
./hack-local info --json
./hack-local plan --project /absolute/path/to/a/separate/project --json
```

`plan` currently previews canonical source identity and isolated future paths only. It does not
parse Compose or `.env`, copy source, enroll a workspace, verify installed SmolVM, or start anything.
It reports `runtime_execution_supported: false` and an empty effects list. Top-level project `up`, `down`, `exec`, and `sync` still fail. The separate `runtime` commands
below affect only the candidate pool.

Use a separate source project or disposable worktree, not the candidate checkout or one of its
ancestors. This prevents recursive synchronization of candidate state when enrollment is added.
A missing project or symlinked candidate state produces a typed error rather than adopting it.

## Convenient invocation from another project

The absolute script path works from any working directory. For an optional current-shell alias,
run this once from the candidate checkout (do not write it to a managed shell profile):

```sh
alias hack-local="'$(pwd -P)/hack-local'"
```

Then change directories and call `hack-local info` or `hack-local plan --project "$PWD"`.
`unalias hack-local` removes the alias. A global symlink is deliberately not installed; the launcher
rejects direct symlink invocation so the owning checkout remains unambiguous.

## Paths and safety boundaries

| Surface | Candidate contract |
| --- | --- |
| Executable | `<checkout>/.hack-local/target/release/hack-runtime-candidate` |
| Build outputs | `<checkout>/.hack-local/target` |
| Runtime state | `<checkout>/.hack-local/run` |
| Provider home/cache/sockets | `.hack-local/run/smolvm/home`; a receipt-bound `/private/tmp/hkl-<random>` alias keeps Unix socket paths short |
| Provider Docker config | `.hack-local/run/smolvm/docker-config`, empty; no global context or credentials |
| Project preview | Canonical source path and derived namespace; no persistent enrollment or runtime ownership claim |
| Future source/data/output | Separate candidate-owned storage, never active v4 volumes |
| Future routes | Dedicated candidate namespace and loopback ports, never v4 route claims |
| Official install/config | Unmodified; no `install:dev`, `install:bin`, `bun link`, or `cargo install` in this workflow |

Build and runtime directories are ignored by Git. Inspection does not create them. The build script
creates only build output and Cargo's normal dependency cache. No global HOME override is used by
the launcher. Future provider-process path overrides must not leak into clients or project commands.

Rebuild explicitly after source changes. The binary refuses a different checkout root, but does
not prove that its bytes match every current uncommitted edit. Do not copy built binaries between
worktrees; build each checkout. The version/banner distinguishes the candidate from v4; package
version changes and release installation are deferred.

## Verify the checkpoint

```sh
cargo fmt --manifest-path packages/runtime-core/Cargo.toml --check
cargo clippy --locked --manifest-path packages/runtime-core/Cargo.toml \
  --target-dir .hack-local/target --all-targets -- -D warnings
cargo test --locked --manifest-path packages/runtime-core/Cargo.toml \
  --target-dir .hack-local/target --jobs 2
./scripts/build-hack-local.sh
./hack-local info --json
```

Contract tests run the real candidate executable with an empty executable search path, synthetic
HOME, poisoned runtime endpoints, a project containing a synthetic secret, and independent
checkout/project paths. They check refusals, no secret disclosure, no project/home writes, and
no fallback to a fake global Hack. These are WU01 proofs, not VM or container isolation proofs.

For a review demo, record the official `hack` executable path and SHA-256 before building, then
compare them afterward. Run a read-only preview against a separate real project and show that its
Git status has not changed. Do not invoke ordinary `hack up` to test this candidate.

Runtime tests begin in WU02 on fresh owned fixtures with admission, watchdog, and cleanup receipts.
Tests against real project services begin only after explicit WU03 enrollment and WU07 readiness.
No test should overlap another stateful test's provider instance, ports, daemon, or containers.

To discard WU01 artifacts, first verify that only WU01 has run; its `.hack-local` contains build
outputs and no live runtime. Later checkpoints require ownership-checked shutdown before any state
removal. Do not introduce a broad deletion command or remove retained data as routine cleanup.


## WU02: prepare and inspect the private runtime

The Mac adapter currently requires Apple Silicon, native permission to use the hypervisor, and
Python 3 for the manual fixture only. Its implementation and live evidence are separate; see
[checkpoint 02](checkpoint-02.md) before treating this as a qualified development environment.

Download the exact archives in [provider-pins.json](../../../packages/runtime-core/provider-pins.json)
into an ignored local directory, then pass their paths explicitly:

```sh
./hack-local runtime prepare --archive /path/to/smolvm-1.14.3-darwin-arm64.tar.gz
./hack-local runtime prepare-engine --archive /path/to/docker-29.5.2.tgz
./hack-local runtime probe
./hack-local runtime status
```

Preparation verifies SHA-256 before extraction, verifies the Mac executable signature, and records
the installed tree fingerprint. It does not download packages, boot a VM, change native trust, or
install software globally. A later changed tree is rejected. Interrupted preparation is retained
for inspection; it is not silently overwritten. Digests pin observed releases; signature verification
is not a notarization or hypervisor-authorization claim.

The VM receives only the pinned engine directory as a read-only tool mount. Its guest base is a
private copy of the verified rootfs, with its own readiness marker. Compressed disk templates are
copied into the provider's private HOME so their expansion cannot modify the pinned installation.
Docker data and containerd data use the native storage disk; PID, exec, and socket state use a
separate 1 MiB tmpfs. No project directories, credentials, SSH agent, or application ports are shared.

## WU02: lifecycle demo

```sh
./hack-local runtime up
./hack-local runtime status
./hack-local runtime down
./hack-local runtime up
./hack-local runtime down
```

For fresh capacity, plain `up` applies the research envelope: 2 vCPUs, 2 GiB guest RAM, 4 GiB storage and 4 GiB
overlay; at least 16 GiB free host RAM and 100 GiB free disk; normal memory/thermal status;
load below 8; and stable swapouts over three admission samples 15 seconds apart. There is another
fresh sample immediately before boot. **The 30-second qualification wait is not provider boot
latency.** These conservative test gates are not the final product admission policy.

### Experimental development profile

`runtime probe --profile development` is read-only. `runtime up --profile development` explicitly
selects a separate development allocation: 4 vCPUs, 6 GiB guest RAM, 32 GiB storage and 10 GiB overlay.
Admission requires a 10 GiB **free-plus-file-cache estimate**: the guest allocation, a provisional
2 GiB provider-overhead allowance, and 2 GiB host reserve. This is a budget and a reclaim estimate,
not measured overhead or guaranteed allocatable RAM. The estimate is vm_stat free pages minus
speculative pages (saturating at zero), plus file-backed pages, using the reported page size.
It excludes separate active, inactive, compressed and purgeable totals. Dirty or mapped file pages
may still require reclamation work; normal pressure and stable swapouts remain independent gates.
The raw free-page observation is retained separately. Research admission still uses raw free pages.

Apple's [memory guide](https://support.apple.com/en-gb/guide/activity-monitor/actmntr1004/mac)
describes cached files as reusable system memory. Do not multiply `kern.memorystatus_level` by RAM:
[XNU](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_page.h) includes active
and inactive pages in that pressure-related level on macOS, so it is not spare capacity.
It also requires normal pressure/thermal state, 100 GiB disk headroom, load below the host's logical
CPU count, and unchanged swapouts across three samples one second apart and immediately before boot.

This implements the spec's separation between experiment controls and an explicit development
policy. It does not revise, rerun, or pass the frozen research cohort. Status labels this profile
`experimental-development-not-benchmark-qualified` and reports the native provider process's RSS
and physical footprint separately from configured guest RAM. It does not aggregate unrelated VMs
or prove complete helper/descendant accounting.

Development source-transfer and engine-mutation operations check a 2 GiB free-plus-file-cache estimated host reserve, pressure, swap
stability and the provider's 8 GiB footprint budget at connection and at most two-second intervals
between requests. A failed check blocks further effects and retains partial source state. This is
not a continuous pool governor or automatic shutdown service: live tests need an independent host
watchdog with owned-pool cleanup. Networked applications remain gated; both profiles currently
disable VM networking and the Docker bridge.

An existing pool retains its recorded profile on plain `up`. Selecting another profile refuses
before resizing or replacing anything. Legacy receipts default to the research profile.

The adapter checks native PID/start-time/UID/executable identity, the retained provider configuration,
open disk handles, ext4 UUIDs, guest boot identity, read-only engine mount and executable digests,
the persistent owner marker, and Docker readiness. A changed boot ID with the same owner marker
is the minimal restart readback; it does not prove application/database durability.

`down` checks the guest Docker process identity, requests quiescence and filesystem flush, then
signals only the verified VM. It confirms process exit, VM-lock release, closed disk handles, and
absent socket listeners before writing a stopped receipt. An early failure before engine startup
has a distinct stop path. A failure or timeout retains an uncertain phase and never force-kills or
claims success. No PID-only or argv-substring fallback is used. macOS identity checks followed by
signals are not atomic pidfd operations or hostile-process containment.

`status` does not start, reconnect to, or recover the provider. Unknown process state is JSON `null`,
not a false "stopped" result. `recover` accepts only a confirmed-dead recorded process, validates
owned disks/locks/sockets, and reports `recovered-unclean`. It does not silently claim a clean stop,
adopt an unrecorded process, or erase retained data. Missing identity requires explicit inspection.

For a bounded manual fixture, after preparing packages:

```sh
python3 scripts/test-hack-local-runtime.py
```

The fixture starts only from an uninitialized pool, checks three boot/stop cycles (two clean
restarts), and runs a host-memory/swap/deadline watchdog. `--resume-owned-fixture` permits a stopped
or recovered pool whose receipt the adapter verifies. Each attempt gets new ignored evidence.
Failures retain receipts and attempt owned shutdown; unverified ownership can still require manual
inspection. Read the final receipts rather than treating fixture launch as success.

After the clean-cycle fixture passes, run the separate provider-loss check on the stopped pool:

```sh
python3 scripts/test-hack-local-runtime.py --resume-owned-fixture --crash-recovery
```

This manual mode needs Cargo on PATH. Its normally ignored Rust test verifies ownership before
sending provider TERM without guest quiescence, refuses recovery while the provider is alive,
recovers after confirmed exit, checks the data marker on another boot, and stops the pool.
It does not simulate a physical power failure or prove application database durability.

The current pool has no project workloads. Keep real project enrollment behind WU03 and full
graph/data qualification behind WU07. The separate native Linux adapter remains WU09 work.


## WU03: review and enroll a project

See the [Compose subset](compose-subset.md) for accepted declarations, redaction, source selection,
and refusal rules. Use an explicit root and file:

```sh
./hack-local project plan --project /absolute/project --file docker-compose.yml
./hack-local project plan --project /absolute/project --file docker-compose.yml --json
./hack-local project enroll --project /absolute/project --file docker-compose.yml --expect-plan <review-id>
./hack-local project status --project /absolute/project --json
```

Review the service graph, source exclusions, proposed loopback ports and compatibility findings
before passing the plan ID to enrollment. Enrollment rechecks the source and writes a receipt only
inside this checkout's private workspace namespace. It does not read environment-file values,
copy project source, start the provider or create application resources. Repeating the same plan
is idempotent; a different existing enrollment is preserved and refused. Replacement is deferred.
[Checkpoint 03](checkpoint-03.md) records the local tests and real-project readback.

## WU04: durable host fixture jobs

Build this checkout with `./scripts/build-hack-local.sh`, then explicitly run:

```sh
./hack-local node serve
```

In another terminal, `./hack-local node status` returns the node target and current mutation
generation. `./hack-local node inspect` reads the same journal without contacting or starting the
service. The [WU04 contract](wu04-contract.md) defines version 1 and its bounds.

Submit with `./hack-local node request '<JSON request>'`. Fill `target`, `expected_generation` and
`principal` from node status and your numeric `id -u` result:

```json
{
  "version": 1,
  "action": "submit",
  "mutation": {
    "operation_id": "my-first-fixture",
    "expected_generation": 0,
    "target": "REPLACE_WITH_NODE_TARGET",
    "principal": 501,
    "required_capabilities": ["fixture_jobs_v1"]
  },
  "fixture": "success",
  "queue_timeout_ms": 5000,
  "execution_timeout_ms": 2000
}
```

The CLI supplies an omitted digest. Save the exact request and returned `job_id`; after an uncertain
acknowledgement, retry the same request, including its original expected generation. Do not fetch a
new generation and silently change a retry. A new operation ID represents a new mutation.

Retrieve a job with `{"version":1,"action":"result","job_id":"RETURNED_JOB_ID"}`.
Cancel it with action `cancel`, the job ID and a new mutation envelope using the current generation.
Cancellation acceptance only persists the request; inspect the job's terminal receipt to establish
cleanup.
The client waits up to 30 seconds for an operation reply to begin, allowing immutable input
verification. Once the response starts, its frame still has a one-second transfer deadline and
the existing size limit. An expired wait does not prove rejection; retry the same sealed request. Available fixtures are `success`, `failure`, `output` and the TERM-resistant `tree`.
They execute inside private candidate state and do not consume project code or ambient secrets.

Ctrl-C stops the foreground node. Existing supervisors finish independently; explicitly restart
`node serve` to reconnect. An absent supervisor or uncertain cleanup becomes `quarantined` and
blocks additional execution. For a quarantined source job only, an explicit `reconcile_source`
request uses the job ID and a fresh mutation envelope requiring `source_job_reconciliation_v1`.
It refuses an active supervisor, verifies owned container identity, deletes only that container,
and confirms absence before committing `reconciled_unknown`. It never replays the job or claims
its application outcome is known. A lost reconciliation acknowledgement retries the same sealed
request. Host fixture reconciliation and receipt deletion remain unsupported.
[Checkpoint 04](checkpoint-04.md) separates the tested local cases from later integration gates.

## Required real-project attempt

At every checkpoint, follow the [real-project acceptance matrix](real-project-checkpoints.md) using
Event Agent's actual `.hack` configuration. Record unsupported and blocked workflows explicitly.
The two-service root Compose file and built-in node fixtures cannot satisfy this gate.

Development uses the pinned overlay template's 10 GiB logical size. Smaller requests need a host
ext4 shrink tool; the provider can otherwise log formatting failure and continue with an oversized,
unmarked disk. The candidate now rejects an allocation/format mismatch and stops its verified
provider process without adopting changed disks. This is an unclean failed boot, not a clean stop.

### Source synchronization in progress

`project sync-source --project <path> --file <compose-file> --expect-plan <review-id>` applies
source to a guest-native working tree. Add `--watch` for native FSEvents/inotify notifications;
`--duration-seconds` bounds a foreground watch session. Output is JSON Lines with the acknowledged
revision, payload bytes and elapsed time. `project sync-status` reports the last persisted acknowledgement,
not a fresh inspection of a running application. Saved receipts remain readable while the provider
is stopped; status validates receipt parents as directories and the receipt itself as a private
regular file. Symlinked or hard-linked receipts are refused. These commands cannot start an application graph.

Sync receipts separate preparation, transfer, guest apply and cleanup time. Each apply transfers
one fixed-name envelope containing the delta archive and before/after/apply scripts. Compressed
and decoded hashes are checked before extracting it into the owned staging directory; the source
archive is still extracted separately and the whole guest tree is verified before acknowledgement.
After a verified apply, its complete verifier is retained outside the watched tree. A later normal
apply reuses that prior verifier only after matching its expected SHA-256, then checks the staged
copy again before execution. Missing caches are regenerated; altered caches fail closed and require
explicit reconciliation. Reconciliation regenerates verification from recorded manifests. A client
that does not update this cache can require reconciliation on a later upgrade. No source-tree check
is skipped. Interrupted envelopes remain subject to explicit reconciliation and owned staging cleanup. Compressed payload bytes
include the delta archive and verification metadata; they exclude base64/framing overhead and must
not be confused with changed source-file bytes. Transfers verify compressed and decoded hashes.

A per-workspace lock permits one host writer. Each apply verifies the prior guest tree, transfers
changed file content, retains the watched root, verifies the resulting tree, and then acknowledges.
Host intent is persisted before transfer. An interrupted apply remains pending; `--reconcile`
rebuilds tracked source paths and refuses unknown guest paths. Staging belongs to recorded operations
and is removed after successful apply; at most eight interrupted operations are retained. At that
limit, explicit reconciliation first acquires the guest apply lock and retires only owned staging.

The current implementation inventories and hashes the selected host tree after each coalesced native
event. Only changed file bytes cross the VM boundary, but host hashing is not yet incremental.
The actual-source container kernel-event observer passed atomic replacement, deletion and restoration,
reading only materialized event output. The guest root inode remained stable. Two-byte edits took
3.7–6.5 seconds to acknowledge in that run because whole-tree verification remains expensive.
Performance and the complete WU05 negative-case matrix remain acceptance gates.

Live source checkpoint: the actual Event Agent capture reached an isolated read-only container,
matched all captured file hashes, rejected input writes, and confirmed owned container/image cleanup.
The development VM restarted/stopped with stable disk identities, normal memory pressure and unchanged
swapouts. This proves source plumbing, not Event Agent application startup or research qualification.


## Explicit image input for source jobs

The experimental runtime load-image command accepts an explicit flat, single-image tarball from
crane, an expected archive SHA-256 and an expected sha256: configuration ID. It bounds compressed
input to 256 MiB and expanded layers to 2 GiB, validates manifest membership, Linux ARM64
configuration and every expanded layer hash, then loads through the owned engine socket. It does
not contact a registry or read Docker credentials/contexts. Image-load intent is durable before
the engine request; a lost reply requires content-ID readback, and an unresolved load on the same
boot is not automatically replayed. Imported images remain in the candidate cache.

This is a development bootstrap interface, not the WU07 application image-resolution workflow.
The exact pinned application image has been acquired privately; live load and application-test
acceptance remain pending in the current checkpoint.

## Immutable publication failure boundary

Publication uploads the archive, file checksums and full-tree verifier into a private `.pending`
directory. It verifies their hashes, extracts and verifies the complete manifest, makes the tree
read-only, and only then renames staging to the final revision path. The host publication receipt
is written after the final guest verification. A failed transfer retains staging and has no accepted
receipt; an ordinary retry refuses that staging directory.

Use `project publish-source --reconcile` with the same current `--expect-plan` to retry an
interrupted publication. Before guest effects, publication records a private host intent bound to
the checkout, provider incarnation, namespace and exact source/archive. New staging includes a
matching ownership marker. Reconciliation requires both records, retains the entire failed staging
directory as `<revision>.retained-1` through `-8`, then starts a fresh verified publication. It never
deletes retained evidence. Exhausted retention, foreign/aliased ownership, conflicting intent and
legacy partials lacking a matching marker are refused. A crash after retention can be retried;
if a crash leaves staging without its ownership marker, automatic recovery remains refused.
Do not remove pending directories to force a retry. Retained-directory garbage collection and
crashes during retention/cleanup remain separate acceptance gates. A real publisher kill after
upload and public CLI reconciliation passed in the September 14 checkpoint.

Reusing a completed revision verifies the existing verifier and content without rewriting either.
A missing or corrupt verifier fails closed, including incomplete final directories left by earlier
candidate versions. Reuse does not silently repair them or replace a prior host receipt.

Native watcher tests exercise a 512-file editor-style burst and separately saturate the one-slot
notification queue with 100,000 injected events. Rescan and error callbacks retain the explicit
reconciliation signal even when that slot is already full; excluded paths remain quiet. These
checks do not establish actual kernel-overflow behavior or end-to-end application reload latency.


## Engine observation during jobs

`runtime engine-info` uses a dedicated read-only observer and does not acquire the supervisor's
mutation lock. It reads only the fixed engine version endpoint, verifies the provider process,
disks, boot configuration and owner identity, and rejects a lifecycle change around the read.
It can therefore inspect a running engine while a source job holds the mutation lock. It cannot
execute guest scripts or allocate/start/delete engine resources. Mutation serialization is unchanged;
concurrent graph mutation and service-level status/readiness remain separate implementation work.


## WU07 infrastructure qualification

The manual `owned_graph_storage_live` test uses a pinned Bun image and a candidate-owned internal
bridge, named volume and init/web/check containers. It verifies service-name HTTP, a SQLite marker
across VM restart, and removal of its exact labelled resources. It is not a user-facing graph
executor, host-loopback routing, or actual Event Agent acceptance.

The bundled Alpine 3.19 guest lacks packet-filter tools needed by Docker's embedded DNS. Runtime
boot now reads four pinned APKs from `.hack-local/providers/network-tools` before starting Docker.
The directory must be private (0700), with private (0600), singly linked regular archives. Every
boot verifies host hashes; initial installation also verifies guest hashes and Alpine signatures,
and installs without network access or package scripts. Supply these public inputs from
`https://dl-cdn.alpinelinux.org/alpine/v3.19/main/aarch64/`:

| Archive | SHA-256 |
| --- | --- |
| iptables-1.8.10-r3.apk | 31ab6343f1f3d0fbbf290c4dcf0430b2d08e8073e516e13530dfab25b097d467 |
| libmnl-1.0.5-r2.apk | d15e6313880bdd14959f42c1556b4a810ef4894992ae9f73b148126f0cc6021d |
| libnftnl-1.2.6-r0.apk | ec1c2b02869fc65bcf7a1105e3a7ac5df1bd9a8bd8b399cb6cf650dd3112c021 |
| libxtables-1.8.10-r3.apk | f0accefde240ece6722479b46cb014d7d2f745af7d796e8eec3ced53571e1088 |

The normal daemon settings retain disabled default bridge, forwarding and masquerading. The
experimental nftables daemon switch was tested and reverted after engine startup failed; it is not
enabled by this checkpoint. Networking packages belong to the candidate guest and persist across
ordinary shutdown; the graph probe no longer installs or removes them. A private guest receipt
binds the runtime owner and package set, installed-file hashes and complete package inventory.
Boot refuses unowned packages, changed receipts/files/inventory, incompatible guest bases and
incomplete installation receipts. Interrupted installation is retained for diagnosis; automatic
repair/removal and distribution qualification remain open in the WU07/WU11 queue. Missing host
archives fail boot without starting Docker; there is no implicit download.
Engine startup failures now report fixed categories from a bounded log tail, without emitting raw
log lines.


## Dependency execution core

`project::execution` compiles dependency conditions from a compatible review plan with explicit
per-service readiness goals. It validates missing dependencies, cycles and budgets before any
driver call, records intent before each start, observes readiness, and stops on failed/uncertain
starts, journal failure, unhealthy services or deadline expiry. It does not retry effects.
The driver contract requires durable reservations and exact resource-identity verification.

The manual graph probe uses this shared loop with an owned Docker fixture driver and private event
journals. Its init must complete successfully, its web service must pass its Docker healthcheck,
and its HTTP check must complete. A failed-init control must leave web/check containers absent.
This is the execution core, not a public Compose executor: build/managed-secret delivery,
durable production resource recovery, service observation and routing remain open.
Review plans continue to redact values and report runtime execution unsupported.


## Executable input compilation

`project::inputs::compile` re-plans the project, requires the caller's exact reviewed plan ID,
and verifies the Compose bytes before and after compiling active-service executable values.
Values are held in structures without `Debug` or `Serialize`; only the redacted review can be
saved. Compilation creates no runtime state and executes no shell or image build.

The initial subset preserves null/inherit versus explicit empty argv overrides, resolves argv
commands/entrypoints, user, scalar/list environment entries and CMD/CMD-SHELL health tests.
Interpolation accepts `$NAME`, `${NAME}` and literal `$$`, using only the explicitly supplied
map. Resolved values are not recursively interpolated. Missing inherited values fail closed;
the compiler does not consult process environment or dotenv files. It rejects NUL and limits
expanded values to 1 MiB, with at most 4096 entries per argv list. Simple command strings use
bounded word splitting. Interpolation operators/defaults, builds and env_file delivery remain
explicit implementation gates. This shared interpolation map is for non-secret values only: it
can populate argv and engine configuration.

The live fixture feeds in-memory program values through a reference-only Compose file, then uses
the compiled commands, environment and healthcheck in its owned Docker driver. Saved review and
event files contain no program or environment values. Its non-secret sentinel verifies delivery;
this does not qualify managed-secret delivery, since production Docker environment persistence
and inspection must be addressed separately before actual application credentials are supplied.

### Service-scoped environment compilation

`project::inputs::compile_scoped` accepts separate non-secret interpolation values and managed
values indexed by service and variable name. A managed value must match a bare list entry or null
map value on an active service. Missing values, unknown/inactive services, undeclared variables,
Compose-owned literal overrides and names shared with the interpolation map are refused. The
same variable name may have distinct values on different services. Values are copied verbatim,
including empty strings and newlines, subject to NUL rejection and the shared 1 MiB expanded budget.
No ambient lookup, provider invocation, filesystem write or runtime operation occurs.

Managed values are returned separately from `ServiceInputs.environment`, command, entrypoint,
health test and user. Neither result type implements `Debug` or `Serialize`. Reviews and errors
contain no supplied values. The executable result retains a private delivery-required flag:
`graph::config::prepare` refuses it even when its public environment is empty. Dropping the managed
map therefore cannot silently start a graph with missing delivery.

Synthetic regression tests cover separate service values, public field isolation, every executable
interpolation field, conflicting/missing ownership, NUL/size refusal and the graph refusal. This is
an in-memory input contract, not live managed-secret delivery. Ordinary Rust strings do not promise
memory zeroization. Native provider selection, scoped leases/expiry, a verified ephemeral guest
transport, entrypoint and health-check behavior, restart/redelivery and owned cleanup remain open.
No actual credentials are used by these tests, and the graph CLI still refuses environment delivery.

### Guest transport before managed delivery

Guest command failures now retain the failure code and a numeric exit status only. Guest stderr,
stdout and malformed metadata are never interpolated into errors: a failed command can echo its
input, so redacting only the original request is insufficient. Successful stdout remains available
for existing public receipts; this is not yet an API for confidential output or managed delivery.

Requests are encoded through a bounded writer and refused above the 64 KiB wire limit before
opening the guest socket. JSON escaping counts toward that limit. This does not bound memory
already owned by the caller or erase in-memory values. Responses retain the same frame limit and
wall-clock deadline. Nonblocking reads with deadline-bounded polling accept a complete reply even
when the peer immediately closes, while incomplete replies and stalled reads fail closed.

Synthetic tests cover echoed failure values over a Unix socket, malformed response fields,
successful public receipts, exact/oversized/escaped frame boundaries and stalled response deadlines.
No real secrets are supplied. Audit of guest-agent request logging/storage and an ephemeral,
service-owned delivery mechanism remain required before credential-provider integration.

## Owned graph CLI (development profile)

The candidate now has explicit `graph run`, `graph inspect`, `graph restart` and `graph cleanup`
commands. `graph run` requires a fresh 32-character lowercase hexadecimal attempt ID, the exact
reviewed plan ID, and one readiness goal for every active service:

```sh
./hack-local graph run --project /path/to/fixture --file compose.yaml \
  --expect-plan <reviewed-plan-sha256> --run-id <fresh-32-hex-id> \
  --ready init=completed --ready web=healthy --ready check=completed
./hack-local graph inspect --run-id <same-32-hex-id>
./hack-local graph reconcile --run-id <same-32-hex-id>
./hack-local graph restart --project /path/to/fixture --file compose.yaml \
  --expect-plan <same-plan-sha256> --run-id <same-32-hex-id> \
  --ready init=completed --ready web=healthy --ready check=completed
./hack-local graph cleanup --run-id <same-32-hex-id>
./hack-local graph cleanup --run-id <same-32-hex-id> --remove-data
```

Source-backed graphs additionally require `--source-revision <published-sha256>` on run,
restart and restore. First review the isolated project, run `project sync-source` and
`project publish-source` with that exact `--expect-plan`, then pass the returned revision to the
graph command. Declare source as an ordinary read-only Compose mount such as `.:/app:ro`.
The driver resolves it to the filtered, verified guest publication; it never mounts the host tree.
Selected regular files are supported. Symlink mount roots and subdirectory mounts containing
symlinks are refused; mount the full selected tree when its internal links are required.
Excluded credential/generated paths stay excluded.

The receipt records source revision, archive digest and selection digest before resource creation.
Fresh runs require the current acknowledged source revision. Restart and restore reverify the
accepted publication and require the same binding and unchanged reviewed plan. No-source graphs
must omit the flag; old receipts preserve their serialization. Normal owned VM restart retains the
provider identity and publication; a foreign provider incarnation remains refused. A changed host
selection currently requires a new review/attempt; restoring an old graph across arbitrary source
edits is not supported. Cleanup does not require readable source and never removes its publication.
Publication retention/GC, writable build outputs and live reload remain separate work.

`graph inspect` also returns `guest_endpoints` for currently healthy native-HTTP-probed services
in a committed ready graph. Each entry binds the probe port to the observed container ID, network ID
and private IPv4 address, checking membership from both directions. Incomplete journals, stopped
services and inactive receipts do not advertise destinations; inconsistent attachments fail closed.
These destinations are **guest-only and not reachability-tested**. A successful loopback health
probe does not prove that the application listens on its guest network interface. This observation
does not bind a host port, create a Caddy route or authorize a later connection to a cached address.

The initial driver requires the explicit development VM profile, pinned local `sha256:` image IDs,
read-only roots, at most 32 services, one internal bridge and eight named volumes. The runtime metadata
tmpfs is bounded to 16 MiB and 4096 inodes; capacity is consumed on demand. Defaults are
0.5 CPU, 256 MiB RAM and 64 PIDs per service; total requested limits cannot exceed four CPUs or
4 GiB RAM. Container logs are limited to one 1 MiB file and `/tmp` to a 16 MiB tmpfs. It rejects
builds, unbound or writable source mounts, port publication, environment delivery, automatic restart, and
user label/logging overrides. The CLI supplies no ambient interpolation values. The provider mutation lease serializes workload admission with allocation. An active or uncertain
graph receipt blocks source-job admission and launch as well as competing graph allocation. Any
retained source-job container blocks graph creation/restart and another source launch until it is
explicitly reconciled. Ordinary graph cleanup releases compute admission while retaining named
data. This conservative single-workload policy does not yet provide concurrent resource scheduling. Receipt retention is capped at 64
active attempts. `graph archive --run-id <id>` moves a fully removed attempt, including its
recovery history, into `.hack-local/run/graph-archive/<id>/`. It refuses pending journals, retained
data or any remaining resource. The archive is bounded at 256 attempts, preserves receipt bytes,
and prevents reuse of archived IDs. Archived receipts are read as evidence at that path; the
active graph commands do not mutate them. `graph export --run-id <id>` writes a private,
deterministic tar of the archive's regular-file evidence to `.hack-local/exports/graphs/<id>.tar`
and returns its SHA-256, byte count and file count. It requires the owned engine for identity
verification and retains the original archive and consumed ID. Export refuses overwrite, symlinks,
hard links, public files and changed/oversized inputs. Limits are 128 total entries, three nested
directory levels, 1 MiB per file and 16 MiB of file contents. Permissions/timestamps are normalized;
this is an evidence export, not a filesystem backup/import. Partial output stays `.pending` and
blocks retry. `graph reconcile-export --run-id <id>` retains the pending bytes in one of eight
private recovery slots before allowing a fresh export; it never publishes interrupted bytes.
`graph prune --run-id <id>` requires an exact verified export, commits a consumed-ID record under
`.hack-local/run/graph-consumed/<id>/`, then removes only matching original evidence. The export
and consumed ID remain. Repeating prune resumes verified partial deletion; a partial consumed-ID
publication is retained and rebuilt only while the original archive still exactly matches its
export. Altered or missing exports block pruning. Consumed records are capped at 4096; this is
not permission to delete them or to reclaim exported bundles.

Private receipts under `.hack-local/run/graphs/<attempt>/state.json` contain identity, readiness
conditions, ownership and phase metadata; they do not contain commands or environment values.
Every create has a prior durable name reservation. Container IDs are saved before start intent,
and uncertain effects are retained without retry. Inspection verifies labels, names and recorded
IDs using the private engine socket; `ready-observed` is historical, while `observations` reports
current state. A missing create ID can be inspected/cleaned by its exact reserved name and labels.
Foreign replacements are refused. An incomplete journal blocks mutation. Explicit `graph reconcile`
verifies resources against the last committed reservations, retains the interrupted bytes and their
hash in one of eight private recovery slots, and marks the attempt `reconciled-cleanup-only`. It
never treats partial bytes as execution authority or starts resources. Reconciled attempts can be
cleaned up but cannot be restarted. Unsafe files or exhausted retention slots remain blocked.

Explicit restart requires the unchanged plan and readiness goals, acknowledged prior success,
all resources present, and every container stopped. It reuses recorded IDs and re-verifies the
compiled configuration. It never creates replacement containers for an uncertain start. Ordinary
cleanup removes owned containers/network while retaining named data; `--remove-data` additionally
removes the exact owned volumes. `graph restore` takes the same reviewed project, plan, readiness
and run ID arguments as `graph restart`, but requires completed ordinary cleanup. It preserves
verified named volumes and recreates removed containers/network, rerunning the reviewed init and
service commands. It refuses missing data, changed plans and interrupted attempts. Up to eight
previous receipts are retained under `restore-N/previous.json`; no history is overwritten. This
supports reusing data within the same attempt identity, not transferring it to another project
or applying a changed graph. VM restart with intact containers remains `graph restart`.

`--timeout-seconds` bounds the readiness loop (default 30, maximum 600); individual engine requests
have their own bounded transport timeout. Source/build and managed-secret delivery, graph updates,
loopback routing, and actual Event Agent execution remain open. The current image/platform boundary
is Linux arm64 inside the owned M3 VM, not the selected Hetzner/Linux adapter.


## Native resource accounting and command words

`runtime status --json` includes `provider_resources` while the owned provider is live. It records
native PID/start/UID/executable identities, resident and physical-footprint bytes, CPU nanoseconds,
disk I/O bytes and idle wakeups for the root and its current descendants. Enumeration is bounded at
64 processes and checked again after sampling; identity changes, unavailable observations and budget
overflow return an error rather than a misleading partial total. Stopped providers report null.
The existing `provider_memory` field remains the root-only memory observation.

CPU counters are converted using the native Mach timebase and regression-tested against `getrusage`.
For identical process identities across two samples, compute percent of one core as
`100 * delta(user_cpu_nanoseconds + system_cpu_nanoseconds) / delta(wall_nanoseconds)`.
Do not divide by host core count or describe cumulative CPU time as a percentage. Changed identities
require a new interval. This live tree does not account for exited/reparented helpers; memory sums
can include shared pages. Instrumentation, transient CLI children, and shared external engines need
separate accounting. A resource snapshot is not an atomic lifetime trace or a pressure guarantee.

Executable Compose command/entrypoint strings now support bounded word splitting: whitespace,
quotes, empty arguments, concatenated quoted words, Unicode and backslash escapes. They are not
implicitly executed by a shell. Unquoted control operators and backticks are refused; use explicit
argv, or explicitly invoke a shell with its script quoted as one argument. Unclosed quotes, dangling
escapes and more than 4096 arguments are refused. Interpolation still uses only explicitly supplied
inputs; operators, build and env-file delivery remain separate gates. The recorded Compose 5.1.2
reference cases are in `packages/runtime-core/tests/fixtures/compose-argv.json`.

Health checks also preserve Compose `start_interval` as an optional reviewed value and deliver it
to Docker as `StartInterval`. For example, `start_period: 10s`, `start_interval: 100ms`, and
`interval: 1s` allow frequent startup probes followed by a slower steady cadence. These settings
are explicit project inputs; the candidate does not rewrite existing defaults. A slower steady
cadence also delays detection of later failures. Plans without this field keep their previous
health serialization, so adding support does not change their identity by inserting a null field.

## Experimental application socket relay

The optional `native-stream-relay` feature builds a bounded single-process Unix-to-TCP relay.
It is absent from the default build and has no route CLI or automatic lifecycle integration.
The [isolated socket bridge qualification](socket-bridge-20260915.md) proves HTTP transport through
SmolVM without enabling general guest networking; it records ownership, recovery and credential
delivery gates before actual application use.

The [persisted provider capability audit](provider-config-audit-20260915.md) supplements the boot
snapshot before startup and guest access. Unexpected socket/SSH forwarding and hidden launch inputs
are refused without returning their contents. Diagnostic status and owned shutdown remain available.

Fresh experimental pools built with `native-stream-relay` can reserve private transport slots with
`runtime up --profile development --bridge-sockets <1..32>`. Capacity is recorded before creation
and cannot change in place. See [explicit bridge intent](application-bridge-intent-20260916.md) for
qualification and remaining graph routing gates. The default pool/build remains unbridged.
