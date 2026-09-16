# Managed Unix publication

The experimental candidate can publish a running, reservation-guarded bridge through
an owned private Unix endpoint:

```sh
./hack-local graph publish-bridge --run-id RUN --slot SLOT --expect-reservation TOKEN --unix
```

Exactly one of `--unix` and `--port PORT` is required. This remains a foreground
command without `--json`. It prints the derived endpoint path to stderr with an
explicit instruction to await `ready`; the path alone is not readiness proof.
Existing TCP publication syntax and legacy durable records remain supported.

Unix mode persists in publication intent before staging or exec. Its endpoint is
`frontend` inside the existing private, reservation-specific publisher directory;
there is no arbitrary user-supplied path and no listener port allocation. Admission
still bounds total managed publications to 32 and prevents duplicate slot or
reservation ownership. TCP port uniqueness remains enforced for TCP entries.

Normal unpublish, bridge release, graph cleanup and VM down use the same managed
publication lifecycle. After actual process exit, Unix cleanup validates the private
`HKPF1` receipt against the recorded process, reservation and socket device/inode.
It removes only the matching socket and receipt, then retires the control socket,
helper and directory. Missing, malformed or mismatched identity retains the affected
resource and durable intent. Ambiguous pre-receipt crashes remain fail-closed.

A failed cleanup can already have stopped the process or retired another verified
resource; a refusal is not a promise of no effects. Retry uses retained identity.
The complete-journal recovery rules preserve endpoint mode as immutable intent;
raw recovery uses the same cleanup path. Pre-exec entries containing any endpoint
or control resources remain rejected.

## Verification

The closest ownership regression now exercises both endpoint types: correct receipt
cleanup, wrong token, missing identity and replacement-socket preservation. Full
candidate checks and live lifecycle qualification are recorded below.

## Remaining gates

This exposes the endpoint needed by the isolated TLS control; it does not install
or manage Caddy, global DNS or trust. Managed TLS must bind route lifetime to this
reservation and handle reload/crash ordering and certificate retention. Real-app
TLS/WebSocket/streaming, scoped QA and matched resource benchmarks remain open.

## Completed live qualification

Unix publication served the real isolated VM application, refused a duplicate,
cleaned up after explicit unpublish and supported republishing. After actual
publisher SIGKILL/reap, a deliberately wrong reservation in the test-owned frontend
receipt blocked cleanup and preserved the socket/intent. Restoring only the harness's
original receipt allowed managed cleanup to retire the abandoned resources.

Bridge release, VM down, offline idempotent unpublish, VM reboot/graph restart and
graph cleanup all passed. The application token and complete volume record were
unchanged across restart. The existing TCP lifecycle control also passed against
the same candidate binary. Both runs completed fixture archive/export, final down,
and all 11 memory-pressure/swap/headroom watchdog samples each. Protected global
Hack hashes remained unchanged. Final registry readback was empty with no pending
publication journal; every managed publisher directory was absent after retirement.

Private evidence:

- Unix: `.hack-local/review/wu07/managed-unix-1789588712489720000/`.
- TCP: `.hack-local/review/wu07/managed-publication-1789588743223811000/`.
- Candidate SHA-256: `140f74988b0ad47f641a535279d2656efa8c8d2ba08c7fb37842cbeca7a07395`.

Default/all-feature Rust suites, strict Clippy, default native-HTTP release and Bun
typecheck/check/tests passed (940 pass, 5 skip). CLI reference generation completed
without stable-CLI changes. Additional regression controls verify legacy records
without an endpoint-mode field, incompatible mode/port combinations, and CLI
mutual exclusion/duplicate/cross-action flag rejection before runtime access.

Unix publisher RSS was 1,872 KiB during the short three-second idle observation;
reported cumulative CPU stayed at 0.02 seconds at `ps` resolution. This is a bounded
helper observation, not total VM accounting or a Docker/Compose comparison.
