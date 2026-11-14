# Lifecycle supervisor contract

The built-in Rust supervisor is an experimental opt-in for host lifecycle
processes. `lifecycle.runner: "supervisor"` selects it; omission keeps the mux
runner described in [lifecycle](./lifecycle.md). Its standalone process contracts
and CLI integration are tested separately. Distribution packaging is a separate
change: opt-in requires a matching supervisor executable alongside Hack or an
explicit test executable path.

## Artifact choice

`packages/lifecycle-supervisor` builds `hack-lifecycle-supervisor`. A separate crate
adds one executable, but compiles only its small process-management dependency set.
A config-compiler subcommand would save that artifact while mixing pure compilation
with process, signal and recovery code. A runtime-core subcommand would bring the
broader native runtime dependency graph into Compose installations. The separate
crate keeps those build costs and failure boundaries independent.

The supported build targets are `aarch64-apple-darwin`, `x86_64-apple-darwin`, and
`x86_64-unknown-linux-gnu`. A successful Linux run does not qualify macOS behavior.

## Protocol and private state

The binary accepts `run`, `serve`, `add`, `stop`, and `status`. Input and output are one four-byte
big-endian length followed by that many JSON bytes. Frames are bounded to 1 MiB;
each frame read or write has one 10-second deadline. A complete frame, rather than descriptor close,
commits delivery. Environment values travel only in the input frame and process
memory. They are never serialized into state, command-line arguments, or errors.
Authored commands can themselves print values; output remains unredacted and private.

`run` accepts `{version: 1, root, ownerToken, processes}`. `root` is an absolute,
existing, owner-only directory for one project instance. `ownerToken` is a fresh
opaque ownership token supplied by the caller. Each process has `name`, `argv`,
absolute `cwd`, and `env`. Names are safe file identifiers and must also be unique
without regard to ASCII case, including on case-sensitive filesystems. Commands execute argv
directly. A shell-authored command can explicitly use `sh -c`; the supervisor adds
no shell wrapper. The full environment is explicit, with no ambient inheritance.
An optional `displayName` retains the user's service label while `name` stays a
safe native file key. CLI callers use stable hashed keys so labels containing
spaces or separators cannot change the native directory layout. Optional
`logPath` selects the existing private lifecycle log; its parent and file must
pass the same owner, mode and no-alias checks as the native root.

`stop` and `status` accept `{version: 1, root, ownerToken}`. Read-only `status`
returns saved phases plus kernel-verified `liveProcessNames` and
`unknownProcessNames`; a saved phase alone is not a health check. It creates no files,
processes or ownership. Stop
requires matching ownership and a live identity before sending a signal. Unknown
identity is a refusal, never proof that a process is absent. A different boot or a
leader with a different start identity proves that the old session ended; it
grants no authority over the replacement. Guard-written terminal receipts are retained as proof that the old session ended.
A missing leader plus a numeric SID is not ownership: orphan recovery requires
a same-user surviving member born no later than the recorded command birth.
Only newer members, or legacy receipts without that birth evidence, report
unknown without signals. Descendants born after the command whose birth was
recorded may therefore require manual recovery once that command exits.

Replies contain `version`, `supervisorPid`, `processes`, and `outcome` (`ready`,
`observed`, `stopped`, or `unknown`). A stop whose confirmation times out emits
`unknown` and exits nonzero. Callers must inspect both the receipt and exit status.
`run` must be spawned as a fresh child without making it a process-group leader:
the supervisor calls `setsid` itself. A caller using `detached: true` or
`setpgid(0, 0)` is refused before authored code starts.

The root contains per-command state and lock files, an instance lock and,
for incremental launches, `control.sock`. The default log is `lifecycle.log`.
Directories are mode 0700; files and the control socket are mode 0600. Symlinks,
hard-linked files, foreign owners and broad permissions are refused. State contains
name, ownership token, guard PID, process group, OS start identity, boot identity,
UID, command PID and start identity when known, phase, and the direct command's exit code or signal
when observed. It contains no command or environment.
State is atomically published and synchronized before authored code can run.
The guard leads a new session in its own process group. The authored command
starts in a separate group within that session. Cleanup covers every live group
in the session, so a command moving into another process group stays owned.

The log uses the existing lifecycle reader contract:
`UTC timestamp<TAB>service<TAB>stdout|stderr|meta<TAB>message<LF>`.
Stdout and stderr drain independently; tabs in messages become four spaces. Lines
longer than 64 KiB become consecutive records so memory remains bounded. An
unterminated final line is retained. Records from different streams can interleave;
there is no total ordering guarantee between stdout and stderr.

All descriptors the supervisor opens are close-on-exec. The command receives only
its intended standard descriptors: null stdin, piped stdout and stderr. On macOS,
creation and setting close-on-exec are not always atomic. Delivery uses explicit
frames with deadlines; process liveness comes from an OS census, and post-exit
output draining is bounded. None depends on another process closing an accidentally
inherited descriptor.

## State model

This transition table is the first model. Each row maps to a fake-caller regression
in `packages/lifecycle-supervisor/tests/fake_caller.rs`. `guard` means a resident Rust
child that owns the command's session and process group. The project supervisor
owns and reaps guards; each guard owns and reaps its direct command child.
The table's labels describe abstract control states and request outcomes. Persisted
phases use lowercase names; `Orphaned` and `StopUnknown` are recovery observations,
not claims that a dead or paused guard rewrote its receipt.

| Before | Event and guard | Effect | After | Regression |
| --- | --- | --- | --- | --- |
| Absent | Start, instance and command locks acquired | Guard creates session; durable identity precedes command spawn | Starting | `starts_and_records_identity` |
| Starting | Command spawn succeeds | Publish command PID; deliver ready receipt | Running | `starts_and_records_identity` |
| Starting | Invalid executable or publication fails | No unrecorded command; terminate owned partial start | FailedStart/refused | `failed_start_runs_no_later_command` |
| Running | Stop with exact owner, boot and start identity | TERM authored session members | Stopping | `stop_after_caller_closed` |
| Stopping | No non-zombie members remain | Reap child; retain terminal evidence | Exited | `stop_after_caller_closed` |
| Stopping | Five-second grace expires, identity still matches | KILL authored session members, keeping the guard alive | KillPending | `term_ignoring_command_is_killed_after_grace` |
| KillPending | Census confirms no live members | Guard reaps and releases command lock | Exited | `term_ignoring_command_is_killed_after_grace` |
| Stopping/KillPending | Confirmation deadline expires with live members | Retain identity and command lock; report uncertainty | StopUnknown | `unresponsive_guard_stop_remains_unknown` |
| Running | Project supervisor dies | Guard and durable identity remain | Running/recoverable | `supervisor_kill_then_recover_stop` |
| Recoverable | Another start sees held command lock or live old identity | Refuse duplicate; preserve original | Recoverable | `supervisor_kill_then_recover_stop` |
| Running/recoverable | Guard itself is separately killed with live session members | Health unknown; refuse duplicate, permit verified session recovery stop | Orphaned | `dead_guard_with_live_session_recovers_term_then_kill` |
| Any live recorded | Owner differs or identity is unknown | Refuse; signal nothing | Unchanged | `foreign_owner_cannot_stop` |
| Any recorded | Boot differs or leader PID is reused | Treat old session as absent; signal no replacement | Unchanged | `stale_reused_session_leader_does_not_block_fresh_launch` |
| Running | Command exits; only zombies remain | Reap direct child; zombies do not hold liveness | Exited | `zombies_do_not_hold_liveness` |

![Supervisor state transitions](./diagrams/lifecycle-supervisor.svg)

A resident guard closes the publication gap: command ownership is durable before
spawn, and the group leader survives the project supervisor's death. The guard
keeps the command lock until its session has no live members, so a restarted project
supervisor cannot launch a second copy. If a guard itself is separately killed
while its command survives, health becomes unknown and duplicate launch is
refused. Stop can recover the recorded session after verifying the boot,
leader identity and each remaining member's UID, birth and session. Recovery
delivers TERM individually, grants a fresh five-second grace, then KILL and
confirms absence. Unverified identity never authorizes signals or a successful
stop. Launch and stop share a bounded lock; a startup descriptor lease keeps
admission locked through guard publication even if the project owner dies.
The guard temporarily inherits this stop-lock lease on stderr (fd 2), then closes
it by detaching stdio after publication. This descriptor is an internal ownership
lease, not a diagnostic stream; authored commands receive a separate stderr pipe.
On Darwin, processes of a different UID may be hidden by kernel inspection
permissions. Such descendants are unsupported: a readable census cannot prove
absence of a hidden different-UID member, and an ordinary owner cannot signal it.

The table models process death and retry, not filesystem hardware failure, hostile
same-user mutation, commands that deliberately create new sessions, or power-loss
recovery of live processes. Commands that daemonize out of their session are outside
this ownership contract. Native tests qualify only their host OS. Darwin has no
pidfd: its identity-to-signal interval, and numeric group signaling on both
platforms, retain a small kernel observation/effect race. The model assumes the
observed identity remains valid across that interval.

## Terminal behavior and later work

The current mux runner supplies a terminal, though its FIFO wrapper redirects
command output. A command that prompts or requires a controlling terminal can
therefore depend on that mux environment today. The standalone supervisor provides
no PTY: stdin is `/dev/null`, output is piped, and there is no controlling terminal.
Such a command sees EOF or its own non-TTY failure. It must use a noninteractive
mode or remain in an interactive workspace until PTY support exists.

Later work can add an explicit PTY mode and a small attach client so a persistent
interactive workspace can exist without tmux. An outside-tool provider interface
should deliver environment on stdin, with explicit framing and launch receipts.
Neither feature is part of this unit; interactive workspaces keep tmux by default.

## Delivery gates

The CLI opt-in is `lifecycle.runner = "mux" | "supervisor"`, default
`mux`, plus a test environment override. Both runners must pass existing lifecycle
unit and e2e scenarios before that integration is ready. Packaging must include the
binary wherever the Compose CLI installs: stable archives, prerelease bundles,
Homebrew, self-upgrade and supported container distributions. Existing prerelease
packaging is macOS arm64 only; Intel/Linux prerelease support needs its own explicit
qualification rather than assuming the stable archive matrix covers it.

The packaging PR inventory is:

- New `scripts/build-lifecycle-supervisor.ts`, root `package.json`, and CLI build
  wiring in `packages/cli/package.json` where needed.
- `scripts/build-release.ts`, `scripts/update-homebrew-tap.ts`,
  `src/lib/release-install.ts`, and `src/lib/release-staging.ts`.
- `scripts/build-native-candidate.sh`, `scripts/prerelease-plan.ts`,
  `scripts/installer/integrity.ts`, `scripts/installer/bundle.ts`, and retained
  `scripts/install-prerelease.py` compatibility inventories.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
  `.github/workflows/prerelease.yml`, and `docker/slim-runtime/Dockerfile`.
- `.hack/toolchain/run.sh`, `.hack/README.md`, and install/prerelease docs.
- Archive, Homebrew, upgrade and prerelease inventory regression tests, plus an
  installed supervisor artifact check analogous to the config compiler check.

Default migration removes the Python/FIFO wrapper in
`src/lib/project-lifecycle-controller.ts` and the shell execution gate in
`src/lib/shared-host-lifecycle.ts`. Finite shell-authored hooks continue to use
POSIX `sh -c` intentionally. Interactive tmux environment delivery stays separate.
Zellij removal, its breaking-change notice, and the workspace-only `MuxBackend`
contract belong to the third unit.

## Opt-in CLI integration

![Launch receipt and adoption state model](./diagrams/lifecycle-controller.svg)

The [controller model coverage](../tests/models/tla/lifecycle-controller/COVERAGE.md)
maps the finite ownership model to implementation tests, separately from the
physical-process model above.

The integration slice adds `lifecycle.runner: "supervisor"`; omission remains
`"mux"`. `HACK_LIFECYCLE_RUNNER=mux|supervisor` overrides the project setting for
verification. Invalid values fail before hooks or runtime effects. The executable
must be installed beside Hack, or selected by an absolute
`HACK_LIFECYCLE_SUPERVISOR_BINARY` test path. An unavailable executable is a refusal,
not a fallback to another runner. Packaging remains a separate delivery gate.

Persistent before hooks start immediately, in their configured order between
blocking hooks. The native `serve` operation starts the first command and listens
on a private Unix socket. Finite `add` clients forward later framed launch requests
to that same project owner. Environment stays in the frame and process memory.
The socket uses a relative address under an opened private directory, avoiding
macOS pathname-length limits. Every handoff has an explicit deadline.

The common lifecycle state records the native owner token and command identities;
logs remain at the existing per-instance log path, so `hack logs -f <name>` watches
them. Processes do not appear in tmux. Interactive `hack session` behavior is
unchanged. Stop uses the persisted backend even if configuration changes later.
Both runners use a five-second TERM grace, KILL escalation, and a bounded
confirmation window; zombies do not count as running. Unknown outcomes keep
ownership and shared helper holders for another `hack down` attempt.

A healthy matching definition can be adopted. A definition whose recorded command
has exited is replaced as a whole, including live siblings, matching the mux
controller's healthy-window requirement. Adoption records a new cleanup generation
without changing the native token, so an earlier start's rollback cannot stop
adopted work. CLI publication and native effects share an instance lock; the common
state file has a separate project-wide writer lock and atomic private publication.

A failed incremental handoff is reconciled with native status. If the requested
command became live after the reply was lost, its verified receipt is published
and the failure remains explicit. It is never launched a second time. A new owner
is retried only after native status proves the earlier commands absent. A missing
native root with no possible state is absent; unreadable, malformed or unverifiable
state remains unknown. Native status reports live and unknown names using kernel
identity, not a persisted `running` string. Doctor and host status use those fields;
missing tools and unknown identities cannot authorize repair or state removal.

Sending TERM to the project owner invokes its owned rollback path; this is not a
finite protocol request and has no response frame. Use the finite `stop` operation
when a confirmation receipt is needed. Logs currently have no automatic rotation.

The CLI keeps native receipts, owner capabilities and `control.sock` in the
host's Hack home under `lifecycle-supervisors/<instance-hash>`, outside the
checkout. The shared log stays in the existing project log location. Do not bind
mount the host Hack home into containers. A Hack home inside the checkout is
refused for this runner. Linux incremental launch peers must have the same UID
and PID, user and mount namespaces; macOS peers must have the same UID (Compose
runs in a separate VM). Same-user host code is trusted. Earlier experimental
checkout-local owners must be stopped with their original CLI before upgrading;
leftover native roots are never treated as proof of absence.

Doctor holds the same instance controller lock as `up` throughout final
inspection, generation validation, native stop and conditional state removal.
Adoption cannot interleave between validation and the stop effect.

Before creating ownership or running hooks, Hack checks the sibling executable's
permissions and exact version/capability handshake. Compiled installations ignore
`HACK_LIFECYCLE_SUPERVISOR_BINARY`; that override is for source development and
tests only. `hack doctor` reports the resolved executable and its version.
A missing or incompatible executable fails before publication. An entry durably
marked as never having attempted launch, with no recorded PID or process, can be
retired by `down` or doctor without that executable. An interrupted launch with
an uncertain result retains ownership.

The native root is keyed on the checkout's real path and its absolute location
is recorded with ownership. Changing HOME or HACK_HOME does not relocate a
running instance. Losing that recorded directory after a launch attempt is an
unconfirmed outcome, never proof of stopped processes; down and doctor retain
ownership. Restore access to the recorded host state before retrying retirement.

Run `hack down` before downgrading or switching CLI builds. Older CLIs cannot
preserve supervisor entries when rewriting shared project state and may start
mux duplicates. After the project owner is killed, existing guards keep working
and `down` can recover them; adding a new persistent hook may refuse until `down`
retires the old owner. Stop and retry rather than removing its socket or state.

Adoption requires a verified live command in the `running` phase. Commands in
`stopping` or `kill-pending` finish retirement before replacement; they are never
adopted as healthy. Native status waits for an existing launch/stop admission
lock before reading receipts, so an in-flight stop cannot expose a pre-TERM
snapshot as adoptable work. This observation creates no lock file in an unused
root and times out conservatively if admission cannot settle.
## Resource and qualification boundaries

A live direct child proves its guard is needed without a full-system census.
Guards wait for output or SIGCHLD; once only descendants remain, a 500 ms
fallback checks the session. Stop uses the short retirement tick. Startup closes
actual open descriptors rather than iterating the open-file limit. A known
restricted process view is refused before authored code; silently hidden
same-user processes remain unsupported.

Linux debug-build measurements with one quiet guard and owner recorded less than
10 ms CPU accounting resolution per five-second sample and two voluntary context
switches per second, across three samples. These are neither hardware wakeup
counts nor macOS measurements. The host's hard descriptor limit was 524,288;
the exact 1,048,576 test requires a host that permits that limit.
Darwin compilation does not qualify execution, group-signal EPERM recovery or
idle cost on a real Mac.

The 168-state TLA+ artifact is an abstract phase/ownership exploration. It models SID reuse and a required old-birth witness for orphan signaling. It does
not model actual kernel census observations, real flock behavior, full orphan recovery,
startup descriptor leases or signal errors. Some safety predicates hold by
construction. Native regressions, rather than that model, are the evidence for
those boundaries; see the model coverage document for the reduced claims.

Stop durably retires the owner generation before confirming teardown, even when
no command receipt exists yet. A delayed `run`, `serve` or `add` checks that fence
under the same admission lock before spawning. A new run after a completed stop
must use a fresh owner token; adoption keeps its existing token. Retirement
markers persist in the private native root and contain no command environment.
Status of retired-but-live work is unconfirmed, so it cannot be adopted.

On Linux, guard spawning uses the kernel's executable reference under
`/proc/self/exe`, which remains usable when an installer atomically replaces the
running helper. A rebuild between the first command and a later add therefore
does not depend on the deleted executable pathname.

Linux ownership checks read the process's effective UID from `/proc/<pid>/status`.
They do not infer UID from proc-file ownership, which changes when a command
disables dumpability. Such a command remains recoverable after guard loss.

Restart policy and restart backoff belong to the CLI integration in #811, not
this binary's command ownership loop. This crate does not restart commands.

Logs are append-only and have no automatic rotation. Stop all generations and
confirm native absence before archiving the private root/log and starting with
a fresh root. Crash-left private .tmp files can be removed only while no writer
holds the root. Retirement markers must not be pruned individually: they fence
arbitrarily delayed frames. Retire the entire quiescent root only after all old
callers and guards have exited. These files have no automatic size/count bound;
long-running installations must arrange a maintenance window and offline rotation.

Native crash tests currently cover prepublication command-lock blocking, incomplete
guard launch frames, and blocked ready delivery. Deterministic tests at the two
smaller instruction windows (starting-state save to spawn, and spawn to running-state
save) remain unqualified; polling a receipt cannot reliably stop a process in either
window. They require a dedicated synchronization seam, not a timing-only test.
