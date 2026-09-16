# Live publication lookup for hostname claims

The candidate adds a diagnostic lookup beyond durable ownership inspection:

```sh
./hack-local runtime lookup-hostname --hostname api.feature-x.demo.hack --json
```

While holding the provider operation lock, lookup normalizes the name, loads its
validated durable claim and requires an exact native PID/start-time/UID/executable
match. It checks the recorded private directory inode, completed helper staging,
private singly linked helper inode and payload digest. Both frontend and control
sockets must exist with matching private, bounded native identity receipts. The
frontend receipt must match the reservation, while the control receipt must match
its separate control token. Native process identity is observed again after the
filesystem checks.

Successful output includes the normalized hostname, run, reservation and derived
endpoint with state `publication-observed` and scope
`point-in-time-host-publication`. It exposes no control token. Absent claims,
staged/incomplete publications, dead or mismatched processes, changed executables,
missing/partial receipts and replacement sockets refuse. Pending journals still
block lookup; a query does not recover or modify them.

The socket validator is shared with cleanup, but observation requires both socket
and receipt to remain present and performs no unlink, stop request or signal.
Cleanup retains its existing absent-resource retry behavior after process exit.

## Verification

The closest receipt regression checks non-mutating observation for valid, wrong-token,
missing, partial and replacement identities for both endpoint types. Actual-process
and managed VM controls are recorded below.

## Authority integration boundary

This is not guest/application health proof: an alive publisher can point at an
unavailable or stopped guest. Its reservation handshake still refuses a different
upstream generation. The observation is not a permanent capability; a publisher
can exit after the last check. Consumers must not use it to bypass ownership checks
or cache a pathname across reassignment. Same-user malicious filesystem mutation
is not a new security boundary established by this diagnostic.

The CLI launches a process and hashes a bounded helper on each call. It is not the
chosen per-request Caddy data path and is not a CPU optimization claim. A long-lived
private authority still needs lifecycle/identity fencing, bounded request parsing,
change/exit invalidation and measured lookup costs. Certificate admission and
retention, managed Caddy ownership, route-label translation and actual-app parity
remain open.

## Completed qualification

The live two-service VM fixture resolved a normalized hostname to its current
reservation and endpoint. While its publisher stayed alive, partial frontend and
control receipts each refused lookup; the receipt bytes and process were preserved
and HTTP continued serving the same token. A replacement frontend socket also
refused; restoring only the harness's original socket restored lookup. Actual
publisher death refused despite retained durable claims. Reassignment after cleanup
resolved the new reservation, and retired names refused.

The complete managed lifecycle still passed: explicit unpublish, bridge release,
VM down, offline retry, restart with unchanged token/volume record, graph cleanup,
archive/export and final down. All 12 watchdog samples and protected global hashes
passed. Final publication state was empty with no pending journal.

Evidence: `.hack-local/review/wu07/hostname-lookup-1789590345297806000/`.
Candidate SHA-256: `15c88b382c9a832ca83652dd1bcb625e1a91e21c7df896ed2a7b2861605a9a0c`.
A bounded 25-call sequential diagnostic sample measured 10.62 ms median, 11.04 ms
p95 and 0.206 seconds total child CPU. This includes wrapper/process startup and
is a baseline for replacing CLI spawning with a long-lived authority, not an
HTTP throughput result or comparison against Docker/Compose.

Default/all-feature Rust suites, strict Clippy, default native-HTTP release and
Bun typecheck/check/tests passed (940 pass, 5 skip). CLI reference generation
completed without stable-CLI changes. The first all-feature run exposed an
existing native HTTP probe fixture-directory collision: PID plus wall-clock
nanoseconds did not guarantee uniqueness across concurrent tests. An atomic
per-process counter now supplements that name; both suites passed after the fix.
