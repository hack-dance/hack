# Shared host helper lifecycle contract

A shared host helper is a long-lived local process that several branches or clients
use through one fixed loopback port: an issuer bridge, a local API proxy, a database
port-forward or an opt-in tunnel. This contract defines how Hack starts, adopts,
reuses and releases such a helper without killing a process it does not own.

Source: [`src/lib/shared-host-lifecycle.ts`](../../src/lib/shared-host-lifecycle.ts).
Fixtures: [`tests/shared-host-lifecycle.test.ts`](../../tests/shared-host-lifecycle.test.ts).

Status: this is a library contract with portable process fixtures. No configuration
key or CLI command uses it yet. Consumers (WU18 shared helpers, bounded external
claims and opt-in tunnels) adopt it in their own changes. The existing
`lifecycle.singleton` port check in [Lifecycle & startup](../lifecycle.md) is
unchanged. It adopts any listener on the configured ports; this contract adopts
only a listener that proves its identity.

## States

| Axis | Values | Meaning |
| --- | --- | --- |
| Ownership | `owned` | Hack started the helper and holds an exact process claim. |
| | `adopted` | Someone else started it; its identity endpoint matched. Hack never signals it. |
| | `disabled` | The helper is off. Hack takes no lock, writes no claim and starts no child. |
| Phase | `starting` | Owned child spawned and claimed; readiness not yet proven. |
| | `ready` | The identity endpoint answered for the expected helper and upstream. |
| | `failed` | One closed failure reason (below). Terminal for this call. |

A disabled public tunnel is the `disabled` case: it never spawns a child.

## Identity and readiness

The helper serves a JSON identity endpoint on `127.0.0.1:<port><identityPath>`:

```json
{ "helper": "issuer-bridge", "upstream": "https://issuer.branch-a.test", "pid": 4242 }
```

- `helper` must equal the expected helper kind. Otherwise the listener is foreign.
- `upstream` must equal the upstream this branch requires. Callers derive it per
  branch. A shared helper serving another upstream is refused, never retargeted.
- `pid` is optional. When present for an owned helper, it must equal the claimed PID.
  A different process answering for the port is foreign.

Readiness is this identity answer. A live process, an open port or a sleeping
placeholder is never readiness. Each probe has its own timeout and reads at most
4 KiB; a larger answer is not an identity.

## Persisted claim

The claim is `<stateDir>/<name>.claim.json`, owner-only (0600), at most 8 KiB,
replaced atomically, and parsed strictly (exact keys, version 1):

```json
{"version":1,"helper":"issuer-bridge","port":4100,"ownership":"owned","phase":"ready","pid":4242,"birth":"Mon Oct 19 10:00:00 2026","holders":["branch-a","branch-b"]}
{"version":1,"helper":"issuer-bridge","port":4100,"ownership":"adopted","holders":["branch-a"]}
```

- Ownership is the pair `pid` + `birth`. `birth` is the process start time from
  `ps lstart`, always read with `TZ=UTC0` and `LC_ALL=C`. `ps` prints `lstart` in
  local time, so without a fixed zone two clients with different `TZ` values, or a
  host whose zone changes, would see different births for the same live process.
- The claim is live only when the census shows that exact pair. A missing PID, or
  the same PID with a different birth time (PID reuse), makes the claim stale. A
  stale claim grants nothing. Hack discards it and never signals that PID.
- One exception: if a stale owned claim's PID still answers the identity endpoint
  as the expected helper, ownership is uncertain. Hack keeps the claim and fails
  with `claim-invalid`. It neither adopts the helper (which would drop the owned
  record and leak the helper on the last release) nor signals it.
- `holders` names the branches or clients that use the helper. Holders carry over
  when a stale owned helper is restarted.
- A malformed, oversized, unreadable, symlinked or group/world-accessible claim, or
  one for a different port, fails closed with `claim-invalid`. Hack does not start,
  adopt or stop anything until an operator inspects it.
- A census that did not observe the calling process (for example `ps` failed) fails
  closed with `census-unavailable`. An empty census never reads as "every claimed
  process is gone".

## Start (`ensureSharedHostHelper`)

1. `enabled: false` returns `disabled` immediately.
2. Take the helper's exclusive lock (`<stateDir>/<name>.lock`, the projects-registry
   lock protocol: hard-link publication, dead-owner reclamation by `ESRCH` only).
   Competing starters wait in turn (`lock-waiting`, then `lock-acquired`). One
   deadline bounds the lock wait, the port probe, the spawn and readiness.
3. A live owned claim is reused. The starter waits for readiness and adds its holder.
   It does not spawn a second helper.
   - A `ready` helper may serve other holders, so if readiness fails the starter
     leaves it running and returns the failure.
   - A `starting` claim seen under the lock has lost its starter, because a starter
     holds the lock until its helper is ready or stopped. If that helper still
     cannot become ready (`deadline`, `child-exited`, `foreign-listener`,
     `wrong-upstream`), the starter stops it through its birth-verified tree and
     removes the claim. `cancelled` and `census-unavailable` leave it recorded.
4. Otherwise, if the deadline has already passed, return `deadline`. Then probe the
   port:
   - identity matches: write an `adopted` claim and return `ready/adopted`;
   - wrong upstream: `wrong-upstream`; another helper, a non-identity answer or a
     listener that stays silent for the full probe timeout: `foreign-listener`.
     Either way the listener keeps running and no child is spawned;
   - a probe whose timeout was shortened by the deadline and then timed out proves
     nothing about the listener: `deadline`;
   - connection failed (refused, reset or unreachable): confirm with a loopback
     bind probe. An occupied port is `foreign-listener`; a free port is spawned.
     The refused-connection error code differs by platform, so the error itself
     never proves absence.
5. Spawn through an exec gate in a new session:
   `/bin/sh -c 'IFS= read -r hack_gate || exit 0; [ "$hack_gate" = open ] || exit 0; exec "$@" </dev/null'`.
   The gate blocks on stdin. Hack reads the gate's PID and birth time, writes the
   `starting` claim durably, checks for cancellation, then writes `open`. `exec`
   keeps the claimed PID and birth time. If the starter dies or cancels before
   `open`, the gate reads EOF and exits, so no spawned helper is ever left running
   without a claim.
6. Probe readiness with exponential backoff (`initialMs` doubling to `maxMs`).
   Every attempt first confirms that the claimed process is still live
   (`child-exited` otherwise). Cancellation (an `AbortSignal`) interrupts the probe
   and the backoff sleep.
7. On readiness, mark the claim `ready` and return `ready/owned`. On any failure of
   a freshly spawned child (`deadline`, `cancelled`, `child-exited`, foreign
   answer), stop its birth-verified process tree and remove its claim. If the stop
   cannot be confirmed, keep the claim so the process stays recorded.

The child receives only the environment the caller passes. Hack never inherits the
runner environment, and the argv is executed directly, not as a shell string.

The optional observer is awaited for each progress event. If it throws, Hack cleans
up and rethrows that error unchanged: a gate that has not opened is closed and its
claim removed, and a helper started by this call is stopped. A holder recorded
before the error stays recorded until it is released. Other errors raised while the
lock is held are reported as `claim-invalid` (a refused claim path) or
`state-unavailable`, never as `lock-unavailable`.

## Release (`releaseSharedHostHelper`)

Under the same lock, remove the holder:

| Remaining holders / claim | Result | Effect |
| --- | --- | --- |
| others remain | `retained` | Claim rewritten; helper untouched. A holder that was not recorded changes nothing. |
| none, adopted | `released-adopted` | Claim removed; the adopted process is never signalled. |
| none, owned, live | `stopped` | TERM, bounded grace, then KILL for the captured tree; each signal re-checks the birth time. |
| none, owned, stale | `stale-cleared` | Claim removed; nothing is signalled. |
| none, owned, stop unproven | `stop-unconfirmed` | Claim kept with no holders. |

A release that cannot take the lock within its timeout returns `lock-unavailable`
and changes nothing.

Hack never kills by port number, process name or pattern (`pkill`, `lsof -t | xargs
kill`). It only signals processes in the captured tree of a birth-verified claim.

## Lost parent

| Starter dies | Outcome |
| --- | --- |
| before the claim is written | The gate reads EOF and exits; no claim, no process. |
| after the claim, before `open` | The gate exits; the claim is stale and the next starter discards it. |
| after `open`, before readiness | The claim stays `starting`. The next starter reuses it if it becomes ready. If it never does, the next starter stops it and removes the claim, and a later start spawns a fresh helper. |
| after readiness | The helper is running and recorded. The next starter reuses it (`claim-reused`). The last holder's release stops it. |

A holder whose client died stays recorded until it is released. This keeps the
helper running (safe), rather than stopping it under another branch.

## Closed diagnostics

Every failure is one of these reasons with a fixed message. Messages never include
paths, argv, environment values, upstream URLs or response bodies.

`foreign-listener`, `wrong-upstream`, `claim-invalid`, `state-unavailable`,
`census-unavailable`, `lock-unavailable`, `port-probe-failed`, `spawn-failed`,
`child-exited`, `deadline`, `cancelled`.

Progress events are also closed: `lock-waiting`, `lock-acquired`, `claim-stale`,
`claim-reused`, `adopted`, `spawned`, `claimed`, `gate-opened`, `probe-retry`,
`ready`, `stopped-after-failure`.

## Fixture receipts

`bun test tests/shared-host-lifecycle.test.ts` runs portable local fixtures. Each
fixture is a Bun process on a loopback port with a private HOME. No Docker, real
HOME, keychain or privileged effect is involved. The file runs in the hosted macOS
`test` job and is registered in the hosted Linux `linux-process-lifetime` job. A
Linux pass is a receipt only once that hosted job has run it.

| Scenario | Asserted behavior |
| --- | --- |
| disabled helper | No lock, claim or child. |
| owned start | Claimed before the gate opens; the endpoint serves the branch upstream; the last release stops it. |
| healthy shared helper | Adopted; endpoint served; release never signals it. |
| wrong upstream | Refused, no spawn, no claim; the listener survives. The result contains no upstream value. |
| foreign listener | A silent TCP owner, a TCP owner that drops every connection, a different helper and an identity answer over 4 KiB are refused and survive. |
| concurrent starters | The first starter holds the lock while the second is shown waiting without acquiring it; then one spawn, both holders recorded, a sibling branch with another upstream refused, the first release retains and the last release stops. |
| different time zones | Clients with `TZ=UTC0` and `TZ=HST10` agree on the birth; the second reuses the owned helper, which stays owned and is stopped by the last release. |
| stale PID / reuse | A claim naming a live PID with a different birth time is cleared on release and discarded on start; that process survives. |
| stale PID still answering | A stale claim whose PID answers as the helper is kept (`claim-invalid`), not adopted; the process survives. |
| child restart | A crashed owned helper is replaced under a fresh claim; holders carry over. |
| child exits during start | `child-exited`; the claim is removed. |
| cancel before the gate | Abort after the claim: `cancelled`, the gate never opens, the gate exits, no claim, nothing served. |
| cancel during retry | Abort after three retries: `cancelled`, the owned placeholder is stopped, the claim is removed, and a bystander survives. |
| cancel during backoff | With a 5 s backoff, an abort returns within 2.5 s. |
| placeholder is not readiness | A live non-listening child hits `deadline` within its bound and is stopped. |
| deadline spent in the lock wait | `deadline`, not `foreign-listener`; a healthy matching helper is not adopted and survives. |
| probe cut by the deadline | A silent listener gives `deadline` when the deadline shortened the probe, and `foreign-listener` after a full-length probe. |
| lost parent before gate | The starter is killed after claiming; the gate exits; the next starter sees `claim-stale`. |
| lost parent after gate, never ready | The next starter returns `deadline`, stops the abandoned helper and removes the claim; a later start spawns fresh. |
| lost parent after ready | The helper stays claimed; another client reuses it; the release by both holders stops it. |
| owned descendants | Release stops the helper and its grandchild; a bystander survives. |
| SIGTERM ignored | Release escalates to SIGKILL after the grace period: `stopped`. |
| stop unconfirmed | A helper that stays in the census after KILL (a zombie under a frozen parent) gives `stop-unconfirmed` and keeps the claim. |
| session and environment | The helper leads its own process group and does not see a runner-only variable. |
| impostor identity | A live `ready` claim whose port is answered by another PID fails `foreign-listener`; neither process is signalled. |
| invalid claim / no census | Malformed, other-port, group-readable and oversized claims, and an unavailable census, fail closed; nothing is spawned or signalled; the claim is kept. |
| release lock | A release while the lock is held times out with `lock-unavailable`; the claim and helper are unchanged. |
| observer error | The observer's error is rethrown; the waiting gate exits and no claim remains. |

The pull request records the source mutations used as negative controls and which
test each one fails. Each test above that guards a single check was confirmed to
fail when that check is removed.

## Not covered here

- Public tunnel readiness against the intended external application route, with
  the trust that route needs. That probe is host- and provider-bound and belongs to
  the consumer (WU18-P06).
- Branch-specific URL derivation. Callers derive the expected upstream per branch;
  the helper endpoint this library returns is always `http://127.0.0.1:<port>`.
- PID reuse within one `lstart` second. Birth times have one-second resolution, the
  same assumption as the existing lifecycle process-tree helpers.
- Linux `lstart` drift. Linux `ps` computes `lstart` from the boot time, which can
  move when the wall clock is changed, so a live helper's birth can change. Start
  then fails closed if the helper reports its PID in the identity answer, but a
  release would read the claim as stale and clear it without stopping the helper.
  macOS records the start time directly and is not affected.
- Wiring into `hack.config.json`, `hack up`/`down` or the daemon, and migrating
  existing `lifecycle.singleton` configurations.
- Native (macOS VM) and container-runtime effects. These fixtures qualify the
  process and claim protocol only.
