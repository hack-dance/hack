# Experimental relay authorization

`provider::relay_auth` supplies mutual capability proofs and revocable effect
admission. It is not a complete authenticated tunnel, an encrypted channel or a
live graph/VM registration mechanism. Do not expose production aliases through
this module until private provisioning, authenticated transport, lifecycle revocation and
bounded transport admission/cancellation are integrated and qualified.

## Credentials and binding

A capability key is 32 random bytes generated from OS entropy, or supplied through
an explicit private provisioning input. The latter does not validate entropy or
prove provenance. Credentials have no Debug/Serialize implementation or raw-key
getter. Stored key buffers use Zeroizing; the authority clears its copy on revoke.
This does not claim to erase caller copies, CPU registers, swap or HMAC temporary
state. Never log keys, handshake dumps or captured application payloads.

The fixed binding consists of owner (16 bytes), VM boot (16), endpoint generation
(32) and service identity (32), in that order. Each component must be nonzero. The
owning runtime must derive these bytes from validated current identities; the
codec does not inspect the VM or establish that a supplied binding is current.
Retire an old authority before registering its replacement. A client credential
copy surviving revocation cannot re-enable the old authority.

## Handshake

All steps are consuming, one-shot state transitions with five-second monotonic
handshake deadlines. Callers must also bound socket reads/writes and concurrent
pending handshakes; this module performs no network I/O and owns no socket timers.

1. Client sends 136 bytes: ASCII `HKRA0001`, the 96-byte binding, and a fresh
   32-byte client nonce.
2. Server validates version/binding, generates a fresh 32-byte nonce and returns
   64 bytes: server nonce followed by its 32-byte proof.
3. Client verifies the server proof and returns a 32-byte client proof.
4. Server verifies the client proof while its authority remains active, returning
   an authorized session and a 32-byte acceptance proof. Client validates that
   acceptance before releasing application payload.

Proofs use HMAC-SHA256 over `Hack relay auth v1\0`, a one-byte role (`S`, `C`, or
`A`), binding, client nonce and server nonce. Fixed field lengths and distinct roles
prevent ambiguous transcripts and reflected role proofs. Fresh challenges and
consuming states prevent reuse of an old proof as a new handshake. This protocol
still requires security review together with its provisioning and transport design
before production use; handshake success alone does not protect subsequent frames.

The implementation pins RustCrypto `hmac` 0.12.1 for compatibility with the existing
`sha2` 0.10 stack and uses its constant-time verification API. See
[HMAC documentation](https://docs.rs/hmac/0.12.1/hmac/) and
[zeroize's guarantees and limits](https://docs.rs/zeroize/1.9.0/zeroize/).
No environment encryption format or global tooling is changed.

## Revocation boundary

`AuthorizedSession::with_active` holds the authority mutex through a bounded,
non-reentrant effect callback. Use it at each actual nonblocking write/effect, not
merely while enqueueing work. The callback must not call revoke or another session
callback. `Authority::revoke` takes the same lock and clears the key. Once it returns,
no later callback through that session can begin. A callback panic poisons admission;
revoke still clears the stored key. Already written kernel bytes cannot be recalled.

The relay must separately wake its event loop, close active sockets and discard
queued work on revocation. This primitive does not provide that cleanup or guarantee
revocation latency under an arbitrary blocking callback. A final acceptance proof
can cross in flight with revocation: clients cannot infer continued permission from
that proof, and the server must keep checking the session at the effect boundary.

## Verification

Focused Rust tests cover an independently computed transcript vector, mutual proof,
wrong key/binding/version/length, tampered server response, reflection, fresh-challenge
replay, old acceptance replay, expiration, revocation boundaries, concurrent effects
and panic/poison behavior. `tests/models/tla/relay-authorization` models the check/write
race and includes a missing-lock negative control in the maintained model runner.
It proves neither cryptographic security nor that future callers use the API correctly.
Production guest provisioning and a graph-integrated relay remain open integration gates.

## Authenticated records

Accepted handshakes now yield one pair of `provider::relay_integrity` traffic codecs.
Client acceptance consumes into the pair; the server extracts it once and retains
`AuthorizedSession` to gate each actual effect. Extracting codecs does not grant
permission to deliver queued data after revocation. Derived keys remain in codecs
until dropped; revocation rejects effects and the transport owner must discard the
codecs and close sockets. Stored traffic-key arrays use Zeroizing, with the same
limits as capability-key storage above.

Each directional key is HMAC-SHA256 under the capability key over
`Hack relay traffic v1\0`, a one-byte direction (`C` for client-to-server or `S`
for server-to-client), the 96-byte binding, client nonce and server nonce. The
fixed transcript and separate domain bind keys to both endpoints and this session.
No raw traffic-key getter, Clone or Debug is provided.

A record is ASCII `HKI1` (4 bytes), inner-frame length (big-endian u32), sequence
(big-endian u64), one complete [HKF1 frame](runtime-relay-framing.md), then a
32-byte HMAC-SHA256 tag. The tag covers `Hack relay record v1\0` followed by all
preceding record bytes, including header, sequence and inner frame. Verification
uses the library's constant-time `verify_slice`. Length must be 8..=16392, bounding
the total record to 16440 bytes. The receiver rejects oversized headers before
reading their advertised body and uses fixed outer and inner buffers (~32 KiB).

Each direction starts at sequence zero and requires the next exact number; no
wrap is allowed. A record with u64::MAX can be accepted once, after which that
direction is exhausted. Tags and sequence validate before inner bytes are exposed.
Malformed, replayed, reordered, cross-session or reflected records terminate the
flow. Inner FIN/RESET semantics remain enforced; raw EOF is graceful only after a
complete authenticated FIN with no partial next record. Encoding advances sender
state: queue in order, bound outstanding output and abort on a failed write.

This provides integrity and ordering, not confidentiality or forward secrecy.
On-path peers can observe traffic and can interrupt/delay it. Transport admission,
read/write deadlines, concurrency, revocation wakeup and cleanup remain caller
obligations. The complete provisioning/protocol design still needs security review
before production use. Independent Python-derived wire vectors, transcript-field
mutation, fragmented/coalesced records, replay/reflection, exhaustion, truncation,
maximum payload and revocation-before-delivery tests cover the codec contract;
those codec tests alone do not establish native interoperability or app parity.


## Native interoperability fixture

`tests/mounted_auth_probe.rs` is an ignored, explicitly invoked macOS integration
fixture. It uses the real Rust handshake, record codecs and host endpoint guard.
`tests/fixtures/mounted-auth-client.c` is an independent Linux ARM64 guest client;
`relay-crypto.zig` supplies pinned Zig standard-library HMAC, not a second copy of
the Rust implementation. These fixtures are not production relay implementations.

Build the guest with the root mise-pinned Zig 0.15.2: compile `relay-crypto.zig` with
`zig build-lib -target aarch64-linux-musl -O ReleaseSafe`, then link its archive and
the C client with `zig cc -target aarch64-linux-musl -static -O2 -Wall -Wextra -Werror`.
Build the host with `cargo test --locked --manifest-path packages/runtime-core/Cargo.toml
--test mounted_auth_probe --no-run`. Invoke the emitted test executable with
`mounted_authenticated_frames_and_refusals --ignored --exact --nocapture --test-threads=1`
only under an owned VM/watchdog harness; a normal test-suite skip is not a native pass.

The host requires a private, current-user-owned directory in `HACK_LOCAL_AUTH_ROOT`
and exactly 128 stdin bytes: the 96-byte binding followed by the 32-byte fixture key.
Guest invocations receive the same packet through exec stdin, never argv, logs or a
persistent credential file. Use only fresh isolated fixture credentials, never app
environments. The private orchestrator sets `mode` before each invocation and checks
both client output and the host's numbered receipt. The seven cases are `echo`,
`wrong-key`, `tamper`, `replay`, `revoke`, `stale`, `echo`. Wrong-key changes key byte
zero. Restart the owned VM before `stale`; that case retires the old authority and
flips boot-binding byte zero. The last echo uses the updated binding. This is an
explicitly driven synthetic boot rotation, not automatic lifecycle registration.

The two valid cases send 64 KiB and explicit FIN to an EOF-driven loopback TCP echo
service. Negative cases must produce the specific host refusal and no extra upstream
connection (exactly two accepts overall); record failures also return a verified
RESET. The rejection controls buffer at most 64 KiB before opening an upstream. Writes are
nonblocking and authority-checked at each effect; connection establishment now uses the nonblocking pending API described below.
The fixture schedules progress checks itself; it does not prove production event-loop
backpressure, wakeup or cancellation behavior.

Qualification requires a private network-disabled provider instance, bounded CPU/
memory/time, pressure/swap/headroom watchdog, checked stop/delete and empty inventory,
no open references before owned-root removal, and unchanged selected global/provider
fingerprints. Real mounted-transport interoperability passed these seven cases on
macOS ARM64 with the pinned provider. This proves the tested transport controls;
production provisioning, automatic lifecycle bindings, async resource limits and
whole-protocol review remain open before exposing application aliases.


## Nonblocking host connection admission

`HostEndpoint::begin_connect(budget, session)` verifies the captured listener and
starts a nonblocking loopback connect under the session's revocation guard. It returns
an owned `PendingConnection`, not a stream or raw descriptor. `progress()` performs
one connection/peer-identity check: `None` means still pending, `Some(stream)` releases
a nonblocking stream only after the intended process accepted the exact tuple and
listener/process identity was rechecked. A live accepted descriptor may be ESTABLISHED
or FIN_WAIT_1/FIN_WAIT_2: a backend can finish sending before admission while still
receiving the request. The exact tuple, owning process and exclusive listener checks
remain required; a closed descriptor or replacement listener cannot establish identity.
Both failure and success are terminal.
Deadline, listener replacement and revocation errors drop the socket; dropping the
pending handle also cancels it. The positive connection budget is capped at five seconds.

The native connect syscall is inside the same authority mutex as revoke. No network
wait or sleeping loop occurs inside that callback. The deadline is rechecked after
lock acquisition and before stream release. The shared guard retains authority
identity without cloning key bytes or allocating a traffic codec; ordinary effect
callbacks do not incur a new Arc clone per write. Native inspection still enumerates
up to 4096 descriptors, and the mutex requires all effect callbacks to remain bounded.

The owning reactor must cap pending connections, schedule acceptance checks with a
bounded retry interval/deadline and wake/drop handles on revocation. This primitive
spawns no threads and does not poll in the background. It does not itself provide a
reactor, automatic graph identity binding or idle-resource policy. Each later payload
write still requires `AuthorizedSession::with_active`; stream acquisition is not
permanent authorization. The older synchronous `connect` remains available for
explicit synchronous callers and fixtures; relay integration should use the pending API.


The raw macOS socket also sets `FD_CLOEXEC` and `SO_NOSIGPIPE`, matching the
relevant setup in [Rust's socket implementation](https://doc.rust-lang.org/src/std/sys/net/connection/socket/unix.rs.html).
An isolated child-process test restores default SIGPIPE handling and writes to a
closed peer: the protected socket returns EPIPE without terminating the process.
A negative-control child with protection disabled must terminate specifically on
SIGPIPE. This avoids a false pass from Rust's usual process-wide signal handling.


## Pollable revocation

`AuthorizedSession::watch_revocation()` lazily creates one private nonblocking Unix
socket pair per authority and shares its receiver across all watch handles. Register
the borrowed descriptor for read/hangup readiness in the reactor; no thread, timer,
per-flow descriptor pair or notification payload queue is created. Revoke clears the
key and shuts down/drops the writer under the same lock used for registration and effects. EOF
is persistent, so registration racing revoke either refuses or yields a notified
watch, and one observer cannot drain another observer's notification.

`is_revoked()` performs one nonblocking read: EOF means revoked; a read error also
requires the owner to close affected flows. A quiet watch is not authorization:
every effect still needs `with_active`, including after a callback panic poisons the
authority mutex. A recovering owner must call revoke to notify watchers in that case.
The owner must handle readiness by closing pending/active sockets and discarding
queued work, then unregister the watch; revoked EOF remains ready. The signal alone does not close application sockets or bound reactor
scheduling latency. Do not register a watch inside an effect callback (the authority
mutex is non-reentrant).

Watches retain only the shared receiver, never the authority or key. Explicit revoke
closes the writer even while sessions/guards survive. Dropping the final authority
core also produces EOF; dropping one Authority handle while sessions or connection
guards remain is not revocation. The pair is retained while its authority is active,
even if individual watches are dropped; at most two descriptors per watched authority.

Real host-socket tests cover quiet/level-triggered readiness, 64 shared watches,
blocked poll wakeup, concurrent registration, final-core drop, poison/revoke recovery
and a sleeping handler that wakes and drops a pending TCP connection without payload.
This establishes the notification contract, not production event-loop integration or
measured idle CPU savings.


## Bounded shared relay loop

The macOS `provider::relay_loop::RelayLoop` now composes accepted sessions, verified
pending host connections, authenticated records and shared revocation watches. It
owns no thread per flow. `Limits` requires explicit flow capacity (1..=256), connection
budget (positive, at most five seconds) and idle budget (positive, at most one hour).
These are experimental safety ceilings; no product default or throughput target is
established. The caller must bound listening/handshake work separately and prove that
each accepted session's binding belongs to its supplied current endpoint.

Each flow retains at most one 16-KiB outgoing application payload and one 16,440-byte
outgoing authenticated record, in addition to the fixed codec buffers and allocator
capacity. Reads stop while their destination queue is occupied. Input reads stop at
codec boundaries, requiring no growing leftover-input queue. Each iteration performs
bounded work per flow; deadline-driven acceptance probes exist only while connection
identity is pending. Established idle flows wait in poll until I/O, revocation, an
idle deadline or the caller's wait limit. `tick_with_wakeup` includes the owner's
listener/control descriptor, including when no flows are active, so new work needs
no periodic polling. The caller handles/drains that control descriptor.

The poll set deduplicates descriptors and distributes readiness to associated flows.
This is required on the qualified macOS host: repeated entries for the same shared
revocation descriptor receive readiness on only one entry in a raw poll experiment.
All affected flows are therefore retired together, while a different authority's
flows remain active. Every actual read/write and application FIN is authority-checked.
Dropping the loop or cancelling a flow closes its owned sockets and discards queues.

FIN closes only its application direction; responses and requests can continue in
the reverse direction. Failed flows request abortive TCP close (zero linger) before
dropping the backend descriptor, so truncated/malformed framed requests do not appear
as normal EOF-delimited requests. If the OS refuses that cleanup option, descriptor
closure still occurs; this cannot retract bytes already delivered to the backend.
Transport EOF without authenticated FIN remains an error.

Local real-socket regressions cover four concurrent distinct 256-KiB streaming echo
flows, bounded queues under a stalled reader, idle/connect deadlines, capacity/cancel,
selective revocation, malformed/truncated records and early response FIN. The mounted
VM fixture now routes both successful 64-KiB exchanges through this loop, including
after restart. Its rejection cases remain separate sequential protocol controls;
loop-specific refusals are tested locally. These results do not prove automatic graph
registration, listener/handshake admission, in-flight VM-loss cleanup, production
alias compatibility or comparative CPU/memory performance.


Revocation shuts down the signal's write direction before dropping its descriptor.
Closing a descriptor alone can delay EOF while a fork/dup retains another writer.
A regression holds such a duplicate across revoke: the prior implementation misses
readiness, and the corrected signal remains immediately readable. This fixes a real
retained-descriptor failure mode; which concurrent process caused the initial
all-feature race failure was not established. No notification payload is written.

## Bounded handshake admission

`RelayLoop::admit` takes an accepted Unix transport, its owner-selected authority and
captured host endpoint. Pending handshakes and authenticated flows share the existing
1–256 connection ceiling. `connections()` includes both; `pending()` and `active()`
report each phase. Admission takes ownership even on refusal, and cancellation IDs
remain stable across authentication. This ceiling remains an experimental limit,
not a graph instance limit or a qualified product default.

A positive handshake budget of at most five seconds starts at admission and never
extends with traffic. Each poll tick performs at most one bounded nonblocking I/O
operation per handshake. Fixed buffers hold the 136-byte hello, 64-byte challenge,
32-byte proof and 32-byte acceptance; message reads never consume following records.
An authenticated session additionally retains its bounded traffic codecs while the
acceptance is pending. All handshake I/O uses the authority guard and the shared
revocation signal participates in the same deduplicated poll set as active flows.
Invalid proofs, EOF, expiry, revocation and cancellation release the owned transport.
No upstream connection starts until proof verification and complete acceptance write;
endpoint identity is then checked by the existing host admission path. Acceptance
acknowledges authentication, not backend availability.

`accept_one` checks capacity, makes the supplied Unix listener nonblocking and accepts
at most one transport. It neither creates nor unlinks the pathname. The owning loop
must omit listener readiness while full to avoid repeatedly waking on backlog; the OS
backlog and an untrusted caller bypassing this API are outside its connection count.
The owner is still responsible for private socket permissions, binding the selected
authority to the current graph owner/boot/service/endpoint, private guest credential
provisioning and retiring that authority before any binding replacement. These APIs
do not infer those relationships from an unauthenticated hello.

Real macOS socket regressions cover fragmented authentication and streaming, fixed
partial-client deadline, failed proof/truncation, combined pending/active capacity,
cancellation, all four handshake phases at revocation, bounded listener acceptance,
stale endpoint refusal, invalid budgets and pre-revoked authority. The isolated native
VM fixture's two successful exchanges now use this handshake path; its five protocol
negative cases still use the separate fixture logic. No full graph integration or
performance claim follows from those component tests.

Native descriptor inspection tolerates a socket descriptor closing or being reused
as a nonsocket between enumeration and inspection (EBADF/ENOTSOCK on a failed call).
Such entries cannot supply listener/peer proof. Unknown errors, short successful
results, missing listener identity and endpoint replacement still refuse admission.
An isolated socket-to-pipe churn regression verifies the unchanged listener identity
across 2000 inspections; it is not authorization based on an incomplete target proof.

## Owner-side retirement handler

`relay_owner::RelayOwner` owns a bounded registry and the relay loop. Its trusted
caller must supply a verified runtime/VM context and graph service-generation digest;
the module does not discover those identities from receipts or untrusted requests.
Registration rechecks and fingerprints the actual host process/listener before
issuing a fresh credential. A random owner incarnation and registration serial bind
each public target generation to that issuance. Credentials remain opaque and are
never included in control messages or acknowledgement serialization.

Retirement validates the complete target batch before its first effect. It then
revokes each exact authority instance and synchronously drops its pending/active
transports and queued bytes before returning an acknowledgement. Core identity is
used rather than a reusable binding, listener or descriptor number. Other authorities
remain active. Drop of the registry performs the same retirement for all its grants.
Already kernel-delivered bytes and caller-retained descriptor duplicates cannot be
recalled; the managed owner must have exclusive ownership of its relay descriptors.

The version-1 request carries an owner incarnation, nonzero operation nonce and
1–256 distinct service/generation targets. Parsing is bounded to 96 KiB; acknowledgements
are bounded to 2 KiB. Unknown fields, duplicate services, invalid versions, empty or
oversized scope and stale generations refuse. Canonical target ordering makes a lost
reply safely reproducible from fenced state without an unbounded reply cache. Operation
identity is the owner, nonce and exact target digest together, not the nonce alone.
Acknowledgement verification checks all of them and the retired target count.

This codec does not authenticate a sender. Use it only over a verified private owner
transport. The exchange primitive below pins the connected peer; private listener and
receipt publication remain integration work. There is no control listener, daemon
activation, receipt-based adoption, durable retirement intent or graph/VM mutation hook
here. The caller must journal lifecycle intent before requesting retirement; a response
is not permission to replay a lifecycle operation whose result is uncertain.

Registry capacity is explicitly 1–256 entries. Retired entries remain fenced and count
against capacity; they cannot be silently replaced, discarded or reused. Confirmed
lifecycle replacement/retention and restart recovery are still required before this
becomes a long-lived multi-worktree runtime path. This is an experimental component,
not a new product service limit or default.

### Retirement control exchange

`relay_owner::transport` provides one nonblocking retirement exchange on an
already connected Unix stream. Both ends pin the kernel peer PID and UID to a
trusted native process identity (start time and executable included) before sending
bytes. The server rechecks that identity before retirement. macOS obtains the peer
PID from the connected socket; this is not a PID supplied by the request. See the
[Apple kernel implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c).

A four-byte big-endian length precedes each JSON message. The existing 96 KiB
request and 2 KiB reply limits apply before body allocation. Each progress call
performs at most one 8 KiB nonblocking read or write, under one positive deadline
of at most five seconds. The deadline is never extended by partial traffic.
Request EOF is required before retirement; truncation, suffixes, invalid scope and
oversized input close the connection without retirement. Reply EOF and exact scope
verification are required for client success. Retirement happens once before the
reply is queued; delivery failure leaves the target fenced and permits a new retry.

The caller must cap aggregate exchanges, schedule readiness and deadline expiry,
and establish private socket path/receipt ownership before connecting. No listener,
discovery, process launch, durable intent or lifecycle hook is supplied here. The
authorized peer must exclusively own its endpoint: deliberate descriptor passing
or a malicious authorized same-user process is outside this identity check.
Native local socket tests cover fragmentation, real retirement, lost reply/retry,
stale peer identities, malformed/suffixed input and backpressure/deadline expiry.
These tests do not qualify a managed daemon, guest lifecycle or app performance.

### Bounded owner reactor

`RelayOwner::admit_control` owns admitted exchanges and applies a separate configured
control capacity of 1–64. This is an experimental component ceiling, not a product
default. Excess or invalid admissions close the supplied stream without displacing
existing clients. Completion, rejection and deadline expiry release their slots.
Control counters report admitted/rejected, completed/failed/timed-out and peak active
exchanges separately from relay flow statistics.
Completed counts a full response write; it does not prove the coordinator received
the acknowledgement or completed its lifecycle mutation.

Owner ticks now poll control read/write interests in the same native poll as relay
flows, deduplicating shared descriptors and returning only each caller's requested
readiness. The next control deadline shortens the wait. Each ready or expired exchange
gets one bounded progress step; malformed or stalled peers do not stop other clients
or unaffected data flows. No new thread or periodic idle timer is introduced.
`tick_with_wakeup` also watches a caller-owned listener/lifetime descriptor. The caller
must handle that readiness and omit a readable listener when admission is full, rather
than repeatedly waking on its backlog. An empty owner without a wake descriptor returns
immediately; a daemon must supply its listener/lifetime wakeup rather than spin on ticks.

The existing retirement-before-acknowledgement rule is unchanged. Owner drop revokes
relay capabilities and closes its control exchanges. Native tests cover mixed traffic,
stalled control isolation, admission saturation and slot reuse, deadline scheduling,
external wakeup, failed requests and shared-descriptor interest fanout. Private listener
publication/receipt recovery, durable lifecycle intent and graph/VM hooks still need
integration before this is a managed runtime path. No CPU or latency win is inferred
from these correctness tests.

### Private control publication and recovery

`relay_owner::publication::ControlListener` binds `relay-control/control.sock` beneath
an existing private runtime root. Its mode-0600 receipt records runtime/boot/owner
incarnation, native process identity, exact socket path, parent and endpoint inodes.
The receipt is bounded to 4 KiB, written with create-new/no-follow semantics, and
synced with its directory before successful publication. No capability key or payload
is stored. A dedicated publication lock is held for the listener lifetime; this is
separate from the VM mutation lease. The private directory and tiny lock file remain
for safe reuse after normal socket/receipt cleanup.

Clients select a `PinnedEndpoint` for the expected runtime/boot, then revalidate the
receipt bytes/inode and socket identity before and after connecting. The raw Unix
socket is nonblocking before `connect`, close-on-exec and protected against SIGPIPE;
a pending/unavailable connection refuses for caller-managed retry. No request bytes
are released until the existing native peer check matches the published owner.
The listener derives accepted caller identity from kernel same-UID credentials and
pins it for the exchange. The local user/private directory is the authority boundary;
no PID or executable claimed in request JSON grants access.

Normal drop only removes unchanged owned receipt/socket paths and refuses cleanup
after a parent or receipt replacement. Explicit recovery of a selected pinned receipt
requires the publication lock, matching current evidence and an absent recorded PID.
A live or reused PID, malformed/partial receipt, unexpected socket or uncertain state
is preserved. Recovery never signals a process. A missing socket with an unchanged
receipt can finish cleanup, and an already absent pair is an idempotent result.
Partial publication without a complete receipt remains a refusal for diagnosis.

This uses cooperative ownership/locking and does not defend against a malicious
same-user writer racing filesystem operations or intentionally passing descriptors.
Deleting control files does not prove relay capabilities have retired and does not
authorize a lifecycle effect. Daemon launch, durable retirement intent, graph/VM hooks
and private guest provisioning remain integration work. Tests exercise named-socket
retirement, replacement/permission refusals, live-owner preservation, owned-child
death recovery and backlog refusal under a child watchdog; no new VM or performance
qualification is claimed.


### Durable lifecycle intent and recovery

`relay_owner::lifecycle_intent::Coordinator` records the selected runtime/boot,
owner publication and native process, operation ID, exact target generations and
caller-supplied effect digest before retirement. It holds a separate journal lock;
the caller must also hold the actual runtime mutation lease and derive the complete
set of affected services. The coordinator does not infer graph coverage.

The private `relay-lifecycle/` directory retains one current `state.json` (at most
128 KiB), a stable lock and at most one interrupted `state.pending`. Writes sync the
pending file, rename it and sync the directory. Replaced, copied, malformed or partial
evidence refuses further mutation. An interrupted pending write is preserved for
recovery work; it is not silently removed or automatically promoted. Confirmed history
is replaced by the next intent, so successful operations do not accumulate journals.

Each recovered intent requires a fresh bounded native retirement exchange with the
selected owner. A stored attempt identifier never grants effect authority. Execution
consumes the live acknowledgement and persists `effect_started` before invoking the
caller's effect once. An error, panic or process exit leaves that phase uncertain:
it may mean the effect was not invoked, partially applied or finished. Recovery cannot
replay it. A separate caller inspector must observe the real desired outcome and
supply its evidence digest before confirmation releases the registration fence.

Published owners bind to the journal. New grants take its lock and refuse unfinished
intent, including after owner restart; existing unrelated flows remain usable. This
conservatively blocks all fresh grants during the serialized mutation. Unbound owner
primitives used in tests do not provide this managed-runtime guarantee.

The existing [lifecycle barrier model](../tests/models/tla/relay-lifecycle-barrier/Barrier.tla)
maps `BeginMutation` to durable intent, retirement/drain/acknowledgement to the owner
exchange, coordinator recovery to discarding volatile authority, `BeginEffect` to
persisting the started phase, and `ConfirmEffect` to separate observed confirmation.
The implementation has an additional crash window between that durable phase and
invoking the effect; it refuses replay in both cases. This is a transition mapping,
not a complete refinement proof. Owner-death fallback is not implemented, and removing
control files never authorizes a mutation.

Regression tests use real private control sockets and an owned child that exits after
applying a synthetic effect. They also cover fresh recovery exchanges, write refusal,
failed inspection, record replacement/copying, partial writes, restart fencing and
bounded history. Actual graph/VM dispatch, authoritative generation derivation,
managed owner startup, guest provisioning and safe replacement of retired registry
entries remain integration gates. These component checks make no performance claim.


Recovery callers use `lifecycle_intent::Inspection::load` with the expected runtime
and boot to discover the durable operation/effect selection, phase and target set.
This uses the existing journal lock without creating directories or files. Busy,
missing, malformed, partial or wrong-context state refuses inspection; it does not
return an older record as a valid fallback. The result contains no capability key
and grants no effect authority. `Coordinator::resume` rechecks the selected operation
under its own lock, so a confirmed record replaced since inspection cannot be resumed
through the old selection. The owned-child crash regression now recovers through this
public path without reading private journal fields. Actual graph/VM outcome inspection
and interrupted-write reconciliation remain separate integration work.


### Graph-bound outbound registration

`graph::HostRelayService::observe` selects a service through the existing verified
private engine transport, graph receipt and immutable resource ownership checks.
It holds the actual VM mutation lease only for this short-lived selection. Its context
uses domain-separated digests of the verified runtime owner and guest boot; its service
identity includes graph run, namespace, plan, service key, immutable container/image
identity and current StartedAt. A restart of the same container therefore invalidates
the previous identity. Non-ready graphs, interrupted journals, missing or stopped
containers, and incomplete starts refuse registration.

`register` re-reads that evidence and verifies the guest before passing the derived
identity to the relay owner; callers cannot substitute a service digest. The owner
must match the selected runtime/boot, and its existing host endpoint checks and durable
registration fence still apply. Registration consumes the selection and releases
its VM mutation lease before returning the grant, so the long-lived owner reactor
holds no lease through this API. This is an experimental API, not an activated CLI workflow. Named dependency bindings are supported through `register_binding`; the `register`
convenience method selects the name `default`. Each binding consumes one registry slot.

Unit tests cover identity rotation and refusal, including wrong owner boot scope.
Actual engine/VM qualification, complete target-set retirement in cleanup/restart,
managed owner startup, dependency binding/provisioning and replacement remain required.
A verified registration does not promise that an externally stopped/restarted container
will be retired without those lifecycle hooks. No new performance result is claimed.


The ignored `owned_graph_registration_live` fixture qualifies this registration
boundary against one dedicated graph on an isolated owned VM. It proves selection
holds the runtime lease, registration releases it, a stopped service refuses, restarting
the same immutable container rotates identity, a wrong owner boot refuses and cleaned
compute cannot register. It does not send guest application traffic or establish
retirement on external restarts. Run only with explicit private fixture paths, pinned
image input and an external resource/time watchdog; the cleanup mode stops only the
same owned candidate. The graph host-relay API is macOS-only, matching the native relay
owner; portable graph functionality remains independent of that module.


### Complete graph retirement sets

Graph-bound registration retains a verified `GraphScope` separately from the rotating
service/dependency identity. `targets_for_graph` selects every retained registration
for that graph, including retired fences and earlier container starts. Other graph
scopes are excluded. A registry containing unscoped primitive grants refuses selection
because complete graph coverage cannot be established; an empty scoped set is an
observation, not an acknowledgement or permission to mutate.

Dependency binding names are bounded to 128 lowercase ASCII letters, digits, dots,
underscores or hyphens. They distinguish capabilities and do not themselves authorize
routes, select credentials or prove reviewed configuration. The binding digest includes
the service generation, so both changing a dependency name and restarting its service
produce distinct identities. Retired entries still count against the existing explicit
registry capacity; confirmation-based replacement remains separate work.

Selection is owner-local. The lifecycle caller must hold its real VM mutation lease
from target selection through durable intent and effects; the native control selection
exchange and automatic cleanup/restart hooks are not yet wired. Tests cover selective
pending-socket retirement, preserved unrelated connections, idempotent retries and
unscoped/wrong-boot refusal. The live fixture also registers multiple dependencies and
checks the complete set across a same-container restart before explicit retirement.


### Native graph selection exchange

`SelectionRequest` uses the distinct `select_graph` kind and binds the owner incarnation,
expected runtime/boot, graph scope and caller-provided fresh nonzero operation nonce.
The server handles it through the same native peer verification and bounded reactor
admission as retirement. Requests are at most 2 KiB; responses contain 0–256 distinct,
nonzero targets within 96 KiB. Legacy retirement requests and 2 KiB acknowledgements
retain their existing shape and nonempty-target requirement.

`PinnedEndpoint::select` reuses publication and socket revalidation before/after the
nonblocking connect. `SelectionExchange` shares fixed five-second maximum deadlines,
one bounded I/O step per turn, native identity checks before request bytes, and exact
response EOF. It verifies the echoed complete request scope before returning targets.
Wrong owner/boot/graph/nonce, unknown unscoped registry entries, oversized or malformed
messages, suffixes, truncation, missing replies and expiry refuse. A successful empty
set is explicit; connection failure never produces one. Selection does not revoke or
retire any grant, and response delivery is not lifecycle completion.

This is transport observation, not durable effect authority. Callers still must hold
the real VM mutation lease from selecting through intent and execution; fresh selection
and empty-set handling are not yet integrated into the lifecycle coordinator. Tests
exercise populated/empty reactor exchanges, a real named published socket, maximum
capacity, scope/shape failures, native identity refusal and incomplete-wire controls.
Automatic graph/VM mutation hooks and managed owner activation remain separate gates.
