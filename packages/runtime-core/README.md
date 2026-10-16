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

Input is bounded to 64 KiB total, 32 services, 64 keys and 8 KiB encoded payload
per service. The five-second input deadline requires EOF. The delivery lifetime
starts before input reception and is never renewed by compilation or staging.
Missing/extra service keys, ownership conflicts and expiry refuse before relay
construction; fresh admission revalidates project inputs. The existing guest tmpfs
and startup launcher deliver values under the selected UID/GID. Cleanup retains
value-free allocation identities and verifies the selected tmpfs has been retired.

Expiry prevents new staging or execution; it does not revoke an already-running
process's environment. Ordinary environment-bound restart/restore still require
fresh-delivery support. This interface does not provide AWS credential acquisition,
SDK refresh or configuration-file compatibility. Guest environment storage has a
shared ceiling of 512 concurrent allocations, each with a 64 KiB tmpfs limit (32 MiB
combined filesystem capacity, excluding kernel overhead). Partial paths also consume
capacity. Graph admission checks the complete requested batch under its runtime
lease before graph effects; staging checks again. Verified retirement frees guest
capacity, while immutable intent history retains its separate 4096-entry bound.
No retained evidence is automatically deleted to admit new work. This environment
budget does not increase the runtime's separate container, CPU or memory limits and
does not establish 32-branch qualification.
Owned ingress buffers/values and prepared payloads are zeroized, but complete host
memory erasure is not claimed: scoped compilation still makes ordinary string copies.

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

Ordinary cleanup retains data. `graph cleanup --remove-data` releases a shared cache
reference rather than deleting that cache; graph-owned persistent volumes retain their
existing explicit removal behavior. Storage inventory reports shared references and
never presents reference release as physical deletion. The current runtime limits
admission to 64 cache volumes; automatic cache collection and byte/age retention are
not yet implemented. Application installer locking, interrupted installation and real
package installation still require qualification independently of these bindings.
