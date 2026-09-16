# Complete publisher journal recovery

Cleanup can finish a complete pending publication receipt while holding the provider
operation lock. Startup still refuses any pending journal; recovery never launches
or replays a publisher.

Both committed and pending maps must pass the same ownership, size, capacity and
uniqueness checks. Recovery accepts identical maps or exactly one changed entry.
For a changed entry, its recorded process must be absent. Allowed transitions are:

- Initial intent with no staged directory or executable identity and no directory
  already present.
- Directory identity added to the same immutable intent, matching an existing
  private directory when present.
- Pre-exec file identity added within the same recorded directory.
- The same file changing from pre-exec to ready.
- Receipt removal after both the process and staging directory are absent.

All other entry fields must remain identical during an update. Readiness regression,
identity changes, multiple-entry edits, live launchers and premature removal refuse
recovery. A complete accepted journal is synchronized and renamed using the original
writer's publication boundary, then ordinary cleanup applies its existing process,
file, socket and digest checks. No other entry is discarded.

Malformed/partial journals remain preserved and blocking. This is not a raw-journal
export or discard API. Missing identity in both committed and pending state still
requires separate recovery work.

## Verification

Regression tests cover initial, directory, file, ready, identical and completed-removal
journals. Negative controls preserve both files byte-for-byte for changed identity,
a live launcher, readiness regression, multiple changes and premature removal.
The malformed-journal fixture has explicit private permissions so rejection tests
JSON validity rather than accidentally testing its mode.

A small cleanup-order model passes 50 states; permitting recovery of a live launcher
produces the expected invariant violation. This is a guard check, not filesystem or
implementation proof; real CLI interruption controls remain the runtime evidence.


The live CLI passed all four startup journal windows: initial intent, directory
identity, file identity and readiness. For each, the harness paused its own launcher
after a complete pending write, killed and reaped it without editing the receipt,
and verified startup refused the unchanged journal. CLI unpublish then recovered
that journal and reclaimed the recorded resources. A new publisher served the same
token on the same port afterward. Completed-removal recovery was subsequently qualified in the live fixture below.
Identical-map recovery retains regression coverage without a separate live interruption.

Private evidence: `.hack-local/review/wu07/publication-journal-1789586539134644000/`.
Candidate SHA-256: `b3b811529ddf9c99460b849c937bbb4af002d5aad8b0f1e0acd1b4fc31d7d329`.
Token and volume inspection remained unchanged until explicit fixture cleanup.
Graph cleanup, archive/export and final VM down passed; 5 watchdog samples and
protected global hashes passed. Readback found zero entries, no pending journal
and zero candidate staging directories.

All six publication tests, default/all-feature Rust suites, strict Clippy, default
native-HTTP release and Bun typecheck/check/tests passed (940 pass, 5 skip).
Malformed or partial journals and identity lost before a complete write remain
open; none were discarded by this recovery path.


## Interrupted retirement control

A later live control caught the real cleanup command on attempt
1, after it removed the host publisher's resources but before
committing the empty publication map. The harness stopped, killed and reaped that
owned CLI process and reaped the already-exited publisher. The original pending
journal was captured without editing it.

Two negative fixtures then verified preservation: a one-byte malformed pending
journal and a new private directory with a sentinel at the previous staging path.
Both refused recovery while preserving the committed receipt and injected state.
Only the harness restored its captured journal bytes and removed its own verified
replacement directory. CLI unpublish then completed retirement. This confirms safe
refusal of partial journals; it does not implement their export/discard recovery.

Private evidence: `.hack-local/review/wu07/publication-retirement-1789586699082935000/`.
Candidate SHA-256: `b3b811529ddf9c99460b849c937bbb4af002d5aad8b0f1e0acd1b4fc31d7d329` (unchanged implementation).
Fresh publication on the same port worked afterward, with unchanged token and
volume record. Graph cleanup, archive/export and final VM down passed. All 5
watchdog samples and protected global hashes passed. Final readback found no
publisher entries, pending journal or candidate staging directories.

This evidence-only follow-up changes no runtime code; prior required checks remain
the code qualification, supplemented by this live retirement control. The next
recovery work is a bounded, explicit path for retaining malformed journal evidence
without replaying startup or discarding ownership that is absent from committed
state. Unknown directory/file identity remains a refusal until independently proved.
