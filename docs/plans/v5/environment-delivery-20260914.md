# Environment delivery audit — September 14

The candidate now has a service-scoped input compiler, fixed-output delivery component and
synthetic stdin/tmpfs probes. Managed
credential delivery to graph services remains disabled. This checkpoint narrows the transport
choice; it does not qualify a credential provider, lease lifecycle, or application integration.

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
to the current boot; earlier empty directories cannot consume its eight-slot budget. Those earlier
pilot directories are retained metadata, not claimed as reclaimed disk space. Stale-directory
recovery and interrupted-stage reconciliation remain open. A failed stage attempts identity-checked
cleanup and reports uncertainty when success is not established; callers must not assume absence.

## Remaining implementation and acceptance

- Integrate the fixed-output delivery component with graph allocation and its mutation lock.
- Bind ephemeral material to the service, provider incarnation, guest boot, authorized provider
  reference and lease expiry. Verify ownership before cleanup; refuse missing or expired delivery.
- Apply the stricter 8 KiB delivery admission at the graph boundary; the input compiler still
  accepts a 1 MiB aggregate. Larger delivery and chunking remain unsupported.
- Integrate service startup and non-root/entrypoint behavior, health checks, restart/redelivery and
  crash recovery. A wrapper's environment is not automatically inherited by separate health execs.
- Qualify native provider authorization and real application behavior. Keep values and their hashes
  out of persisted manifests, journals, receipts and public logs.

The probe does not prove host swap/core-dump exclusion, memory zeroization, forensic disk erasure,
hostile-root isolation or protection from applications that deliberately persist their environment.
No CPU, memory or latency improvement is claimed by this checkpoint.
