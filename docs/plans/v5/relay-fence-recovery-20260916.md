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
metadata remain untouched and block effects. A first journal without a matching committed state,
or a journal for a newer reservation, remains outside this recovery path. Partial publication and
missing identity recovery are still open; this is not arbitrary journal reconstruction.

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

Partial fence bytes and first/new-generation publication still refuse effects. Missing process
identity and dead relays without socket identity need dedicated recovery. Loopback/TLS publication,
scoped QA delivery, actual application parity, disk-retention policy and branch idling remain open.
