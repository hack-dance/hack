# Namespace-pinned relay lifetime

The subsequent [managed graph relay](graph-relay-lifecycle-20260916.md) uses these native controls.
This report preserves their earlier standalone qualification and its boundaries.

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

## Owned graceful stop primitive

`stream-relay --stop PID START_TICKS` adds an explicit Linux shutdown path for future graph
cleanup. The helper opens the target pidfd, verifies start ticks and executable device/inode
against its own executable, checks that the target is still alive, and signals SIGTERM using
`pidfd_send_signal`. It then waits on that same handle for at most five seconds. Numeric-PID
signaling and automatic SIGKILL escalation are absent. Identity/capability refusal returns 78;
invalid arguments return 64; timeout or an uncertain wait returns 70. A nonzero result never
authorizes deleting a process receipt or reusing its slot.

The caller must establish graph ownership and boot identity separately. A future supervisor
should use a distinct, verified executable inode per allocation, retained until confirmed exit;
this also distinguishes otherwise identical relay binaries. A pathname or matching binary digest
alone is not process ownership. PID/start ticks alone must not replace the native executable
check. The helper confirms process exit; the supervisor still has to verify socket/resource
cleanup and preserve interrupted start/stop receipts before reassignment.

The ARM64 live stop control passed in
`.hack-local/review/wu07/netns-relay-1789575433247392000/` using relay SHA-256
`34693e8e76acbf40b746cb3646c9baa5ca6649bcd0f1e69261d74ceb2c07ce66`. It refused a wrong start
time, the running application PID, and a byte-identical relay copied to a different inode.
Successful stop closed an active stream, removed the socket, refused new traffic and left the
application container running. The restore lifecycle independently repeated automatic target-exit
shutdown. Both lifecycles served 64 parallel HTTP requests before shutdown; relay RSS was
464–496 KiB with one thread, seven descriptors and no CPU ticks recorded across five-second idle
samples. These remain component observations.

Owned graph cleanup, restore, reservation recovery, VM restart/audit and final shutdown passed;
all 16 admission watchdog samples passed and protected global configuration was unchanged. An
earlier fixture attempt passed the stop assertions but then correctly hit `graph_restart_running`;
the corrected fixture stops the application only after proving relay-stop isolation. That failed
fixture also completed owned cleanup and VM shutdown. The fixture stages the C binary separately;
the Rust candidate executable hash therefore does not identify the relay payload.

Eight portable relay contract tests pass on macOS. A Linux-only regression additionally exercises
a real owned child through stale-start refusal, graceful stop and repeated-stop refusal; it is
not part of the macOS test count. Linux behavior was exercised by the ARM64 live control above.

After the stop change, default/all-feature Rust tests, strict Clippy in both configurations, the
default release build, repository typecheck/check/test (940 CLI passes, five skips), and changed
documentation links/whitespace checks passed. The default build remains without stream relays.
