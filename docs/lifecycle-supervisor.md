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
the exact recorded command PID/birth or a matching guard, including a zombie.
Only unrecorded members, or legacy receipts without a surviving matching guard, report
unknown without signals. Descendants alone may require manual recovery when both recorded processes are gone.
Stop attempts to capture verified members before signaling even a live guard;
a failed capture does not prevent that healthy guard from handling shutdown. Stop
allows a live guard ten seconds for its five-second TERM grace, KILL confirmation,
and scheduling and publication delays. If the guard is lost during stop,
recovery prefers a fresh capture and falls back to those
admitted identities, rechecking each before TERM/KILL. Each recovered target gets
its own five-second TERM grace and two-second confirmation bound. Recovery begins
at most once per target. Late guard loss can extend the combined waits to roughly
seventeen seconds. Descendants forked after the capture are never
signalled: once no captured member is left, stop waits until the target's own deadline for them to
exit and reports unknown only if they are still alive. A failed or expired target does not abandon other admitted
targets: stop drives them to their own outcomes before returning unknown. A receipt that
cannot be verified at admission is never signalled, but it no longer keeps the owner's
other targets from being stopped; the reply is still `unknown` with `stop-incomplete`.

Replies contain `version`, `supervisorPid`, `processes`, and `outcome` (`ready`,
`observed`, `stopped`, `unknown` or `refused`). A stop whose confirmation times out emits
`unknown` and exits nonzero. Callers must inspect both the receipt and exit status.

Every `stop` and `status` request whose frame is read ends with exactly one framed
receipt, also when it fails. Such a failed request exits nonzero and carries a `reason`
(the fallback frame below, written before any frame is read, has none):

| `reason` | `outcome` | Meaning |
|---|---|---|
| `invalid-request` | `refused` | The control frame or root was rejected; nothing was read or changed. |
| `stop-lock-wait-expired` | `unknown` | Another stop or a launch held `.stop.lock` for the whole wait (nineteen seconds). This request acted on nothing. |
| `foreign-live-process` | `unknown` | A receipt from another owner token still has live members. |
| `foreign-unknown-process` | `unknown` | A receipt from another owner token has live members that no witness ties to it. A census, inspection or boot-ID failure while checking that receipt is `io-error` instead. Nothing is signalled or retired in either case. |
| `stop-incomplete` | `unknown` | Stop could not confirm that every member is gone. |
| `retired-owner-live` | `unknown` | Status for a retired owner whose members are not proven absent. |
| `stop-lock-failed` | `unknown` | Taking `.stop.lock` failed for a reason other than the wait expiring. |
| `receipt-read-failed` | `unknown` | The process receipts could not be read. |
| `retire-failed` | `unknown` | Stop could not durably retire the owner token; nothing was signalled. The retirement marker may already exist, so a later `run` with that token can be refused. |
| `io-error` | `unknown` | Any other local failure. |

A successful reply has no `reason`. The nineteen-second stop-lock wait exceeds the
combined guard and recovery waits of seventeen seconds. Admission and census work
can add time, so an expired lock wait still returns its own receipt. The CLI's
forty-second request timeout allows for both waits and the framed reply.

The reply's `processes`, `liveProcessNames` and `unknownProcessNames` are a snapshot
read after the stop lock is released. Another stop or launch can run in between, so
they describe the root at reply time; `outcome`, `reason` and the exit status describe
this request.

A request that fails before it writes any reply gets one fallback frame: outcome
`refused`, an empty `processes` list, no `reason`, and a nonzero exit. For `stop` and
`status` this happens only before the request frame is read, so nothing was done: the
startup descriptor cleanup failed (on macOS it needs one spare descriptor to list
`/dev/fd`, so a caller at its descriptor limit is refused), the argument count was
wrong, or the action was unknown.

No frame (exit nonzero with no receipt, or a partial frame) means the request may or
may not have acted. That happens when the reply cannot be written: a closed stdout, a
reader that does not drain within ten seconds, a receipt over 1 MiB, or the process
being killed. An oversized receipt is never replaced by the fallback frame, because the
request may already have signalled. Re-run `status` to learn the state.
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

Each record is written with one `write` on an `O_APPEND` descriptor and no lock. On a
local file system the kernel places each append atomically at the end of the file, so
whole records from different guards never interleave; records from different guards
appear in the order their appends happened. No guard waits for another guard to log,
so a stopped or hung guard cannot stall a sibling guard's output, exit detection or
stop handling.

Readers: a final line without a line end is incomplete (a record can be read while it
is still being appended) and must be held back until it ends.

When a log write fails, a record can be split. If the first write is short and the
second fails (a full disk), the head of the record stays in the file without a line
end; the next record from any guard is appended directly after it, so that line has a
damaged head followed by a whole record. A failed log write is an error for the guard:
it sends TERM to its command, waits the five-second grace, sends KILL and exits, so on
a full disk each guard ends its command at its next log record. With a file-size limit
(`RLIMIT_FSIZE`) the second write raises SIGXFSZ, which the guard does not handle, so
the default action ends the guard itself and its command continues without a guard;
`stop` then recovers it as after any lost guard.

## Locks and waits

A guard stopped at any instruction (SIGSTOP, a debugger) can hold only what it already
had. No sibling guard waits on it, and every request that can wait on it has a bound.
The bounds below limit each wait, not the total duration of a request:

| Lock | Held by | Held across a blocking call? | Who waits, and the bound |
|---|---|---|---|
| `.instance.lock` | The project supervisor (`run` or `serve`), for its lifetime | Yes, its whole run | Another `run` or `serve` for the root: up to 10 s, then refused. Guards, `add`, `stop` and `status` never take it. |
| `.stop.lock` | `run` or `serve` from admission until its ready receipt; `add` while it admits one command; each new guard (inherited on fd 2) until it publishes and detaches, or through its cleanup if a step before detaching fails (five seconds plus the KILL confirmation); `stop` for its duration; the project supervisor while it stops on a signal | Yes. A guard frozen before it publishes keeps the lease until it is continued or killed | `stop` waits up to 19 s, then answers `unknown` with reason `stop-lock-wait-expired` and acts on nothing. `status` waits up to 19 s only when the lock file exists (it never creates it), with the same framed answer on expiry. `add` waits up to 19 s, and its forwarder reads the reply for up to 29 s. A launch (`run` or `serve`) waits up to 19 s, then exits nonzero without a ready receipt and starts nothing. `run` writes each guard's plan and reads its receipt with a 10 s deadline each, then rolls back (up to seven seconds more). The project supervisor's signal-triggered stop also waits up to 19 s, then tries again on its next loop pass. |
| `<name>.lock` | The guard of that command, for its lifetime | Yes | Only a new guard for the same command name: up to 10 s, then refused. Never a sibling, `stop` or `status`. |
| Receipts, retirement marker, `lifecycle.log` | No lock | No | Receipts are replaced atomically; a reader that races a replacement reads the complete version it opened. Log records are single appends (above). |

A guard frozen before it detaches keeps every `stop`, `run`, `serve`, `add` and (when
the lock exists) `status` of the whole root failing, each within its bound, for as long as it stays frozen, healthy siblings
included. If the project supervisor is alive it rolls back and stops the published
siblings itself; if it was killed, they keep running and cannot be stopped through
`stop`. A guard frozen before its first receipt save has no receipt, so `status` does
not show it. Recovery: find the frozen guard and continue it (`SIGCONT`) or kill it;
the lease is released when it exits or detaches. The guard is a stopped process
(state `T`) whose session ID is its own PID, a child of the project supervisor or
orphaned. On macOS its command line is the supervisor's full path followed by
`guard`. On Linux it is started as `/proc/self/exe guard`, so `ps` shows the
command line `/proc/self/exe guard` and the short name `exe`, not
`hack-lifecycle-supervisor`; confirm it with `readlink /proc/<pid>/exe`, which names
the supervisor binary.

`status` takes only the bounded stop-lock wait above. `stop` handles each target
separately. A live guard that stays frozen exhausts its ten-second wait and its
target contributes an `unknown` outcome while the other targets finish.

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

Fixture processes run in their own sessions, in a private root named after the test
process (`supervisor-test-<pid>-…`); the supervisor and its guards run there too.
Teardown stops the fixture, kills each recorded session, then kills every remaining
process of a `fake_caller-<hash>` or supervisor binary whose working directory is that
root (on Linux, read from any live thread), and fails the test if one survives. A run
killed before teardown (a timeout, Ctrl-C) leaves its fixtures behind; the next run's
first fixture reaps roots whose test process no longer exists. A root is removed only
when no process of any kind still works in it. The CI Supervisor job fails when any
fixture or test supervisor process survives the suites.

| Before | Event and guard | Effect | After | Regression |
| --- | --- | --- | --- | --- |
| Absent | Start, instance and command locks acquired | Guard creates session; durable identity precedes command spawn | Starting | `starts_and_records_identity` |
| Starting | Command spawn succeeds | Publish command PID; deliver ready receipt | Running | `starts_and_records_identity` |
| Starting | Invalid executable or publication fails | No unrecorded command; terminate owned partial start | FailedStart/refused | `failed_start_runs_no_later_command` |
| Running | Stop with exact owner, boot and start identity | TERM authored session members | Stopping | `stop_after_caller_closed` |
| Stopping | No non-zombie members remain | Reap child; retain terminal evidence | Exited | `stop_after_caller_closed` |
| Stopping | Five-second grace expires, identity still matches | KILL authored session members, keeping the guard alive | KillPending | `term_ignoring_command_is_killed_after_grace` |
| KillPending | Census confirms no live members | Guard reaps and releases command lock | Exited | `term_ignoring_command_is_killed_after_grace`, `stop_confirms_kill_after_guard_is_delayed_past_old_budget` |
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
delivers TERM individually, grants a fresh five-second grace, then KILL to the captured incarnations and
confirms absence. The capture remains authoritative if TERM ends the witness;
every signal still rechecks that member's PID, birth, UID and session (pidfd on Linux).
Readers that open a receipt while a guard atomically replaces it read the complete version
they opened (the read takes effect just before the replacement), so a
concurrent update never reads as a refusal.
On Linux a thread-group leader whose main thread exited while other threads run shows
`Z` in `/proc/<pid>/stat`; it counts as live while the kernel's thread count on that same
stat line is above one. A pidfd open that
reports the process missing (`ESRCH`, or `EINVAL` on Linux 6.8 when the PID survives only as a group or
session ID) skips that member without a signal; liveness is still decided by identity afterwards.
Unobserved descendants never inherit this authority; stop waits for them until its deadline and reports unknown if they remain. Unverified identity never authorizes signals or a successful
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

The 426-state TLA+ artifact is an abstract phase/ownership exploration. It models
SID reuse, an exact recorded-incarnation witness for orphan signaling, witness loss
after capture and the retained-snapshot KILL step. It does
not model actual kernel census observations, real flock behavior, recovery timing,
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

This crate does not restart commands, and the CLI opt-in does not add a restart
policy either: a persistent command that exits stays down under both runners
until `hack restart` or `hack up`. Automatic restart with crash-loop backoff is
deferred to a later slice and would belong to the CLI, not this ownership loop.

Logs are append-only and have no automatic rotation. Stop all generations and
confirm native absence before archiving the private root/log and starting with
a fresh root. Crash-left private .tmp files can be removed only while no writer
holds the root. Retirement markers must not be pruned individually: they fence
arbitrarily delayed frames. Retire the entire quiescent root only after all old
callers and guards have exited. These files have no automatic size/count bound;
long-running installations must arrange a maintenance window and offline rotation.

Native crash tests cover prepublication command-lock blocking, incomplete launch
frames, and blocked ready delivery. The opt-in integration also adds deterministic
SIGKILL tests at both smaller instruction windows: after saving starting but before
spawn, and after spawn but before saving running. Only a build with the test-hooks
feature contains these checkpoints; normal and release builds omit them. Before
spawn the session is absent; after an unrecorded spawn it is unknown and stop sends
no signal without a birth witness. CI runs the two checkpoint tests separately from
the default suite and builds the release executable without this feature.

## Manual recovery after an unknown stop

Stop retires the owner token before validating all receipts. One unknown receipt
is left running (it is never signalled) and blocks every new start in that private
root, although the owner's other, verifiable targets are still stopped. Repeating up with a new token does not bypass the uncertainty.
This also applies when a guard dies after spawn but before publishing running:
the receipt has no command birth evidence, so an unanchored session is unknown.

1. Keep the private root and all receipts. Run status with the recorded token;
   use the reported guard/command PIDs and session as leads for inspection, never
   as authority to kill. Inspect current processes with the OS process tools
   (ps on macOS; ps and /proc on Linux), including PID, parent PID, SID, UID,
   start time and command. Identify the actual application processes yourself.
2. For each process you confirm belongs to this failed launch, record its current
   start identity. Send TERM to those individual PIDs, wait at least five seconds,
   and recheck each identity before sending KILL to any remaining process. Never
   signal a numeric process group/session from the stale receipt alone. Leave
   unfamiliar or inaccessible processes untouched and seek operator help.
3. Retry stop with the original token (or hack down through the same persisted
   project owner). Once the uncertain session is absent, normal stop can retire
   the remaining healthy guards. If another receipt is unknown, inspect it in the
   same way. Confirm stopped/status absence before a fresh up with a fresh token.
4. Do not delete receipts, locks, retirement markers or the root to unblock up.
   That discards the ownership evidence without stopping anything. Offline root
   rotation is allowed only after all original callers/guards and authored work
   have been independently confirmed gone.

Darwin libproc requires a nonzero PROC_PIDTBSDINFO argument to include unreaped
zombies. The inspector requests it explicitly. A matching boot, PID, birth and
UID prove the original zombie guard has not been reused even when getsid rejects
it; this zombie never counts as live work and is never signalled. Live guards
and recovery members still require the recorded session and UID.

Darwin start timestamps come from the wall clock and can decrease between guard
and command creation. Recovery therefore never orders those timestamps: it matches
PID and the recorded birth exactly. A backward step between those starts does not
invalidate a still-matching command witness. The native identity contract still
assumes a PID and exact recorded birth value identify one incarnation; Darwin has
no pidfd, so its short inspection-to-signal race remains as documented above.
