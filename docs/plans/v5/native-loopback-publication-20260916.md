# Native loopback publication primitive

The optional native relay now supports a host mode:

```text
stream-relay --publish PORT PRIVATE_UNIX_SOCKET RESERVATION IDLE_MS
```

The listener address is fixed to IPv4 `127.0.0.1`. Startup refuses an occupied port; it does not
replace an existing listener. The upstream must be a private, singly linked Unix socket owned by
the current user. Its metadata is checked at startup and around each connection. The publisher
never unlinks that provider-owned socket. Normal termination closes its own listener and streams.

Each upstream connection sends the recorded reservation handshake and consumes its acknowledgement
before reading or forwarding client application bytes. Invalid/missing acknowledgements fail closed.
The connect/handshake phase has the smaller of a one-second or configured idle deadline; ordinary
stream activity follows the configured idle limit. The existing 32-connection and 16 KiB-per-direction
userspace buffers, nonblocking flow control, half-close and signal wakeup are reused. Idle listeners do not poll
on a timer. No shell, per-request child, persistent cache or additional retention file is involved.

The publisher currently runs as an explicitly owned foreground helper. This is not yet the managed
`hack-local graph` publication API. A stale publisher keeps its local port until stopped, but cannot
reach a new reservation through a reused transport slot. The next unit must integrate its lifecycle,
process identity, cleanup and crash recovery into managed CLI intent.

## Host and VM evidence

Host contracts stream a 2 MiB payload and reply through the complete TCP→Unix→TCP path, verify
handshake bytes stay out of application traffic, and exercise half-close. Controls cover occupied
port refusal, old-token refusal after upstream socket reuse, invalid acknowledgement without
application-byte forwarding, listener shutdown and upstream socket preservation. Nonprivate,
symlinked and regular-file upstream paths are refused before listening.

Live evidence: `.hack-local/review/wu07/loopback-1789582732760848000/`.
Native host publisher SHA-256:
`08be18b69f85d62aef531aa5fce4f9efa7d1a1a309ec427b5098ad09334a2c34`.
Managed guest candidate SHA-256:
`4c8ee74d0135a98f9bb1466902dfb0a28575f9dda4d558e7fcfd6dc8ebdafa16`.

The host helper was built from the changed source using the same C flags as the repository host
build. It connected to a managed reservation-v1 relay in the isolated VM. A real loopback HTTP
request returned the application token. A second helper on the same port exited with conflict while
the original still served. Releasing the guest relay closed a held HTTP connection. A new managed
relay reused the slot; the old publisher failed closed. After stopping the owned old helper, a new
publisher reused the same port and served successfully. Final stop left the port refusing connections.
The test tracked and terminated only its own direct child processes.

Host `ps` reported `1888` KiB RSS (about 1.84 MiB) and cumulative CPU time `0:00.00` both before and
after a three-second idle sample. This is a short, quantized component observation, not a claim of
zero CPU or a full comparison with Docker/Compose. RSS excludes kernel socket buffers and provider/VM memory. All seven resource-watchdog samples passed.
Graph cleanup with explicit fixture-data removal, archive/export/reconciliation and VM shutdown
passed. Protected global configuration was unchanged.

Default/all-feature Rust suites (including 15 native stream-relay host contracts), strict Clippy,
default release, repository typecheck/check/test (940 passes, five skips), documentation links and
privacy checks passed. Logs, publisher source and the measured host binary are retained with the
live evidence.

## Remaining gates

Managed publication must persist transport/reservation/port/process identity before effects and
qualify interruption, port reuse, cleanup ordering and target invalidation without idle polling.
Then connect local routing/TLS, scoped QA and real application flows. Matched resource/performance
benchmarks, disk retention and many-branch suspension remain open.

A bounded CPU follow-up is now identified in `release`: every connection clears the full fixed
flow buffers. Compare that baseline with state-only reset under matched short-request and large-stream
loads, checking cross-connection byte isolation, half-close, failure paths and memory accounting.
This is an unmeasured optimization hypothesis; no buffer-clearing behavior changed in this unit.

The [paired buffer-reset experiment](publisher-ownership-cpu-20260916.md) is complete: state-only
reset did not demonstrate a CPU improvement, so full-buffer clearing remains unchanged. The same
report qualifies foreground exec identity/lock behavior as a managed-startup building block.
