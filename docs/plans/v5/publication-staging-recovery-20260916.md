# Publisher partial-helper staging recovery

Publication intent now records the staged executable's device/inode before writing
its payload. The receipt remains explicitly pre-exec until the complete executable
and its directory have been synchronized; the ready transition is persisted before
exec. This retains foreground PID continuity and the provider operation lock.

After proving the launcher/publisher absent, cleanup may remove a partial executable
only when its inode matches that pre-exec receipt and no control socket or control
identity exists. Size, private ownership, regular-file and single-link limits still
apply. A ready executable requires both the recorded inode and full digest. Legacy
receipts lacking the new field retain their full-digest requirement. Unknown files,
replacements and contradictory control state are preserved.

This addresses partial payload writes after inode intent is committed. It does not
authorize removing files in the create-before-inode-record window or replaying a
pending publication journal. Those remain explicit recovery work.

## Verification

The ownership regression covers a reclaimable partial file, a ready-but-corrupted
file, a mismatched inode, a legacy ambiguous file and unexpected control state.
Only the first is reclaimed; the others preserve both file and intent.


The actual CLI launcher was caught on attempt 1 in its durable
pre-exec phase with no pending journal. The harness stopped its own child, verified
the staged inode, resized the empty file to seven incomplete bytes, then killed and reaped the
launcher. CLI unpublish reclaimed the partial helper, directory and intent. This
is explicit partial-write fault injection, not a claim that an ordinary process
kill naturally produced exactly seven bytes. A fresh publisher then served the
same fixture token on the same port and cleaned up normally.

Private evidence: `.hack-local/review/wu07/publication-staging-1789586038981075000/`.
Candidate SHA-256: `8ac51020e47e7d11dcf70d098bba673722d4d568402a9ecbe4c717d26af62544`.
The token and volume inspection record were unchanged until explicit fixture
cleanup; graph archive/export and final VM down passed. 4 watchdog samples and
protected global hashes passed. Readback found zero publication entries and zero
candidate staging directories.

All four publication ownership tests, default/all-feature Rust suites, strict
Clippy, default native-HTTP release and Bun typecheck/check/tests passed (940 pass,
5 skip). The native relay contracts remain green. No pending-journal or
create-before-inode-record recovery is claimed by this test.
