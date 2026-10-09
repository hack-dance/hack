# Hack runtime core

The opt-in `native-config-plan` feature exposes `project::native::compile`, an
experimental, pure adapter from the native configuration compiler's metadata
planning request to dependency IR and ephemeral
workload inputs. It calls the compiler in-process and performs no filesystem,
provider, image acquisition or receipt effects. This feature's compiler path
dependency requires the repository's pinned Rust 1.97.1. The default runtime
package keeps its declared Rust 1.85 minimum; enabling the adapter requires Rust 1.97.1.

The adapter accepts at most 32 selected pinned-image services/jobs, exec readiness,
explicit exec/shell commands, entrypoint clearing, init, exact shutdown intent and
working directories. Jobs require successful completion; services with readiness
require health, and other services require startup. Workload names, including dots,
remain exact. Omitted process fields preserve image/backend defaults. One project-relative
read-only live source bind per workload is supported through an already-approved
pool share. Other source acquisition and worktree declarations and local resolution
remain intent only.
An explicit entrypoint requires an authored command, matching the bounded NC03
renderer; image CMD inheritance under an entrypoint override remains unqualified.

The compiler owns profiles and environment policy. Caller-selected private values
must match its active managed source keys exactly, after unset/profile selection.
The adapter remaps those values into a separate destination-keyed map. Public
literals/defaults remain separate; private values never affect portable identities.
Outputs deliberately lack `Debug` and `Serialize`. Encoded private values are
bounded to 32 KiB and 256 destination keys per workload; process argv is bounded
to 4096 arguments and 64 KiB. Persistent worktree storage mounts are a separate
receipt-v4 path described below. Build/acquisition policy, source/file mounts, routing,
endpoints, standalone host effects, HTTP/TCP readiness and automatic restart explicitly refuse.

`project::native::review` validates the same subset without acquiring private values.
Its hash-only identity includes the authored semantic hash, local-resolution hash,
selected profiles and a separate versioned environment-policy hash. That policy hash
comes from the compiler's selected directives and resolved public bindings, including
managed source keys/scopes and typed endpoints; private values never enter it. Endpoint
execution still refuses. Compilation returns the same identity so a future native
admission boundary can compare fresh inputs with the reviewed selection.

`provider::native_input` adds a separate versioned native preparation boundary. Its
review binds compiler identity to the explicit project/branch namespace and attempt
ID. Preparation recompiles before comparing that review, keeps private values in the
existing bounded `PendingEnvironment` delivery handles, and retains one ingress
deadline of at most 300 seconds. It never stages a guest or renews credentials.

Hash-only v2 preparation artifacts live under
`run/native-inputs/<namespace>/<run>/input.json`. They are private, bounded to 8 KiB,
published once with synchronized state helpers and limited to 64 retained attempts
per namespace under an operation lock. A missing/unsafe/aliased/oversized/interrupted
artifact, unknown or duplicate fields, wrong kind/version or stale review refuses;
no artifact is repaired, overwritten or treated as provider ownership. Reads are
nonblocking and cannot reacquire private values. Compose v1 graph receipts, enrollment
and frontend run mappings keep their existing paths and byte contracts.

A future native execution consumer must verify the selected authored input and
namespace, image/source/provider admission and effect-time deadline, integrate active
native runs into common capacity/inventory, and implement tagged native ownership and
recovery. These preparation artifacts carry no resource ownership or replay authority.

`provider::graph::native::configuration` lowers freshly prepared native input
into public container configuration using the existing bounded container isolation.
It preserves exact process/exec-readiness values and compiler job/dependency goals,
requires immutable image IDs and the default source root, and adds distinct native
input labels and resource names. With omitted topology, one ordinary outbound
project bridge supplies exact service/job DNS aliases, including dotted names,
through the shared network lowerer.
Omitted image process/environment defaults remain
omitted; managed values remain in separate pending handles. Whole-second shutdown
grace up to 30 seconds is represented exactly; fractional seconds refuse. This pure
lowerer retains logical storage mount intent without fabricating provider volume IDs.
Explicit native topology currently admits two owned bridges, one internal and
one outbound, with
compiler-selected per-workload attachments and DNS aliases. External/default/
ingress attachments and source/storage intersections refuse.
It checks owner shape and deadline, never real guest ownership, image presence,
combined capacity, private staging or engine effects.

The explicit native consumer additionally admits at most one compiler-normalized
read-only project source bind per selected workload. The authored source mode is
`host-mounted` with root `.`: content changes remain live, including atomic edits
of descendants inside a selected directory. A selected regular file may change
in place; replacing that file itself changes the selected identity and refuses.
Writable source binds and custom source roots remain unsupported. Source-bearing
projects cannot combine live source with persistent storage. The separate storage
candidate requires an explicitly pinned guest witness tool before provider admission.
This does not create an immutable snapshot or publish a new source revision.

Source consumption requires the provider pool to already contain the exact
explicitly approved unfiltered project share. The consumer never approves that
whole-tree writable share, changes pool mounts or enrolls a project implicitly.
Individual workload binds are read-only and `rprivate`. Selection pins the source
root, every selected path and its ancestors by device, inode, type, UID and full
mode; aliases, hardlinked selected files and permission changes refuse. Startup
and active observations recheck those host paths, the existing provider share,
virtiofs mapping and configured/runtime bind around engine work. Host editors are
not locked: these are bounded replacement checks, not an atomic host filesystem
fence. Descendant edits under a selected directory follow the approved live-share
policy; its whole tree can include local configuration.

Source-bearing native graph receipts use a closed v3 source binding; image-only
v2 receipts keep their prior fields and serialization. This graph v3 is separate
from the foreground publication-owner v3 and does not change the v2 ready/control
envelopes. Retained inspection/startup cannot recapture or adopt a new selected
path. Exact owned cleanup continues after the host source is moved or deleted:
it verifies the original provider share and read-only container bind, stops and
removes only the original resource inventory, and never deletes host source data.
Dead-owner recovery of source-bearing graph v3 remains outside this increment;
the separately qualified image-only recovery admission must refuse that version.

The maintained macOS ignored control
`native::runtime::tests::live_source::approved_live_source_preserves_host_edits_and_cleanup_after_selected_source_moves`
requires a caller-created synthetic `live-fixture/project` and isolated sibling
`native-home`. Prepare its provider through the existing explicit development
`--project-share PROJECT --unfiltered-source` contract, then load a pinned Linux
ARM64 Bun image. The fixture verifies a run-bound private inode/mode manifest and
exclusively claims the invocation before graph effects; it does not enroll shares.
Set `HACK_NATIVE_SOURCE_TEST_FIXTURE`, `HACK_NATIVE_SOURCE_TEST_PROJECT`,
`HACK_LOCAL_TEST_ROOT`, `HACK_LOCAL_TEST_IMAGE` and a fresh 32-character hex
`HACK_NATIVE_SOURCE_TEST_RUN`. Source files are public synthetic data under private
ancestors. The control requires live HTTP reads after host edits and atomic
descendant replacement, an `EROFS` container-write refusal, source-withdrawal
inspection refusal and normal exact cleanup preserving host data. It publishes
no host ports. Compile the exact test before the caller's 300-second watchdog;
uncertain failures retain the graph/pool for inspection and never replay cleanup.
Its filesystem admission controls run without a provider. This does not qualify
whole frontend parity, dead-owner recovery or performance.

`provider::graph::native::selection` selects only the exact absolute native project
root and reads bounded, stable regular `.hack/hack.project.json` and optional
`.hack/hack.local.json` files. It forwards raw authored text and owner-supplied
environment metadata through the typed compiler request; it does not parse authored
policy, decrypt values, search ancestors or fall back to Compose. Selection binds
the candidate's real project/branch namespace, preserves the ingress deadline, and
rechecks file/directory identities, content, absent local input and legacy conflicts
before and after private preparation. Linked-worktree local inheritance explicitly
refuses until its primary-worktree verification is qualified; opted-out inheritance
preserves the owning compiler's checkout-local semantics. This is read-only input
selection and private preparation, with no durable enrollment or runtime ownership.

`provider::graph::native::run` is an explicit library consumer for pinned images
with optional preapproved read-only live source; persistent-storage intent remains
a separate, inactive path. It retains the development guest mutation lease, requires an
admitted Internet or explicitly restricted outbound pool, verifies existing immutable
images and shared graph/allocation capacity, and reserves a distinct
`native-graph-runtime` journal in `run/native-graphs` before effects (v2 for
implicit-bridge image-only graphs, v3 for source-bearing graphs, and v5 for the
image-only two-bridge subset; the separate inactive storage contract uses v4).
Create/start
intent is durable and never replayed or adopted. Network create intent precedes the
first network effect; each immutable bridge ID, labels, driver and internal policy
is verified before container work. Containers bind all selected bridge IDs and
service/extra aliases; running endpoints must match each owned bridge membership.
The same authored selection and
ingress deadline are checked before staging, creates, starts and observations.
Omitted shutdown grace uses a bounded ten-second runtime default. Optional private
delivery uses the existing static launcher and tmpfs through separate v2
`native-environment-allocation` records in `run/native-environment-leases`, binding
namespace, native review, run, workload and container without persisting values.

Native `inspect` and `cleanup` require the original guest incarnation and boot,
exact resource labels, immutable IDs, names and images. Foreign network members or
changed network policy refuse before cleanup effects. Cleanup preflights every
stop, retains terminal observations before deletes, removes each verified empty owned
bridge after containers, and retires private payloads
only after the bound container is absent. Failed/uncertain attempts retain their
reservations. Cleanup retries preserve committed stop/removal progress: terminal
instances are not stopped again, and fully Removed inventories are inspected without
rewriting their receipt. A restarted stopped instance or reappearing removed resource
refuses before any cleanup effect. Shared admission counts native and Compose attempts together; a build
with native support accepts validated, fully removed same-owner history from an
older boot for capacity purposes only. Active, malformed or foreign old-boot
records still refuse; they grant no inspection, cleanup or restore authority. A build
without native input support refuses retained native journals before more graph
work. Existing Compose v1 codecs, bindings and paths retain their contracts.

On macOS, `provider::graph::native::foreground` adds an explicit library owner for
this same subset. Its private `native-graph-owner` record and authenticated v2
`native-graph-control` status/cleanup protocol bind the native review, exact
process incarnation, directory, socket, file and retained per-run lock. Direct
run/cleanup and foreground publication exclude each other under that lock.
New publications use a closed version4 owner with `host_boot_uuid`, captured by
the native read-only `kern.bootsessionuuid` sysctl. Its fixed 37-byte response must
contain a nonzero ASCII UUID and terminal NUL; the reader canonicalizes lowercase.
Persisted UUIDs must already be lowercase. Unavailable or malformed readings refuse,
without a timestamp or shell fallback. Live authentication rechecks the session
together with the exact nonzero process incarnation and filesystem identities;
it does not compare process birth against mutable calendar boot time.
The closed version2 live-owner decoder remains available without a boot qualifier.
Version3 remains strictly qualified by its original `host_boot_micros`; it receives
no inferred UUID or migration. Each version rejects the other versions' qualifiers.
Native runtime receipts are v2 for implicit-bridge image-only graphs, v3 for
source-bearing graphs and v5 for the closed image-only two-bridge subset; the
authenticated control/ready wire remains v2.
Compose receipt and owner formats remain unchanged. This provenance alone grants
no dead-owner recovery authority. V5 permits same-incarnation inspection and
exact cleanup, while dead-owner recovery remains limited to the qualified v2
implicit-bridge inventory.
The inactive read-only recovery selector admits only a complete Ready journal and
a dead version3 or version4 publication on the same qualified native host boot. It captures the current
private owner bytes and inode; its raw SHA is a selector for later independent
admission, not an external identity anchor from before that capture. After a
durable intent, the saved inode and digest refuse replacement. Cleanup progress
retains the original Ready selectors and exact inventory. Pending writes refuse;
retired paths require the intent's preceding phase and unchanged archived inode.
`graph native recovery-selection --run-id ID --json` exposes only the closed
selection: run, original value-free Ready receipt, raw receipt/owner hashes and
the original boot qualifier. Version1 selections retain version3 calendar micros;
version2 selections carry version4 `host_boot_uuid`. Neither rewrites original
owner bytes, inode or digest. Version2 dead owners remain ineligible. Version3
recovery conservatively refuses if its calendar qualifier has drifted.
The receipt contains review hashes, workload readiness,
resource IDs/images/networks and terminal observations; it contains no environment
keys/values, command argv, source bytes or publication process/path metadata. The
selector creates no intent and connects no provider. It grants no cleanup or
frontend recovery authority.

The UUID boundary addresses calendar correction without weakening reboot refusal.
[XNU calendar updates adjust boot time](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/clock.c#L674-L752),
while the [read-only boot-session sysctl](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c#L2735-L2762)
is [generated at boot](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOPMrootDomain.cpp#L3846-L3861).
Unrelated legacy filesystem chronology still uses its existing calendar helper.
Injected-reader and codec regressions qualify the ownership fences without changing
the host clock or rebooting. They do not establish actual provider recovery.

The separate explicit library recovery entrypoint re-admits both raw selectors
and commits a bounded 64 KiB recovery intent before cleanup. It retains the
publication gate, original operation lock and cleanup provider lease through
matching Removed resources, private-environment absence and publication
retirement. A metadata-only current slot inventory is bound into the intent;
changed or missing records refuse. Bounded read-only guest slot enumeration
cross-checks the validated native and Compose host records before cleanup and
again before publication retirement. Unknown guest slots refuse even when host
records are empty; no payload contents are read or inferred from missing records.
Durable phases precede each exclusive archive move; original Ready
hashes and inventory remain fixed while cleanup phases advance. Completed retry
checks absence rather than repeating retirement. Pending writes, unexpected
replacements or missing original and archive paths retain a refusal. Public
frontend recovery and actual dead-owner acceptance remain separate gates.
The distinct macOS command `graph native recover-live-owner --run-id ID
--expect-receipt SHA --expect-owner SHA --json` exposes only this explicit
cleanup entrypoint. Both hashes select the original read-only recovery envelope;
source, private stdin, review, action and timeout options refuse. Existing live
control and direct-cleanup ownership gates remain strict. This command does not
retire frontend start/ready/source artifacts or enable ordinary `up` takeover.

Guarded native cleanup checks its retained authority before and after every
engine observation, removal request and admitted stop batch, including failed
calls. The existing stop batch retains its concurrent HTTP-stop semantics. Cleanup
checks authority before each journal publication. It also
checks each private-environment absence and retirement call. A lost guard refuses
before the next request or journal transition; an already attempted effect remains
durable evidence for an explicitly admitted retry. This prerequisite introduces
no dead-publisher cleanup entrypoint.
Cancellation fences startup before admission and subsequent effects. Cleanup
retains stop failures by admitted workload name, and retires the publication only
after exact cleanup succeeds. Replies bind their requested action and immutable
admitted membership. A cleanup reply crosses the already authenticated connection
after retirement and requires unchanged parent/lock identities, absent publication
paths and the exact durable removed journal. Changed current membership and
unknown native failure-observation fields refuse. Failed or abandoned publications preserve evidence;
they never authorize adoption, restart or dead-owner recovery. This owner has no
ordinary frontend selection yet and does not implement reactive health or hooks.

The optional feature exposes this bounded consumer through a distinct public CLI:
`graph native plan --source-file FILE --json`, then
`graph native run --source-file FILE --expect-review SHA --json`.
`graph native inspect|cleanup --run-id RUN --json` use its versioned native journal. These commands
are explicit bounded prerequisites, not full ordinary project parity. Their project
network does not publish ports or grant host-service access. Normal native `hack up`
continues to require the full source/storage/routing/host and foreground-owner contract.

On macOS, `graph native serve` accepts the same source, reviewed identity and private
stdin options as `run`, and keeps the owner in the foreground until TERM/INT or
`graph native control --run-id RUN --action cleanup --json`. Its first stdout line is
the v2 `native-graph-foreground-ready` envelope, binding run, review and admitted
receipt; its final JSON receipt follows owned shutdown. Authenticated `control`
with `--action status` returns the exact admitted snapshot. Direct cleanup refuses
while this owner is published. Serve/control on other platforms refuse before
reading private stdin or using the provider. These explicit candidate commands
do not activate ordinary native `hack up`.

The Bun native-source process adapter validates this separate wire format and
authenticates status and checks its admitted readiness conditions before the
readiness callback. The selected status request bounds draining after its owned
child exits, even if descendants retain output pipes. Cancellation or owner exit
during that handshake prevents publication and waits for owned process shutdown.
The caller must still recheck selected input before publication and inspect the
durable native journal after exit; process completion alone does not prove cleanup.
Its separate `native-authored-project-run` v2 artifact records the original native
receipt in excluded private storage. It never supplies a Compose plan ID or grants
cleanup authority; retirement requires unchanged file identity and matching Removed
evidence. Native startup admission additionally holds an exact process-owned lock
through the foreground lifetime and publishes a separate hash-only
`native-authored-project-start` v2 intent before spawning the consumer. Ready
publication must match that unchanged intent. Failed or interrupted starts retain
it and refuse a new start, including after ready-file retirement. Only a caller
that authenticated the exact durable Removed journal can retire the intent;
missing ready files, expired timeouts and dead processes do not grant cleanup or
replay. The strict Compose v1 reader and its artifact path remain unchanged.
Command integration and live frontend acceptance remain gates.

Held startup admission can also publish the exact public source envelope in that
excluded storage. It captures profiles, overlay and closed names-only metadata
before asynchronous work, binds the source inode and bytes to its admission, and
refuses source removal while startup or ready evidence remains. It does not parse
authored policy or acquire values. Ready publication accepts a synchronous owner
guard after the final asynchronous authority checks, immediately before linking
the mapping; the consuming caller must supply its process and cancellation guard.
Guard returns must be `undefined`. Accidental asynchronous or other return values
refuse publication, and rejected promises are consumed without printing their details.

The `serveNativeAuthoredProject` owner connects these boundaries without
Compose normalization: shared input preparation, native source review, durable
startup intent, compiler-selected private source keys over stdin, authenticated
readiness and guarded run publication. The review must match the canonical
project/branch namespace before intent reservation or private delivery. It holds
admission through foreground exit and preserves the first parsed runtime receipt
before status or input freshness checks; that observation grants no ready authority.
It checks this original binding against a fresh native journal inspection before
retiring mappings, intent and source. Missing, changed or live cleanup evidence
retains the attempt and refuses replay. Input acquisition shares the original Bun
startup deadline; it does not renew that budget for each subprocess. This component
is selected only by explicit native backend foreground `up` on macOS. Detached,
JSON, recovery, subset and other lifecycle requests refuse before input acquisition.
Its fake driver tests and effect-free compiler interop do not qualify the installed
frontend, provider or full authored corpus. See the separate
[command contract](../../docs/reference/native-authored-commands.md).

Shared Bun input preparation accepts the native source's explicit compiler branch
context. It binds that branch into resolve and environment planning without
implicit Git or global-domain discovery, matching the native source's local hash.
Omitting this context preserves the existing Compose preparation behavior.

Native-source plan and inspect requests have a separate opt-in pipe-lifetime
bound for those exact read-only arguments. They reject private stdin and other
actions; the default client and Compose requests retain their prior behavior.
A closed native snapshot parser binds inspection to its reviewed source and,
after readiness, the original admitted owner, boot and resource identities.

The stable, absolute source file is a public v2 envelope with
`kind: "native-graph-source"`, `project`, optional canonical `branch`, 32-hex `run`,
optional `profiles`, and compiler-owned `env_metadata`. Its `overlay` is `"inherit"`
(also the omission default), `"base"`, or `{"named":"NAME"}`; null refuses. The source
and authored files are rechecked before private preparation and effects. It returns
a native `review_id`; Compose plan IDs and normalized-input fields are not accepted.
Optional `run|serve --environment-stdin` receives a bounded private pipe envelope with
`version: 2`, `kind: "native-graph-environment"`, `review`, `run`,
`lifetime_seconds` (1..300), and selected source-keyed `services`. Public selection
and review comparison happen before reading this descriptor. The old private v1
Compose codec remains strict and cannot decode this envelope. Values never enter
source files, arguments, stdout or journal records.

The Bun project frontend does not select this consumer yet. Actual installed
native execution, frontend ownership/cancellation, interrupted recovery and full
network acceptance, source/storage/routing/host contracts remain separate qualification gates.

Run its pure regressions with
`cargo test --locked --manifest-path packages/runtime-core/Cargo.toml --features native-config-plan project::native::tests`.

The optional `shared-mcp` feature builds `hack-mcp-adapter`, an experimental native
stdio relay for the explicit shared MCP socket backend. Build it with
`cargo build --locked --release --manifest-path packages/runtime-core/Cargo.toml --features shared-mcp --bin hack-mcp-adapter`.
It takes `--socket PATH --backend-id ID`, verifies a private socket and same-user
peer before sending cwd/environment, and never launches a backend or replays a
request. Its buffers are bounded; handshake frames have a five-second deadline.
The initial connection has a separate five-second deadline. A temporary 128 KiB-stack
worker isolates blocking connect; timeout exits the adapter and terminates the worker
without transferring context or retrying. A full accept queue is refused immediately
on the tested macOS host and times out within the bound on Linux.
Socket-write and stdout-consumer stalls fail after five seconds without progress.
The stdout worker retains at most one 16 KiB chunk, does not change caller file
flags, and supports temporary backpressure. Idle socket reads wait for readiness.
The relay is not wired into installed client configuration. Automatic startup,
crash recovery, and broader resource qualification remain
open. Set `HACK_MCP_ADAPTER_TEST_BINARY` to the freshly built absolute executable
path to run `bun test tests/mcp-native-adapter.test.ts`; otherwise those integration
tests explicitly skip.

The experimental runner `bun scripts/run-mcp-socket-backend.ts PRIVATE_DIRECTORY
BACKEND_ID [IDLE_TIMEOUT_MS]` retires after 60 seconds with no connected clients;
`0` disables retirement. Connected clients, including quiet sessions, prevent it.
The library keeps explicit lifetime by default (`idleTimeoutMs: 0`) and exposes a
`closed` promise that resolves only after command cleanup and owned endpoint/claim
retirement. A reconnect before retirement starts cancels the deadline; after it
starts, new connections are refused. This does not yet provide automatic restart
and does not change installed client settings. Native-owner recovery is described below.

`hack-mcp-owner` (also behind `shared-mcp`) supplies an experimental native
ownership lease for an explicitly launched backend:

```sh
cargo build --locked --release --manifest-path packages/runtime-core/Cargo.toml --features shared-mcp --bin hack-mcp-owner
# PRIVATE_DIRECTORY must already exist, be canonical, user-owned and mode 0700.
hack-mcp-owner --directory PRIVATE_DIRECTORY -- /absolute/path/to/backend PRIVATE_DIRECTORY BACKEND_ID
```

It takes an exclusive nonblocking OS lock on a private zero-byte `.mcp-lease`, then
replaces itself with the selected command. There is no resident launcher. The backend
inherits `HACK_MCP_LEASE_FD` and `HACK_MCP_LEASE_DIRECTORY`; it must retain that descriptor
through cleanup and must not pass it to work processes. Bun source and compiled
backend execution and Bun-spawned command isolation are covered by integration tests.
Other runtimes/spawn mechanisms require their own descriptor-inheritance verification.
The lock inode remains for reuse, including after failed exec or abrupt owner death;
never remove or replace it while a backend could be running. Public, nonempty,
symlinked or hardlinked lease files are refused. Manual same-user replacement of the
lock or ownership directory is outside this cooperative locking contract.

An owned backend writes a bounded private `.mcp-receipt.json` containing only the
version and directory, lease, claim and socket identities (decimal device/inode
strings). After acquiring the OS lease, the next native owner can retire a matching
stale socket and empty claim. It removes the receipt last, so cleanup can resume
when the socket or both socket and claim are already gone. Normal backend shutdown
also removes its owned receipt. Existing unwrapped backends remain unchanged and
do not acquire recoverable ownership merely by creating a socket.

Missing, malformed, oversized, aliased or mismatched receipts, foreign sockets and
nonempty claim directories are refusals; recovery never uses a PID as authority.
A crash before receipt publication remains a refusal. Process-kill/restart tests
and intermediate-cleanup-state tests qualify this sequence, not host-power-loss
durability or malicious same-user filesystem replacement. Descriptor handoff env
variables are internal to the trusted native launcher, not user configuration.
Automatic client startup, replay and installed-client migration remain disabled.

Session activation waits for ownership publication to finish. While it is pending,
the backend buffers at most 256 KiB plus a newline per connection without parsing
or acknowledging context. Publication failure closes those clients; successful
publication processes buffered input in order. The existing five-second handshake
budget includes this wait. Connection admission defaults to 128 accepted sockets
(including pending sessions); the library's positive-integer `maxConnections` option
can set the limit. Overflow is closed before protocol activation, and disconnects
release slots. This is a connection/input bound, not a total backend memory budget.
The publication-ordering tests use an isolated subprocess with a controlled publisher;
the native-owner tests separately exercise real receipt writes and recovery.
The standalone runner registers shutdown handlers before asynchronous startup; a
stop requested during publication closes the backend without announcing readiness.
Set `HACK_MCP_OWNER_TEST_BINARY` to the freshly built absolute owner executable to
run `bun test tests/mcp-native-owner.test.ts`. Optionally set
`HACK_MCP_BACKEND_TEST_BINARY` to a freshly compiled standalone backend; otherwise
the real-backend integration invokes its source with Bun.

Private Rust implementation for the v5 candidate (local `_docs/docs/plans/v5/README.md`). The library owns
candidate identity, bounded Compose review and enrollment, native source synchronization,
immutable source-job admission, durable host fixture jobs, and the
experimental Apple Silicon SmolVM lifecycle. The installed Hack, existing Docker contexts, and existing project runtimes are separate.

For an explicit relocatable Apple Silicon bundle alongside the supported CLI, see
[opt-in native candidate installation](../../docs/guides/native-candidate.md).
The default checkout launcher retains its existing identity and state boundary.

Build with `./scripts/build-hack-local.sh`, then run `./hack-local info` and
`./hack-local runtime probe`. The development guide (local `_docs/docs/plans/v5/development.md`) describes
pinned package preparation, ownership, resource admission, lifecycle commands, and manual tests.
The default private build includes native HTTP graph probes (local `_docs/docs/plans/v5/native-http-probe-20260915.md`)
and requires Zig 0.15.2 plus a host C compiler.
[Provider pins](provider-pins.json) record the exact package inputs; the engine runs inside the VM.

Source binaries embed their build checkout. If a copied Cargo target directory
retains a different checkout identity, use a fresh `--target-dir` for checks and
tests; Cargo reporting a cached binary as fresh does not qualify that identity.

`provider/` separates bounded child processes, artifact verification, admission, private ownership,
native process/disk identity, guest protocol, and lifecycle decisions. Guest requests use a bounded
connection to the existing socket; they cannot silently start or recover a VM. Failed operations
retain their phase and receipts. Recovery preserves disks and labels an unclean exit explicitly.

SmolVM seeds a machine's disks during its first start (`machine create` makes none) from expanded
`*-template.ext4` files that it creates from the verified compressed templates and then reuses.
Until a pool adopts its disk identities, those expanded files are verified against content
digests derived from the pinned SmolVM archive: before create and before each start for any file
SmolVM would reuse, and after the first start, before disk adoption, for the files it expanded and
cloned. SmolVM expands and clones within one start, so a first-start expansion is verified only
after the guest has booted from it. Size, owner and mode checks are not integrity; the content
digest is. A mismatch refuses with `disk_template_untrusted` and changes no files. Before a start,
removing the refused file lets SmolVM re-expand it from the verified compressed template. After a
start, the boot is stopped as a failed boot without adopting its disks and needs manual recovery.

A start interrupted before the pool records its provider process (for example, `up` is killed)
leaves the pool `creating` or `booting`, and `up` refuses. Each start clears the previous
provider's already-dead identity before `booting`, so this covers every start, not only the
first. `runtime recover` resolves those states only after proving that no process executes the
candidate's provider binary. An interrupted create that never recorded its machine deletes only
this pool's own machine record and returns to `initializing`. A start that created no disks
returns to `stopped-before-engine`. A launched start becomes an unclean stop after the
provider's own PID record is verified (and the provider stopped if alive), or after it has
exited, and after its VM lock, disk handles and sockets are proven released. Recovery never
adopts disks: a first start's disks stay unadopted until the next boot's template, size and
format checks accept them. Missing adopted disks, a partial launch and other phases still
refuse for manual inspection. `down` treats a stopped pool with no recorded provider as already
stopped.

Prepared bases are an opt-in way to format a **fresh** pool's disks. Without a request, startup is
unchanged and fresh pools use the stock templates. A base is a pair of templates cloned from a
sanitized seed machine's disks, published into an explicit, private store with a strict
`hack.prepared-base/v1` receipt. The receipt pins the SmolVM archive, agent rootfs, engine,
network-tools identity and disk capacity, and records content digests and a sanitization record.
Publication stages under a random name and renames the complete base into place without replacing
anything. Activation binds a fresh pool only (no machine disks, no plain templates, no prior
activation) to exactly matching pins. It records its intent first, then clones each template into
the pool's provider home and verifies the clone's content before placing it. Because SmolVM formats
disks during the first start, the activated templates are verified in place of the stock pins
before and after that start, and removed only after disk adoption. Recovery rolls back only files
this activation provably created, and only before the first start. Every pool operation requires
the pool's held provider operation lock, which the caller keeps from activation through the first
start, disk adoption and consumption. The activation record is bound to its pool. An interrupted
record write is removed only when it validates as this pool's next write; a torn or unassociated
pending file is kept and blocks the pool's prepared-base operations until someone inspects it.
Receipts and records are read without following links or blocking, and only as regular files. The
base-scoped network-tools owner is `prepared-base:<id>`.

`runtime prepared-base build` makes a base from a disposable seed pool in `<store>/.work/<nonce>`
(cloned providers; no project share, sockets, graphs or credentials): it installs network tools
under the base owner, then a reviewed guest script proves there are no containers or volumes, stops
the engine, and removes the owner marker, engine id, logs and runtime residue before publication.
`runtime prepared-base verify` then boots a separate disposable verifier from the *published* base,
re-proves its content digests on its own clone, and reads both disks read-only before any guest
setup. A host-side allow-list must account for every entry; only a passing inventory is recorded
(`<store>/.verified`). The publisher's sanitization claims are never treated as proof.

`runtime up ... --prepared-base prefer|require [--prepared-base-store PATH]` asks for the newest
verified base bound to the pool's pins and capacity when the pool is created. The installed
candidate defaults to `<home>/prepared-bases`; a development checkout needs an explicit store.
`prefer` keeps the stock templates and records a typed reason when no usable base exists or a base
fails activation; `require` refuses before anything is created. Ambiguous pool state (an unowned
template or an unprovable interrupted record) refuses in both modes. `runtime status` reports the
selection, activation and any deferred consumption. Stores are locked shared while a pool clones
and exclusively to publish, record a verification or remove a base
(`runtime prepared-base status|remove`), so no base disappears mid-clone. Each seed build or
verification runs in its own work root under `<store>/.work`, holding a lock there for as long as
its process lives. A root whose lock is free was abandoned by an interrupted build or verification:
`status` lists it, and the next `build` or `verify` tears it down first (its own machine, alias and
directory), keeping any root where a provider still runs. A pool never depends on its base after
the first start. Prepared bases change only how a pool's disks are first formatted,
so they speed up creating a pool (the first one, or one recreated during recovery), not starting
graphs inside a running pool. macOS APFS only: elsewhere `prefer` keeps the stock templates and
`require` refuses.

Protocol version 1 describes this development client. It is not a promised release API. This is
a bounded experimental application graph executor, not a qualified native Linux container adapter. The checkout-owned `node serve`
service and independent supervisors implement the WU04 contract (local `_docs/docs/plans/v5/wu04-contract.md`).
Its [versioned schema](node-protocol-v1.schema.json) precedes any TypeScript consumer. The
Compose subset (local `_docs/docs/plans/v5/compose-subset.md`) defines the importer and refusal boundaries. The
work-unit ledger (local `_docs/docs/plans/v5/work-units.md`) separates implementation from live qualification.

The submit_source request adds the immutable_source_jobs_v1 capability to the same node journal.
It requires an acknowledged working-tree revision, a separately published immutable snapshot and
an exact local image ID. Admission retains the source writer lock through the journal commit.
Execution rechecks the immutable tree before container creation and inside the container before
the requested program. Input is read-only; /output and /tmp are bounded writable tmpfs mounts,
with no network or managed credentials. This interface is in live qualification and does not
establish real-project readiness.

Restore history is diagnostic, not execution authority. Restores retain at most
8 recent previous receipts within a 1 MiB history file and mark truncated history
explicitly. Legacy `restore-1` through `restore-8` directories migrate only after
the replacement is durably published. Interrupted matching writes and partial
legacy retirement can resume; foreign contents fail closed. Current state, run
identity and named data remain outside history retirement. Archive/export retains
the bounded window rather than a complete lifetime log. Use the current candidate
for migrated private state; older experimental candidates do not understand this
history format. Stable v4 uses its separate state and is unaffected.

## Named-volume integrity qualification

The ignored fixture
`foreground::native_test::same_boot_absent_relay::absent_relay_cleanup_retries_preserve_data_and_live_sibling`
uses a caller-owned running development pool and a pinned image containing
`/bin/sh` and `sleep`. Set `HACK_LOCAL_TEST_ROOT` to that private candidate home
and `HACK_LOCAL_TEST_IMAGE` to the loaded `sha256:<config digest>`. Compile the
all-feature library test with `--no-run`, then invoke its exact test name with
`--ignored --exact --nocapture --test-threads=1` under a 300-second external
watchdog. It starts two unique control-only graphs, lets one managed relay exit
normally, and checks explicit same-boot recovery after interrupted intent,
container removal, completed cleanup, and publisher retirement. Persistent data
and the live sibling must survive; substituted endpoint/lock/directory, receipt
bytes, and completed-retry process evidence must refuse. It removes only its own
graph resources on success, including an interrupted explicit volume removal and
idempotent retry, and never restarts the pool. On failure, inspect its
retained graph evidence before another attempt. This fixture does not qualify
application authentication, dependency listeners, browser routing, or publication.

The two ignored tests under
`foreground::native_test::same_boot_absent_relay::bridge_normalization` use the same
300-second external watchdog and a caller-owned capacity-two development pool.
Set `HACK_LOCAL_TEST_NATIVE` to the absolute current `hack-native` binary to run
the final positive recovery through its public CLI. The read-only ignored
`removed_fixture_has_no_engine_resources_or_selected_guest_helpers` child audits
an exact `HACK_LOCAL_GRAPH_RUN` afterward, including engine absence and the
selected guest process identities.
Their pinned image additionally supplies BusyBox `httpd`; the target has two
HTTP-probed services on an internal network. They qualify an exited bridge plus a
never-launched reservation, and separately a second originally live bridge that
exits after normalization selection. Exact pending-fence writes, socket unlink,
owner unlink, registry removal and completion are interrupted and retried. A
replaced reservation refuses. Named markers and a live **unbridged** sibling must
survive; both owned graphs are removed through guarded cleanup on success. These
fixtures do not qualify simultaneous bridged siblings or application/browser
acceptance. Inspect failed-run resources before allocating another fixture.

The ignored foreground-owner fixture
`foreground::native_test::stop14::fourteen_services_retain_named_data_across_cleanup_and_restore`
qualifies normal retaining cleanup of thirteen running services and one completed
job, then restores all fourteen with the original named-volume identity and marker.
It uses no application source, credentials or host listeners. It does not inject
a partial stop or qualify successor-boot recovery.

Prepare a separate development pool with the managed provider, engine and network
tools and load a pinned local Linux ARM64 image containing `/bin/sh`. The pool
must have no graph attempts. Set `HACK_STOP14_TEST_ROOT` to its private candidate
home, `HACK_STOP14_TEST_BINARY` to the matching current-source native CLI, and
`HACK_STOP14_TEST_IMAGE` to the loaded `sha256:<config digest>`. Compile the
all-feature library test with `--no-run` first, then run this exact ignored test
with one test thread under a 240-second external watchdog. Failure retains the
graph, data and foreground owner for explicit inspection; do not rerun it against
that pool or replay an uncertain stop. Success removes only its graph resources;
stop the owned pool separately with the managed runtime command.

The ignored fixture
`foreground::native_test::partial_stop::exact_partial_stop_recovers_only_on_immediate_successor_boot`
requires another fresh, prepared pool and the same pinned shell image. Set
`HACK_PARTIAL_STOP_TEST_ROOT` and `HACK_PARTIAL_STOP_TEST_IMAGE`, compile the
all-feature library test first, and run the exact ignored test with one thread
under a 300-second external watchdog. A test-only socket accepts one exact
container stop request and closes without a response; all other selected stops
use the verified guest engine. It verifies pending cleanup and refuses same-boot
and stale-receipt recovery, then performs one managed boot rollover and exact
receipt-selected recovery. Target and stopped-sibling volume identities and
markers must survive. Success removes only the two owned graphs and stops the
pool; failure retains their sources, data and owner evidence for inspection.
This is a controlled transport failure, not a reproduction or diagnosis of an
unexplained real-world stop timeout.

The ignored Apple Silicon macOS fixture
`owned_named_volume_integrity_survives_container_restart` writes a synthetic
64 MiB corpus into one owned named volume. It fsyncs files and directories,
atomically replaces one file, and checks independent block and whole-file hashes
against a Rust-generated manifest across two managed container-only stop/start
cycles. Provider boot/process/disk, container and volume directory identities must
remain unchanged. A disposable one-byte corruption must fail the verifier at the
expected block and also change the independently read whole-file digest.

Prepare a new mode-0700 candidate home outside repository and application homes
using the [native candidate setup](../../docs/guides/native-candidate.md). Only the
preparation operation lock may preexist; prior runtime or graph state is refused.
The fixture boots its own isolated development VM, publishes no host ports and
uses no application source or credentials. Set these explicit inputs:

- `HACK_VOLUME_INTEGRITY_ROOT`: the new, prepared candidate home.
- `HACK_VOLUME_INTEGRITY_IMAGE`: an exact Linux ARM64 Bun image content ID
  (`sha256:<config digest>`) containing `/usr/local/bin/bun`.
- `HACK_VOLUME_INTEGRITY_IMAGE_ARCHIVE`: its local Docker image archive.
- `HACK_VOLUME_INTEGRITY_IMAGE_SHA256`: the archive's SHA-256, distinct from the
  image content ID or registry manifest digest.

Compile the test first with the same Cargo selection and `--no-run`, so compilation
does not consume the runtime deadline. Run once under a 300-second external
watchdog that forwards ordinary cancellation to the exact owned test process;
do not force-kill a VM or replay uncertain effects:

```sh
mise exec -- cargo test --locked --manifest-path packages/runtime-core/Cargo.toml \
  --target-dir .hack-local/target --jobs 2 --lib \
  provider::graph::shutdown::native_test::integrity::owned_named_volume_integrity_survives_container_restart \
  -- --ignored --exact --nocapture --test-threads=1
```

Success verifies graph resource removal and stops the VM. Assertion failure retains
the fixture volume for inspection and attempts managed shutdown; external
cancellation can skip unwinding, so inspect owned state before any recovery. Hash,
identity and phase evidence is private candidate review data, not tracked source.
Same-boot reads may use guest page cache: this fixture does not qualify VM-shutdown
durability, crash/power-loss safety, framework concurrency or application readiness.

## Foreground graph dependency owner (candidate macOS path)

If an interrupted foreground owner leaves private dependency socket paths after
the provider has stopped, normal `hack up` still refuses to adopt or replace them.
`hack-local runtime dependency-socket-recovery --json` selects only owned, unlistened
socket inodes in that stopped pool and returns an exact SHA-256 selection. After
review, `hack-local runtime recover-dependency-sockets --expect-sha256 <hash> --json`
retires just those inodes. The operation holds the provider lock, journals its
selection before the first unlink, and can resume a partial unlink against the same
identities. A live listener, changed inode, nonprivate path, unconfirmed stopped
state or changed provider identity refuses recovery. VM disks and graph data remain.
This is cooperative same-user recovery for a stopped pool, not adoption of an
unreceipted active relay or proof of application readiness.

For an already-running VM whose retained graphs are all stopped, the separate
`hack-local runtime quiescent-dependency-socket-recovery --json` command selects
legacy unreceipted socket inodes without rebooting. Explicitly apply its selection
with `hack-local runtime recover-quiescent-dependency-sockets --expect-sha256 <hash> --json`.
This mode holds a pool publication gate before foreground retirement locks and the
provider lease. It pins the exact provider receipt, host/guest boot, every retained
graph receipt and volume identity, and requires absent compute, no foreground
publisher, no dependency assignment and no untracked guest containers. It rechecks
that proof before each inode-selected unlink and journals the selection separately
from stopped-pool recovery so partial retries retain their original scope.
An incomplete journal, live listener, replacement path or changed proof refuses
recovery. Owner bytes, source-rebind witnesses, retained data and the running VM
remain unchanged. This is explicit cooperative legacy cleanup, not proof of the
original socket creator or a security boundary against another same-user process.

TERM and INT are checked during initial graph startup, including readiness waits
and before new service effects. Cancellation enters owned cleanup while preserving
persistent data. Checks occur between bounded operations; an in-flight operation
is not interrupted or retried, so its remaining duration contributes to shutdown
latency. Cleanup runs after the startup cancellation check has been disarmed.

After confirmed foreground cleanup and clean owner retirement, explicit
`graph cleanup --run-id <id> --remove-data --json` can remove retained data. The
operation holds the foreground publication lock, rechecks retirement and resource
ownership, and records volume identities before removal so an interrupted attempt
can resume against the same resources. Completed same-boot recovery is supported
with exact completion and archived publisher evidence; the removal intent pins its
proof source so a retry cannot switch to a different recovery generation.
Active owners still handle their own cleanup;
stale owner artifacts, uncertain cleanup and changed identities refuse removal.
Ordinary volume identity is captured when removal is admitted; shared caches also
retain their existing provenance and shared-resource protections. Persistent data
is never removed merely because startup was cancelled.

Compose review recognizes a bounded local HTTPS declaration: `caddy` lists up to
eight unique DNS names, `caddy.reverse_proxy` is exactly `{{upstreams PORT}}`, and
`caddy.tls` is `internal`. The plan records normalized hostnames and the target port
as `routing`; arbitrary directives, partial declarations and interpolated values
remain refused. Execution requires explicit internal route enrollment: each
selected route must have `Healthy` readiness and a matching native HTTP probe on
its declared upstream port. The graph receipt persists the exact normalized
hostnames and upstream port; this records intent, not an active publication.
For an enrolled route, explicit bridge publication must use Unix transport, the
same upstream port, and the complete declared hostname set after normalization;
omitted, duplicate or additional names and host TCP publication are refused.
Unrouted services retain the existing explicit bridge publication behavior.

The library's `foreground::serve_with_routes` accepts an explicit reviewed
service-to-bridge-slot map. It owns publisher children, checks readiness against
the exact run/reservation and live child, observes exit through kqueue, reaps old
publishers during restore, and completes cleanup before acknowledging retirement.
This is a source-qualified supervision API, not native forwarding or TLS proof.
`graph serve --route-slot service=index` explicitly selects publication slots for
reviewed routes. `service=auto`, used by the candidate frontend, reserves the entire
requested set under the provider mutation lock and persists it together; exhaustion
does not leave a partially allocated set. Other graph actions do not accept this flag. Relay control-owner
identity is now run-scoped so distinct foreground graphs no longer select the same
control root by construction. These CLI/identity changes are source-qualified;
two concurrent routed graphs still require native acceptance. A bounded native
reference control qualifies one graph with two networks and two declared hostnames:
both forward real HTTP over Unix publication, followed by authenticated cleanup,
foreground exit and independently verified resource absence. This does not qualify
actual Event Agent routing, TLS, two routed graphs, restore, publisher-exit/partial
startup failure, owner-crash recovery, scale or performance. No global Caddy
configuration or trust installation is performed by this contract.

The bundled candidate frontend uses a detached, pool-bound HTTPS helper with one
durable lease per ready graph. The helper is launched from the exact candidate
executable and pins the runtime and Caddy artifacts. Disconnecting an application
does not release its lease. Release independently checks that application's graph,
bridges and hostname claims; the last release closes admission before retiring
the HTTPS processes. Finalization receipts bind the complete helper generation and
lease identity so recovery for one application cannot retire another's listener.
Missing or inconsistent owner evidence refuses automatic adoption. A killed helper
can leave children and receipts requiring explicit recovery; this is not automatic
crash reclamation. Compiled candidate and native multi-application checks remain
separate from the finite lifetime model and injected process tests.
An interrupted initial helper creation before intent publication also requires
explicit recovery. Small release and retired-generation receipts are retained for
retry; automatic receipt collection is not part of this implementation.

The graph compiler accepts up to 32 owned networks and records each
service's ordered attachment selection. Endpoint inspection uses the declared
primary network and verifies every attachment; changes to secondary attachments
invalidate multi-network publication generations. Legacy single-network receipts
retain their generation format. Native multi-network and HTTPS application
qualification remain separate acceptance gates.

`graph dependency-plan --dependencies FILE --json` reviews an explicit, non-secret
JSON selection and returns `dependency_plan_id`. The selection schema is:

```json
{
  "version": 1,
  "plan": "<64 lowercase hex graph plan ID>",
  "artifact": "/absolute/path/to/reviewed/hack-relay-guest",
  "artifact_sha256": "<64 lowercase hex artifact digest>",
  "dependencies": [
    {
      "service": "web",
      "binding": "database",
      "slot": 0,
      "guest_port": 5432,
      "host_pid": 12345,
      "host_port": 15432
    }
  ]
}
```

Replace the placeholders with reviewed values. The selected host process must own
an exclusive IPv4 loopback listener. Review pins its native process/listener
generation; changing the configuration or replacing a listener invalidates the
returned dependency plan ID. The guest artifact digest is verified before runtime
creation. No credential is a valid configuration field. Keep generated selection
files outside the reviewed project: writing a new file into its inventoried source
after planning invalidates the executable plan. `graph serve` validates executable
inputs before creating relay owners and revalidates again at graph admission.

An optional `host_executable` absolute path on each binding pins the exact
same-user executable as well as the PID and listener. The frontend can obtain the
current PID with `graph dependency-discover --host-port PORT --executable PATH
--json` after lifecycle hooks, then place that PID and executable in the reviewed
selection. Discovery refuses a missing, ambiguous, wildcard, shared or
wrong-executable listener. It does not authorize a port by itself; `dependency-plan`
and `serve` recapture the selected process and socket generation.

Run `graph serve` with the usual `graph run` project/file/plan/run/readiness options,
plus `--dependencies FILE --expect-dependencies ID`. It remains foreground, prints
one compact `graph_foreground_ready` JSON line after startup, and prints its final
receipt on exit. Keep that process supervised. This is not detached startup.

An active ready foreground graph supports explicit
`graph refresh-dependencies --run-id RUN --json`. The private control connection
authenticates the live owner, which derives the current plan and receipt generation
and rechecks them before effects. Refresh follows only originally admitted
`host_executable` selectors whose replacement has the same executable, host port
and unchanged same-user supervisor identity. Fixed-PID drift, missing or ambiguous
listeners and replaced supervisors refuse. The admitted service/binding/alias/port
and shared-slot layout cannot change through this operation.

Refresh retires affected grants before replacing their relay generation; successful
completion retains application container and volume identities. An unchanged
selection is a verified no-op. The public response contains `ok`, `run`, `plan`,
`owner`, `namespace`, the current 64-hex `generation` and bounded unique `changed_slots`;
it contains no credentials. A partial transition retains its journal and fences
admission rather than replaying effects. Inspect the owner and use owned retaining
cleanup/restart for recovery; never remove managed evidence to bypass refusal.

The native frontend requests refresh once before `exec`/`run` selection or private
environment preparation, with a 180-second request budget. A lost or malformed
reply refuses command admission without replay. Read-only `ps`/`logs` do not initiate
refresh. Authenticated relay traffic can notify the owner of endpoint drift, causing
a bounded refresh attempt without idle polling. The first affected application
request can fail and is never replayed; subsequent traffic requires a verified
replacement. Restart preflight remains an immediate ownership check.
This operation does not renew startup environment allocations or adopt a new
supervisor, and source/unit checks alone do not qualify real tunnel recovery.

For read-only project mounts, publish the reviewed project with
`project publish-source --project DIR --file FILE --expect-plan PLAN --json`, then
pass its returned revision as `--source-revision` to the graph command. Graph
admission uses that immutable publication and verifies its namespace, source
selection, runtime incarnation and guest content under the runtime mutation lease.
It does not require a mutable `sync-source` acknowledgement. Source-job submission
retains its separate working-tree acknowledgement requirement.

With the experimental `environment-launcher` feature, `graph serve` accepts
`--environment-stdin`. A trusted caller supplies one JSON envelope over an inherited
pipe or local stream socket and closes it to signal EOF. Files, terminals, TCP
sockets, missing EOF, duplicate fields and oversized input refuse. Never put values
in selection files, arguments, logs or source control. The envelope fields are
`version: 1`, the exact reviewed `plan` and `run`, `lifetime_seconds` (1–300), and
`services` mapping service names to their declared bare/null environment keys.
Only explicit values are delivered; no host environment is read implicitly.

Input is bounded to 256 KiB total, 32 services, 256 keys and 32 KiB encoded payload
per service. The five-second input deadline requires EOF. The delivery lifetime
starts before input reception and is never renewed by compilation or staging.
Missing/extra service keys, ownership conflicts and expiry refuse before relay
construction; fresh admission revalidates project inputs. The existing guest tmpfs
and startup launcher deliver values under the selected UID/GID. Cleanup retains
value-free allocation identities and verifies the selected tmpfs has been retired.

Expiry prevents new staging or execution; it does not revoke an already-running
process's environment. Ordinary environment-bound restart/restore still require
fresh-delivery support. This interface does not provide AWS credential acquisition,
SDK refresh or configuration-file compatibility. The internal fresh-delivery restore
entry point accepts the original ingress deadline, preserving it through compilation
and staging; it does not renew an expired allocation.

For a control-only foreground graph (no host dependency bindings), select the exact
`plan` and `generation` returned by `graph owner-status --run-id RUN --json`, then
use `graph owner-restore --run-id RUN --expect-plan PLAN --expect-generation GENERATION
--environment-stdin --json` with a fresh private envelope on stdin. The live owner
validates input, source and generation before cleanup without data removal, then
recreates compute using new environment allocations. It retains its control socket
and checks owner liveness during restore. Generation and expiry are rechecked under
the cleanup mutation lease. Nonempty host bindings refuse before cleanup. A lost
reply is not permission to retry: inspect current state and make a new explicit
selection. Failure after cleanup can leave stopped or failed retained state requiring
recovery. The ignored native test
`foreground::native_test::private_owner_restore_preserves_data_and_retires_values`
qualifies the control-only small reference fixture through the actual CLI/socket.
Actual application restore and host-dependency replay remain separate open gates.

The CLI uses the shared bounded parser in `provider::managed_environment` directly.
Its private forwarding format binds exact plan/run and an
absolute same-host, same-boot monotonic deadline; conversion can shorten but never
renew the original lifetime. It uses the same clock as Rust `Instant` (Apple uptime
raw, otherwise monotonic), a fixed 64 KiB zeroizing output buffer, and the existing
duplicate/key/service validation. Transport callers must authenticate the peer and
operation before decoding and erase the raw input. This format is not a persisted
credential or authority to restore; the authenticated foreground request also binds
the expected current execution generation.

Guest environment storage has a shared ceiling of 512 concurrent allocations,
each with a 64 KiB tmpfs limit (32 MiB
combined filesystem capacity, excluding kernel overhead). Partial paths also consume
capacity. Graph admission checks the complete requested batch under its runtime
lease before graph effects; staging checks again. Verified retirement frees guest
capacity, while immutable intent history retains its separate 4096-entry bound.
Graph cleanup uses that same history capacity, counting active and archived
records together, so repeated restores cannot exceed a smaller cleanup-only
ceiling after allocation succeeds. Matching ownership, container bindings and
unambiguous records are still required.
No retained evidence is automatically deleted to admit new work. This environment
budget does not increase the runtime's separate container, CPU or memory limits and
does not establish 32-branch qualification.
Owned ingress buffers/values and prepared payloads are zeroized, but complete host
memory erasure is not claimed: scoped compilation still makes ordinary string copies,
and the JSON parser can use internal scratch storage for escaped strings.

Reviewed public Compose environment values populate Docker `Config.Env`, including
empty values and interpolation from the explicit non-secret input map. Omitting a
public override preserves image defaults. Bare/null keys use managed delivery;
managed values never populate Docker environment metadata, and conflicting ownership
is refused. The caller must classify values correctly rather than place secrets in
the public input map.

Container verification compares the exact pinned-image defaults plus public
overrides, independent of order; missing, changed, duplicate or unexpected entries
are refused. The private launcher replaces inherited values only inside the process.
If an image already defines a managed key, its public image default remains visible
in Docker metadata; the delivered private value does not.

A second CLI uses `graph owner-status --run-id RUN --json` or ordinary
`graph cleanup --run-id RUN --json`. Cleanup for an enrolled startup goes to its
pinned private owner; missing or replaced ownership requires explicit recovery and
never falls back to ordinary unenrolled cleanup. A disconnected status client does
not terminate the owner. TERM/INT requests cleanup; a signal during startup is
handled after the bounded startup operation returns, before publishing readiness.

The selected graph services must enable init and use an explicit numeric UID/GID.
A binding may optionally include `aliases`, up to eight exact canonical DNS names.
Every Compose `extra_hosts` name must select exactly one binding for its service,
with `host-gateway` as its declared target. Unsupported targets or incomplete alias
coverage refuse before owner creation. Interpolation uses only the supplied input
map, including literal `:-` defaults and `:+` alternatives; it never reads ambient
host environment values. Reserved localhost aliases and mounts overlapping
`/etc/hosts` or `/etc/nsswitch.conf` refuse for named routes so project mounts cannot
replace the selected name-resolution files.

Aliasless bindings retain `127.0.0.1`. Named bindings use `127.0.0.(slot+2)` and
publish those exact addresses through container extra hosts. Applications keep the
original hostname and selected port; the relay does not terminate TLS or rewrite
Host/SNI. Separate bindings can therefore use the same destination port. Ports below
1024 require an isolated graph network namespace, dropped capabilities and the
container-only `net.ipv4.ip_unprivileged_port_start=0` setting. An isolated native
fixture verifies nonroot port 443, original Host/SNI, certificate rejection and
cleanup. Actual application hostname/TLS acceptance remains open.

Each service may select multiple named bindings. Slots are unique across this owner,
and listener address/port pairs are unique within each service. One application/health gate opens
only after all of that service's selected listeners have been provisioned for the
same container generation. Startup or cleanup failures preserve uncertain evidence.
Explicit cleanup errors keep the owner available for retry; an already-started
uncertain mutation still requires its existing independent confirmation path.

The current owner handles one graph attempt. Detached ownership, enrolled
restart/restore, owner-death recovery and real
application qualification remain open. Private stable lock directories are retained;
they are not evidence of a live owner. Earlier experimental single-binding startup
receipts are explicitly refused by the named-binding schema; use the corresponding
older candidate for their cleanup. Stable v4 state is separate and unaffected.


### Dependency cache bindings

An installer service can declare `hack.dependencies.cache-volume`,
`hack.dependencies.lockfiles`, and `hack.dependencies.runtime-files`. The selected
named volume must be declared and mounted by that service. Cache initializers need
`completed` readiness; successful container start alone is insufficient. A verified
source publication and pinned image are required before cache admission.

For named volumes nested beneath a read-only source mount, capture/publish/verify
include empty mountpoint directories in the hashed source manifest and archive.
Ignored directory contents remain excluded, and the host checkout stays unchanged.
Conflicting files or symlinks and excluded source roots refuse publication; graph
admission also rejects older artifacts missing the required mountpoint directories.

Compatible graphs share a cache only when repository scope, logical volume, image,
Compose configuration, declared input contents and resolved public execution inputs
match. Linked worktrees use their verified common Git directory as repository scope.
Declare installer scripts in runtime files when their contents affect installation.
Explicit missing lockfiles and symlink inputs refuse admission. Source changes outside
the declared inputs do not independently change cache identity.

Cache provenance is separate from the cache fingerprint. New graph receipts record
whether a cache was created by this run or adopted, together with its observed
volume identity. Legacy receipts without provenance remain usable but provide no
evidence of fresh initialization. Successful initializer evidence requires a verified
container exit and unchanged cache identity; start or graph readiness alone is not
sufficient. Restore preserves historical evidence rather than renewing it for a
cache-hit execution. These records do not enable automatic eviction or reclamation.

Ordinary cleanup retains data. `graph cleanup --remove-data` releases a shared cache
reference rather than deleting that cache; graph-owned persistent volumes retain their
existing explicit removal behavior. Storage inventory reports shared references and
never presents reference release as physical deletion. The current runtime limits
admission to 64 cache volumes; automatic cache collection and byte/age retention are
not yet implemented. Application installer locking, interrupted installation and real
package installation still require qualification independently of these bindings.

Explicit package egress can be requested when creating a separate candidate pool:
`runtime up --profile development --allow-host registry.example.com --allow-host packages.example.com`.
Low-level omission preserves legacy isolated creation and existing intent; normal
native development selects `--internet` explicitly. The opt-in host mode accepts
at most 32 canonical DNS name inputs;
existing pools preserve their intent on omission and refuse a changed configured
host set. The pinned SmolVM virtio-net provider resolves names during creation.
The candidate validates and pins that initial public-address configuration before
boot, then audits its retained configuration. That audit is **not** a static runtime
allowlist: Smol also permits DNS descendants of each configured name and learns
addresses from permitted DNS answers for a bounded TTL (60–3600 seconds).

Every candidate provider invocation for this mode explicitly sets
`SMOLVM_EGRESS_FLOOR=strict` in its clean environment. The provider's strict floor
blocks private, gateway, loopback and metadata destinations even when learned from
DNS; the weaker local default is not used. This launch policy does not retroactively
change an already-running provider. Source review and configuration checks require
fresh native allowed/denied destination controls before credentials are delivered.

Outbound Docker bridges require recorded internet or approved-host capability. Their
internal/outbound property is recorded and checked through inspect, restart,
restore and cleanup; existing external Docker networks are never adopted. NAT is
enabled only for explicitly networked pools, without an implicit host-gateway
mapping. Existing internal graph networks remain internal. Egress is an IP/DNS
policy, not TLS identity or per-port authorization: applications must still verify
TLS, and shared CDN addresses do not provide hostname-level isolation by themselves.
Credential delivery remains a separate managed-environment contract. This source
integration requires a native allowed/denied destination qualification before
claiming real package installation support.


For active dependency-cache services, project `.npmrc` configuration is reviewed
separately from source selection. Only HTTPS registry locations, exact registry
`${ENV_NAME}` token references and `always-auth` are accepted; literal credentials
and unrelated npm options are refused without including values in errors. Capture
adds the canonical template to the immutable source artifact, and admission verifies
the template against the reviewed plan. Mount permissions remain a separate graph
contract; capture does not grant writable source access.
The original host file is never copied wholesale or modified. Registry configuration
changes invalidate the plan and dependency-cache identity. Required token values
must arrive through service-scoped private environment delivery and are excluded
from public container environment configuration and published source artifacts.


A reviewed foreground selection may explicitly contain `dependencies: []` for a
managed-environment service that has no host dependencies. It still binds the plan
and retains the foreground owner/control lifecycle. No dependency sockets or guest
relay helper are required in this mode; persisted control-only receipts distinguish
it from incomplete legacy relay state. Independent cleanup verification refuses
both surviving guest paths and dangling links rather than reporting them absent.


A service may use up to the graph's existing 4 GiB memory ceiling, allowing a
bounded dependency installer to request 3 GiB. Combined service reservations still
must fit 4 GiB and four CPUs; increasing one service does not increase the aggregate
budget or bypass host/VM admission.

Named volumes support the standard long-form `volume: {subpath: relative/path}`.
The path must be a canonical relative directory (no traversal, empty components,
interpolation or control characters). Multiple targets can select distinct
subdirectories of one shared dependency cache; they still count as one volume.
Their reviewed layout participates in cache identity and exact container config
verification. Source mountpoint placeholders remain part of the immutable source
publication; source directories are never made writable.

Before any graph container is created, required subdirectories are prepared only
in a freshly created, empty, independently verified owned volume. Existing/shared
volumes are validated without repair. Interrupted preparation can resume only
with a matching private host-side pending record, the same owned volume creation
identity and directory inode, no container references (including stopped containers),
and an otherwise empty tree containing only the reviewed directories. Preparation
holds a bounded guest directory lock; completion is durably recorded before any
graph container creation. Completed records never authorize repair of missing data.
The create-before-record gap, torn journal writes, symlinks, unexpected contents,
and identity changes refuse recovery. Records are retained while volumes exist;
ordinary owned-volume deletion reclaims its matching record only after verified
volume absence. Shared caches keep their records. The private journal inventory
is bounded to 256 entries; cache-wide GC remains a separate gate.
No helper container is created. Subpath mounts disable Docker
copy-up; newly created directories use root-owned mode 0755. Applications requiring
other ownership or image-populated volume content need a separate explicit contract.
Root-only volume mounts without subpaths keep their existing behavior. Native
workspace installation and engine subpath confinement require separate qualification.

Fresh `graph run` or `graph serve` may explicitly select
`--release-initializer-cache <service>` (repeatable). The service must be a reviewed
dependency-cache bootstrap initializer with completed readiness. This optional
policy releases guest page/dentry caches after the first verified successful
initialization of a cache created by that graph; it never deletes package files.
Default behavior is unchanged. Adopted/legacy caches are ineligible, and restore
and restart retain historical outcomes without repeating the release.

The graph receipt's `initializer_cache_release` records selection and the outcome.
Before dependents start, the runtime verifies initializer and cache identities,
other graph journals, and the complete bounded Docker container inventory under
the Engine lease. Other containers or active graphs cause an explicit safe skip;
malformed or uncertain ownership refuses the operation. This conservative policy
may skip release even for an unrelated stopped container.

A durable `pending` record precedes synchronous `sync` and guest `drop_caches=3`.
The recorded elapsed duration includes validation, quiescence checks, intent
persistence and the effect, ending before the final acknowledgement write.
The guest exec timeout is seven seconds and the host response budget eight seconds;
normal ownership checks are additional. The pinned agent kills the entire exec
process group on timeout/disconnect. Kernel-blocked work can still delay exit, so
an uncertain response never counts as success or triggers a retry. Pending evidence
blocks subsequent graph admission, restart/restore, and archival, including after
ordinary cleanup. Explicit `graph reconcile` can mark an uncertain effect
`aborted_boot_change` only after the owned guest has independently verified a
different boot; it never marks the release successful or replays it. Same-boot
uncertainty remains fenced. The effect does not change
provider reclamation defaults, capacity limits, or provider pins. Guest-cache
release alone does not prove host backing reclamation or a performance gain.

The pinned Bun 1.3.14 application fixture needs an explicit package-manager
compatibility setting: `BUN_INSTALL_STREAMING_MIN_SIZE=999999999999` in the
installer service's Compose environment. Native Linux ARM64 qualification
reproduced Bun's tiny-first-chunk streaming extraction failure and verified
buffered extraction of identical archive bytes. The [upstream fix](https://github.com/oven-sh/bun/pull/34861)
describes the defect. This setting allowed the real dependency install and web
edit/restore/revert workflow to pass with the original 2 GiB installer limit.
It remains specific to this pinned fixture; buffering changes memory behavior
and must be included in capacity and performance comparisons.

### Automatic disk trim limitation

Candidate provider launches explicitly set `SMOLVM_DISK_TRIM=0`, including
restart and recovery; ambient values cannot enable automatic guest trim. Pinned
Smol accepts `0` as disabled and forwards it to its guest agent. Its imago discard
path can truncate backing files, conflicting with the candidate's exact retained
disk-size identity. Automatic trim remains disabled until safe disk reclamation
is supported and qualified. This does not relax disk identity checks or repair
previously shortened files, and does not change the separate memory-reclamation
policy. Already running providers require an owned stop/start to receive the setting.

### Extending a stopped pool's approved hosts

`runtime network extend --allow-host pkg-npm.githubusercontent.com --json` adds
explicit hostnames to an existing approved-host pool without replacing its disks
or starting it. It requires the retained provider process to be absent, its PID
record and database identity to match, the VM lock and disk handles to be free,
and existing disk/configuration/owner-registry checks to pass. Isolated and
host-gateway pools cannot be converted through this command.

The managed pinned-schema adapter journals the exact old/new owner and provider
record before a SQLite transaction, then commits the owner policy. Normal startup
refuses an outstanding network-update journal. Repeat the same extension to
reconcile a complete journal whose state is exactly before/before, before/after,
or after/after; foreign edits and the impossible after/before state refuse.
Malformed or incomplete staging files require inspection rather than automatic
adoption. DNS resolution is bounded, and only canonical public host addresses are
accepted. Existing hosts/CIDRs and unrelated provider fields remain unchanged;
this does not bypass disk recovery or authorize runtime startup.

### Temporary files in writable services

Services with writable image roots (the Compose default, or `read_only: false`)
use the image's ordinary `/tmp`; the candidate does not overlay it with a small
RAM filesystem or impose `noexec`. This permits package extraction and temporary
executables without imposing an unrelated 16 MiB limit. These files remain in
the container-owned writable layer and are discarded with container removal;
source-bind protections and named-volume persistence are unchanged. Explicit
`read_only: true` services retain the bounded 16 MiB `rw,noexec,nosuid` `/tmp`
tmpfs contract.


Compose services without `pids_limit` retain Docker's default PID policy; the
candidate does not impose an implicit 64-task cap. Linux counts threads as tasks,
so that cap can prevent Next.js/Bun workers from starting even without an OOM.
Explicit supported PID limits remain enforced and verified (maximum 128).

Fresh managed environment for noninteractive exec uses `graph exec-selection`
followed by one `graph exec --environment-stdin --expect-plan SHA
--expect-container ID --expect-generation SHA` request. Selection includes owner,
namespace, run, service, boot and generation; clients must compare it with their
saved project mapping. The bounded v1 private input selects exactly one service.
Values travel through an upgraded Engine stdin stream to the exact current
launcher already mounted in that service, never Docker Env, arguments or journals.
The launcher checks an ingress-derived expiry and consumes stdin to EOF before
executing an absolute command. This does not renew startup environment allocations
or host-dependency grants. Older mounted launcher versions refuse fresh execution
until an explicit restart with the matching candidate. Transport timeout or loss
is uncertain completion, never authorization to replay or a claim that the command
was killed. Output remains caller-owned and may contain secrets.


Normal native development uses `runtime up --profile development --internet --json`:
unrestricted public outbound internet/NAT, without hostname allowlisting. The
pinned provider still receives `SMOLVM_EGRESS_FLOOR=strict`, preserving its
private/loopback/metadata boundary. This is not restricted package egress, TLS
verification, or application authorization. It adds no inbound ports, host gateway
alias or cross-VM network. Internal Docker networks remain internal.

The development profile's guest allocation is 6 GiB; guest allocation plus
2 GiB is a provisional provider-footprint estimate, not a hard operating cap.
Startup requires the unchanged 10 GiB free-plus-file-cache estimate: 6 GiB guest,
2 GiB provisional provider overhead and 2 GiB host reserve. Development admits
observed normal or warning macOS memory pressure only with that headroom, normal
thermal/performance status, and unchanged swapouts. It samples before acquiring
the startup lease, then samples a fresh three-observation window under the lease
before creating ownership, aliases, disks or provider capacity. Swapouts must
remain at the pre-lease baseline; a stale or incomplete observation refuses.
The final pre-boot check remains in place. Research keeps its normal-only pressure
policy, 16 GiB raw-free-memory floor and three samples 15 seconds apart.

Before new live Development effects, normal pressure requires at least 2 GiB of
estimated host headroom; warning requires 4 GiB, retaining both provisional
overhead and host reserve after the guest allocation has been charged. Either
floor increases by the measured provider footprint above the guest-plus-overhead
estimate. Critical or unknown pressure, changed swapouts, or thermal/performance
warnings refuse new effects. Cleanup retains its separate ownership checks. A
larger healthy application graph can continue operating when its excess footprint
has matching host headroom. `runtime status` reports that footprint separately;
this experimental policy does not qualify efficiency or host capacity.

Admission reports add `memory_pressure_level` (the observed sysctl value or null)
and `memory_pressure_state` (`normal`, `warning`, `critical`, or `unknown`). Apple's
exported dispatch masks are 1, 2 and 4; other or missing values refuse. The retained
`memory_pressure_normal` field stays true only for normal pressure and remains
false in an admitted warning report. Older reports containing only that boolean are
historical observations and cannot authorize the warning policy; every operation
uses a fresh typed observation.

An existing owned pool changes policy only while stopped through
`runtime network internet --json`, then an explicit up with `--internet`.
The operation verifies the dead retained process, owner registry, exact disks and
provider database; it changes only network intent under the existing durable
recovery journal. Volumes and all unrelated database fields remain unchanged.
Repeating the same command reconciles exact old/new commit sides; foreign changes
and incomplete journal staging refuse. Running pools and mismatched startup
requests refuse without changing policy. Host allowlisting remains opt-in through
`--allow-host`, mutually exclusive with `--internet`; there is no automatic policy
migration, restart or disk replacement.

### Stopped normalized foreground restoration

A normalized foreground graph that has completed owned cleanup to
`stopped-data-retained` can start a new foreground owner with its existing run
and retained volumes. Obtain `graph restore-selection --run-id RUN --json` after
the candidate VM is running, then use `graph serve-restore` with the same reviewed
normalized input, original Compose hash, namespace, plan, run, and returned
`--expect-generation`. Supply the ordinary serve dependency plan, readiness,
source, and route selections again. Supply fresh `--environment-stdin` only when
managed values are needed; credentials and expired grants are never replayed.

The normal candidate CLI retains its scoped run mapping after confirmed `hack down`
or foreground cleanup. A later `hack up` with that candidate home verifies the
stopped owner, recorded environment/profile/AWS selections and current reviewed
source contract, then uses this same-run restore path. Mapping publication after
readiness compares the exact retained owner before replacing its record. An active,
changed or uncertain mapping refuses before new graph effects. Earlier candidate
builds removed the mapping on down; their retained volumes are not guessed or
silently adopted by a fresh up and require explicit owned-state recovery.

Selection binds the receipt, current VM boot and verified current volume
observations. Restoration rechecks these before effects, requires the old owner
publication and lock to be retired, and verifies the historical cleanup
acknowledgment in its original boot context. A changed plan, missing volume,
active owner, or stale selection is refused. The prior stopped receipt is archived
before fresh dependency ownership is admitted. This does not enable file-based
`graph restart`/`restore` or normalized live-owner redelivery, and does not replay
initializer cache-release effects. Native same-run restoration and cross-boot
volume continuity require separate runtime qualification.

An explicitly recovered post-reboot graph may retain a stopped shared-source
receipt whose `source.shared.device` names the prior host filesystem device.
After **completed** selected absent-publication cleanup and separate publisher
retirement, inspect that same run with `graph inspect-source-device-rebind
--run-id RUN --json`. Review the returned original stopped-receipt hash and
qualification, then commit only that selection with `graph
recover-source-device-rebind --run-id RUN --expect-selection SHA
--accept-legacy-device-rebind --json`. This private candidate command changes no
stopped receipt, cleanup proof, retirement proof or named volume. It writes one
immutable witness for the current Owner share, requiring the same canonical
project path, inode, guest path and unfiltered access, with only the host device
number changed. The current guest's writable virtiofs mount and selected volume
identities are checked independently. The explicit acceptance records that
legacy receipts cannot establish original physical volume continuity across the
host reboot.

An exact completed cleanup and retirement for the current stopped receipt takes
precedence over older cleanup records. Pending operations, unresolved initializer
effects and mismatched receipt or retirement identities still refuse recovery;
historical records cannot authorize a later generation.

When a normal foreground shutdown has already removed its publisher endpoints,
`graph retire-recovered-publisher` confirms the current boot's acknowledged
cleanup under the publisher lock. It checks the exact stopped receipt, cleanup
effect, guest inventories, retained volumes and absent endpoints. It changes no
publisher files or graph data. A confirmed but invalid acknowledgement refuses;
historical crash-recovery receipts cannot override it.

Ordinary cleanup can be acknowledged before a later dependency-journal archival
step fails. If this leaves a dead foreground publication for the current stopped
graph, use the explicit private `graph retire-acknowledged-publisher --run-id RUN
--expect-owner OWNER --expect-receipt RECEIPT_SHA --expect-publisher PUBLISHER_SHA
--json` recovery. The SHA selectors identify the exact stopped receipt and
foreground owner-record bytes. Admission requires the current guest boot's
confirmed cleanup acknowledgement, no pending operation, independent absence of
compute by both immutable ID and reserved name, and all named volumes present.
Environment, startup, probe and bridge cleanup inventories are rechecked while
holding the publisher and provider locks, including at each publication effect.
The existing retirement journal preserves both original publication files and
resumes an interrupted socket-first rename. Active owners, replacement listeners,
stale selectors and incomplete acknowledgements refuse without falling back to
historical recovery. This operation changes no graph receipt, VM, dependency
journal or retained data; it does not authorize a restore by itself.
An old completed or cleanup-completed dependency journal is accepted as inert
evidence only; malformed, incomplete or pending rebind state refuses at each
effect boundary. Safe archival and the next restore remain separate checks.

If ordinary cleanup closed all dependency sockets but a later archival failure
left its reservation, first complete that exact publisher retirement. Inspect
`graph dependency-reservations --json`, then use `graph
release-acknowledged-dependencies --run-id RUN --expect-owner OWNER
--expect-receipt RECEIPT_SHA --expect-publisher PUBLISHER_SHA
--expect-reservation RESERVATION_SHA --json`. The final selector is the inspected
reservation fingerprint. This requires the current boot's acknowledged cleanup,
the exact completed publisher retirement, a dead reservation process matching
that publisher, the same run/Owner/boot and precisely the receipt's dependency
slots. Every selected socket must already be absent; even a matching stale socket
refuses. The selected record moves atomically without overwriting into the graph's
`dependency-reservation-retired-SHA.json` history, preserving bytes and inode.
Retry verifies that same record and proof. Changed selectors, another publisher,
pending/foreign records, occupied history and any reappearing socket refuse.
No socket, VM, graph receipt, dependency journal, data or sibling is removed.
This explicit recovery frees the claim; normal `up` still performs its own checks.

`restore-selection` then binds the witness's raw hash to the selected generation.
The source checks use only an in-memory device projection; original retention and
restore history consume the unchanged stopped receipt. The new receipt receives
the projected source after history retention, before the first new-attempt write.
The witness file remains pinned and is rechecked before that write. Once the
first new generation replaces the stopped receipt, the witness is audit history
and grants no authority to later ordinary down/up cycles. An incomplete
`source-device-rebind.pending` file, including an empty or partial write, is
preserved and refuses both explicit recovery and a new retired-publisher bind;
there is no automatic prefix-based adoption or deletion. The ignored native
synthetic-device fixture checks this same-run transition and later retained
marker reads, but only an actual host-reboot application run can qualify the
physical continuity claim.

A selected source-device witness also preserves an existing dependency cache's
namespace when the Git common directory is on that same filesystem. The runtime
reconstructs the old scope hash from the unchanged common directory path/inode
and selected prior device number, and requires every retained cache scope to
match. Only the new attempt receives optional cache-scope continuity metadata;
the stopped receipt, original cache names/fingerprints, volumes and witness bytes
stay unchanged. All package inputs, image, command, environment, host mappings
and volume layouts are still freshly fingerprinted, with strict resource equality.
This is not a fallback for changed lockfiles or an unrelated repository.

Later ordinary replays verify the immutable witness's raw hash and run/owner/share
linkage, the current common directory path/device/inode and retained scopes.
Missing, changed or pending provenance and replaced Git metadata refuse. A second
device transition requires a separately supported explicit recovery; the runtime
does not silently extend this projection. Older candidate binaries may refuse the
new optional source metadata, so a downgrade must be qualified separately.

Completed post-reboot absence recovery also retires the prior boot's completed
dependency-rebind journal. A retained foreground restore can finish this archival
for an earlier candidate: it selects the exact original ready receipt and exact
completed stopped receipt from bounded history, verifies durable retirement,
unchanged provider/boot and retained volumes, and proves old and current compute
absent under the held foreground lock and provider lease. The journal's completed
generation must match the original receipt. Original bytes remain in a digest-bound,
resumable archive; a later current-boot journal is preserved for its own cleanup.
Changed evidence, pending state or live compute refuses archival. This does not
replay old dependencies or relax the fresh graph's endpoint/readiness checks.

The ignored native regression
`foreground::native_test::retired_rebind_history::completed_prior_boot_rebind_archives_after_newer_stopped_generation`
uses an isolated capacity-two candidate, a pinned pre-archive native executable
(`7dc0811cd0179f40340e48c540699933dc099cf7`) and a current executable with
`retire-acknowledged-publisher` and `release-acknowledged-dependencies`.
The candidate must already be prepared and running with the pinned image loaded.
Supply `HACK_LOCAL_TEST_ROOT`,
`HACK_LOCAL_TEST_BINARY`, `HACK_LOCAL_TEST_LEGACY_BINARY`,
`HACK_LOCAL_TEST_LEGACY_SHA256`, `HACK_LOCAL_TEST_IMAGE`,
`HACK_GRAPH_RELAY_ARTIFACT` and `HACK_GRAPH_RELAY_SHA256`. The pinned image must
contain `/usr/local/bin/bun` for the HTTP server and retained marker. Precompile the
test, then run it under an external 300-second watchdog with one test thread.
Both executables must accept that exact candidate root; checkout-bound source
binaries must be built for it, or use relocatable `hack-native` executables with
a dedicated private root. The test stops and restarts the entire supplied pool,
so the root must contain only this fixture, with no application or sibling-owner
resources. Its host listener uses an ephemeral loopback port. Project and private
inputs live beneath that declared root and remain on failure, along with readiness
stage labels and bounded foreground failure output. The test has no fallback
`--remove-data` cleanup on unwind. Only its successful explicit graph cleanup
removes data and disposes its own input directories; the external harness must
stop the exact owned pool and preserve evidence after failure.
The prior-host-boot owner and selected dependency reservation are synthetic:
after proving the exact reservation owner dead and every recorded socket inactive
and unchanged, test-only setup projects its process timestamp and socket device
numbers. It preserves the real completed journal, socket inodes, bindings, graph
receipt and sibling reservations. Production inspection still rejects current-boot
timestamps, mismatched device/inode evidence and live owners or listeners.
It uses normal refresh, recovery, cleanup and restore paths, plus an injected
archive interruption at the owned verifier boundary. The original owner crash and
legacy archival refusal remain controls. Only the later legacy foreground owner
receives graceful SIGTERM: the test requires normal handler exit, process death
and exact dependency socket absence before independently retiring its publisher
and reservation through acknowledged cleanup. Reservation history must preserve
the original bytes and inode, with the selected active claim absent and sibling
state unchanged. A passing test proves
same-run retained marker and sibling isolation in that fixture; it does not
establish application or physical host-reboot acceptance.

An interrupted legacy HTTPS frontend can leave its exact socket, Caddy receipt
and lock alongside an unpublished shared-owner configuration. Explicit private
`runtime recover-quiescent-https --expect-owner RECEIPT_SHA
--expect-configuration CONFIG_SHA --expect-frontend-pid OBSERVED_DEAD_PID --json`
archives this combined incident without signaling processes or changing CA data.
It requires the current pool/boot, strict configuration, exact authority path,
dead recorded processes and configured executables, no shared leases or release
history for that generation, an inactive Unix socket, and exclusive IPv4/IPv6
wildcard and loopback listeners held across each move. The legacy receipt and
unpublished configuration must select the same Caddy path, binary hash and port.
Receipt/config selectors identify raw file bytes; the CA must retain its original DER fingerprint. A durable journal
and exclusive renames preserve original inodes and permit exact partial retries;
foreign targets, changed evidence and live or uncertain effects refuse. A crash
during initial journal publication may leave an incomplete journal: it refuses
retry before archival rather than guessing or discarding that evidence. Global
HTTPS evidence archival does not itself recover a project finalization token or
prove application readiness: run the explicit frontend recovery and normal
startup checks afterward.

Legacy receipts may predate a host filesystem device-number change. The strict
command refuses those records. An explicit additional
`--accept-legacy-device-rebind RUN:WITNESS_SHA:SOCKET_DEV:SOCKET_INO:LOCK_DEV:LOCK_INO`
selects the existing graph source-device witness and both current HTTPS identities.
Both old receipt devices must match its old device; both current devices must match
its current device, with each respective inode unchanged. Current owner bytes,
host/guest boot, project share, stopped graph scope and witness bytes are rechecked
before each effect. Mixed changes refuse. The journal pins the current identities;
the legacy receipt stays byte-identical. This is explicit legacy migration with
**original host-volume continuity unproven**, not an automatic identity relaxation.

Development admission distinguishes fresh capacity from a verified running pool.
A fresh VM retains the 58 GiB disk floor (32 GiB storage, 10 GiB overlay and
16 GiB host reserve). Reusing the exact owned running pool requires the 16 GiB
host reserve, with memory-pressure, memory-headroom and thermal checks unchanged.
`runtime probe --profile development --json` reports `disk_budget_basis`. Reuse
requires matching profile, creation receipt, native process/PID-file identity,
machine name and both disks' current identities and declared sizes. Every sample
and the acquired startup lease recheck the selected owner; changed ownership
refuses, and a reserve-qualified request cannot enter VM create or boot. Stopped,
missing or unproved capacity retains fresh-allocation requirements or refuses.

### Native persistent-data identity codec

`provider::graph::native::persistent_data` defines one closed, private-candidate
version-1 owner record and a pure comparison. Its persistent binding contains a
64-hex project namespace, logical storage name, 32-hex owner, exact guest owner,
boot UUID and backing-disk identity, and the default local-volume policy. An
enrolled record retains the exact volume name, UTC `CreatedAt` bytes and directory
device/inode. Runtime run, plan and generation IDs are absent, so independent
compute generations can compare the same explicitly selected data identity.

Pending intent is distinct from enrolled observation and always refuses the
comparison, even when supplied an exact volume observation. Missing observations,
unknown/duplicate fields, malformed identities, unsupported versions/policies,
and scope, guest, birth or directory changes refuse. Copied labels do not make a
replacement volume match its original birth. Guest boot/disk rollover remains a
refusal requiring a future separately owned handoff; no migration is inferred.

This codec alone is data-only. Decoding an enrolled assertion does
not prove a durable enrollment commit, fresh observation, contents or effect
authority. It is separate from dependency-cache provenance and does not qualify
persistent databases, initializer replay, SQL retention or the full NC05 corpus.
The enrollment and adapter owners establish their separate commit and observation
boundaries. Their presence does not qualify the real SQL/application gates below.

### Persistent-data enrollment owner

`persistent_data::enrollment` owns the private-filesystem lifecycle. The owner uses a stable namespace/storage slot,
independent of compute generations, under an explicitly supplied existing private
host directory outside application data. An exclusive slot/lock and pending
record are synchronized before the sole original-create attempt. Promotion
requires that attempt's captured volume identity, matching fresh observations,
and unchanged guest, root, lock and original record identities/bytes. Existing
volume names, slots, incomplete staging and pending attempts refuse; no later
invocation recreates or promotes an interrupted attempt.

The sealed transport requires exclusive creation relative to every supported writer
under an existing guest effect owner. An absence probe followed by Docker's
idempotent volume create API alone does not satisfy this contract. The native
adapter supplies the continuously held common provider lease described below;
unserialized direct guest/socket writers remain outside that authority. No
adoption, repair, deletion or global default is introduced. Existing-only retained reads acquire the existing lock, compare the
exact binding/birth/directory, and leave record bytes and generation references
unchanged. Pending or missing/foreign state cannot become enrollment by reading.

Before rename, failures retain pending or incomplete staging. After rename, a
publication/directory-sync failure is uncertain: the enrolled pathname may exist,
but the operation returns no successful durable commit. A later retained read is
a fresh data-only comparison and cannot retroactively prove that failed operation
completed, or authorize runtime effects by itself. The lock coordinates these
writers; unsynchronized same-user external mutations are not atomically frozen.
Local synchronous filesystem I/O and trusted transport deadline obligations are
not process cancellation or crash-durability proof. Real private-filesystem and
stand-in tests qualify sequencing/refusal; persistent SQL and full NC05 runtime
retention remain open.

### Native persistent-storage adapter and receipt v4

Persistent startup without an explicit witness tool remains gated before provider
connection or graph/data owner publication. The candidate can select a caller-pinned
Linux arm64 tool through paired `--storage-witness-tool` and
`--expect-storage-witness-tool` options on native `run`/`serve`. The path must be
absolute and the SHA-256 exact. There is no artifact discovery, build, download,
emulation or fallback. Source wiring is not package/ABI or live SQL qualification.
Name, labels, `CreatedAt` and directory device/inode can all alias after an empty
volume replacement; matching that tuple is insufficient. No metadata-only pass
can enable storage or establish unique physical continuity.

The explicit candidate implementation connects `persistent_data::engine` to the existing
native graph Engine. Receipt v4 carries stable data references and exact workload
mounts outside its run-owned container/network inventory. A persistent identity has
no run, plan or generation ID. Graph2 image-only receipts retain their old binding
bytes; graph3 is reserved for the separate source-bearing contract. Persistent
graph4 with a complete enrolled proof may enter the same-boot recovery candidate;
its runtime qualification remains open. Ordinary authenticated compute teardown uses the
original graph owner and never deletes, recreates or replays data or jobs.

All supported mutation paths retain `OwnedGuest` and its original provider
`operation.lock`. The adapter checks the held descriptor against the canonical
private pathname and root incarnation, in addition to the existing process,
guest boot and backing-disk checks. It holds that lease from authoritative absence
through one volume POST and final private owner commit. Supported native workloads
cannot mount a Docker socket or invoke arbitrary guest control; source/file mounts
remain refused, and private-delivery binds combined with storage also refuse in
this first slice. Existing provider Engine/guest writers use the same common lease.
External same-user Docker/guest writers are not serialized by this cooperative
contract. Docker's idempotent POST is not an exclusive creation primitive.

The private graph reservation and synchronized data pending intent precede the
sole original create. The returned name, local driver/default policy, exact labels,
`CreatedAt` and guest directory device/inode are captured and freshly compared
before enrollment. A timeout, lost lock, failed observation or changed identity
returns uncertainty without adopting a later matching row, retrying POST or deleting
data. A visible enrolled file after failed final sync is not successful completion.
An earlier graph's unconfirmed reserved data reference blocks another compute
attempt even after its compute-only retirement. Missing owner state with an
existing volume for that logical namespace also refuses; copied labels or empty
contents do not authorize enrollment.

Retained startup validates the existing owner and physical volume under the same
lease without rewriting its stable binding. Previous compute consumers must have
completed exact retirement. Explicit mounts use `NoCopy`; every image-declared
volume must be covered by exactly one admitted persistent mount, so no anonymous
volume is created. Physical mount membership is exact. Startup/final readiness,
inspection, shared active-run admission and final teardown publication recheck data.
Startup uses the original ingress deadline; read-only data observation and cleanup
validation use a bounded 40-second budget per observation group, without renewing
it per volume; final teardown validation begins a separate group after compute stops.
Compute teardown stops/deletes only recorded containers and their empty bridge.
Persistent volume deletion, pending enrollment recovery and guest/disk rebinding
are not implemented.

`tests/fixtures/native-persistent-sqlite.json` pins the Bun/SQLite programs adapted
from the existing graph SQL fixture. It separates initializer attempts from an
`INSERT OR IGNORE` seed marker/nonce, adds an app-to-database HTTP write/readback,
and keeps `CapDrop: ALL` and `no-new-privileges`. The compiler/lowerer/scheduler
regression uses synthetic observations; it does not execute SQL or prove Engine
behavior. The first real native acceptance must use a source-pinned cached Bun
image ID and two independent compute generations of this same logical data slot:

- First startup records the exact data owner/birth/directory and seed nonce, requires
  a fresh successful initializer attempt, and proves the app HTTP SQL write/readback.
- Authenticated down retires only its exact compute inventory. The volume identity,
  SQL marker, seed nonce and written value must survive unchanged.
- Fresh up uses new compute IDs and the same data identity. The initializer process
  runs again and increments the attempt table once; the seed nonce stays unchanged.
  SQL initialization is idempotent, not a cached completed-job result.
- Known initializer failure prevents dependent starts. Pending or missing owner
  state, lock loss, a copied-label replacement with changed birth/directory and
  changed guest identity refuse before dependent effects; uncertainty retains
  receipts/data without an automatic create/adoption/delete retry.

The root-witness continuation must reuse the reviewed directory-xattr contract:
an independently random name/value is persisted by the owner, then exclusively
created only during the original enrollment with `XATTR_CREATE` on a retained
nofollow root descriptor, synchronized, and independently reread with exact
descriptor/path/root checks. Retained startup only reads; missing/changed witness
refuses without repair. Whole-root/xattr copying remains outside the claimed
guarantee. The historical metadata-only checkpoint did not implement that helper
boundary; the witnessed continuation below connects its source without claiming live qualification.

These runtime/SQL gates and replacement safety are not yet qualified by this source implementation. Stock
PostgreSQL parity remains a separate NC05 gate requiring authored ownership/user
or a specifically qualified capability policy. This slice guesses no UID/GID,
changes no volume permissions, and adds no capability to make a stock image work.
# Witnessed runtime enrollment (candidate)

The separate persistent owner version2 stores its expected root xattr in the private
pending intent before the single original volume create. It captures the original
volume and root UID/GID/device/inode, seeds with `XATTR_CREATE`, independently verifies
the root, and only then publishes enrollment under the original private lock. A missing
or changed witness refuses retained reads without repair. Version1 metadata records
are not upgraded or treated as continuity proof. Ambiguous create/seed retains the
intent; publication after rename can be uncertain even when an enrolled file is visible.

Native receipt4 may describe a separate pinned guest tool installation, including the
original directory and helper identities. This control path shares the existing relay
artifact/upload boundary and uses private descriptor input under the original operation
deadline. Dependency-free legacy graphs continue to install no guest artifact. Tool
receipt parsing grants neither installation nor storage authority. Startup selects only
version2 owners, publishes the current run/tool reservation before upload, then reopens
the complete saved helper against the current receipt before every owner proof. Metadata
selection alone cannot authorize a mount. Every receipt write requires new admission.
The one-run verifier lease can read another retained data owner only while both its own
tool receipt and the target receipt remain pinned; it cannot seed that other owner.
The exact Preparing reservation is excluded from capacity accounting only while every
resource is still reserved without an ID. All other uncertain attempts continue blocking.
Each installation or proof transport publishes one exclusive synchronized
`storage-call.pending` leaf before dispatch. Only its issued value clears the exact
inode after known completion and fresh admission. Unknown replies or interrupted
publication retain this fence across fresh provider leases; neither reopening nor
a new storage attempt can replay it or create a competing verifier. No command
resumes or repairs a retained marker. Receipt2–5 wire formats do not change.

The initial process policy is explicit Bun with an empty entrypoint, UID/GID0, dropped
capabilities and no privilege gain. The maintained SQLite initializer/web/check corpus
is the first live acceptance target. Captured root UID/GID remain exact; a PostgreSQL
entrypoint or owner handoff is refused rather than inferred from unchanged inode/xattr.
No permissions are changed. The separate `hack-storage-root-witness` binary target
uses the same bounded codec/Linux kernel implementation and emits only closed replies;
its artifact, guest transport, durability and real SQLite lifecycle remain live gates.

Inspect and cleanup reopen the saved verifier without requiring a current host artifact.
Cleanup verifies content before effects and retains data and verifier dependencies after
workload removal. A complete Ready receipt4 may enter the existing same-boot dead-owner
cleanup protocol; actual owner2/root/xattr checks still precede cleanup effects. Partial
installation, pending enrollment, lost proof or unknown transport never authorizes
repair, seed replay, data deletion or migration. Receipts2–5 retain their wire shapes;
version1 metadata owners remain separately decodable and never become continuity proof.

Saved helper re-admission is read-only and requires the same complete tool reference,
guest/boot/disk, canonical private directory chain, and receipt inode and bytes before
and after transport. A receipt transition requires fresh re-admission; missing or partial
installation never triggers upload, repair or seed. Retirement consumes the issued
handle and checks the complete bounded native receipt inventory under the original
provider lease. Every saved dependency, including a Removed receipt4 that still proves
retained data, prevents deletion. No receipt archival or proof withdrawal is implemented,
so ordinary workload removal cannot retire its verifier. A separately eligible handle
can remove only its exact helper, owner file and empty original directory; an ambiguous
result has no retry, follow-up cleanup or crash-resume authority. These source and
stand-in transport controls do not qualify guest execution or enable storage startup.
Tool handles are bound to one run on its original Engine/provider lease. The first
admission binds that run for the lease's entire lifetime; another run on that lease
refuses before transport. Its constant-size volatile state is shared by all sibling
handles; claiming retirement before transport permanently revokes them, even if failure
leaves guest files unchanged. A fresh lease cannot accept an older handle and has its own
independent run authority. There is no count limit shared across operation leases.
Active tool transport also prevents retirement; uncertain transport revokes sibling
handles rather than treating guard destruction as proof that a guest command settled.
The shared artifact reader now requires a current-UID regular file with one link,
no group/world write permission, and matching held-FD/path identity and bytes. Legacy
relay graphs with dependencies use that stricter reader and its fixed
`guest_tool_artifact` refusal; dependency-free graphs do not read an artifact.
Whole-root copies retaining the exact xattr remain outside this witness guarantee.
Stock PostgreSQL remains a separate ownership/capability acceptance gate.

### Frontend-owned finite hooks

Normal native graph compile/review/plan/run/serve still refuse host intent. Explicit
`frontend-plan`/`frontend-serve` accept a private source-v3 envelope only when its
pinned finite-hook permit and active owner match the original frontend parent PID,
UID, run, project/branch and compiler semantic hash. Permit/owner bytes, incarnations
and canonical private parent are rechecked through preparation and effect fences.
Finite normalized host intent stays ephemeral in `NativeInputs`; it is not discarded
or serialized in graph receipts. Persistent host processes and host endpoint bindings
remain unsupported. Source/storage/topology admission and receipt versions2–5 are
unchanged. The TypeScript frontend owns phase intent/completion, managed hook values,
supervised host children and owner-mediated stop; Rust owns workload readiness and
exact native cleanup. See [finite hook lifecycle](../../docs/reference/native-authored-commands.md#finite-host-lifecycle-hooks)
for uncertainty and recovery limits.

### Native guest endpoint observations

`provider::graph::native::endpoints::observe` adapts a decoded native receipt and
captured Engine inspections to the existing `GuestEndpoint` representation. It
requires a Ready receipt, the current boot, the selected started container's exact
ID/name/image/native labels and readiness, and the complete ordered declared
attachment set. Every network must match its recorded ID/name/labels/bridge policy;
container and network must agree on endpoint ID, private IPv4 address and membership.
Captured running/paused/restarting/dead/OOM flags must be explicit booleans proving
running without pause, restart, death or OOM; missing or malformed flags refuse.
The primary comes from the receipt, never from inspection order. A secondary
attachment replacement also changes the generation. The native generation domain
is separate from legacy graph generations and includes immutable receipt identity,
boot, selected service/port, StartedAt and every attachment identity. Mutable
lifecycle phases and terminal observations are excluded from the hash. Legacy
generation encoding is unchanged.

This is an observation-only foundation with no runtime or frontend caller. A parsed
receipt, captured inspection or generation hash is not a source/ownership capability,
bridge reservation, host publication or reachability proof. A later authenticated
owner must bracket current source/data/receipt/boot and live observations across
awaits under its original cancellation/deadline, then use the existing bridge and
publication owner before private value delivery. No normalized Compose receipt is
constructed. Source5 guest-service, routed and TCP delivery stays refused.

The common-corpus acceptance still requires a guest-dependent persistent host
consumer under the existing controller/private IPC, launched only after authoritative
healthy publication. It must bind run/review/boot/member/start/attachment generation,
slot and reservation; prove normal stop, cancellation, recovery, source/member drift
and foreign-owner refusal; and retain unknown outcomes. Host providers must still
start before their guest consumers, and unsupported cycles must refuse before effects.
Routed HTTPS authority and a typed TCP projection remain separate gates. Portable
captured-inspection tests qualify none of those live behaviors, installed execution,
old-receipt recovery or full NC05 corpus acceptance.
