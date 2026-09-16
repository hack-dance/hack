# Namespace-pinned relay lifetime

The optional native stream relay accepts a Linux-only target mode:

```text
stream-relay SOCKET 127.0.0.1 PORT IDLE_MS --netns PID START_TICKS
```

It verifies the expected process start ticks, opens a pidfd, pins the target network namespace,
checks identity again and enters that namespace before creating its Unix listener. It refuses
the current namespace, PID 1, non-loopback destinations, missing privileges and unavailable pidfd
support. There is no fallback to periodic process polling or an unverified bridge address.
The namespace and original process descriptor remain pinned for the relay lifetime. Connections
use container loopback, so a replacement container reusing the bridge IP cannot inherit traffic.
Process exit wakes the existing poll loop, closes active streams and removes only the original
owned socket. No empty-listener timer was added. Legacy fixed-address mode is unchanged.

## Live qualification

An isolated ARM64 SmolVM pool with two explicitly owned transport slots passed both fresh graph
and restore controls: 64 HTTP requests at concurrency eight per lifecycle; stale process start
and guest-root namespace refusals before socket publication; namespace identity verification;
and container stop while a request was held open. Target exit closed that connection within the
two-second fixture deadline, removed the socket, and refused subsequent HTTP traffic. No explicit
relay stop was used for these target-exit assertions.

The relay had one thread, seven descriptors and 468–496 KiB RSS after traffic. Each five-second
idle sample recorded zero additional user/system CPU ticks. These short, relay-only observations
are neither whole-VM CPU results nor a Compose/OrbStack comparison. The pidfd adds a descriptor
but avoids a recurring process-health timer.

Generation/reservation replacement, partial-journal cleanup refusal and byte-preserving recovery
also passed. Graph cleanup, restore, final owned data removal, archive/export reconciliation,
VM down, reboot/audit and final down passed; all 16 pressure/swapout/reserve watchdog samples
passed. Protected global configuration remained unchanged.

Evidence: `.hack-local/review/wu07/netns-relay-1789575005754131000/`.
Candidate SHA-256: `2d706e94d020c0e73b06588e62787f01645c25955dd3df60a1c11ebab808c778`.
Relay SHA-256: `2fcf8235120e678cf1fbfe9a1d4223b8920820bd697cc64b4ec26fb844146a10`.
The raw result summary inherited obsolete wording about an explicit relay stop; the saved protocol
and per-lifecycle `active_connection_closed`/`target_exit` receipts describe the executed control.

An earlier attempt stopped before relay launch because formatted PID paths increased the binary
beyond the fixture's bounded staging frame. A bounded integer path builder removed that dependency;
the protocol limit was preserved. Cleanup completed after that refusal.

## Remaining boundary

This is a manually launched native primitive, still outside the default build. Graph reservations
remain reservation-only. Automatic launch must first record durable start intent, validate the
container generation and PID/start/boot identity under ownership, record exact relay identity,
and reconcile interrupted starts/stops before slot reuse. Unhealthy-but-running targets, ownership
loss, VM/daemon crashes, replaced sockets and recovery require supervisor controls. Host loopback
publication, hostname/TLS routing, QA delivery and actual application parity remain open.

Default/all-feature Rust suites, strict Clippy in both configurations, the default release build,
and repository typecheck/check/test passed (940 CLI tests passed, five skipped). Seven relay
contract tests passed, including malformed namespace arguments and identity refusal before socket
publication. Documentation links and whitespace checks passed. The isolated optional-feature
release was the executable used for the live control above.

A fresh read-only actual-application plan still has 14 services, 22 errors and two warnings; its
Compose source was unchanged. Evidence:
`.hack-local/review/wu07/netns-application-1789575160837640000/`. These compatibility gates are
not closed by the relay change.
