# Runtime performance diagnostics

Use bounded, repeated measurements against the same inventory. Record CLI version,
container IDs, daemon freshness and the workload window. A healthy endpoint is not
evidence that every project is fast. Avoid treating stopped containers, large RSS,
or bind mounts as a cause without measuring the associated work.

## Project listing

```sh
hack projects --json --summary --timings
hack projects --json --summary --timings --no-daemon
hack projects --json --project my-project --timings
hack daemon status --json
```

`--summary` returns project identity and status, service/container/branch/session
counts, and a separate lifecycle host-process count. The default JSON response
retains its full detail contract. Load one project's details with `--project`;
`--summary` cannot be combined with `--details` or `--meta`. Older daemons without
summary support fall back to direct discovery.

`--timings` writes numeric profiling JSON to stderr and preserves JSON stdout.
Phases include current-checkout registration, Docker listing, inspect/cache lookup,
lifecycle discovery, registry reads/updates, project views, optional metadata,
projection and JSON serialization. The measured handler duration excludes CLI
startup and downstream stdout consumption. Daemon reads report request phases and
cache age separately from the last refresh's phases. With older daemons these
server-side timings may be unavailable.

The daemon `/v1/metrics` endpoint includes `last_refresh_phases_ms`,
`last_projects_serialization_ms`, and `last_projects_response_bytes`. These describe
the most recent operations, not an aggregate benchmark. `/v1/projects` accepts
`summary=true` and `profile=true`. A summary and `include_meta=true` are incompatible.
Docker inspection requests only the runtime model's fields; environment values and
container command arguments are not fetched for listing.

## Host commands and container usage

```sh
hack host ps --json
hack usage --project my-project --details --json
hack usage --project my-project --details --watch
```

Host tracking, timeout and persistence semantics are described in [env.md](env.md).
`usage --details` adds individual container CPU, memory, I/O, PID counts and mount
types/locations to JSON, plus a per-container table in human output. The project
filter includes its branch instances. Stats requests exclude stopped containers
and synthetic lifecycle entries. Verified tracked host command trees also appear
in host usage groups. The project filter also scopes these command groups and
their totals, including branch instances. Shared host infrastructure remains
visible; reporting does not transfer ownership of other processes.

For a deeper, explicit read-only probe from this checkout:

```sh
bun scripts/inspect-container-resources.ts --container <id-or-name>
bun scripts/inspect-container-resources.ts --container <id-or-name> --runtime node
bun scripts/inspect-container-resources.ts --container <id-or-name> --storage
```

The probe reports selected Docker metadata, cgroup memory/current/peak/anonymous
and file counters, OOM events, cumulative CPU, process RSS and inotify watch-entry
counts. It requires Bun or Node inside a running container. Unsupported runtime,
procfs/cgroup access or stopped containers are reported as unavailable; the script
never starts containers. Process enumeration is capped at 128 processes and 4096
file descriptors with a three-second scan budget. The observer's RSS is reported
separately, but its allocation still affects cgroup totals. Watch entries are
counts, not necessarily unique files or proof that watching is expensive. No argv,
environment, application files or output logs are read by the probe.

Compare at least two CPU/memory samples: cumulative counters alone cannot establish
current load or a leak. Inspect anonymous memory, file cache and OOM events before
changing limits. Frequent healthchecks against a full application route can trigger
rendering/database work; use measured request costs to decide whether an application
should provide a cheaper readiness route.

## Watchers and caches

Use mount metadata and actual watch counts before adding volumes or ignore rules.
Measure the same tracked source-file reads on the host and in the container, with
identical file counts and bytes. Repeated reads measure warmed behavior; do not
call the first observed read cold without controlling caches. Do not flush system
caches or write benchmark files into an active source tree as a default diagnostic.
A shared source bind across many services establishes fan-out, not its CPU cost.

## Stopped containers

```sh
hack projects prune --dry-run --json
hack projects prune --project my-project --dry-run --json
```

The preview uses existing registry/runtime ownership and missing-path checks, and
changes nothing. It reports candidates, not proof that their writable data is
safe to discard. A missing working directory might require further review of
worktree ownership or disconnected storage. Existing `projects prune --json`
without `--dry-run` applies cleanup, so use the preview explicitly.

The resource probe's `--storage` option adds writable-layer size and changed-path
prefix counts. Sizes exclude named-volume data and are not exact reclaimed disk
space. Large changes outside declared volume destinations may be application data;
review or preserve them before removal. Successful dependency/setup containers can
legitimately be stopped. Cleanup can recover storage and reduce inventory work;
stopped containers do not execute CPU work. Never infer that broad pruning is a
CPU remedy.

## MCP session overhead

The standard `hack mcp serve` launch loads the MCP implementation without initializing
the rest of the command graph. Additional arguments retain normal CLI parsing,
including help, version, global flags and invalid-option errors. Each connected stdio
client still has its own server process.

For a bounded native comparison, build the revisions into separate executable paths,
then run the repository harness:

```sh
python3 scripts/benchmark-mcp-sessions.py \
  --executable /path/to/baseline-hack \
  --compare-executable /path/to/candidate-hack \
  --output /tmp/hack-mcp-sessions.json
```

It alternates revision order over three trials at 1, 8 and 32 clients, verifies
initialization and tool discovery, samples a two-second idle window, and closes all
owned sessions. It uses isolated temporary homes and invokes no project tools.
The default aggregate RSS ceiling is 3 GiB; `--rss-ceiling-mib` can set a bounded
256–8192 MiB ceiling when host capacity allows. Failed cohorts retain their cleanup
results. This ceiling is checked after initialization, not enforced as an OS memory
limit. `--settle-seconds` delays the idle sample when separating startup work from
steady activity. RSS counts shared pages repeatedly; `ps` CPU-time resolution and the short
idle window limit conclusions about steady CPU use. These are MCP transport/session
measurements, not Compose, container-start or real-application benchmarks.


## Owned shared-MCP benchmark

For the experimental native adapters/shared backend, build the current stdio CLI,
`hack-mcp-adapter`, `hack-mcp-owner` and standalone socket backend once at stable
paths. Then run `scripts/benchmark-mcp-adapter.py --stdio <cli> --adapter <adapter>
--backend <backend> --owner <owner> --output <private-report.json>` with Python 3.
The default three trials alternate 1/8/32-client fresh-process cohorts, include the
owner exec handoff in shared startup, verify tool-schema parity and check cleanup.
This measures initialization/discovery and short idle activity, not application or
Docker performance. OS caches are not flushed; RSS sums are not physical footprint.

The owner-aware path requires private receipt publication and preserves startup
failures even if cleanup also fails. Run its negative controls with
`python3 -m unittest discover -s tests/python -p test_mcp_benchmark.py`.
Store raw reports under ignored `.hack-local/runs/` or local planning evidence.
Measure first use of new executable paths separately from steady repeated use;
reuse verified artifacts across sessions/worktrees instead of copying executables
to a fresh directory per client. Retain first-use outliers in the report, and do not
claim a specific OS cause without tracing it.

### Experimental managed MCP startup

The native adapter also accepts an explicit managed mode:

```sh
/absolute/hack-mcp-adapter \
  --socket /absolute/private-backend-directory/mcp.sock \
  --backend-id candidate-build-id \
  --owner /absolute/hack-mcp-owner \
  --backend /absolute/compiled-socket-backend
```

Create the backend directory with user-only permissions first. Use the same stable
executable paths and backend identity for clients sharing it. The backend executable
is the compiled `scripts/run-mcp-socket-backend.ts` entry point. This experimental
mode does not modify installed Hack or any client configuration.

A healthy endpoint is reused. Otherwise the native owner acquires the existing
lease and performs witnessed recovery before launching the backend independently
of the client. Managed mode includes a temporary startup supervisor. The adapter clears the launch environment; each client's cwd/env is
transferred only after peer and protocol identity checks. Native owner `--detach`
returns after detaching, not after readiness; exit 75 denotes lease contention in
this mode. The adapter retries that condition during a ten-second startup window,
including the interval between an old backend removing its socket and releasing
its lease. Other launcher failures are reported. A connect attempt can add up to
five seconds, followed by the existing five-second handshake deadline. Filesystem
syscalls and process reaping are not hard real-time bounds.

Closing the first client leaves other clients connected. The standalone backend
retires after 60 seconds without clients; ownership cleanup preserves the reusable
zero-byte lease. Adapters never replay requests or kill the shared backend on a
client timeout. They reap only their direct launcher. Crashes before a valid receipt
still require investigation rather than automatic deletion. The startup supervisor separately waits up to eight seconds for a readiness
request, then kills and reaps only its ungranted direct child on timeout. It invokes
witnessed recovery while still holding the lease. Ambiguous pre-receipt state is
preserved. This is separate from the adapter's timeout. Existing
resource measurements used explicitly launched backends; measure managed startup
separately before attributing those numbers to this mode.

Run managed-startup regressions with `HACK_MCP_ADAPTER_TEST_BINARY`,
`HACK_MCP_OWNER_TEST_BINARY` and `HACK_MCP_BACKEND_TEST_BINARY` pointing to current
compiled artifacts, then `bun test tests/mcp-managed-startup.test.ts`. These tests
use isolated directories and short fixture-only idle timeouts.

During managed startup, SIGINT/SIGTERM now trigger direct-launcher cleanup before
the adapter restores and redelivers the signal. Once startup returns a connection,
normal relay signal behavior resumes; other clients keep their shared backend.
This does not handle SIGKILL. The startup supervisor relinquishes kill authority
before sending an inherited-channel grant; the backend requires that grant after
receipt publication and before admitting sessions. A failed grant write never
re-arms killing or triggers post-grant recovery. The supervisor then exits without
a resident helper. Native `--supervise` uses a versioned backend argument prefix;
use the matching current compiled backend. Its child has separate null stdio, so
it cannot retain the supervisor's command output pipes. If the supervisor itself
is lost, a backend reaching the grant exchange refuses EOF; a backend stuck before
that exchange can remain stalled. That recovery gap, pre-receipt ambiguity and
physical syscall bounds still block default-rollout qualification. See
`tests/models/tla/mcp-startup/` for the finite safety contract and its limitations.
When comparing Rust revisions, use separate Cargo target directories or force and
verify a rebuild: a cached build can otherwise leave a binary from another checkout
at the shared output path. Record executable hashes as well as source revisions.

The backend's private startup channel has independent eight-second receive/send
timeouts inherited across exec. A stopped supervisor therefore cannot hold an
otherwise-running backend in its grant read indefinitely. Refusal closes the
channel and removes the backend's witnessed publication state. The supervisor
also rechecks its absolute deadline after poll, rejecting stale queued readiness
after a pause. A stopped supervisor still retains its lease until it resumes or
exits; this change does not authorize stealing that lease. A backend stalled before
the exchange remains a separate recovery gap. Ordinary MCP sessions have no new
I/O timeout: the private startup descriptor closes before session activation.


### Managed MCP measurement boundary

`scripts/benchmark-mcp-managed.py` compares selected CLI stdio sessions with managed
adapters using the compiled `scripts/fixtures/mcp-benchmark-backend.ts` observer.
It records startup readiness, settled RSS, idle CPU and cleanup. The observer adds
private process/exit receipts and uses a one-second fixture retirement timeout;
include these differences when interpreting results. Executable hashes are checked
before and after each cohort.

Tool schemas must match exactly by default. For the stable 4.2.0 comparison,
`--allow-optional-output-truncation` permits only the known additive, optional
Boolean `outputTruncated` output property. Reports preserve raw schema hashes and
compare a separate normalized contract hash; required fields, changed types and
other contract differences still fail. This does not establish general API parity.

The default post-initialization summed RSS ceiling is 3072 MiB. An experiment may
explicitly select `--rss-ceiling-mib 4096` after checking host capacity; reports
record the selected budget. These are experiment stop thresholds, not continuous
memory enforcement or production limits. Preserve any earlier stopped attempt.

Use `--isolated-cgroup` only inside the bounded Linux toolchain: its CPU counters
include exited launcher/supervisor processes, the controller and init, but exclude
the outer VM and host. Native startup CPU is deliberately absent; native idle CPU
uses quantized process counters. RSS sums can count shared pages repeatedly.

Benchmark clients use private homes, an empty executable search path and an
unavailable Docker endpoint. An untimed real projects-list call is pinned to the
selected CLI and must return zero projects with an unavailable runtime. Temporary
HOME alone is insufficient: Docker can still discover the host engine. A failed
boundary must not print tool output or count as a valid sample. This synthetic MCP
workload does not measure application startup or Docker/Compose parity.


Managed startup measurements exposed a bind-to-chmod race under concurrent native
clients. Socket creation now temporarily restricts the process mask during Bun's
synchronous Unix listen call and restores it before awaiting readiness. Endpoint
validation remains strict; later command file creation keeps the original mask.
The pre-chmod permission regression also checks ordinary file creation afterward.
Qualify this synchronous-bind assumption when upgrading Bun.


The backend now observes its inherited startup channel before asynchronous
filesystem preparation. Observed EOF, invalid grant or an eight-second startup
deadline prevents later steps from advancing. An in-flight effect is awaited and
its identity captured before cleanup; cancellation does not race a late filesystem
completion. The channel's pending read/write callbacks finish before descriptor
closure, and closure precedes session activation. A deliberately stalled syscall
or blocked JavaScript can still delay this cooperative cleanup; a stopped live
supervisor can still retain its lease. Use matching qualified native owner/backend
binaries: the owner supplies the inherited blocking-I/O timeouts.

The supervised startup capability marker is now `--startup-supervised-v2 --`.
Rebuild the owner and backend together. V1 included owners without inherited I/O
deadlines; accepting that generation would make early channel closure unbounded
if such an owner were stopped. The v2 runner rejects old, unknown and missing
markers paired with a startup channel before creating a claim, socket or receipt.
An old v1 runner likewise refuses a v2 owner. The adapter's existing launch arguments
and explicit unsupervised backend mode are unchanged. A foreground owner receiving
early EOF reports that startup was refused and recommends matching artifacts.
This capability marker is not a build fingerprint. Candidate bundle assembly below
adds exact asset identity. Native candidate packaging includes these opt-in assets;
default client wiring remains separate.

### Candidate MCP bundles

Build the native adapter and owner with the `shared-mcp` Cargo feature, and compile
`scripts/run-mcp-socket-backend.ts` with the pinned Bun. Package the three explicitly
selected local executables together:

```sh
bun scripts/package-mcp-bundle.ts \
  --output .hack-local/bundles/mcp-native \
  --adapter .hack-local/target/release/hack-mcp-adapter \
  --owner .hack-local/target/release/hack-mcp-owner \
  --backend .hack-local/mcp-bundle-backend
bun scripts/verify-mcp-bundle.ts BUNDLE_DIRECTORY
```

`scripts/build-native-candidate.sh` performs this assembly automatically and includes
one `mcp/BUNDLE_ID` selection in the complete native candidate. Prerelease archives
and the side-by-side installer preserve its read-only files and validate the exact
nested payload; older bundles without MCP remain supported. This does not install
any client configuration. Use the explicit `--bundle` and `--cli` selection below.

Assembly queries each executable's `--mcp-artifact-info` using a private home and
cleared environment. Reports must identify the expected role, current host OS and
architecture, startup protocol 2 and wire protocol 1. These probes have a five-second
deadline and an 8 KiB combined output limit. Inputs must be trusted local artifacts;
metadata probing is executable code, not a sandbox or signature check.

The manifest records SHA256 and byte size for each asset. Its content-derived bundle
ID includes those fingerprints and protocol/host fields; use that ID as the backend
identity when wiring a managed adapter. Assembly validates a private staging directory
before publishing by rename. Concurrent identical builds reuse a verified bundle.
Existing invalid bundles are refused, not overwritten; ordinary failures remove their
owned staging directory and preserve earlier bundles. Files are read-only and
directories remain owner-private. Verification rejects changed bytes, wrong hosts,
unexpected files, hard links and final-path symlinks. It checks a snapshot, not future
mutation by another process with the same user privileges.

The assembly scripts do not install a client configuration or change the installed Hack.
Keep adapters as native per-client processes; a resident Bun launch wrapper would
undo their memory savings. Hashing and capability probes belong to assembly and
activation, not every MCP request. Publisher signing/notarization, crash
durability and retention of old bundles remain separate work. A killed assembler may
leave a staging directory; this unit does not authorize broad deletion of artifacts.

For qualification, point `HACK_MCP_ADAPTER_TEST_BINARY`,
`HACK_MCP_OWNER_TEST_BINARY` and `HACK_MCP_BACKEND_TEST_BINARY` at the verified bundle
and run `tests/mcp-managed-startup.test.ts`. Set `HACK_MCP_CLI_TEST_BINARY` to the
absolute candidate CLI to also exercise a real isolated projects-list call. The
fixture uses a short idle retirement timeout, private state, an unavailable Docker
endpoint and no executable search path. Its synthetic 32-client control verifies
context separation; neither control measures application performance or Compose parity.

### Selecting a candidate bundle in a client

Use the built candidate CLI to preview and then install a selected bundle:

```sh
./dist/hack mcp print --claude --scope user --bundle BUNDLE_DIRECTORY --cli /absolute/candidate/hack
./dist/hack mcp install --claude --scope user --bundle BUNDLE_DIRECTORY --cli /absolute/candidate/hack
```

Codex and Cursor use the same options with `--codex` or `--cursor`. `--cli` is
required so tool calls cannot silently fall back to an installed stable Hack.
The generated command is the bundle's native adapter, with absolute owner/backend
paths, the full content-derived backend identity and a pinned `HACK_MCP_COMMAND`.
Preview validates the bundle and executable without creating runtime state. Install
creates a private runtime directory, but starts no backend until a client connects.
The default directory is under `HACK_HOME/mcp` (normally `~/.hack/mcp`), keyed by
the first 16 characters of the bundle identity; endpoint authentication uses all 64.
Use `--runtime-directory` for a shorter path if the Unix socket path exceeds 103 bytes.
Existing non-private or final-path symlink directories are refused without chmod.

Switch or roll back by installing another previously verified bundle. Different
default bundle directories let existing sessions finish on their original backend.
An explicitly reused runtime directory must finish retiring before a different
bundle can use it; identity mismatches do not authorize killing sessions or deleting
state. Empty runtime directories and stable lease files remain for safe reuse.
Client reload/restart behavior remains client-specific.

Ordinary `hack mcp install`, `hack setup mcp`, and `hack setup sync` preserve an
existing Hack entry, including a selected shared adapter and custom client settings.
Repeating setup does not switch the selected backend back to standard stdio. Pass
`--bundle` and `--cli` to select another verified bundle, or remove the selected
entry and reinstall without bundle options to return to standard stdio.

Candidate installation preserves other JSON servers, custom Hack fields and env
keys. Codex updates retain custom Hack values and verify the complete TOML meaning
after replacing its section. Unsupported table layouts, malformed config and HTTP
Hack entries are refused. Comments inside the replaced Hack TOML section are not
preserved. Each client is updated independently; this is not a multi-client
transaction or concurrent-writer/crash-durability guarantee. Bundle validation is
at selection time; do not mutate a selected bundle afterward. Absolute bundle and
CLI paths are host-specific, so avoid committing generated personal configuration.

`tests/mcp-bundle-client.test.ts` opts into installed-client qualification with
`HACK_MCP_BUNDLE_TEST_DIRECTORY`, `HACK_MCP_CLI_TEST_BINARY`,
`HACK_CLAUDE_TEST_BINARY` and `HACK_CODEX_TEST_BINARY`. Supply native client
executables rather than PATH-dependent shims. It uses isolated homes/configuration,
checks Codex configuration discovery and Claude MCP connectivity, calls a real
isolated CLI tool through the generated adapter entry, and observes the normal
60-second retirement. Codex discovery alone does not prove a Codex model session
loaded the server or accepted project trust.

To return a client to the standard stdio launcher, remove the selected scope's
Hack entry and reinstall it without bundle options. For Codex user scope:

```sh
./dist/hack setup mcp --codex --remove --global
./dist/hack mcp install --codex --scope user
```

Use `--claude` or `--cursor` instead of `--codex` for those clients. For project
scope, omit `--global` and use `--scope project`. Removal clears the whole selected
Hack entry, including nested env/tool tables and that server's custom settings.
It preserves other servers and user preferences, and refuses layouts
whose complete parsed result cannot be verified. Ordinary quoted table names are
supported. Inventory parses TOML rather than mistaking a header inside a string for
an installed server. Reinstallation selects `hack mcp serve` from the client's PATH;
verify that PATH resolves the intended Hack version. Config removal does not kill
already-running clients or their shared backend.


### Provider network activation audit

The current isolated pool contract requires `network=false`, no published TCP
ports, and absent/null CIDR and DNS-host policies in the pinned provider record.
SmolVM can activate networking from ports or nonempty policies independently of
the network Boolean. The candidate checks all of these before invoking machine
start, and rechecks the persisted record during running-state audits. Explicit
empty policy overrides are refused too: they are not the captured default record.
The audit emits fixed errors without returning configured hostname/CIDR values.
This preserves the isolated contract; it does not enable guest-to-host egress.

For pinned-provider qualification, capture a newly created, unbooted private
machine record named `probe` with label `hack-local.owner=synthetic-owner`, no
network/ports and no other capabilities. Pass the private JSON record path in
`HACK_TEST_PROVIDER_RECORD` and run:

```sh
cargo test --locked --manifest-path packages/runtime-core/Cargo.toml \
  pinned_provider_default_record_preserves_network_isolation -- --ignored
```

The test accepts the actual default record, then rejects each independent network
activation input. Ordinary regression tests cover missing mandatory fields and
null versus explicit-empty policies. This is record validation, not a live packet
filter test; provider upgrades need fresh capture and runtime qualification.


### Experimental owned gateway intent

The candidate library exposes `up_with_capabilities` with an optional
`NetworkIntent`. New pools default to `Isolated`; omitted selection on reuse keeps
the recorded mode. Old owner records without the field remain isolated. An explicit
mode change is refused before admission and checked again under the provider lock;
no resize, update or adoption occurs. Runtime status includes the recorded mode.

`HostGateway` creates the pool with exactly `--net-backend virtio-net --allow-cidr
100.96.0.1/32`. The provider database and retained running resource configuration
must agree with this intent. Different backends/CIDRs, DNS filters, named networks,
custom DNS and published TCP ports remain refused. Gateway mode permits the
provider's host-loopback translation across ports; it does not authenticate a host
listener or authorize service aliases. The graph's internal-only networking
requirements are unchanged.

This is an experimental library API, not a CLI default or application compatibility
claim. Candidate-owned boot/restart, container NAT and stale-endpoint qualification
are still required. The default and gateway serializer checks use fresh private
unbooted records from the pinned provider. Supply `HACK_TEST_PROVIDER_RECORD` and
`HACK_TEST_PROVIDER_GATEWAY_RECORD` to run the ignored `pinned_provider_` tests.
Do not use a global provider database for these fixtures.


The ignored native test `owned_gateway_pool_restarts_without_widening_intent`
qualifies the experimental API with a fresh candidate root selected by
`HACK_LOCAL_TEST_ROOT` and an external pressure/time watchdog. It refuses an
already-initialized runtime, uses the unchanged development profile, and checks
loopback HTTP through the gateway, mode-conflict receipt preservation, ordinary
restart with omitted mode, stable disk identities, synthetic data readback and
shutdown. Run its release build only in a disposable, artifact-verified checkout.
It does not qualify Docker-container NAT, TLS, stale host listeners or performance.
Provider CLI helpers must be built for the selected checkout; do not bypass the
checkout identity check. Research admission retains its stricter raw-free-RAM floor.

Direct provider experiments must also isolate disk-template expansion: copy the
pinned compressed templates into the fixture HOME's `.smolvm` directory before
launch. Otherwise the provider can expand raw sparse templates beside its shared
executable and invalidate the verified artifact tree. Candidate preparation already
uses private templates. Account for generated caches alongside VM disks, and never
infer allocated or reclaimable bytes from sparse logical capacity.

For an explicitly gateway-enabled pool, Docker now enables IPv4 forwarding,
iptables and masquerading, and sets its `host-gateway` address to `100.96.0.1`.
Isolated pools retain all three disabled. Both modes retain `--bridge=none`, no
IPv6 firewall activation and a private Unix-only engine endpoint. Daemon mode is
required; an absent/unknown mode refuses launch. Restart the owned pool to apply
new daemon startup settings; an already-running daemon is not reconfigured.

The native ignored `owned_gateway_container_egress_and_aliases` fixture uses a
stopped disposable gateway pool, a hash-pinned local Bun image and an external
loopback HTTP fixture/watchdog. Under the engine mutation lease it creates a
labelled non-internal test network and sequential bounded containers. It verifies
the literal gateway, explicit alias and Docker host-gateway mapping; network-none
and a stopped host listener must refuse access. It checks labels before cleanup
and verifies empty container inventory. No graph network policy is relaxed by this
fixture. Host endpoint identity, TLS and application aliases still require their
own qualification; this is not an egress-security or performance guarantee.


The experimental `provider::host_endpoint::HostEndpoint` primitive captures one
explicit same-UID macOS process's exclusive `127.0.0.1` TCP listener. It records the
native process identity and SDK-reported socket generation; `SO_REUSEPORT`, wildcard
listeners, ambiguous or unavailable observations are refused. A connect operation
returns a stream only after the original process has accepted the exact reverse
TCP tuple and the listener generation/process identity still match. No application
bytes are sent during validation. Acceptance is polled only while a connection is
pending, within a caller budget of at most five seconds; there is no idle poller.
Descriptor inspection is bounded to 4096 entries per scan and does not shell out.

This is an in-memory transport primitive, not graph/VM authorization or durable
endpoint registration. It is macOS-only and IPv4-loopback-only; unsupported hosts
refuse capture. Multiprocess acceptors, shared-port servers and non-accepting peers
are not supported by this contract. Native identity does not defend against a
malicious authorized peer. Guest relay integration, stale boot/owner registration,
TLS/name qualification and matched resource measurements remain open.


A bounded macOS probe of the pinned SmolVM 1.14.3 `--mount-socket` path verified
64-KiB byte exchange and restart with recorded networking disabled. This offers a
guest-to-host Unix transport without enabling gateway IP routing/NAT. It is not yet
a transparent stream or a managed application endpoint: the same client calling
write-half shutdown immediately after sending stalled after the host received only
8 KiB. Source-level relay half-close tests did not qualify the complete native
vsock path. A managed relay must use explicit data/EOF framing over this transport
or qualify a lower-level fix before claiming end-to-end half-close preservation.

The probe also confirmed guest socket mode 777 and that the raw mount reconnects
to a replacement host socket at the same path. Mount configuration alone therefore
does not establish service authorization or endpoint generation. Keep service/boot
authorization and the owned host connection guard in the relay design; do not map
application aliases directly to this raw path. SmolVM's `--network none` means a
named network called `none` and enables networking. To qualify disabled networking,
omit network-enabling flags and assert the persisted configuration before boot.
These are functional transport findings, not a resource or latency comparison.


The candidate now has a [bounded stream-framing codec](runtime-relay-framing.md).
A native mounted-socket fixture passed explicit EOF delivery through the actual
codec and host identity guard, including VM restart and oversized-frame refusal
without an upstream connection. This avoids raw write-half shutdown in the tested
exchange. It does not yet qualify production relay ownership/authentication,
bidirectional load behavior or application/performance parity.

## Prepared-base startup benchmark

`scripts/benchmark-prepared-base.py` compares fresh native pools started from the stock disk
templates with pools started from an independently verified prepared base (`runtime up
--prepared-base require`). It prints its plan unless `--run` is given. Pass the installed
`hack-native` bundle, a private 0700 `--root`, a store holding a verified base for the bundle's
pins, the pinned provider, engine and network-tool inputs, and a pinned image reference. Each
trial creates a fresh candidate home, so the image cache is cold in both lanes; the host page
cache is not flushed.

- `pairs` alternates stock and prepared lanes. It times create-to-ready (`runtime up`) and
  service readiness: image ensure, then a graph service reaching `healthy`, and its volume
  token read back. It then restarts the pool, restores the graph and requires the same token.
- `cohort` starts 1/8/32 (by default) graphs in one shared pool per lane. Graph operations
  in one pool serialize on the provider lock and refuse with `provider_busy`, so concurrent
  requests are retried and counted. A base changes only pool creation, so its saving is a
  fixed offset that later graph starts amortize.
- `concurrent` creates several pools at once from one base and requires distinct machines,
  guest boots and data.
- `worktrees` (opt-in with `--mode worktrees`) creates a harness-owned repository with 1/8/32
  (by default) real linked `git worktree add` checkouts, each on its own branch with a
  committed random marker. A running pool cannot mount another root, so each worktree gets its
  own fresh development pool and private home, with `runtime up --project-share ROOT
  --unfiltered-source`. Pools start `--worktree-parallel` at a time. Each graph runs with
  `--shared-source --branch` and must serve its own committed marker before readiness counts.
  The trial then requires distinct pools, branch namespaces and volume data. It stops and
  restarts every pool, re-plans, and restores the same run. The re-plan must still match the
  run's plan: the harness drives raw runtime graphs, which restore only their exact accepted
  source, while a changed review is honored only for normalized receipts (the `hack up`
  path). The restore must report `healthy` and return the same data and marker. Last, it
  writes a new host file into every root, which must reach only that root's restored pool. The
  fixture is
  removed only after every pool is confirmed disposed; otherwise every root, its Git
  registration and its source are kept. After any cleanup failure no further worktree cohort
  starts, and that cohort's measurements are excluded from the qualified summaries. Cold
  create-to-ready and warm restart are summarized separately, with each start's selection
  (`stock` or `prepared`, base ID, and whether this run had used that base before).
  Configured guest memory and vCPUs for the largest cohort appear in the preview, with a
  warning when they exceed host memory. They are maxima, not measured use, and never block a
  run: the runtime's own admission decides each start, and a refused start is recorded as the
  cohort's outcome.

Every sample records the CPU of each command's CLI process tree (via `wait4`, covering
terminated children it reaped). It also records the provider tree the runtime returns, counting
each process once, helpers included: that tree's CPU, resident size and physical footprint, the
sum of per-process lifetime peaks (an upper bound), and each disk's logical, allocated and
clone-private bytes. The provider tree lists only processes live at the snapshot, so the two
CPU figures never count a process twice. Worktree cohorts also report attributed CPU (their
sum), configured guest memory, each home's allocated bytes (including its disks, and not
clone-aware), the checkout's allocated bytes, and the shared base store once. Cohort sums are
read one pool after another, a staggered snapshot whose window is recorded, not one instant;
the summed lifetime peaks are not a simultaneous cohort peak. Resident size, physical
footprint, configured guest memory and clone-private bytes are reported side by side and never
added together. Unobserved values stay null. Each summarized metric reports its coverage
(`n` of `of`) and is labeled unqualified when any sample lacks it, instead of counting the gap
as zero.

Admission is sampled at the start and end of each trial's timed work and every
`--admission-interval` seconds (default 1) in between. Each sample costs one process listing
and one sysctl. A trial is flagged, not dropped, when build tools run, the 1-minute load
exceeds half the CPU count, memory pressure is raised, or any of these could not be observed at
any sample. A failed observation or a gap longer than five intervals also flags the trial. Only admitted samples
enter the admitted summaries and the paired pair and cohort ratios.

The load rule counts the run's own VMs, and half the CPU count is not a measurement of this
host, so a measured baseline can replace it. `--idle-baseline SECONDS` first samples the host
for SECONDS of elapsed monotonic time while nothing of the run exists. It refuses to start
anything if build tools appear, memory pressure rises, a new crash or watchdog report appears, an
idle VM changes, or fewer than three intervals are observed. The first failed or timed-out
observation ends it at once and refuses, so it takes at most SECONDS plus one interval and the
observations in progress.
- **Background.** It measures background CPU as per-process CPU-time deltas of processes whose
  command line does not name `--root`. Trial VMs, CLI calls, fixtures and the harness are
  therefore excluded. A process that starts and exits between two samples is not seen.
- **Interval.** Every measurement spans at least 90% of the admission interval. A check that
  follows a continuous sample reuses that sample rather than dividing `ps`'s 10 ms rounding by a
  tiny interval. A trial's start check restarts the meter and measures one full interval
  immediately before timed work, so untimed setup and the previous trial's cleanup never enter
  it.
- **Bounded observation.** Every host observation (`ps`, `sysctl`) is limited to 30 s. One
  that fails or times out is unobserved and fails closed: admission flags the sample, the idle
  baseline stops at once and refuses to start, and trial or fixture cleanup keeps its state. Trial runtime
  commands keep their own step timeouts, shortened by a worktree cohort's deadlines.
- **Attribution.** Each sample records its three largest background commands. The sampler
  summary reports those behind its peak sample, and the idle baseline reports those behind its
  ceiling.
- **Host services.** Background CPU of two named host services is also recorded on its own:
  security assessment of new executables (XProtect, `syspolicyd`, `amfid`) and Spotlight
  indexing (`mds`, `mds_stores`, `mdworker`). A fresh home's binaries and files are new, so a run
  can induce this work.
  - The idle baseline reports each service and the rest separately, as the reference for what
    the host does without the run.
  - Worktree cohorts report mean background per phase, split the same way: cold start (to
    all-ready) and warm restart. The warm restart re-executes the same binaries, so security
    scanning in cold phases but not warm ones is consistent with the run inducing it.
  - The summary's `worktree_flag_attribution` breaks each flagged cohort's peak sample into its
    excess over the ceiling, each service and the rest.
  - Membership is by process name and timing, not causal tracing. The services stay in
    background: admission, thresholds and flags are unchanged, and a cohort flagged by induced
    scanning stays flagged.
- **Ceiling.** The maximum background observed becomes the admission ceiling. A timed sample
  is flagged `background_above_idle` when background exceeds it, and load is then recorded but
  not judged.
- **Idle VMs.** `--idle-vm-pid` names a VM left running beside the run (repeatable). It counts
  as background and is reported on its own. If it is no longer the same process at the end,
  the background every trial was admitted against changed. No trial's timing is then admitted,
  and all records stay in the flagged summaries. The raw file keeps the end identity, so
  `--summarize` reaches the same verdict.
- **Stops.** Before each worktree cohort, the run stops scheduling when a new syspolicyd,
  WindowServer, panic, Jetsam or reset report has appeared since it began, memory pressure is
  raised, a build tool runs or ran during the finished trial, or an idle VM changed. The same
  applies when `--budget SECONDS` is spent, and after a cohort outlives its deadline. A cohort
  in progress always ends within its own deadline and cleanup budget.
- **Deadlines.** A worktree run requires `--cohort-deadline SECONDS` and `--cleanup-budget
  SECONDS`, and the preview shows both with their sum. A cohort's work (fixture, setup, starts,
  warm restarts and live edits) runs under one deadline. Every runtime and Git command's timeout
  is shortened to the time left, a command still running at the deadline is killed, and none
  starts after it. Disposal then runs under its own budget, so an expired cohort still stops
  each pool and confirms it stopped before removing only what it owns. A `down` stopped at the
  budget, or a pool the budget never reached, is not confirmed disposed: its home and the whole
  fixture are kept, and the run stops as after any cleanup failure. Each record carries both
  bounds, whether each expired, and how long disposal took. Runtime and Git commands end within
  the deadline plus the budget; a host observation already in progress (at most 30 s each) and
  local file removal can run briefly past either. `--budget`, `--cohort-deadline` and
  `--cleanup-budget` must each be a positive, finite number of seconds: any other value is refused
  while the arguments are parsed, before any host observation. Omitting `--budget` means no run
  budget.

`--summarize SAMPLES`
recomputes the summary from a retained raw file without running anything. Cleanup stops each
pool and requires `runtime status` to report its VM process gone. Only then does it remove the
trial's home and provider alias, with a readback; otherwise it keeps them and reports the
failure. Store raw output
outside the repository. The negative controls run with
`python3 -m unittest discover -s tests/python -p test_prepared_base_benchmark.py`, locally and
in CI's runtime state models job.

This measures pool creation and a synthetic single-service graph. Worktree cohorts add real
linked-worktree roots through the runtime interface, one pool per root. They do not exercise
the `hack up` frontend, routing, application-specific images or cold host caches, and each
fresh home still acquires the image, which is timed separately.

Prepared bases carry no application images. On an M3 (September 2026, one prepared pool, three
repeats), `ensure-image` for `postgres:16-alpine` (114 MB archive) took 10.6 s cold. The engine
load itself took 3.1 s and host digest and layer validation about 1.8 s; the rest was registry
acquisition into the home's image cache. `node:22-alpine` (61 MB) took 6.3 s cold, with a 1.7 s
engine load.

Preloading an image into a base could skip only the engine load. A fresh pool's load receipt is
bound to its incarnation, so it still acquires and validates every image. Preloading would also
make bases project-specific and require the verifier to check layer contents, so bases stay
image-free. The larger remaining costs are image acquisition and per-incarnation revalidation.
