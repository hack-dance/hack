# Publisher failure cleanup and stale control sockets

Failure controls first ran against the managed-publication candidate. Occupied-port
startup exited 73; subsequent unpublish removed only its staged helper and preserved
the test's unrelated listening socket. An unexpected file caused cleanup to retain
intent and preserve that file after native shutdown. Normal foreground termination
left an intent that unpublish could retire. Abrupt termination left an unprovable
control socket, so cleanup correctly refused. That baseline required exact-inode
fixture teardown and did not qualify product crash recovery.

The native publisher now writes `control.identity` before reporting readiness. Its
bounded private record binds the publisher PID, control socket device/inode and
fresh control token. Creation is exclusive and refuses an existing path; file and
parent directory are synchronized. Graceful exit removes only the original receipt
inode as well as the original socket. Existing/replacement paths are preserved.

After native process exit or confirmed absence, managed cleanup validates the whole
staging directory and helper digest. It accepts a surviving control socket only
when the private, singly linked, bounded native receipt matches the retained PID
and token and the socket's current device/inode, owner and permissions. It then
removes that socket and receipt before retiring staged files and intent. A missing,
partial, wrong-token or mismatched receipt remains a refusal. Legacy helpers with
no socket receipt retain the previous safe refusal after abrupt death.

## Remaining boundaries

This closes post-readiness abrupt-death cleanup with an intact native receipt. It
does not close the bind-before-receipt crash window, interrupted registry updates,
partial executable staging, missing directory identity or PID reuse ambiguity.
These remain bounded retained-state recovery work. Same-user intentional state
replacement is not treated as proof of ownership; replacement sockets are preserved.
Application volumes are never involved in this host cleanup path.

## Evidence

Baseline failure controls: `.hack-local/review/wu07/publication-failures-1789585289079596000/`
(candidate `ebf14e8180f99e1bfb50eaf0ac32130c87509752b188296b306a76609acb06cf`).
The updated CLI then passed actual SIGKILL recovery: unpublish removed the original
native-receipted socket, helper and intent without manual socket teardown. A wrong
token refused cleanup; restoring the test-modified receipt permitted retry. A newly
bound replacement socket was preserved, along with the receipt and helper; only
the test harness removed its own replacement before final cleanup.

Updated evidence: `.hack-local/review/wu07/publication-socket-recovery-1789585669951504000/`.
Candidate SHA-256: `c69af0a9136cb6d015798f58f857571b96d3192e12153114562e7105c59388ea`.
Occupied-port recovery, unrelated-listener preservation, unknown-file preservation,
normal termination and same-port reuse also passed. The application token and
volume record remained unchanged until explicit fixture cleanup. Graph cleanup,
archive/export and final VM down passed; 6 watchdog samples and protected global
hashes passed. Readback found zero publication entries and zero candidate staging
directories.

All 17 native relay contracts and the three publication ownership tests pass,
including wrong-token, missing-receipt and replacement-socket controls. Default and
all-feature Rust suites, strict Clippy, default native-HTTP release, and Bun
typecheck/check/tests pass (940 pass, 5 skip). No overall performance improvement
is claimed by this recovery change.
