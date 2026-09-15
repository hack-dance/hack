# Environment delivery audit — September 14

The candidate has a service-scoped input compiler, fixed-output delivery, graph-owned cleanup and
an experimental native startup adapter. Explicit in-memory delivery is available through the
`environment-launcher` build feature. Native credential-provider delivery and CLI exposure remain
gated; the checkpoints below distinguish component controls from real application qualification.

## Pinned source findings

The audit inspected SmolVM v1.14.3 at commit
`f233d46e8cc34e51543c4f463c2cea7622827093`. The installed release remains archive/tree verified by
`provider-pins.json` and candidate preparation. Inspecting the tag does not independently prove
that the shipped binary was reproducibly built from that source; live controls check the observed
installed behavior separately.

| Channel | Source behavior | Delivery implication |
| --- | --- | --- |
| Command/script/argv | The VM exec handler logs the command at info level. | Values must never be interpolated into scripts or arguments. |
| Noninteractive stdin | The handler pipes the supplied bytes to child stdin; its request summary is just `VmExec`. | Suitable for a bounded synthetic delivery probe; child output still needs control. |
| Stdout/stderr | Captured in memory and returned; `send_response` debug-logs the full derived `Debug` response, including byte vectors. | Host error redaction alone is insufficient. Delivery must emit fixed acknowledgments and suppress payload output on every path. |

Source references: [request summaries](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/crates/smolvm-protocol/src/lib.rs#L719),
[VM exec](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/crates/smolvm-agent/src/main.rs#L6678),
[response logging](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/crates/smolvm-agent/src/main.rs#L7057).
The default agent module filter is info, but delivery must not depend solely on debug logging
remaining disabled.

## Synthetic probe contract

The opt-in Rust test `stdin_payload_uses_tmpfs_without_console_or_error_reflection` requires an
explicit candidate root, an already-running owned VM and an external host watchdog. Ordinary tests
skip it. It uses fresh random synthetic bytes, including quotes, dollar signs and newlines; no
credential provider or actual secret is consulted.

The probe verifies zero guest `SwapTotal`, creates a dedicated 64 KiB tmpfs with
`nosuid,nodev,noexec`, and checks its mount source/type and root-owned 0700 directory. A 0400 file
receives the payload only through stdin. A second stdin transfer uses `cmp` to verify exact bytes
without returning their contents. Fixed receipts identify successful staging and verification.
The checked tmpfs is unmounted and its empty directory removed before the test completes.

A separate command deliberately echoes synthetic stdin to stderr and fails. The host must return
a redacted failure. The owned agent console must contain a public argv marker, proving that the
logging control was active, while containing neither the payload value, its base64 representation,
nor its debug byte-vector representation. This checks the observed logging configuration; it does
not establish safety under every possible tracing configuration.

The guest lacks `/proc/swaps`, so the probe uses `/proc/meminfo` and checks the swap list only when
present. Earlier attempts that required `/proc/swaps` stopped before tmpfs creation and shut down
the owned VM. They do not count as successful delivery probes.

The M3 run `environment-probe-1789426210222463000` passed the live probe and owned VM
boot/status/shutdown. The host watchdog reported normal pressure and unchanged swapouts; installed
Hack and global configuration hashes remained unchanged. Raw protocol and test receipts remain in
the private review directory. This is component evidence, not graph-service readiness.

## Fixed-output delivery component

`provider::environment::PendingEnvironment` now prepares one service's values and stages them
through stdin. Both the pending values and returned `EnvironmentLease` intentionally lack
`Debug`/`Serialize`; fields are private. The component accepts at most 64 keys and 8 KiB of encoded
JSON, rejecting invalid names, NUL and excess data before guest allocation. This stricter delivery
limit fits the transport frame without chunking or truncation; graph admission must still apply it
when that integration is implemented.

Each lease uses a 64 KiB tmpfs slot, a root-owned 0700 directory and 0400 data/metadata files.
The provider mutation lock serializes admission, with at most eight current-boot slots. Values are
never placed in scripts or argv. Staging, verification and removal suppress both output streams of
their operation bodies and emit only fixed acknowledgments after success. A local shell regression
test ensures failed preflight stops before effects and produces no receipt.

The in-memory lease binds a service, provider incarnation, guest boot and host monotonic deadline
of at most 300 seconds from preparation. Guest uptime expiry provides an additional check. Whole
seconds round down; verification refuses a remaining lifetime below one second. `verified_path`
checks ownership, permissions and both expiry guards before returning the guest path. That path
must not be cached as authority. `remove` permits cleanup after expiry and retains the handle on
failure so the caller can retry. An already-absent slot on the same boot is a successful cleanup
retry; a different boot is always refused. Expiry blocks new verification,
not a process that already read its values. The lease does not auto-delete on drop or expiry.

Live run `environment-lease-1789427425288311000` passes eight-slot admission and ninth-slot refusal,
exact synthetic payload comparison, wrong-service verification/removal refusal, mismatched boot
identity refusal, host and guest expiry controls, console checks and repeated current-boot slot
cleanup. Final validation passes 138 Rust tests, the separate live lease probe, 940 CLI tests,
typecheck, lint, privacy checks and release build.
The boot mismatch and expiry controls deliberately modify test-handle metadata or the owned guest
expiry file; they do not qualify a real native provider lease or application restart. The outer
watchdog completed owned VM shutdown with unchanged installed Hack/global configuration hashes.

The first pilot exposed a shell rule: placing a subshell in an `||` list disables `set -e` inside
its body. Removing that conditional context restored preflight and ownership refusals. The next
pilot exposed retained empty mount-point directories after VM shutdown. Admission is now scoped
to the current boot; earlier empty directories cannot consume its eight-slot budget. The nine earlier
pilot directories have now been explicitly retired under the recovery qualification below. A failed stage attempts identity-checked
cleanup and reports uncertainty when success is not established; callers must not assume absence.

## Recovery from immutable allocation intent

Before any guest allocation, staging now durably writes an immutable, mode-0600 intent under
`.hack-local/run/environment-leases`. It contains only schema version, service, slot ID, provider
incarnation and guest boot. Values, environment keys, value hashes and renewal authority are absent.
A staging error identifies its retained cleanup intent so a caller can address it after losing the
in-memory handle. At most 4096 intent files are admitted; retired intents are retained for retry,
and pruning that metadata is a separate open task.

`provider::environment_recovery::recorded_slots` lists intent-file IDs, not live leases or validated
contents. `retire_recorded` is an explicit cleanup operation: callers must own the allocation's
lifecycle, and must not automatically retire every listed entry. Cleanup uses the provider mutation
lock and cleanup admission, validates the private receipt and incarnation, and never restores data
or refreshes expiry.

On the same guest boot, a matching tmpfs allocation can be removed even if interruption occurred
before its service/expiry files were written. An absent slot or an empty, unmounted directory is
also retry-safe. On an older boot of the same provider incarnation, only absent or empty, unmounted
directories are eligible. Foreign mount sources, symlinks, nonempty unmounted directories,
unrecorded paths and foreign incarnations are refused. Cleanup removes no recursive directory tree.
The ordinary in-memory handle still refuses a different boot; cross-boot retirement requires the
cleanup-only intent path.

A complete initial `.pending` intent can be validated and atomically promoted before cleanup.
Partial JSON, unknown fields, identity mismatches, conflicting committed/pending files and aliases
are retained and refused. Recovery never deletes pending publication state to force a retry. These
controls do not claim recovery from arbitrary torn storage writes or hostile modification by the
runtime owner.

Live run `environment-recovery-1789428814471630000` passed the existing fixed-output lease
controls together with lost-handle cleanup, missing guest
metadata, an empty mount-point directory, foreign-mount/symlink/nonempty/unrecorded refusal, and
repeated retirement. After an actual VM shutdown and restart, the synthetic payload file was
absent and the prior-boot directory was retired from its original intent without reconstructing
values. The retained records contained neither the synthetic value nor its environment key.

The nine pre-intent pilot directories were handled separately in
`environment-legacy-cleanup-1789428106505741000`. Their exact names and timestamps matched the
recorded pilot; a private manifest selected only those entries. The manual fixture cleanup
rechecked root ownership, 0700 permissions, exact modification time, lack of a mount, and emptiness
at removal. The final inventory found none remaining. This one-time qualification path is not
automatic adoption of unknown directories by the product API. Both runs stopped the owned VM and
preserved installed Hack/global configuration hashes.

The full Rust gate also exposed an enrollment operation reported as busy after completion.
Enrollment now explicitly unlocks on exit instead of relying on descriptor closure. A regression
test retains a duplicated descriptor: it fails with close-only release and passes with explicit
unlock. This proves the descriptor-lifetime mechanism; the exact inheritance timing of the original
suite failure was not traced. All 142 regular Rust tests and Clippy pass after the correction.

## Borrowing the graph engine's mutation guard

Environment staging, path verification and removal now have internal operations that borrow the
`OwnedGuest` already held by the graph engine. They derive the candidate from that guard rather
than accepting a second candidate root, and neither reacquire nor release its mutation lock.
Standalone delivery calls use the same implementation after acquiring their own guard.
Verification also requires the caller's selected service to match the lease.

Cleanup-only connections refuse staging and path authorization before writing allocation intent.
Retirement under a normal engine guard bypasses allocation admission while retaining provider,
boot, mount and ownership checks. This lets the holder clean up after a pressure refusal without
releasing its lock or temporarily allowing another mutation. Cleanup does not refresh expiry or
grant permission to use a payload.

The opt-in engine handoff test checks exact synthetic bytes, engine HTTP observation between lease
operations, wrong-service refusal, repeated removal, and continued exclusion of a second provider
connection until the engine is dropped. A separate test injects a swap-baseline mismatch into the
in-memory guard: verification refuses with `runtime_pressure`, removal succeeds, allocation
admission remains refused, and the mutation lock remains held. It creates no actual host pressure.
These tests require an owned development VM and external watchdog.

Live run `environment-handoff-1789430822574659000` passed both new controls, the existing lease
checks, interrupted-stage cleanup and recovery across a real VM restart. The owned VM was stopped;
host pressure stayed normal, swapouts and installed Hack/global configuration hashes were unchanged.
The observed console contained lease-slot logging but neither new synthetic payload in plaintext,
JSON, base64 or byte-vector form. This is evidence for the observed logging configuration only.
Validation passed 142 regular Rust tests, 940 CLI tests, typecheck, lint, privacy and release build.
There is no new CPU, memory or latency comparison in this checkpoint.

This closes the mutation-guard borrowing prerequisite only. The graph executor still refuses
managed environment inputs: container attachment, entrypoint behavior, durable graph-to-slot
ownership and native authorization are not enabled by these internal methods.

## Container attachment and graph cleanup ownership

The experimental `graph::stage_environment` API accepts a pending environment only for a
committed, preparing graph's reserved service on the development VM. It refuses an existing
container, a pending graph journal or a second allocation for that service. It marks the graph as
requiring environment delivery and records the graph ID and exact container name in the immutable
allocation intent before guest staging. Values and their hashes remain absent from both records.
The normal graph input compiler/startup path still refuses managed environment inputs.

Container-bound retirement requires a confirmed engine not-found response for the recorded
container name. A stopped or never-started container still blocks retirement because its bind
mount may retain access to the payload. Engine errors and a foreign container occupying that name
also refuse cleanup. Graph cleanup validates each matching binding against its service resource,
removes and verifies absence of containers, then retires the slots before marking cleanup complete.
A lost create reply can therefore recover by the recorded name and ownership labels without the
returned ID or an in-memory lease. Intent inventory does not promote pending files; explicit
retirement can promote a complete, validated initial intent as before.

Graphs with attachments retain an `environment_attached` marker. Restart, restore and archive
export refuse these graphs until redelivery and binding retention are qualified. Older receipts
omit the false marker and preserve their serialization. The bounded intent inventory currently
requires all candidate allocation records to validate; uncertain records must be resolved before
attachment discovery or attached-graph cleanup can proceed. Ordinary graphs skip this inventory.

The manual attachment fixture binds the payload file read-only into a pinned Bun container. A
finite root-only parent loads it and passes exact values to a child through its process environment,
with child stdout/stderr suppressed and a fixed completion acknowledgment. This is a synthetic
attachment proof, not a production entrypoint wrapper. It covers interruption before create, after
create without retaining its returned ID, and after child execution. A second test process performs
cleanup without any lease handles, checks graph-binding mismatch refusal and repeats retirement.
It also verifies the engine's environment metadata has no injected values and its mount is read-only.
These are retained phase snapshots and dropped handles, not SIGKILL fault injection.

Live run `environment-attachment-1789431561987618000` passed both attachment/recovery tests,
borrowed-engine and admission-refusal controls, the existing lease checks, and recovery across a
real VM restart. All three fixture graphs reached removed state through explicit cleanup. The
observed agent console contained lease-slot logging but none of the new synthetic values in
plaintext, JSON, base64 or byte-vector form. The VM was stopped with normal host pressure,
unchanged swapouts and unchanged installed Hack/global configuration hashes.

Validation passed 144 regular Rust tests, 940 CLI tests, typecheck, lint, privacy and release build.
An initial regression correctly caught the false marker changing legacy serialized receipts; the
marker now omits itself when false and that compatibility test passes. No performance improvement
is claimed by this checkpoint.

## Native startup, non-root identity and signals

The opt-in Cargo feature `environment-launcher` builds a static Linux ARM64 launcher with Zig
0.15.2 and embeds it in the candidate. Default builds do not invoke Zig and keep managed startup
unavailable. Build the experimental candidate with `cargo +1.97.1 build --release --locked
--features environment-launcher --manifest-path packages/runtime-core/Cargo.toml
--target-dir .hack-local/target --jobs 2` (as one shell command).

`graph::run_with_environment` feeds explicit, service-scoped in-memory inputs into the normal graph
executor. The compiler keeps them out of executable configuration; the 8 KiB encoded limit is
checked before provider allocation. Each selected service stages under the engine mutation guard,
records graph ownership before effects, and revalidates the lease before create and start. It does
not choose or invoke a native credential provider, and the existing CLI path remains gated.

The adapter requires an explicit absolute entrypoint and numeric UID:GID (default `0:0`). It
preserves entrypoint/command argument boundaries and explicitly sets the container user. Payload
and expiry files remain mode 0400 and are owned by that UID:GID; slot directories and service
metadata remain root-owned. Files and launcher are bound read-only at reserved paths, with mount
collisions rejected. Named users are refused until image account resolution is qualified.

The launcher verifies regular, single-link files, permissions, effective UID/GID, payload size and
guest boot-time expiry. It rejects duplicate JSON keys, invalid environment names, non-string
values and NUL. It sets the core-dump limit to zero, combines supplied values with the image's
inherited process environment, and calls exec to replace itself with the explicit application.
It prints nothing on failure and exits 125. There is no resident launcher process. This does not
prevent an application from deliberately logging or persisting its environment.

Direct PID 1 execution and the existing Docker init option are both supported. The adapter does
not implement its own signal-forwarding supervisor. At this startup checkpoint, separate health
execs were refused and inherited image checks were disabled. The following checkpoint adds
explicit CMD health delivery; inherited checks remain disabled.

Launcher publication uses a capped, compressed stdin transfer, verifies the decompressed SHA-256
and root-owned executable metadata, and retains uncertain pending files. The first live pilot
exceeded the 64 KiB transport frame before launcher or environment allocation. Compression brought the compiled
launcher below that limit; oversized compressed artifacts refuse rather than truncating. No values
are part of this code artifact or its hash.

Live run `environment-startup-1789433610282575000` passed the normal graph scheduling path with
three services and scoped synthetic values including quotes, newlines, carriage return and Unicode.
The root application confirmed PID 1 after exec. Services with UIDs/GIDs 1001 and 1002 confirmed their
identities and exact values; Docker init forwarded SIGTERM/SIGINT and preserved exit codes 42/43.
Engine environment metadata contained no injected entries; inspection was also checked against
JSON-escaped payloads. A deliberate direct engine restart with an expired file bypassed the host
check and was refused independently by the launcher with exit 125 and no new stdout/stderr.

The full live run also passed the prior attachment, independent-process cleanup, shared-lock,
admission-refusal and actual VM-restart recovery controls. The owned VM was stopped, host pressure
stayed normal, swapouts were unchanged, and installed Hack/global configuration hashes matched.
Validation: 146 regular Rust tests with and without the feature, eight live controls, 940 CLI tests,
typecheck, lint, privacy, Zig formatting and the feature-enabled release build. The default build
continues to reject managed startup without the feature. These checks do not qualify named users,
arbitrary application process trees, native authorization or redelivery. No new performance
comparison is claimed; exec removes the launcher process rather than retaining a wrapper.

## Explicit health checks and fresh restore delivery

The experimental adapter now accepts explicit `CMD` health checks with an absolute executable.
Each health invocation reads and validates the same service-scoped payload and expiry as startup.
The launcher redirects stdin, stdout and stderr to `/dev/null` before reading values and replacing
itself with the health command. This intentionally removes health output diagnostics: exit status
and Docker health state remain available, but application output does not enter health history.
Timing, retries and argument boundaries are preserved. `CMD-SHELL`, relative executables and
implicit inherited health checks remain unsupported for managed delivery.

Live health checkpoint `environment-startup-1789434169172839000` confirmed non-root healthy
readiness even when the check printed its synthetic value to both output streams. Docker health
history remained empty. Expiring the owned lease produced health exit 125 and unhealthy status
while the main application remained running. All eight delivery/recovery controls passed and the
owned VM stopped with unchanged swapouts and protected host hashes.

`restore_with_environment` accepts newly supplied scoped values after completed ordinary cleanup.
It shares the existing unchanged-plan, source, readiness, retained-volume, resource-absence and
bounded-history checks. Old slots are rechecked and retired under the existing engine guard before
fresh allocations. Every supplied service receives a new immutable slot; no old intent or payload
is read as credential authority. Restore then creates new containers around the retained volumes.
In-place restart and export of attached graphs remain gated. Failed or interrupted restore still
requires explicit reconciliation/cleanup; it is never automatically replayed.

Live `environment-redelivery-1789434460004136000` passes the combined startup/health/restore
control. Restore supplied a changed value, created three new container IDs and three new immutable
slots, and preserved a named-volume counter from 1 to 2. The root app independently required the
fresh value on its second execution. A second restore while running was refused; retained old
intents could not retire allocations while their bound container names existed. Restored inspection
metadata contained none of the supplied values. Validation: 147 Rust tests in each build
configuration, 940 CLI tests, typecheck, lint, privacy, formatting, both Clippy configurations and
feature release build. All eight live controls passed, including real VM-restart recovery. The VM
was stopped afterward; host pressure stayed normal, swapouts and protected host hashes were unchanged.

This session exposes no callable 1Password Environment tool. Native provider authorization is
therefore unverified; the APIs remain feature-gated and the qualification uses synthetic values.
CLI credential delivery is not enabled by these component changes.

## Managed driver interruption controls

The feature-enabled live suite now includes an owned subprocess driver killed with SIGKILL at
seven boundaries: startup after environment staging, after container creation and after start;
restore after durable intent and at each of those three boundaries. The fault markers contain only
the graph identity and boundary name. Synthetic values are generated inside the child, not passed
through its argv or written into fixture files.

The parent verifies the actual signal, recorded slot count, expected container presence and
acknowledgement state. It requires fresh restore to refuse the interrupted graph without changing
its receipt. It then performs repeated explicit cleanup, fresh restore and final removal. Panic
unwinding also attempts owned graph cleanup. These controls address driver-process loss; they do
not qualify arbitrary application crashes, host power loss, native credential authorization or
forensic removal of values from memory.

Live `environment-crash-1789434858915391000` passes all seven managed driver SIGKILL boundaries.
Validation includes 147 regular Rust tests in both build configurations, 940 CLI tests, typecheck,
lint, privacy, Rust formatting, both Clippy configurations and a rebuilt feature-enabled release
candidate. All nine live controls passed, including prior health/redelivery and actual VM-restart
recovery. The VM stopped afterward with normal pressure, unchanged swapouts and matching protected
host hashes. No new performance comparison is claimed.

## Remaining implementation and acceptance

- Qualify native provider authorization before exposing managed delivery through the CLI. The
  explicit in-memory API is experimental; only the tested numeric-user and absolute-entrypoint
  subset is enabled by its build feature.
- Bind native provider authorization and expiry to the existing service/incarnation/boot guards.
  The cleanup intent alone must never authorize reading values or renewing a lease.
- Qualify pruning of retired cleanup intents without losing retry or ownership evidence.
- Qualify larger payload delivery if needed. The general input compiler accepts a 1 MiB aggregate,
  but the experimental startup API now applies the stricter 8 KiB per-service encoded limit before
  allocation. Larger payload delivery and chunking remain unsupported.
- Qualify named image users, shell health checks, in-place application restart and crash recovery.
  Ordinary restart and restore without fresh values remain refused for attached graphs; init signal
  forwarding is not proof of every application's process-tree shutdown behavior.
- Qualify native provider authorization and real application behavior. Keep values and their hashes
  out of persisted manifests, journals, receipts and public logs.

The probe does not prove host swap/core-dump exclusion, memory zeroization, forensic disk erasure,
hostile-root isolation or protection from applications that deliberately persist their environment.
No CPU, memory or latency improvement is claimed by this checkpoint.
