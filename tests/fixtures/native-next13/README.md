# next.13 writer fixtures

Source: tag `v5.0.0-next.13`, commit
`7151636f975f473581cc18013604c91789a35c41`. These are **synthetic writer captures**,
not VM captures. No VM, Docker engine or host runtime was used to generate them.

The tag was checked out separately. Its TypeScript `beginNativeProjectFinalization`
and `saveNativeProjectRun` wrote `frontend.json` and `mapping.json` in an isolated
home; that frontend then exited without calling `complete`. The mapping
uses the base-environment selection emitted by the tag's `selectedMapping`
(`effectiveEnvName: null`, empty profiles, no AWS selection). The fixture installer
replaces filesystem scope/inodes and the PID with the test's own exited child.
It does not call the current mapping or finalization writers to create old state.

The Rust captures use the tag's typed `Receipt`, `Entry`, `Record` and original
durable writers. The private lifecycle `Record`/`Store` and retirement request
codec were extracted unchanged into a test module inside the tag's portable
`provider::state` module: the enclosing relay-owner module is macOS-only. Its
original native identity **shape** checks, file locks, serialization, file sync,
rename and directory sync run on Linux. Native process observations and the guest
effects are synthetic. Three writer-generation tests passed.

| Capture | Original path / transition |
| --- | --- |
| `ready.json` | `graph::run_normalized_with_host_dependencies_until`: ready receipt before cleanup enrollment; original `state::write` |
| `ready-pending.json` | `host_relay::cleanup_enrolled` calls `begin_graph_enrolled`'s persist callback, adding Pending `RelayCleanup` to the still-ready receipt; original `state::write` |
| `coordinator-intent.json` | `Coordinator::begin_selected` publishes version 2, Intent, acknowledgement required, using original `Store::write` |
| `coordinator.json` | `prepare_graph` records selection; `execute` writes EffectStarted and the attempt before invoking cleanup, using original `Store::write` |
| `publishers.json` | `publication::save`: port publisher registry remains present when authenticated publisher stop cannot be confirmed |
| `frontend.json` | `beginNativeProjectFinalization`: active version-2 frontend attempt, no completed or recovered marker |
| `mapping.json` | `saveNativeProjectRun`: version-1 scope/inode-bound run mapping after readiness |

The synthetic Rust setup supplies the same field values at those writer
boundaries; it does not execute the macOS coordinator transport or claim guest
cleanup succeeded. In particular the port publisher PID can be exited while its
registry, control socket and identity receipt remain. Failure occurs before the
graph's stopped receipt or coordinator confirmation/acknowledgement is written.

Normalization replaces only paths, PIDs/births/UIDs, filesystem identities, random
attempts and hash-derived scope identities with public fixture values. Array sizes,
versions, optional-field presence, enum spelling and Pending/EffectStarted/ACK
states come from the old writers. The test installer rebinds those volatile
identities to owned temporary fixtures. A fixture is not authority to signal a PID.

Portable down tests consume these bytes for same-boot and predecessor-boot
dispatch, recover frontend finalization and admit a new ordinary frontend
lifetime. Rust tests read old receipt/registry codecs and bind the old coordinator
under current identity checks. The real coordinator restored-owner test proves
an unfinished legacy coordinator is preserved while a new owner can start and
stop in its own control generation. The opt-in VM fixtures and retained next.13
homes remain separate acceptance evidence.
