# Guest command protocol

The host runtime client uses this crate to communicate with the agent inside a
Linux VM. The agent uses the same codec to parse requests and report outcomes.
The private stream grants authority to run commands as the guest agent. Restrict
both ends of the socket bridge to their owner. All peer input is untrusted.

## Frame

A four-byte big-endian length counts the following payload. Its first two bytes
are family and opcode. Family 1 is a request, 2 is a response, and 3 is reserved
for negotiated server events. A peer may send multiple complete frames on a
stream. A flags byte and u32 channel follow the opcode. END (bit zero)
finishes this direction of the channel. Reject other flag bits. Channel zero
negotiates, then the host assigns increasing nonzero channels. Responses echo
their channel. Several exchanges share a connection; negotiated stream
extensions can interleave data frames before END. All fields
are positional and required, in the order below. Reject unknown codes, trailing
or repeated fields and truncated frames. Adding a field requires a new version.

The 65536-byte payload limit bounds each transport allocation and leaves room
for a 32768-byte chunk and metadata. The seven header bytes leave an aggregate
budget of 65529 bytes for all fields including their counts and lengths. Byte strings use raw bytes and two length
bytes. Text is a byte string containing UTF-8 with no NUL. Integers and counts
are big endian; counts and byte lengths are unsigned 16-bit. Flags occupy one
byte, zero or one. An exchange deadline also applies to peers sending partial
frames. Diagnostics must omit request and response contents.

Both versions in Hello are inclusive u16 values. Select the highest common
version. A peer supporting 1 and 2 uses 1 with a v1-only peer in either role.
A v2-only peer cannot communicate with a v1-only peer. The discovery envelope
stays stable across command versions. V1 is the only implementation today.

## Requests

| Opcode | Message | Fields in wire order |
| --- | --- | --- |
| 1 | Hello | min, max supported versions, u64 capability offer (unknown bits ignored) |
| 2 | Facts | none |
| 3 | Start | handle, argv list, env pair list, absolute cwd, initial stdin bytes |
| 4 | Inspect | handle |
| 5 | Signal | handle, signal byte (1 interrupt, 2 terminate, 3 kill) |
| 6 | Output | handle, stream byte (1 stdout, 2 stderr), unsigned 64-bit byte offset |
| 7 | Release | handle, only after recording the terminal result |
| 8 | List | none; inventory of unreleased jobs on this private endpoint |

A handle contains three text fields. The boot and agent-incarnation IDs each use
36 lowercase UUID characters with hyphens at positions 8, 13, 18 and 23
(zero-based). The execution ID uses 32 lowercase hex digits. Persist these
before starting a command. Argv has 1–128 strings of at most 4096 bytes and a
nonempty executable. Env has at most 128 pairs with unique, nonempty names
of at most 255 bytes, no equals sign, and values of at most 4096 bytes. Cwd
is at most 4096 bytes. Initial stdin is at most 32768 bytes.

## Responses

| Opcode | Message | Fields in wire order and meaning |
| --- | --- | --- |
| 1 | Welcome | selected u16 version, u64 common capabilities, u32 max frame, u16 max jobs, u32 per-stream retention (1–65536 bytes), boot UUID, agent-incarnation UUID |
| 2 | Facts | architecture (64 bytes), kernel release (256), agent version (64), UTC Unix milliseconds (u64), boot UUID, agent-incarnation UUID |
| 3 | Absent | no current record at inspection time |
| 4 | Running | child owned, terminal outcome pending |
| 5 | SpawnFailed | reserved execution failed to spawn |
| 6 | Released | ID permanently retired; no live record |
| 7 | Exited | signed 32-bit normal exit code |
| 8 | Signaled | signed 32-bit terminating Linux signal |
| 9 | Output | absolute u64 start offset, up to 32768 raw bytes, EOF flag for this offset, truncation flag for this stream |
| 10 | Ack | request accepted |
| 11 | Unknown | uncertain outcome or wrong incarnation |
| 12 | Conflict | duplicate start or incompatible state |
| 13 | Full | agent has reached its capacity |
| 14 | Invalid | invalid request or unsupported handshake |
| 15 | Handles | counted list of up to 16 unreleased handles, including completed jobs awaiting collection |

A connection failure leaves the execution outcome uncertain. Reconnect, list
and inspect the original handle. A previous Start can arrive after a new client
observes Absent. Preserve terminal status across reconnects until the host
records it and releases it. An incarnation change fences old handles.
The host client returns `Error::StaleHandle` before sending a handle from a
different boot or incarnation. This consumes no channel. An `Unknown` reply
on a negotiated session is an observation received from the peer.

V1 supplies buffered commands with bounded offset reads. Interactive input,
PTY allocation and resize, output wakeups, file-change subscriptions, time sync,
identity selection and per-process resource limits require negotiated extensions.
The existing guest path continues to serve callers needing those operations.

The Guest protocol CI workflow runs the locked Rust tests and the bounded
execution model registered under tests/models/tla/guest-execution. The lockfile and ignored
target directory belong to this standalone Cargo package.

The guest socket lives in an owner-only directory (0700), has mode 0600, and is
exposed to the host through a private Unix socket bridge. Ordinary containers
have separate mount namespaces and receive neither the socket nor its parent.
A privileged container, engine-control access, or a host-root bind mount can
defeat this boundary. Any caller that can reach the agent can execute as its UID.

A timeout never makes Absent final while a previous submission can still arrive.
Retry the same immutable command and handle within its incarnation; on Conflict
inspect the original. One host owns a durable, increasing u128 execution counter for each agent incarnation. Wire IDs are fixed-width lowercase hex, so lexical and numeric order agree. Persist the allocation before sending Start. Submit new IDs in admission order; finish reconciling a timed-out Start before submitting a later ID. After a confirmed Release never resend Start. The guest checks its live table first, then rejects IDs at or below its greatest admitted ID. A missing ID below this mark is permanently retired, including skipped numbers; Released does not establish that a skipped command ever ran. A full live table refuses new work before advancing the mark. Release drops the record and both pipes; the mark never decreases or wraps. Restoring a host without its durable counter requires recovery of that counter or a coordinated new incarnation, never guessing from List.
List includes every
unreleased job (maximum advertised in Welcome, at most 16). A terminal Signal
returns the cached status. A guest that pins the unreaped leader may signal its
owned process group until Release. It must never signal a recycled PID. Release discards all bytes
while the incarnation watermark fences the ID. Each pipe keeps its newest advertised retention
bytes and continues draining. A lagging reader resumes at start_offset plus the
returned byte count. A 1 GiB writer retains only that finite tail.

The optional runtime guest-agent-client feature exposes Session on an already
connected Unix stream. Negotiation has its own deadline; each subsequent call
gets one deadline for its complete write and read. Poll readiness and per-call
nonblocking I/O preserve the owner's socket settings. A failed exchange retires
the session. Reconnect to reconcile an uncertain effect.
The exchange requires a single writer per socket. On Apple platforms each send is bounded by the socket send low-water mark after poll reports writable, so a slow reader cannot hold a large write past the exchange deadline.
