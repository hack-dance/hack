# Hack runtime core

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

`provider/` separates bounded child processes, artifact verification, admission, private ownership,
native process/disk identity, guest protocol, and lifecycle decisions. Guest requests use a bounded
connection to the existing socket; they cannot silently start or recover a VM. Failed operations
retain their phase and receipts. Recovery preserves disks and labels an unclean exit explicitly.

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

TERM and INT are checked during initial graph startup, including readiness waits
and before new service effects. Cancellation enters owned cleanup while preserving
persistent data. Checks occur between bounded operations; an in-flight operation
is not interrupted or retried, so its remaining duration contributes to shutdown
latency. Cleanup runs after the startup cancellation check has been disarmed.

After confirmed foreground cleanup and clean owner retirement, explicit
`graph cleanup --run-id <id> --remove-data --json` can remove retained data. The
operation holds the foreground publication lock, rechecks retirement and resource
ownership, and records volume identities before removal so an interrupted attempt
can resume against the same resources. Active owners still handle their own cleanup;
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
reviewed routes; other graph actions do not accept this flag. Relay control-owner
identity is now run-scoped so distinct foreground graphs no longer select the same
control root by construction. These CLI/identity changes are source-qualified;
two concurrent routed graphs still require native acceptance. A bounded native
reference control qualifies one graph with two networks and two declared hostnames:
both forward real HTTP over Unix publication, followed by authenticated cleanup,
foreground exit and independently verified resource absence. This does not qualify
actual Event Agent routing, TLS, two routed graphs, restore, publisher-exit/partial
startup failure, owner-crash recovery, scale or performance. No global Caddy
configuration or trust installation is performed by this contract.

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
Before new effects, the candidate requires normal macOS memory pressure,
unchanged swapouts, and at least 2 GiB of estimated host headroom plus any
provider footprint above that estimate. A larger healthy application graph can
therefore continue operating, while its excess footprint consumes an equal
amount of the allowed headroom. `runtime status` reports the actual provider
footprint separately; this admission rule does not qualify its efficiency.

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
