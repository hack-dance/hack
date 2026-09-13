# Checkpoint 02: private provider lifecycle

The candidate now implements an isolated SmolVM pool on Apple Silicon macOS. This is a
lifecycle checkpoint; project enrollment, Compose networks, source sync, useful workloads,
and speed/footprint qualification remain later work units.

## Implemented boundary

- `hack-local runtime probe/prepare/prepare-engine` validates pinned artifacts and reports
  admission. `hack-local runtime up/status/down/recover` operates only on candidate state.
- Rust owns the lifecycle, framed agent protocol, bounded subprocesses, locks and receipts.
  The Python script is a manual host watchdog and fixture, not part of the product executor.
- Provider artifacts and guest engine binaries are verified before use. Guest startup checks
  the native ext4 data UUID, read-only engine mount and owner marker before engine startup.
- Native process ownership requires PID, microsecond start time, UID and exact executable.
  A stale identity cannot authorize a signal. Recovery refuses a recorded process still alive.
- Shutdown requests engine quiescence, guest flush/unmount and verified provider termination.
  Completion requires the provider to be absent, its VM lock available, both owned disk files
  closed, disk identities unchanged and neither owned socket accepting connections.
- Data disks survive stop and recovery. Read-only status reports disk identity separately from
  data preservation, which requires the boot fixture's guest marker readback.

The pinned minimal guest does not include iptables. WU02 explicitly disables the Docker bridge,
packet-filter configuration and VM networking. Networked Compose compatibility is unqualified.
The 30-second quiet-host sampling interval is research admission, not measured startup latency
or the final product admission policy. Admission requires 16 GiB free memory and retains the
existing host pressure, disk and load checks.

## Live verification

M3 testing uses a separate private candidate checkout. Earlier attempts exposed packaging cache
placement, guest mount observation, guest process identity, missing networking dependencies and
an engine process waiting for the agent to reap it after exit. Their receipts are retained; they
are not successful cycles. Shutdown now recognizes the exited zombie state and retains a receipt.
Corrected failed-start and interrupted-stop cleanup confirmed provider absence and retained disks.

The final revision passed these bounded M3 checks on September 9, 2026:

| Check | Result |
| --- | --- |
| Clean lifecycle | Three boots and stops; two clean restarts; distinct boot IDs and the same guest owner marker |
| Provider loss | Native identity verified before TERM without guest quiescence; live recovery refused; dead provider recovered as `recovered-unclean`; marker checked on the next boot; final clean stop |
| Owned resources | No provider executable processes, open disk handles or accepting agent/Docker sockets; VM lock available |
| Retained data | Both 4 GiB raw disks retain their recorded identity; guest owner marker survives clean restart and provider loss |
| Stable runtime | Recorded installed Hack binary hash unchanged on both Macs; M3 OrbStack container inventory remains empty |
| Host watchdog | 100 samples across the final two fixtures; minimum free RAM 36.76 GiB, normal pressure and unchanged swapouts |

This verifies one owned pool using SmolVM 1.14.3 and Docker 29.5.2 on Apple Silicon M3. It does not
qualify networked workloads or every Mac host. The executable retains
`WU02-live-qualification-pending` because broader qualification gates below remain open.

The exact runtime/test input bundle SHA-256 is
`a1d21bd3fc47da8655546c626170f2e53378d21fb72bad27737fe3454db5a2ea`.
The M3 release executable SHA-256 is
`5ab61d1b6e6ee6cbe1e729657840988360d662cfd0566968d18e515830231bcb`.
The clean fixture is `lifecycle-1788972548374094000`; the separate provider-loss fixture is
`lifecycle-1788972649900978000`. The working checkout retains their raw receipts, failed attempts,
watchdog samples, final readback and transfer hashes under `.hack-local/review/wu02/m3-evidence`.

## Verification and remaining scope

Local Rust unit and integration checks cover artifact rejection, private state/alias ownership,
framed protocol bounds and deadlines, lock contention, interrupted receipts, native process identity
and a real stale-identity signal rejection with an unrelated sentinel surviving. The live fixture
adds engine readiness, guest disk/mount validation, marker readback and complete stop observation.

Local verification: 30 Rust tests passed; fmt/clippy and the release build passed. The normally
ignored provider-loss test passed separately on M3. Existing repository typecheck, quality checks
and tests passed with Turbo cache hits; they are not a fresh full-repository test run. The v4 CLI
rebuilt, its CLI reference regenerated unchanged, all 17 candidate document links resolved, and
shell/Python syntax and privacy checks passed. M3 used its existing Rust 1.97.1 toolchain; the
configured Rust 1.85.1 hosted CI matrix has not run for these uncommitted changes.

Run the ordinary checks described in [development](development.md). Run the manual M3 fixture
only on an admitted, owned pool. `--resume-owned-fixture` accepts an existing terminal receipt;
`--crash-recovery` separately exercises identity-verified provider TERM without guest quiescence,
refusal to recover a live process, dead-process recovery and a subsequent marker-checked reboot.
This simulates provider loss; it does not establish power-loss durability or hostile isolation.

Hosted CI, native Linux execution, real application data durability, native authorization rejection,
network compatibility and performance superiority are not established by this checkpoint.
