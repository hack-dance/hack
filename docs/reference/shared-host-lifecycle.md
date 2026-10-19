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
placeholder is never readiness. Each probe has its own timeout and reads at most 4 KiB.

## Persisted claim

The claim is `<stateDir>/<name>.claim.json`, owner-only (0600), replaced atomically,
and parsed strictly (exact keys, version 1):

```json
{"version":1,"helper":"issuer-bridge","port":4100,"ownership":"owned","phase":"ready","pid":4242,"birth":"Mon Oct 19 10:00:00 2026","holders":["branch-a","branch-b"]}
{"version":1,"helper":"issuer-bridge","port":4100,"ownership":"adopted","holders":["branch-a"]}
```

- Ownership is the pair `pid` + `birth` (process start time from `ps lstart`). The
  claim is live only when the census shows that exact pair. A missing PID, or the
  same PID with a different birth time (PID reuse), makes the claim stale. A stale
  claim grants nothing. Hack discards it and never signals that PID.
- `holders` names the branches or clients that use the helper. Holders carry over
  when a stale owned helper is restarted.
- A malformed, unreadable, symlinked or group/world-accessible claim, or one for a
  different port, fails closed with `claim-invalid`. Hack does not start, adopt or
  stop anything until an operator inspects it.
- A census that did not observe the calling process (for example `ps` failed) fails
  closed with `census-unavailable`. An empty census never reads as "every claimed
  process is gone".

## Start (`ensureSharedHostHelper`)

1. `enabled: false` returns `disabled` immediately.
2. Take the helper's exclusive lock (`<stateDir>/<name>.lock`, the projects-registry
   lock protocol: hard-link publication, dead-owner reclamation by `ESRCH` only).
   Competing starters wait in turn, bounded by the deadline.
3. A live owned claim is reused. The starter waits for readiness and adds its holder.
   It does not spawn a second helper. If readiness fails, it leaves the helper for
   the other holders.
4. Otherwise probe the port:
   - identity matches: write an `adopted` claim and return `ready/adopted`;
   - wrong upstream: `wrong-upstream`; another helper, a silent or non-identity
     listener: `foreign-listener`. Either way the listener keeps running and no
     child is spawned;
   - connection refused: confirm with a loopback bind probe, then spawn.
5. Spawn through an exec gate in a new session:
   `/bin/sh -c 'IFS= read -r hack_gate || exit 0; [ "$hack_gate" = open ] || exit 0; exec "$@" </dev/null'`.
   The gate blocks on stdin. Hack reads the gate's PID and birth time, writes the
   `starting` claim durably, then writes `open`. `exec` keeps the claimed PID and
   birth time. If the starter dies before `open`, the gate reads EOF and exits, so
   no spawned helper is ever left running without a claim.
6. Probe readiness with exponential backoff (`initialMs` doubling to `maxMs`).
   Every attempt first confirms that the claimed process is still live. One deadline
   bounds the lock wait, spawn and readiness. Cancellation (an `AbortSignal`)
   interrupts the probe and the backoff sleep.
7. On readiness, mark the claim `ready` and return `ready/owned`. On any failure of
   a freshly spawned child (`deadline`, `cancelled`, `child-exited`, foreign
   answer), stop its birth-verified process tree and remove its claim. If the stop
   cannot be confirmed, keep the claim so the process stays recorded.

The child receives only the environment the caller passes. Hack never inherits the
runner environment, and the argv is executed directly, not as a shell string.

## Release (`releaseSharedHostHelper`)

Under the same lock, remove the holder:

| Remaining holders / claim | Result | Effect |
| --- | --- | --- |
| others remain | `retained` | Claim rewritten; helper untouched. |
| none, adopted | `released-adopted` | Claim removed; the adopted process is never signalled. |
| none, owned, live | `stopped` | TERM, bounded grace, then KILL for the captured tree; each signal re-checks the birth time. |
| none, owned, stale | `stale-cleared` | Claim removed; nothing is signalled. |
| none, owned, stop unproven | `stop-unconfirmed` | Claim kept with no holders. |

Hack never kills by port number, process name or pattern (`pkill`, `lsof -t | xargs
kill`). It only signals processes in the captured tree of a birth-verified claim.

## Lost parent

| Starter dies | Outcome |
| --- | --- |
| before the claim is written | The gate reads EOF and exits; no claim, no process. |
| after the claim, before `open` | The gate exits; the claim is stale and the next starter discards it. |
| after `open` | The helper is running and recorded. The next starter reuses it (`claim-reused`). The last holder's release stops it. |

A holder whose client died stays recorded until it is released. This keeps the
helper running (safe), rather than stopping it under another branch.

## Closed diagnostics

Every failure is one of these reasons with a fixed message. Messages never include
paths, argv, environment values, upstream URLs or response bodies.

`foreign-listener`, `wrong-upstream`, `claim-invalid`, `census-unavailable`,
`lock-unavailable`, `port-probe-failed`, `spawn-failed`, `child-exited`,
`deadline`, `cancelled`.

Progress events are also closed: `lock-acquired`, `claim-stale`, `claim-reused`,
`adopted`, `spawned`, `claimed`, `gate-opened`, `probe-retry`, `ready`,
`stopped-after-failure`.

## Fixture receipts

`bun test tests/shared-host-lifecycle.test.ts` runs portable local fixtures. Each
fixture is a Bun process on a loopback port with a private HOME. No Docker, real
HOME, keychain or privileged effect is involved. The fixtures run on macOS and in
the Linux toolchain service (which ships `procps`).

| Scenario | Asserted behavior |
| --- | --- |
| disabled helper | No lock, claim or child. |
| owned start | Claimed before the gate opens; the endpoint serves the branch upstream; the last release stops it. |
| healthy shared helper | Adopted; endpoint served; release never signals it. |
| wrong upstream | Refused, no spawn, no claim; the listener survives. The result contains no upstream value. |
| foreign listener | A silent TCP owner and a different helper are refused and survive. |
| concurrent starters | Two independent client processes produce one spawn; both holders are recorded; a sibling branch with another upstream is refused; the first release retains and the last release stops. |
| stale PID / reuse | A claim naming a live PID with a different birth time is cleared on release and discarded on start; that process survives. |
| child restart | A crashed owned helper is replaced under a fresh claim; holders carry over. |
| cancel during retry | Abort after three retries: `cancelled`, the owned placeholder is stopped, the claim is removed, and a bystander survives. |
| placeholder is not readiness | A live non-listening child hits `deadline` within its bound and is stopped. |
| lost parent before gate | The starter is killed after claiming; the gate exits; the next starter sees `claim-stale`. |
| lost parent after ready | The helper stays claimed; another client reuses it; the release by both holders stops it. |
| owned descendants | Release stops the helper and its grandchild; a bystander survives. |
| impostor identity | A live owned claim whose port is answered by another PID fails `foreign-listener`; neither process is signalled. |
| invalid claim / no census | Start and release fail closed; nothing is spawned or signalled; the claim is kept. |

Each scenario was proven with a source mutation that fails it: pid-only identity,
adopting unidentified listeners, ignoring the upstream, removing the lock, opening the
gate before the claim, treating liveness as readiness, ignoring holders on release,
keeping a failed child, stopping only the tree root, trusting an empty census,
ignoring `enabled`, ignoring an invalid claim, and accepting another PID's identity.

## Not covered here

- Public tunnel readiness against the intended external application route, with
  the trust that route needs. That probe is host- and provider-bound and belongs to
  the consumer (WU18-P06).
- PID reuse within one `lstart` second. Birth times have one-second resolution, the
  same assumption as the existing lifecycle process-tree helpers.
- Wiring into `hack.config.json`, `hack up`/`down` or the daemon, and migrating
  existing `lifecycle.singleton` configurations.
- Native (macOS VM) and container-runtime effects. These fixtures qualify the
  process and claim protocol only.
