# WU04 durable operation contract

The checkout-owned node executes four bounded host fixtures through independent supervisors.
It cannot execute arbitrary commands, enrolled Compose services or project source. The fixture
adapter is cooperative process execution; it is not a hostile-process sandbox.

## Protocol version 1

`node serve` explicitly owns `.hack-local/node/node.sock`. `node status` contacts that service;
`node inspect` opens SQLite read-only and never starts a service or VM. `node request <json>`
submits a request and prints the response envelope. A refused request exits with code 2.
No background registration, launch agent, global socket or shell environment is installed.

The [JSON schema](../../../packages/runtime-core/node-protocol-v1.schema.json) fixes the request,
mutation, acceptance and job-receipt shapes for this checkpoint. The wire frame is a four-byte
big-endian byte count followed by UTF-8 JSON, bounded to 128 KiB. One request receives one response:
`{"ok":true,"result":...}` or `{"ok":false,"error":{"code":"...","message":"..."}}`.
Unknown fields and versions are refused. Each socket read/write has a 500 ms idle timeout and
checks a one-second total budget between transfers; a blocked transfer may exceed the total by
at most the idle timeout. Other clients can retry after contention. Job supervision is independent.

Requests are `status`, `result`, `submit` or `cancel`. Every request declares `version: 1`.
Mutations include an operation ID, expected generation, explicit target, peer-UID principal,
request digest and required capability list. The default CLI capability is `fixture_jobs_v1`;
`cooperative_process_groups` is also supported. Other required capabilities fail before acceptance.
The private directory and native peer credentials enforce the local UID boundary.

The v1 digest is SHA-256 of compact sorted-key JSON after Rust deserialization/serialization,
with `mutation.request_digest` removed. The CLI fills an omitted or empty digest. An explicitly
provided digest is verified. On the wire, a missing or incorrect digest fails. Raw clients must
include normalized capability defaults in the digest input; [Rust Request](../../../packages/runtime-core/src/node/journal.rs)
provides `digest` and `seal`. This hash binds request identity; it is not an authentication signature.

A target identifies one journal incarnation and its canonical state directory. Recreating a
journal generates a different target; copying its database to another directory is refused.
Operation IDs are scoped to that incarnation. A new operation consumes exactly one generation;
job phase/output updates do not. An identical retry returns the original acceptance, even after
later generations. Changed reuse conflicts. `result` returns the current job receipt.

## Persistence and recovery

Schema version 1 uses `meta` (generation, identity and state directory), `operations` (ID, digest,
original acceptance) and `jobs` (ID and typed receipt JSON). SQLite DELETE journaling, FULL
synchronization and immediate mutation transactions persist acceptance and a queued job together
before effects. This combines the accepted-to-queued transition into one commit. No automatic
expiry or receipt replacement exists. Admission stops at 128 jobs or 2,048 operations; exact retries
remain readable at capacity. Deleting or restoring the journal is not a supported cleanup API.

The node durably claims `preparing` before launching a supervisor. The supervisor acquires a
per-job lock and verifies that claim before moving to `running` and starting its child. A late
supervisor cannot revive a quarantined claim. Node restart preserves a locked supervisor and
quarantines an unlocked, ambiguous `preparing`, `running` or `finishing` receipt. Recovery never
signals a stored PID and never relaunches an uncertain job. Any quarantine blocks new execution;
operator reconciliation is a later explicit capability. Existing queued work can still expire or
be cancelled. There is no claim of exactly-once external application effects.

Only one fixture runs at a time. Queue deadlines use persisted wall-clock timestamps (100–30,000
ms); execution deadlines use a supervisor monotonic clock (100–10,000 ms). Accepted cancellation
is a durable request, not proof that cleanup has finished. A queued cancellation starts no child.
A running supervisor sends TERM, escalates after 150 ms, and verifies group absence before
publishing cancellation or timeout. It retains the unreaped leader while signalling its group,
checks native boot/start/UID/group identity while the child is live, and never signals after reaping.
After exit, the kernel parent/unreaped-child relationship pins identity even when macOS no longer
returns native start metadata. Boot/start identity
is also retained for inspection. macOS records start microseconds and boot time; Linux records
start ticks and boot ID. Those representations are host-specific.

Completion and cancellation serialize through journal transactions. A terminal result is immutable;
a cancellation racing an already completed child may leave a successful result. Uncertain cleanup
or failed result publication becomes `quarantined`, never successful cancellation. A killed
supervisor leaves uncertainty; the fixtures self-expire within eight seconds rather than requiring
recovery to signal unverified processes. Scheduler or disk stalls can delay observed deadlines.

Output is drained continuously with bounded nonblocking reads, retaining at most 16 KiB per stream.
Receipts record truncation, exit code, signal, observed start count and cancellation separately.
Live output is checkpointed about every 100 ms; a supervisor crash may lose the last uncommitted
chunk. `starts` records observed child launches, not an exactly-once application-effect counter.

## Verification boundary

[Checkpoint 04](checkpoint-04.md) records the actual local results. Required cases include lost
acknowledgement, restart while running, owned-tree cancellation with a surviving sentinel, stale
identity/generation, queue expiry, malformed/oversized frames, output truncation, SQLite full,
failed acceptance/result publication and ambiguous launch recovery. Native Linux qualification,
project execution, SSH transport and terminals remain separate gates.

The persistence design follows [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)
and [rusqlite immediate transactions](https://docs.rs/rusqlite/0.37.0/rusqlite/struct.Transaction.html).
