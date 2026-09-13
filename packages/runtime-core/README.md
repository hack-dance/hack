# Hack runtime core

Private Rust implementation for the [v5 candidate](../../docs/plans/v5/README.md). The library owns
candidate identity, bounded Compose review and enrollment, native source synchronization,
immutable source-job admission, durable host fixture jobs, and the
experimental Apple Silicon SmolVM lifecycle. The installed Hack, existing Docker contexts, and existing project runtimes are separate.

Build with `./scripts/build-hack-local.sh`, then run `./hack-local info` and
`./hack-local runtime probe`. The [development guide](../../docs/plans/v5/development.md) describes
pinned package preparation, ownership, resource admission, lifecycle commands, and manual tests.
[Provider pins](provider-pins.json) record the exact package inputs; the engine runs inside the VM.

`provider/` separates bounded child processes, artifact verification, admission, private ownership,
native process/disk identity, guest protocol, and lifecycle decisions. Guest requests use a bounded
connection to the existing socket; they cannot silently start or recover a VM. Failed operations
retain their phase and receipts. Recovery preserves disks and labels an unclean exit explicitly.

Protocol version 1 describes this development client. It is not a promised release API. This is
not an application graph executor or native Linux container adapter yet. The checkout-owned `node serve`
service and independent supervisors implement the [WU04 contract](../../docs/plans/v5/wu04-contract.md).
Its [versioned schema](node-protocol-v1.schema.json) precedes any TypeScript consumer. The
[Compose subset](../../docs/plans/v5/compose-subset.md) defines the importer and refusal boundaries. The
[work-unit ledger](../../docs/plans/v5/work-units.md) separates implementation from live qualification.

The submit_source request adds the immutable_source_jobs_v1 capability to the same node journal.
It requires an acknowledged working-tree revision, a separately published immutable snapshot and
an exact local image ID. Admission retains the source writer lock through the journal commit.
Execution rechecks the immutable tree before container creation and inside the container before
the requested program. Input is read-only; /output and /tmp are bounded writable tmpfs mounts,
with no network or managed credentials. This interface is in live qualification and does not
establish real-project readiness.
