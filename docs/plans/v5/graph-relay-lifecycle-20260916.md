# Graph-managed guest relay lifecycle

The optional `native-stream-relay` build now embeds the native ARM64 relay and supports:

```text
hack-local graph start-bridge --run-id <run> --slot <index> --expect-reservation <token>
```

Reserve the slot using the current endpoint generation first. Start requires that exact reservation
in `reserved` phase, a currently healthy endpoint, and matching boot/container/network/generation.
It records the target PID/start ticks, port and binary digest in a durable `starting` receipt before
any guest allocation. It verifies the endpoint again after startup before committing `running`.
Repeated start never replays a possibly completed launch. An endpoint change after launch stops
that relay and leaves the slot recorded for explicit release.

Each allocation lives in private guest tmpfs under its random reservation token. It contains one
verified executable copy with its own inode, an owner marker, process PID/start receipt and socket
identity. The embedded binary is compressed within the bounded agent transport. A child shell
records its own identity before replacing itself with the relay, so observed process exit cannot
be followed by that child starting a later relay. The relay pins the container namespace and watches
the container process with a pidfd. There is no host TCP binding or general guest network exposure.

`graph bridges` observes the relay process and socket identity independently of endpoint currency.
A running relay and a current endpoint are separate facts; an unhealthy target can remain alive.
Target exit closes connections automatically. Restart requires a fresh generation/reservation;
there is no transparent retargeting to a reused address.

## Stop and recovery

Explicit `release-bridge` and ordinary graph cleanup commit `stopping`, verify the guest allocation,
request graceful exit through the exact executable's pidfd stop helper, and verify socket removal.
Only then do they commit `stopped`. Guest allocation removal follows that durable proof; the slot
is freed only after removal succeeds. An interrupted removal can resume from `stopped` while its owner marker remains, including
an already removed allocation. If the marker was removed but the directory remains, cleanup
refuses rather than assuming that an empty replacement directory belongs to it. Files are removed individually and the directory must be empty;
unknown files are not recursively deleted. Persistent application volumes are unaffected by relay
release. Ordinary graph cleanup retains its existing separate data-removal policy.

An interrupted host journal still blocks reuse and cleanup. `reconcile-bridges` preserves its exact
bytes without replay; subsequent release/cleanup resumes from the last committed phase. A new,
audited VM boot proves boot-local relay processes and tmpfs allocations no longer exist, so old
relay intent can be retired without signaling a process in the new boot.

Missing or malformed guest process identity, executable replacement and unrecorded socket identity
remain refusal cases. In particular, interruption before a child records its PID can require an
owned VM shutdown/restart before releasing that uncertain allocation. The command does not restart
the VM automatically or erase the receipt. Further controlled abrupt-start/stop tests remain open.
No claim is made that every possible partial guest allocation already has in-place recovery.

## Qualification boundaries

The managed control exercises native namespace/exit behavior through the graph CLI, without manual
relay staging or launch. It covers start/repeated-start refusal, target exit, generation replacement,
active cleanup, explicit release preserving the application, pending-journal refusal/reconciliation,
and removal of all allocation directories after each lifecycle. This is still an isolated HTTP
fixture. Host loopback publication, hostname/TLS routes, QA delivery, actual-application parity and
matched Compose/OrbStack resource/performance comparisons remain open. Default builds and the
normal pool remain unbridged.

## September 16 final control

Evidence: `.hack-local/review/wu07/graph-relay-1789576371081677000/`.
Optional candidate SHA-256: `b6c825b983f8118b8d47b490d08bad244155af98883a196921d98231e8ed7b64`.
The embedded relay is 28,504 bytes. Each active allocation occupied 40 KiB of guest tmpfs according
to `du`; this is guest allocation, not unique host disk consumption. Both lifecycle cleanups
confirmed no remaining allocation directories or relay socket. No persistent relay cache is added.

Fresh and restored graphs each served 64 HTTP requests at concurrency eight. Relay RSS was
464–580 KiB, with one thread, seven descriptors and zero additional user/system ticks in each
five-second idle sample. Those short component samples are not a whole-VM efficiency comparison.
An open stream closed on target exit, active graph cleanup and explicit relay release. Explicit
release preserved the running application. Repeated start, old endpoint generations and stale
release tokens were refused.

Temporarily removing the allocation owner marker made cleanup refuse with the phase retained;
HTTP still worked. Restoring the exact marker allowed subsequent cleanup. An injected partial
host journal independently blocked cleanup while traffic remained available; reconciliation
preserved its bytes without replay and cleanup then completed. All 16 pressure/swapout/reserve
watchdog samples passed. Final graph data cleanup, archive/export reconciliation, VM shutdown,
reboot/audit and final shutdown passed; protected global configuration remained unchanged.

Default/all-feature Rust suites and strict Clippy passed, including phase/identity and CLI argument
regressions. Repository typecheck/check/test passed (940 CLI tests, five skips). CLI reference
generation, shell syntax, changed-document links and whitespace/privacy checks passed. The final
live candidate includes the container/network identity hardening and strict guest-operation replies.

The final default build's read-only actual-application plan remains at 14 services, 22 errors and
two warnings, with Compose source unchanged. Evidence:
`.hack-local/review/wu07/graph-relay-application-1789576492029144000/`. Relay integration does not
resolve those application mount/routing compatibility gates.

The subsequent [interruption controls](graph-relay-interruption-20260916.md) qualify real CLI
termination at committed start/stop intent. Stop retry passes; an unlaunched start still requires
new-boot recovery. A bounded guest cancellation fence is the next recovery slice.
