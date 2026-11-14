# Lifecycle supervisor: standalone contract

This first slice builds a standalone Rust supervisor with a fake caller. It does
not change `hack up`, configuration, or the default runner. CLI integration follows
lifecycle retirement changes; packaging is a separate change. The current default
continues to use the lifecycle mux session described in [lifecycle](./lifecycle.md).

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

The binary accepts `run`, `stop`, and `status`. Input and output are one four-byte
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

The root contains per-command state and lock files, an instance lock and
`lifecycle.log`. Directories are mode 0700; files are mode 0600. Symlinks,
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

The CLI opt-in is planned as `lifecycle.runner = "mux" | "supervisor"`, default
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

Stop durably retires its owner generation before confirming teardown, even if no
command receipt exists. A delayed run checks that fence under the admission lock
before spawning. New generations must use fresh owner tokens; markers persist in
the private root and contain no command environment. Retired-but-live work remains
unconfirmed. Linux guard spawning uses `/proc/self/exe`, preserving an executable
reference even after atomic helper replacement.

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
