# Native publisher private stop channel

The optional native publisher accepts `--control PATH TOKEN` after its existing
publish arguments. The absolute Unix datagram path must fit the platform socket
limit and have an owned private directory as its immediate parent. The token is
32 lowercase hexadecimal characters. Managed callers must generate a fresh token
per publication; this primitive does not yet persist or manage publisher intent.

The helper creates the socket with its private umask and refuses an occupied path.
Only the exact 39-byte datagram `HKSTOP1` followed by that token stops it. TCP
payloads never enter this control parser. Wrong, truncated and oversized datagrams
are ignored. Control uses the existing poll loop with no periodic idle wakeup and
no per-control-client allocation. Shutdown closes the listener and streams and
removes the control socket only if its original device/inode still matches.
Upstream provider sockets and replacement paths are preserved.

Sending a datagram proves neither receipt nor termination. Managed cleanup must
wait for the recorded publisher to exit and verify resource closure before
retiring its receipt. This avoids requiring a numeric-PID signal for native
publisher shutdown on macOS. The Unix path remains an authority under its private
parent; arbitrary mutation by another process with the same user privileges is
outside that boundary.

## Verification

Host regression coverage exercises matching stop, wrong/short/oversized/empty
requests, TCP control lookalikes, occupied and nonprivate path refusal, listener
closure, socket removal, replacement preservation and upstream preservation.
All 17 native host contracts pass. Default/all-feature Rust suites, strict Clippy,
default native-HTTP release, Bun typecheck/check and tests pass (940 pass, 5 skip).
The final stream-closure assertion was rerun after moving its read timeout before
shutdown: macOS rejects setting that option after reset. No production change was
needed for this test-order issue.

The controlled VM fixture passes HTTP, occupied-port refusal, target exit, stale
publisher refusal after same-slot reuse, same-port replacement and private stop.
Wrong control tokens left the publisher alive; matching tokens exited cleanly and
removed the control socket. Graph fixture data cleanup, archive/export, VM down
and unchanged global configuration checks passed; seven watchdog samples passed.
Evidence is retained privately under
`.hack-local/review/wu07/publisher-control-1789584044077675000/`, including the
protocol, source, helper and check logs. Measured host helper SHA-256:
`6bc095b680fb0e7f781ce29babbb9aec935dca7ad035be2db217124e5e7d80a6`.
The existing managed guest candidate is unchanged for this host-only feature.

A three-second idle sample showed 1888 KiB helper RSS and displayed cumulative
CPU of `0:00.00` both before and after. This excludes the VM and kernel buffers
and is not evidence of zero CPU use or a matched Docker/Compose advantage.

## Remaining work

This is a foreground primitive, not a managed publication command. Durable intent,
process/exec identity, startup interruption, offline cleanup, VM-down ordering,
TLS and actual-app parity remain open. A bounded control queue is not a periodic
resource consumer; no end-to-end CPU or performance superiority is claimed here.
