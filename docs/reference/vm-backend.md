# VM backend interface

The initial Rust interface is private to the lifecycle controller in
`packages/runtime-core/src/provider/lifecycle/backend/mod.rs`. It separates admitted
VM effects from the controller's durable records and recovery decisions. The released
provider CLI is the first implementation; this slice does not yet make other launchers
interchangeable.

| Operation | Required input | Meaning of success |
| --- | --- | --- |
| `create` | `MachineSpec`, consumed `FreshCreate` | Provider accepted the machine definition; disk adoption remains with lifecycle. |
| `start` | Consumed `StartPermit` | Provider command completed and its recorded process identity was read; independent process, disk, socket and guest observations remain necessary. |
| `recorded_process` | Bound machine | Backend returned its current identity claim; this does not prove the process is live or owned. |
| `stop` | Bound machine | Stop request completed; lifecycle must still prove process exit and check disk holders. |
| `delete_forced` | Bound machine after caller's teardown/recovery proof | Existing forced-delete command completed, without relaxing ownership checks. |
| `enable_translation` | Bound machine after caller's host/config checks | Existing translation update completed. |

Constructing `SmolvmCli` grants no create or start authority. Both trait methods consume
tokens with private constructors and no clone/copy capability. Ordinary pool creation
requires the fresh admission basis, while boot requires the existing final leased
recheck. The disposable verifier follows its existing admission probe, work-root lock,
pool lock and template activation; only that module can construct its admission proof
for a separate pair of tokens. Neither path introduces an extra probe or changes phases.

`pool_spec` translates the retained owner and profile into creation inputs, including
the engine volume/socket pair, translation, project shares, network and socket roles.
Its regression checks the entire provider argument vector through the real helper.
A signature regression checks token requirements on both the trait and implementation.

The provider implementation reads and parses its PID record after a successful start.
The controller independently observes and verifies the returned process identity before
persisting it. Recovery and network checks use the same backend reader without starting
a process. Missing or ambiguous records retain their existing refusal codes and messages;
a successful start command followed by an unreadable record remains an uncertain outcome.

Errors retain the existing `CandidateError` codes, messages and diagnostic metadata.
Command execution keeps its closed environment, stdio behavior and 60-second bound.
Timeout is an uncertain outcome: inspect before admitting another start. Acknowledgment
does not prove that a process exists or has exited. Lifecycle retains leases, disk
ownership, phase publication, identity checks and recovery. No state machine changes
in this slice; the admission model's source-order test retains its existing assertions.

Later slices cover status/process handles, guest execution, configuration and disk
observations, neutral network/share encoding, error classification and backend selection.
Scripted fake lifecycle tests, the invocation-boundary regression and VM lifecycle
model/chart mapping are still required for full backend interchangeability. Native
qualification requires macOS tests and real-VM scenarios; cross-compilation is insufficient.
