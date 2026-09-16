# Resume complete interrupted relay fence writes

Cleanup can now finish publishing a complete guest fence journal under the existing per-slot lock.
Recovery requires a private, singly linked regular pending file, the exact current serial and
reservation, canonical three-field bytes with one terminating newline, and a known phase transition.
Only stop/remove operations may recover it. Start and inspect continue to refuse pending state;
recovery never repeats a launch or grants a newer reservation authority.

The journal is renamed into the committed state, then normal cleanup continues. Recognized edges
cover preparation to launch/discard, discard completion, and closing/stopped cleanup retries.
Existing process/executable/socket ownership checks still apply after publication. A pending launch
record does not imply the process exists or authorize blind allocation removal. No new retention
files, polling loops or background helpers are introduced.

Truncated/noncanonical content, unknown transitions, other serials/reservations and unsafe file
metadata remain untouched and block effects. The initial qualification covered matching committed generations; the follow-up below extends
complete first writes. Partial publication and missing identity recovery remain open; this is not
arbitrary journal reconstruction.

## Evidence

Live evidence: `.hack-local/review/wu07/fence-pending-1789580388851696000/`.
Optional-feature candidate SHA-256:
`027d36b442ee6b320a102ac469b76eb507c8989a6095c4d7ef3d60f2cb068ea6`.

The fixture started four fresh relays. A complete `launching -> closing` journal recovered through
ordinary release, leaving neither pending journal, relay allocation nor guest socket. Controls for
a missing newline, wrong serial and illegal `launching -> stopped` transition refused release,
preserved both committed and pending bytes, and continued serving HTTP. After replacing only the
verified test-injected invalid bytes with the fixture's valid closing journal, release succeeded.
The application and boot ID remained unchanged. These are injected on-disk interruption states,
not a claim that the guest process was killed at each write/rename instruction.

The broader staging, cancellation, identity refusal and managed lifecycle controls passed under a
caller mask of `022`. All 20 resource-watchdog samples passed. Final cleanup/archive/export,
shutdown, reboot audit and final shutdown passed. Protected global configuration was unchanged.
The injected host journal was exported through the supported offline API with no occupied recovery
source slots afterward. There is no new application performance comparison in this unit.

The repository shell contract executes the production recovery block, checks all recognized edges
for stop/remove, rejects start/inspect replay, and preserves malformed or foreign pending bytes.
Its lightweight file predicate deliberately does not claim guest metadata/locking coverage; the
live path uses the full guest script. A seven-state ordering model passed its safety invariant;
allowing the invalid direct transition to stopped produced the expected counterexample. The model
assumes serialized operations and valid write ordering, and does not prove filesystem durability.
It ran with an explicitly selected Java toolchain without altering global selection.

Default/all-feature Rust suites, strict Clippy, default release build, repository typecheck/check/test
(940 passes, five skips), shell syntax, changed-document links and privacy checks passed. Model,
focused regression and full verification logs are retained with the live evidence.

## Open gates

Partial fence bytes still refuse effects. Missing process
identity and dead relays without socket identity need dedicated recovery. Loopback/TLS publication,
scoped QA delivery, actual application parity, disk-retention policy and branch idling remain open.

## Follow-up: complete first writes and explicit shell guards

A complete pending `preparing` or `cancelled` record can now be committed for a newer reservation
by a stop operation only. The previous phase must be empty or terminal, the pending serial and
reservation must exactly match the host request, and both allocation and socket must be absent
(including symlinks). After the rename the local generation is updated before normal cancellation
continues. Remove/start/inspect cannot authorize this first-publication path. Active previous
phases, partial or foreign records, and unexpected allocations still refuse effects.

The expanded shell contract caught an error-handling bug during development: a failed guard on
the left of an `&&` list did not stop later commands under `set -e`. Required guards in the relay
and fence scripts now use independent tests. This also fixes the same pattern in private-file,
executable, socket and allocation checks. Conditional `if` predicates retain their intended logic.
The failing regression was a remove operation incorrectly accepted by the first-publication block;
it now refuses. The contract covers action/phase combinations and allocation/socket occupancy.

Live evidence: `.hack-local/review/wu07/fence-first-1789580860555208000/`.
Candidate SHA-256: `f6933ce46e0dc51527857524fb4fa78717b195d5e4f6177b63e100f93509f958`.
The fixture killed its own startup CLI after committed host intent, then injected complete first
journals for an unused slot (`preparing`) and a reused slot (`cancelled`). Ordinary release recovered
both without a VM restart or remaining allocation/socket. Before the unused-slot release, separate
symlinked-journal and unexpected-allocation controls refused and preserved their exact fixture
bytes. Only those verified test mutations were restored/removed before retry. The application
remained running and the boot ID stayed unchanged. Guest write/rename interruption itself was
represented by injected state, not a guest shell kill at every instruction boundary.

The existing relay/staging/cancellation/identity controls also passed. All 21 resource-watchdog
samples passed. Two used slots retained four fence files, 8 KiB by guest `du`, with no allocation
directories remaining. Final graph cleanup/archive/export, shutdown, reboot audit and final
shutdown passed; global configuration was unchanged. The host injection journal was exported
through the offline API, leaving no occupied source recovery slots. No new retention class or
background helper was added. Whole-application performance was not benchmarked by this unit.

A small first-publication admission model checked terminal-phase, empty-allocation and complete-record
requirements. Removing the occupancy guard produced the expected safety counterexample. This model
checks that limited decision boundary, not filesystem durability or the complete relay lifecycle.

Follow-up verification also passed: default/all-feature Rust suites, strict Clippy, default release,
repository typecheck/check/test (940 passes, five skips), shell syntax, changed-document links and
privacy checks. The 24-state model and verification logs are retained with the follow-up evidence.
