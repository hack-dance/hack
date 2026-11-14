# Desktop process tests

Run `bash scripts/test.sh` from `apps/desktop`. It checks the exact nextest pin
from the repository installer, runs the workspace tests in separate processes
with zero retries, then runs doctests. Each invocation creates and removes its
own HOME/HACK_HOME. Both desktop CI jobs use this command. To qualify a native
Mac, run `HACK_DESKTOP_TEST_REPETITIONS=200 bash scripts/test.sh`; preserve the
complete output and exact commit. Three consecutive green hosted macOS desktop
jobs are a separate acceptance gate.

The default threaded libtest runner is not the qualification route. Tests can
write executables and create descriptors concurrently within a single process;
Rust 1.98.1 on Apple creates a pipe and sets close-on-exec in later calls. Linux
uses atomic `pipe2(O_CLOEXEC)`. Separate test processes prevent one test's open
fixture writer or pipe-creation window from being inherited by another test's
child. Executable fixtures are also written to a private pending filename,
flushed, closed, marked executable, then renamed into place before use. Existing
first-launch warmups remain outside timed observations.

## Reported symptoms and what they prove

| Symptom | Interpretation and coverage |
| --- | --- |
| Fake CLI `NotFound` | The runner received a spawn ENOENT, not proof that the fixture pathname was absent. An unavailable script interpreter or a transient executable-launch failure can also produce ENOENT. The precise origin in the reported Mac runs was not captured; do not label it proven descriptor leakage. Separate test processes and closed-before-publish scripts remove cross-test writer inheritance. |
| Fake CLI never started | No ready marker was written before a product timeout. This can reflect startup scheduling or failed launch. Warmups, process isolation and the ready marker distinguish startup from tested cleanup; the timeout contract is unchanged. |
| Fake daemon `WouldBlock` (Darwin error 35) | Darwin/BSD can return this immediately when accept inherits a listener's nonblocking mode; it can also mean a timed read expired. Error 35 alone does not prove elapsed time or a spawn ENOENT. Fixtures explicitly restore blocking mode before reads. Version warmups precede a single 60-second fixture conversation deadline, shared by acceptance, complete header reads and response writes; no separate two/three-second fake-server read timer remains. Per-test processes remove cross-test descriptor interference. |
| Slow stream Drop / late pipe EOF | An inherited pipe writer can keep a reader alive after the intended writer exits. The Apple product boundary below closes unlisted descriptors. #843 separately replaces the tight elapsed-time oracle with reader completion and process retirement under a generous deadline. |

These are evidence boundaries, not a claim that every observed failure has one
proven cause. Linux checks and Apple-target compilation do not establish Mac
reliability. The 200-run native result and three hosted results must be recorded
before HACK-2243 acceptance.

## Product spawning

Test isolation alone cannot protect the multi-threaded application. The Apple
CLI runner uses `posix_spawn` with `POSIX_SPAWN_CLOEXEC_DEFAULT`, explicitly
installing only null stdin and the two output pipes, a fresh process group, cwd,
and the authored environment overrides. It preserves the normal SIGPIPE default
and an empty signal mask, so a GPUI worker cannot pass a blocked SIGTERM to the CLI. Pipe/action/attribute ownership uses RAII; waiting
reaps the owned child and caches its status. Linux keeps standard `Command`.

A runner-only mutex is insufficient because GPUI or another library can open a
descriptor outside it. The native regression deliberately holds an inheritable
high-numbered descriptor open: the standard-spawn control must see it; the app's
spawn must not. A second native regression checks argv, environment, cwd, null
stdin, separate stderr and process-group identity. They use only fixed system
commands and owned fixtures, with no daemon, engine, services or network.

The helper is an internal CLI-runner boundary, not a general replacement for
`Command`: it implements the runner's fixed null/piped stdio and process-group
contract. If a future runner adds environment clearing or other Command options,
it must carry those explicitly into this boundary as well.

The Apple boundary marks initial pipe descriptors close-on-exec immediately,
then promotes sources above standard IO with atomic close-on-exec duplication.
A small initial pipe-to-fcntl window remains for external spawners that do not
use CLOEXEC_DEFAULT; the application boundary cannot change those libraries.
All CLI spawns through this boundary close unlisted descriptors regardless of
that window. Executable resolution uses the captured child PATH and absolute
`posix_spawn`, avoiding libc's process-global PATH lookup.

Fake-daemon timing is fixture scheduling, not an assertion about production
latency. Both source fixtures and the headless-state fixture use the same
60-second conversation budget. Reads accept delayed and partial HTTP headers
(up to 4096 bytes), recalculate remaining time after each read, and report a
fixture-specific failure at the deadline. Response writes use the remaining
budget too. A regression deliberately waits beyond the old two-second deadline
before sending a split header. Product socket/CLI timeouts and nextest retries
are unchanged.

The shared request reader restores blocking mode immediately on entry after
accept, because Darwin/BSD accepted sockets can inherit O_NONBLOCK from a
nonblocking listener (Linux does not). WouldBlock is handled only while the
overall deadline remains; nextest still performs zero retries. The regression
now uses a nonblocking listener, forces the accepted nonblocking mode on Linux
too, sends a delayed split request, and checks that the accepted stream was
normalized back to blocking mode.
