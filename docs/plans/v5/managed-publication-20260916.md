# Managed foreground loopback publication

The experimental `native-stream-relay` candidate supports:

```sh
./hack-local graph publish-bridge --run-id RUN --slot 0 --expect-reservation RESERVATION --port 3000
./hack-local graph unpublish-bridge --run-id RUN --expect-reservation RESERVATION --json
```

Publication requires an already running, current-generation guest bridge using
`reservation-v1`. It binds only host loopback. It remains in the foreground and
prints `ready` after the native listener and private control socket bind; `--json`
is rejected for this command. Run it in an explicitly managed terminal/process.
The normal default candidate build still leaves native stream relay optional.

The provider lock is held while the launcher writes bounded intent, creates its
private staging directory and executable, and execs the native publisher in place.
The recorded PID/UID/start time therefore precede listening; the executable path
changes to the uniquely staged helper. Exec closes the operation lock, allowing a
separate CLI command to clean up. No detached child is launched before ownership
is recorded. Publication receipts are bounded to 32 entries and 64 KiB; each helper
is bounded to 512 KiB. One publication per bridge slot and one per port are allowed.

Explicit unpublish works with the VM stopped. Bridge release, graph cleanup and VM
shutdown stop matching host publications before releasing guest resources. Cleanup
uses the private control request and native exit proof, checks the recorded staging
directory device/inode and helper digest, removes only the expected helper, then
retires the receipt. Empty registry state is retained. Application volumes are
outside this cleanup path.

## Recovery limits

Interrupted registry writes retain `state.pending` and refuse replay. An interruption
between directory creation and its inode receipt, an unrecorded helper inode, a live
launcher that has not execed, or an unexpected/replaced file is preserved and can
require further recovery support. New helpers write a [native socket receipt](publication-socket-recovery-20260916.md)
before readiness, allowing exact stale-socket cleanup after abrupt death. Missing
or incomplete socket identity is still preserved rather than guessed safe to unlink. Such uncertainty can block normal publication cleanup and VM down. These
are explicit follow-up gates, not claims of complete lifecycle parity.
[Recorded pre-exec partial helpers](publication-staging-recovery-20260916.md) can now
be reclaimed after the launcher is confirmed absent. A normal
foreground interrupt exits the native helper and removes its socket; unpublish
then retires its recorded staging files.

Managed publication does not yet configure TLS, hostnames, automatic background
supervision or many-branch idle policy. The durable receipt and runtime cleanup
integration are the current qualification target.

## Qualified controls

The actual candidate CLI passed HTTP forwarding, duplicate publication refusal,
explicit unpublish, bridge release, VM down, offline idempotent unpublish,
same-port reuse and graph cleanup. The fixture's persisted token and complete
volume inspection record matched after VM restart. Its graph data was then
explicitly removed, archived/exported, and the VM stopped. Readback found zero
publication entries and zero candidate staging directories. Eleven resource
watchdog samples passed; protected global configuration/executable hashes matched.

Private evidence:
`.hack-local/review/wu07/managed-publication-1789585048944839000/`.
Candidate SHA-256:
`ebf14e8180f99e1bfb50eaf0ac32130c87509752b188296b306a76609acb06cf`.
The foreground helper showed 1872 KiB RSS and cumulative CPU `0:00.02` before and
after three idle seconds. CPU includes launcher startup before exec; neither this
sample nor helper RSS establishes an overall Docker/Compose performance advantage.

Focused ownership/CLI tests, default/all-feature Rust suites, strict Clippy,
default native-HTTP release and Bun typecheck/check/tests pass (940 pass, 5 skip).
The small cleanup model passed 16 reachable states; an unsafe early-retirement
control violated its invariant. The model initially omitted the live-guest launch
guard and was corrected to match `Engine::connect`; that was a model error, not a
new runtime defect. It does not prove filesystem race safety or crash recovery.

Next bounded controls are occupied-port startup cleanup, interruption during
staging/journal publication, abrupt publisher death and unknown-file preservation
through the actual CLI. Recovery must maintain bounded retained state without
claiming that preserved uncertainty is already reclaimed disk space.
