# Native warm-up window after `hack up -d` (HACK-2669, HACK-2707, HACK-2708, HACK-2709, HACK-2720)

`hack up -d` returns at started with "N routes warming". The owner then reaches
its ready line and releases the provider lease, and the detached frontend takes
the run's shared HTTPS lease (`allReady` in `native-project-start.ts`). That
acquisition needs the provider lease three times:

1. The shared owner's hostname authority (`serve-managed-hostnames`) takes it to
   start (`hostname_authority::managed`). It waited 5 s (`STARTUP_LEASE_WAIT`).
2. The shared owner verifies the acquire (`verifyNativeHttpsLeaseGraph`):
   `graph inspect` reads under the lease. It made one nonblocking attempt.
3. At cleanup the owner verifies the release the same way, with `graph inspect`,
   `graph bridges` and `runtime publication-hostnames` (one attempt each).

The ready line is exactly when `hack exec` and `hack run` stop waiting for ready
and take the same lease (dependency refresh, the exec or job itself), and when a
`hack down` issued right after `up -d` stops the graph under it. So:

- **Rows 1, 3, 4 (HACK-2669).** A command holding the lease at step 2 made the
  acquire refuse. The frontend treats any acquisition failure after a started
  return as fatal: it stopped the whole run (about 11.6 s, the same as a
  Ctrl-C stop), and the exec then found no ready run ("exec identity or
  response is unconfirmed" after 11.7 s). `hack run` saw its job cancelled
  (`graph_cancelled`); on next, its own nonblocking job admission
  (`foreground/jobs.rs`, `one_off::runtime::begin`) lost instead
  (`provider_busy`).
- **HACK-2709.** The same refusal needs no command: the ready owner's own
  restart tick (once a second, for the `restart: unless-stopped` route) takes
  the lease for a moment, so a single nonblocking acquire read loses now and
  then. Nothing reports it, because the frontend is detached: the run stops
  and its routes never answer. This is the same race; the model's brief holder
  is any holder, a command or the tick.
- **HACK-2707.** `hack down` holds the lease for its whole stop (about 12 s),
  longer than the authority's 5 s at step 1. The shared owner's startup failed
  (`authority-ready: provider_busy`) and, by design, kept its startup failure.
  The frontend's cleanup also ran as soon as the graph owner exited, without
  waiting for the acquisition still in flight, and a recovery against an owner
  that never published its endpoint cannot be confirmed. `down` exited 1 and the
  next `up` refused `E_RECOVERY_REQUIRED`.
- **HACK-2708.** After a Ctrl-C stop, an exec that had been waiting for the lease
  (PR #1260 made it wait) takes it the moment the stop releases it, so step 3's
  single read refused (`graph-verification: provider_busy`) and the owner
  exited 1 instead of 130.

## Fix

- Steps 2 and 3 wait out contention: every leased read of
  `verifyNativeHttpsLeaseGraph` and `verifyNativeHttpsOwnerIdle` retries only
  `provider_busy` (nothing admitted) inside one shared deadline of 15 s
  (`INSPECT_BUSY_WAIT_MS`, as the other inspections inside `up` and `down`),
  through `withNativeProviderBusyWait`. The owner's SIGTERM or SIGINT aborts the
  wait. A holder that outlasts it is still refused, with the holder's refusal.
- Step 1 waits as long as owned cleanup does, 30 s
  (`AUTHORITY_STARTUP_LEASE_WAIT`), and stops waiting once its owner is gone:
  before every attempt one non-blocking `read` of its stdin FIFO sees end of
  file (Darwin's `poll` reports nothing on a named FIFO whose writer closed, so
  the first version of this check never fired on macOS). The TypeScript budgets
  follow: authority and Caddy readiness 40 s, and every connector waits 55 s for
  the owner's endpoint (`NATIVE_HTTPS_OWNER_STARTUP_WAIT_MS`), not only the one
  that spawned it, which also stops once that process exits. A recorded startup
  failure still ends every wait at once.
- A stop can hold the lease far longer than 30 s (its stop budget reaches
  540 s, for example `stop_grace_period: 40s`). When the authority gives up
  behind it (`authority-ready: provider_busy`, child cleanup confirmed, no
  endpoint ever published, no lease file), that owner generation admitted
  nothing. The lease's recovery, which the frontend runs only after its graph
  owner has settled and `down` only after the stop, now retires that generation
  under the owner admission lock (`retireUnadmittedNativeHttpsOwner`): it writes
  the retired-owner record, then moves the whole owner root beside it
  (`released-leases/<generation>/failed-owner`) with one `rename`, so a crash
  between the two steps leaves a root the next recovery matches and finishes.
  The release is then verified through the graph as for any retired owner.
  Every other startup failure is still retained as before. A connector whose
  owner configuration is gone or replaced refuses at once instead of waiting
  out the startup budget; only a missing endpoint is waited for.
- Cleanup awaits the in-flight acquisition before it chooses between release and
  recovery, and starts none once the graph owner has exited. A refused acquire
  after the owner exited is the stop, not an infrastructure failure.
- `hack down` follows its lifetime when the frontend adds the HTTPS lease to it
  while the stop runs (version 2 to 3, same attempt), instead of refusing.
- The compose one-off (`hack run`) owner path waits too: its read-only
  selection and `one_off::runtime::begin` share one `COMMAND_LEASE_WAIT` bound,
  with the owner's signal and client-disconnect check before every attempt, and
  all of it before the job reservation.

## Model

`WarmupWindow.tla` has one provider lease; one brief holder (`CmdHold` ticks: a
command or the owner's tick), which may arrive at any time, including after the
stop; one stop (`StopHold` ticks) requested by `hack down` or Ctrl-C; and the
shared HTTPS acquisition (`pending`, `authority`, `verify`) with its cleanup
(`releasing`). Waiting steps poll faster than holders hold, so time passes only
while someone holds the lease, and a step's wait counts across holders (one
shared deadline). A step that gives up while the run is ready tears the run down
(`torn`). A startup failure or an unsettled acquisition at cleanup leaves the
lifetime `unconfirmed`, unless `Retire` holds: then cleanup retires the failed
generation and verifies the release (`releasing`) like any other.
`VerifyWait = 0` is the old single read, `AuthorityWait = 1` the old 5 s
(shorter than a stop), `Await = FALSE` the old cleanup, `Retire = FALSE` the
retained startup failure.

| Config | Result | Shows |
| --- | --- | --- |
| `positive` (`VerifyWait = 2`, `AuthorityWait = 5`, `CmdHold = 1`, `StopHold = 3`, await) | 272 distinct states, no error; `WarmupSettles` and `StopSettles` hold under weak fairness | A brief holder never tears the run down (`NoTeardownByBriefHolder`); a stop during warm-up always ends confirmed (`NoRecoveryRequired`); cleanup is never acknowledged while an acquisition can still land (`NoAcquisitionAfterCleanup`) |
| `negative` (`VerifyWait = 0`) | `NoTeardownByBriefHolder` violated: `torn = TRUE`, `https = "refused"`, `lease = "cmd"` | Rows 1, 3, 4 and HACK-2709 |
| `nonblocking-release` (`VerifyWait = 0`) | `NoRecoveryRequired` violated: `fin = "unconfirmed"`, `https = "retained"`, `lease = "cmd"` | HACK-2708 |
| `short-authority-wait` (`AuthorityWait = 1`, `Retire = FALSE`) | `NoRecoveryRequired` violated: `fin = "unconfirmed"`, `https = "startupFailed"` | HACK-2707, the authority half |
| `long-stop` (`StopHold = 7 > AuthorityWait = 5`, retire) | 510 distinct states, no error; every invariant and both properties hold | The outcome no longer depends on the stop's length (#1260 review, M3) |
| `long-stop-retained` (`StopHold = 7`, `Retire = FALSE`) | `NoRecoveryRequired` violated: `run = "stopped"`, `torn = FALSE`, `fin = "unconfirmed"`, `https = "startupFailed"` | The previous head: a stop longer than the authority's wait still needed recovery |
| `cleanup-before-settled` (no await) | `NoRecoveryRequired` violated: `fin = "unconfirmed"`, `https = "authority"` | HACK-2707, the cleanup half |
| `acquire-after-cleanup` (no await) | `NoAcquisitionAfterCleanup` violated: `fin = "confirmed"`, `https = "pending"` | The same omission acknowledged a lifetime whose acquisition had not even recorded its intent |
| `long-holder` (`CmdHold = 3 > VerifyWait`) | `NoTeardownByBriefHolder` violated: `torn = TRUE`, `https = "refused"`, `lease = "cmd"` | The waits stay bounded: a holder that keeps the lease longer is still refused |
| `released-after-refusal` | `NeverReleasedAfterRefusal` violated: `fin = "confirmed"`, `https = "released"`, `refusedSeen = TRUE` | Reachability: a stop during warm-up ends with a refused acquire, a verified release and confirmed cleanup |

[State chart](warmup-window.svg) ([source](warmup-window.mmd)).

## Code and tests

- `src/backends/native-project-inspect.ts`: `withNativeProviderBusyWait`.
- `src/backends/native-https-owner-server.ts`: `verifyNativeHttpsLeaseGraph`,
  `verifyNativeHttpsOwnerIdle`, the owner's `stopping` signal.
- `packages/runtime-core/src/provider/lifecycle.rs`:
  `AUTHORITY_STARTUP_LEASE_WAIT`; `provider/hostname_authority/managed.rs`: the
  wait and its owner-pipe check.
- `src/backends/native-project-https.ts` and `native-https-owner.ts`: the child
  startup and connect budgets, the spawned owner's exit, and
  `retireUnadmittedNativeHttpsOwner` inside `recoverNativeHttpsLease`.
- `src/backends/native-project-start.ts`: `readyIngress` and `serveSettled`.
- `src/backends/native-project-down.ts`: `wait` follows a lease added during
  the stop.
- `packages/runtime-core/src/provider/graph/foreground/jobs.rs` and
  `graph/one_off/runtime.rs`: the waiting job admission.
- `tests/native-https-owner.test.ts` ("shared HTTPS graph verification and
  provider-lease contention"): acquire, release and idle reads wait out a
  briefly held lease; a lasting holder is refused with its own refusal; the
  owner's shutdown ends a wait; a refusal after acquisition is never retried.
  With the wait removed, four of them fail.
- `tests/native-project-start.test.ts`: a stop during a started return's HTTPS
  acquisition waits for it, then releases or recovers and only then
  acknowledges; fails without `readyIngress`.
- `tests/native-project-down.test.ts`: down follows the lease a started return
  adds during the stop; fails without the follow.
- `hostname_authority::managed` tests, on a real flock held by another thread:
  the production wait outlasts a holder longer than the ordinary 5 s, then
  reloads the pool as before; the owner check ends the wait in under 2 s; the
  pipe check treats end of file as the owner's exit, on an anonymous pipe and
  on a real named FIFO (`owner_fifo_end_of_file_is_the_owners_exit`, which fails
  with the old `poll` check on macOS); the startup wait ends at once when the
  owner FIFO's writer closes.
- `tests/native-https-owner.test.ts`: a startup that admitted nothing is retired
  by its lease recovery (release still verified, evidence kept, repeatable) and
  the next owner starts; an interrupted retirement is finished by the next
  recovery; one with unconfirmed child cleanup stays retained; a second
  connector waits for a 16 s owner startup as the spawner does; a connector
  whose owner configuration is gone or replaced refuses at once.
- `engine/command_lease_tests.rs`: the shared owner's leased reads
  (`publication::inspect_claims`, `graph::inspect_bridges`) refuse
  `provider_busy` at once, naming the holder, which is the only refusal the
  owner retries.

## Owner killed while serving (HACK-2720)

On a real VM a routed project was ready for three minutes, then its shared
HTTPS owner (`hack --internal-native-https-owner`) got `kill -9`. The run went
to `stopped-data-retained`, but the hostname authority
(`serve-managed-hostnames`) was still running 120 s later, both routes answered
403, `hack down` failed with "Shared native HTTPS ownership is unavailable or
unconfirmed", `up -d` then refused `E_RECOVERY_REQUIRED`, and a Caddy process
was left behind.

- **The authority never noticed.** Once serving, its loop
  (`hostname_authority.rs`, `serve_locked`) learned of its owner's exit only
  from `poll` on its stdin FIFO, and with no clients it waited with a `-1`
  timeout. On a named FIFO Darwin's `poll` reports nothing after the writer
  closes, the same defect the startup wait had (#1260, M1). It now reads the
  pipe once without blocking after every wake-up (`managed::owner_pipe_open`:
  0 is the owner's exit, `EAGAIN` a live owner) and never waits longer than
  1 s (`OWNER_CHECK_MS`), so it ends within about 2 s, on Linux as on macOS.
- **Nothing stopped Caddy.** Caddy is the owner's child and routes every
  request through the authority. The authority is now told Caddy's admin socket
  (`--caddy-admin-socket`) and, whenever serving ends, asks that Caddy to stop
  with its own graceful `POST /stop` (bounded, only through a private socket,
  never a signal) before it removes its socket and receipt, as the cooperative
  `stop-hostname-authority` does. Caddy's `grace_period 1s` bounds that stop
  with open connections (a dev server's websocket).
- **Recovery could only release through a live owner.** `recoverNativeHttpsLease`
  now retires an owner generation that ran and exited without its cleanup
  (`retireExitedNativeHttpsOwner`), under the owner admission lock and without
  signaling anything: the endpoint was published and its control socket is gone
  or refuses connections; no process runs that generation's exact owner
  invocation (checked again at the effect boundary); the pool still runs the
  owner's boot (an ended boot is the previous-boot archive's); and its children
  are gone (`retireExitedNativeHttpsChildren`). That waits 5 s for the
  authority and Caddy to exit on their own; an authority still serving after
  that (an older runtime, or a caller faster than its check) is stopped only
  through the cooperative, identity-checked `stop-hostname-authority`, and only
  when the dead owner's receipt (whose challenge socket refuses connections)
  names its exact socket, receipt hash and process; anything else, and a port
  still held, is refused with a next step. Then the receipt, the dead challenge
  socket and the empty owner lock are removed by their exact identities, and
  the owner root moves beside a retired-owner record
  (`released-leases/<generation>/exited-owner`). Each lease's release is still
  verified through the graph.

`ServingExit.tla` (same directory) models this: the ready owner, its authority
and Caddy, a kill, ticks of one second while the authority still serves, the
authority's notice, `hack down` at any time after the kill (also before the
authority noticed), and the next `up`. `PipeCheck = FALSE` is the old serving
loop, `StopsCaddy = FALSE` an authority that leaves Caddy running,
`RetireExited = FALSE` the old recovery.

| Config | Result | Shows |
| --- | --- | --- |
| `serving-exit` (all fixes) | 9 distinct states, no error; `ChildrenEnd` holds under weak fairness | The authority is gone within the 2 s deadline (`NoticedInTime`); a healthy owner's children never stop (`NoFalseExit`); a live owner is never retired (`NoLiveRetire`); a confirmed `down` leaves no child running (`DownLeavesNothing`); `down` confirms and the next `up` needs no recovery |
| `serving-exit-old` (`PipeCheck`, `StopsCaddy`, `RetireExited` all FALSE) | `NoticedInTime` violated: `authority = "serving"`, `owner = "killed"`, `since = 3` | The real-VM row: the authority serves on after its owner was killed |
| `serving-exit-caddy-left` (`StopsCaddy = FALSE`) | `DownConfirms` violated: `caddy = "running"`, `down = "refused"` | Without Caddy's stop, `down` cannot prove the children gone |
| `serving-exit-retained` (`RetireExited = FALSE`) | `NoRecoveryRequired` violated: `up = "recoveryRequired"`, `records = "held"`, `down = "refused"` | `down` failed and the next `up` refused `E_RECOVERY_REQUIRED` |
| `serving-exit-recovered` | `NeverStartedAfterKill` violated: `up = "started"`, `records = "retired"` | Reachability: a killed owner is recovered and the next `up` starts |

[State chart](serving-exit.svg) ([source](serving-exit.mmd)).

Tests:

- `hostname_authority::managed::tests::serving_authority_exits_soon_after_its_owner_fifo_closes`:
  the real serving loop on a real named FIFO with no clients keeps serving
  1.5 s while the writer is open, then ends under 2 s after it closes, sends
  `POST /stop` to a stand-in admin socket and removes its socket and receipt. It
  fails on macOS with the old loop (timed out, still serving).
  `caddy_is_stopped_only_through_a_private_admin_socket`: a socket in a
  directory others can enter gets nothing.
- `tests/native-https-owner.test.ts` ("a shared owner that exited while
  serving"): the real owner process is killed with `SIGKILL`; the production
  owner-invocation check sees it alive and then gone; the lease recovery
  retires it (evidence kept, release verified, repeatable) and the next owner
  starts. A still-running invocation, an ended pool boot, children not proven
  gone, or a live owner leave every record and refuse as before.
- `tests/native-project-https.test.ts`: the authority gets the admin socket and
  Caddy `grace_period 1s`; an exited owner's records are retired once its
  authority exits on its own; an orphaned authority is stopped only through the
  cooperative stop, with its exact socket and hash; a dead authority is
  recovered by its hash; an authority the receipt does not name, a held port,
  and a receipt whose owner still answers are refused with every record kept.

Not modelled or tested: the real Caddy and runtime binaries, the 5 s wait
against a slow machine, and a Caddy whose authority was killed too (recovery
refuses with a next step: the user stops it). Only the real-VM rows prove the
end-to-end outcome.

## Not modelled

- Several connectors sharing one owner (#1260 review, M2). The model has one
  acquisition; the fix is a budget (every connector waits the whole startup),
  checked by the two-connector test rather than by states.
- The repeating restart tick and several holders sharing one 15 s deadline. The
  model has one brief holder. Its time abstraction lets a holder always take the
  lease before a waiter, so a holder that returns again and again would exhaust
  any bound, which the real tick (a few milliseconds once a second against a
  50 ms poll) does not. The real reads still share one 15 s deadline, so many
  back-to-back holders can exhaust it, and the refusal then names the last one.

Also not modelled: lock fairness between waiters, the
route checks after admission, Caddy, the shared owner serving several runs, OS
scheduling, and the VM. The compose one-off path has no dedicated test: building
a `HostRelayRuntime` and a `Managed` value needs the launcher input path. Only
the real-VM rows prove the end-to-end outcome.
