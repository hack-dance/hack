# Guest command protocol

The host runtime client uses this crate to communicate with the agent inside a
Linux VM. The agent uses the same codec to parse requests and report outcomes.
The private stream grants authority to run commands as the guest agent. Restrict
both ends of the socket bridge to their owner. All peer input is untrusted.

## Frame

A four-byte big-endian length counts the following payload. Its first two bytes
are family and opcode. Family 1 is a request, 2 is a response, and 3 is reserved
for negotiated server events. A peer may send multiple complete frames on a
stream. V1 uses Hello/Welcome and one command/reply per connection. All fields
are positional and required, in the order below. Reject unknown codes, trailing
or repeated fields and truncated frames. Adding a field requires a new version.

The 65536-byte payload limit bounds each transport allocation and leaves room
for a 32768-byte chunk and metadata. Byte strings use raw bytes and two length
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
| 1 | Hello | min, max supported versions |
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
| 1 | Welcome | selected u16 version, boot UUID, agent-incarnation UUID |
| 2 | Facts | architecture (64 bytes), kernel release (256), agent version (64), UTC Unix milliseconds (u64), boot UUID, agent-incarnation UUID |
| 3 | Absent | no current record at inspection time |
| 4 | Running | child owned, terminal outcome pending |
| 5 | SpawnFailed | reserved execution failed to spawn |
| 6 | Released | ID tombstoned after result release |
| 7 | Exited | signed 32-bit normal exit code |
| 8 | Signaled | signed 32-bit terminating Linux signal |
| 9 | Output | up to 32768 raw bytes, EOF flag for this offset, truncation flag for this stream |
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

V1 supplies buffered commands with bounded offset reads. Interactive input,
PTY allocation and resize, output wakeups, file-change subscriptions, time sync,
identity selection and per-process resource limits require negotiated extensions.
The existing guest path continues to serve callers needing those operations.

The Guest protocol CI workflow runs the locked Rust tests and the bounded
execution model in this crate's model directory. The lockfile and ignored
target directory belong to this standalone Cargo package.
