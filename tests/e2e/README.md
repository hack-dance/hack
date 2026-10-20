# hack CLI end-to-end harness

Drives the ACTUAL working-tree CLI (`bun <repoRoot>/index.ts <args>`, non-TTY
by design) against a disposable turborepo-style Bun monorepo, so changes to
init/env/worktrees/lifecycle/doctor are verified against real behavior — not
just unit tests.

## Running

```sh
bun run test:e2e:local              # tier 1 (no docker required)
bun run test:e2e:local:docker       # tier 1 + tier 2 (docker + real global infra)

bun tests/e2e/run.ts --list         # list scenarios
bun tests/e2e/run.ts --only=init    # run a subset by name
bun tests/e2e/run.ts --shard=2/4    # run one deterministic CI shard of the default set
HACK_E2E_KEEP=1 bun tests/e2e/run.ts --only=doctor   # keep temp dirs for debugging
HACK_E2E_REQUIRE_TMUX=1 bun tests/e2e/run.ts --only=lifecycle-session-recovery
```

Exit codes: `0` all pass/skip, `1` any scenario failed, `2` isolation canary
failed (nothing ran).

## CI tiering

Only the `test` job (typecheck, lint, unit tests, build) is a required status
check on `next` and `main`. `docker-e2e`, `Config compiler`, `Candidate core`,
`Runtime state models`, `secret-scan`, `runtime-images` and
`linux-process-lifetime` run on every push and pull request but are optional
checks: a red result is a signal to triage, not a merge block. "Registered in
Docker CI" below therefore means the optional `docker-e2e` job. Every job has a
`timeout-minutes` budget so a hung engine or runner cannot hold a slot open.

`docker-e2e` is a fan-in job. The scenarios run on four parallel
`docker-e2e shard i/4` runners, each with `bun tests/e2e/run.ts --shard=i/4`.
`tests/e2e/shard.ts` splits the default scenario set deterministically: it puts
each scenario in the lightest shard, longest first, using the checked-in
duration hints. Every scenario runs in exactly one shard, and
`tests/e2e-shard.test.ts` proves that for the current list. The long native
scenarios (`native-config-networks`, `-compose`, `-routing`) each get their own
shard, so the slowest single scenario sets the wall time. `docker-e2e` always
runs and passes only when every shard succeeded. The prerelease exact-head gate
also requires each shard job by name. To reproduce one CI shard locally, run
`bun tests/e2e/run.ts --list --shard=i/4`, then rerun its names with `--only`.
`--shard` and `--only` cannot be combined.

When a shard fails, the process-policy scenario keeps its fixture roots and
writes its fixed-field capsule and startup diagnostic under `HACK_E2E_CAPSULE_DIR`
(`$RUNNER_TEMP/process-policy-capsules` in CI). The shard uploads that directory
as the `process-policy-capsules-shard-<i>` artifact. Those files hold counts,
enums and booleans only.


## Compiler fixture prerequisite

Suites that drive the actual config compiler need a built sidecar before they
run. `bun run test` runs `test:preflight` first, which checks an explicit
absolute `HACK_CONFIG_COMPILER_BINARY` or the checkout's
`dist/hack-config-compiler` and stops before the suite with a fixed setup
message. Prepare a checkout with `bun run build:config-compiler` (the hosted
test job already does this). When a compiler-dependent suite is run directly
with `bun test`, `tests/helpers/test-config-compiler.ts` applies the same
selection once per file: an absent or non-executable fixture fails that file
immediately with the same setup text, never a silent pass or one opaque
`E_COMPILER_MISSING` refusal per case. Current users are
`native-authored-command-dispatch`, `native-compose-file-owner` and
`native-compose-file-sources`; add the helper when a new suite depends on the
real compiler.

The `native-compose-adoption-dependency-worktrees` Docker selector uses a closed
forwarder for original-ID effects and fixed metadata/config-hash reads. First
preparation hashes its saved Compose copy before publishing `receipt.prepared`.
That one read requires a previously absent store, one canonical private staged
generation, an empty receipt and exact captured original bytes. Later saved reads
use the current prepared/publication receipt. The temporal regression evaluates
each emitted query at its actual receipt state; a final receipt cannot authorize
an earlier query retroactively. Missing interruption controls report fixed stage,
exit and control flags without printing command output or authored values.

The `native-compose-adoption-job-worktrees` Docker selector uses the current
compiled CLI and matching compiler with cached `postgres:17.6-alpine`. The static
default-bridge fixture has no published ports and never pulls. Two linked
worktrees retain their original container/network IDs and volume creation identity
through ordered adoption, down/up, restart and rollback. An explicitly declared
job must have a fresh exact-ID start and exit zero before its dependent starts.
SQL keeps the original seed separate from attempt, successful-attempt and dependent
counters; the dependent must read the current successful attempt. Exit 17 and
interrupted startup must preserve pending state without starting the dependent.
Saved stop recovery never replays the job. Cleanup refuses unknown ownership and
retains both roots if child settlement or exact retirement cannot be confirmed.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=native-compose-adoption-job-worktrees
```

This is a maintained acceptance gate, not a recorded live pass. It does not qualify
generated/managed/typed-local input, profiles, custom networks, routes, files or
builds with jobs. Fresh observed job completion plus dependent SQL readback does
not guarantee exactly-once business effects or atomic exclusion of external Docker
writers. Cancellation checks captured host child/pipe settlement; uncertain
callbacks prevent teardown rather than being treated as canceled work.
Ordinary fixture effects and CLI calls use that same bounded child owner and
write private PID/PGID plus exit, stdout/stderr EOF and fresh absence receipts.
These files are observations only: an uncancellable receipt write can finish late.
Cleanup still requires the capture's successful return and its live settlement
gate; a failed or uncertain capture permanently withholds teardown authority,
even if a later file records exit zero and absence.
Group absence refers to the captured host child's group; it does not establish
guest Docker worker completion or recursively inventory unrelated child groups.

Retained ordered-command failures may include a fixed `legacy_adoption_refusal`
stage/reason in the JSON error detail. Observer categories distinguish malformed
shape, timestamp, restart policy and membership. Probe reasons separately identify
operation admission/discovery/spawn, nonzero child exit, timeout, cancellation,
I/O budget, capture failure, UTF-8 decoding, JSON parsing, non-object row and unknown
failure. The legacy `probe` reason remains accepted for historical diagnostic
compatibility; newly observed unknown errors use `probe-unknown`. These classifications
come from the probe owner's weak association and fixed parse boundaries, never
arbitrary error properties. Scheduler
categories distinguish selection, deadline, attempts, job failure, readiness and
completion authority. They never include daemon output, resource IDs, SQL or env
values. Unknown ownership errors retain their existing fixed generic refusal.
The earlier `ordered-observation/probe` live failure does not establish which of
these newly distinguished seams failed; it remains preserved as unresolved evidence.
The disabled job restart codec accepts both `no` and the empty daemon spelling,
with zero retries still required. This is an independent compatibility correction,
not an established explanation for the earlier live startup refusal. Compose
[v5.1.2's default policy](https://github.com/docker/compose/blob/v5.1.2/pkg/compose/create.go#L551-L575)
and its pinned Moby API
[v1.54.1 disabled-policy contract](https://github.com/moby/moby/blob/api/v1.54.1/api/types/container/hostconfig.go#L267-L270)
define those two spellings.

## VM-native protected files

The explicitly selected `native-config-vm-files` scenario exercises ordinary new
containers with protected VM-native material; it does not adopt existing binds.
It uses only cached `oven/bun:1.4.2-slim`, two linked worktrees, no published ports
and no image build or pull. Application-side checks independently require exact
0400/default-root and 0600/explicit-numeric owner identity, actual owner reads,
distinct-UID `EACCES`, privileged write-open `EROFS`, exact single-file mounts and
absence from an ungranted service. Restart, saved stop with unavailable authored
material, recreation and sibling isolation retain their own assertions.

The shipping saved-stop owner retires the exact observer and singleton volume;
the fixture adds no raw removal authority. Every CLI/guest command reuses the
bounded completed-job child/EOF/absence owner. An uncertain child or failed
whole-owner observation permanently withholds teardown. The 16 MiB
successful-result threshold is not a strict disk quota: the last refused command
can already have its bounded private capture.
Full original IDs, stopped states, volume births, image IDs/tags and daemon must
match after cleanup. Unknown VM material can remain retained and fails this gate.
This maintained source is not a recorded provider pass or retained-adoption
permission qualification.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_CONFIG_COMPILER_BINARY=./dist/hack-config-compiler HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=native-config-vm-files
```

## Command-path cache regressions

`bun test tests/e2e/run-dependency-cache.test.ts` runs the real source CLI in
isolated child homes against a recording Docker stub. It covers linked-worktree
cache selection, changed fingerprints, dependency-skip decisions and container
inspection failures. It runs in the normal Bun suite without a Docker daemon;
its passing result proves command assembly and decisions, not mounted data.
The separate live cache qualification (local `_docs/docs/plans/v5/run-cache-parity-20260916.md`)
records compiled-CLI volume readback and cleanup against an isolated engine.

The `dependency-cache`, `dependency-cache-protocol`, and
`dependency-cache-package` Docker scenarios use standalone, network-disabled
containers and exact ownership labels for cleanup. Prepare `alpine:3.20`,
`alpine:3.22`, and `node:24.11.0-bookworm-slim` locally first; CI pulls these before
the scenarios. Tests resolve installed repository digests and refuse missing
prerequisites rather than downloading during qualification. The package scenario
packs a local npm package and installs its real lockfile offline; it does not test
registry access, private credentials, or Bun installation.

```sh
HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 HACK_E2E_CLI_BIN=./dist/hack bun tests/e2e/run.ts --only=dependency-cache,dependency-cache-protocol,dependency-cache-package
```

Image invalidation checks use distinct installed digests. On ARM64, platform
invalidation changes `linux/arm64` to `linux/arm64/v8`; this verifies declared
platform identity, not cross-architecture package compatibility.

## Portable multi-service qualification

`portable-multiservice` exercises a Bun HTTP app and PostgreSQL through the selected
Hack CLI in slim mode. It needs Docker with Compose and locally cached
`oven/bun:1.4.2-slim` and `postgres:17.6-alpine`; image tags are resolved to immutable
IDs before startup, and the scenario never pulls. Missing prerequisites fail.
It uses a private internal Compose network, no published ports or `hack-dev`, and
explicitly disables Hack internal DNS/TLS. No credentials or global setup are needed.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=portable-multiservice
```

The scenario requires an empty initial database, writes and reads a marker through
HTTP using `hack exec` and `hack run`, checks an independent SQL read and bounded
Compose logs, then verifies that `hack down`/`hack up` creates new containers with
the same database volume and marker. Cleanup checks exact ownership and resource
absence; an adjacent owned canary proves unrelated containers, networks and volume
data survive that cleanup. The canary is then removed separately. PostgreSQL uses
fixture-only trust on this unexposed network. This qualifies the actual execution
host, not Codex Cloud capabilities, browser access or native VM support elsewhere.

## Pattern fixture qualification

`pattern-p01-dependency-bootstrap` (HACK-1145), `pattern-p02-portable-toolchain`
(HACK-1146) and `pattern-p07-capability-overlays` (HACK-1151) start copies of the
checked-in `examples/patterns/` fixtures against a real engine. Each catalogue card
names its scenario in `e2eScenario`, and `tests/pattern-examples.test.ts` fails when
that scenario is not registered here as Docker-tier with a duration hint.
`tests/e2e/scenarios/pattern-fixture.ts` makes the copy. It changes only the
project name, the image (the cached `oven/bun:1.4.2-slim` repository digest with
`pull_policy: never` instead of the pinned Alpine image), a declared platform
(the daemon's architecture) and exact owner labels. Commands, mounts, dependency
labels, gates and health checks stay as the fixture authored them.

- P01 runs a cold and a warm `hack up --json`, a linked worktree, a `bun.lock`
  change and an installer killed mid-run under a fresh generation. Every running
  consumer must read a complete payload with a ready marker and never mount the
  killed attempt's volume. That volume must stay populated but unready, a retry
  of the same generation must be refused, and a generation bump must recover.
- P02 runs the README's `hack run --profile toolchain` commands from the primary
  checkout and a linked worktree, whose `/app/.git` is a pointer to an unmounted
  `gitdir`. A failing check must exit non-zero, `sh -c "exit 7"` must return 7, and
  a pipe filter must show how filtered output hides the failure. Ordinary
  `hack down` must keep both instances' cache volumes.
- P07 runs the laptop overlay in the primary checkout and the runner overlay in a
  linked worktree. `hack env explain` must name each source file, including an
  inherited primary-local override, without printing a value. Container metadata
  must carry each overlay's keys, both APIs must reach `upstream`, `hack exec`
  with the other overlay must be refused, and no browser opener on `PATH` or in
  `BROWSER` may run.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=pattern-p01-dependency-bootstrap,pattern-p02-portable-toolchain,pattern-p07-capability-overlays
```

These are maintained gates for the hosted Linux runner, not recorded passes on
other hosts. They do not qualify the pinned Alpine image, registry access,
credential-dependent installers, cross-worktree toolchain cache reuse or a
headless machine identity.

## Compose config-hash drift (F03)

`compose-config-hash-drift` (HACK-1124) checks that `hack run` and `hack exec`
leave running containers alone after a dependency's Compose config changes.
It uses cached `alpine:3.20` with `pull_policy: never`, a private internal
network, no published ports, and Hack internal DNS/TLS turned off. `app`
depends on `dep`. After `hack up --detach`, the scenario changes only `dep`'s
environment, so only `dep`'s config hash drifts. It then runs `hack run app`,
`hack run dep`, `hack exec app` and `hack exec dep`. After each command, both
services must keep the same full container ID, `State.StartedAt`,
`RestartCount` and config-hash label, and no one-off container may remain.

`hack run` has no user `--no-deps` flag. The legacy Compose path adds
`--no-deps` when the target service is already running, and `hack exec` maps
to `docker compose exec`, which never converges services. Two positive
controls keep the check from passing vacuously. The `hack run dep` one-off
must print the drifted value while the running `dep` still prints the old
one. A final `hack up --detach` must recreate `dep` with a new ID and config
hash. Whether that converging `up` also restarts `app` is logged, not
asserted. The scenario covers the legacy Compose backend only, not the
authored native-config path or `HACK_RUNTIME_BACKEND=native`.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=compose-config-hash-drift
```

For a managed cloud environment, repeat acceptance in a fresh task restored from
the published environment. Setup-session access does not prove task access: local
listeners and the Docker socket may be restricted even when the tools restore.
Record normal-permission failures separately from passes through the provider's
supported command-approval flow. Do not loosen permissions to turn a failed
capability check into a pass, and verify that the saved startup guidance is
available to the restored task.

The fixture sets both `NO_PROXY` and `no_proxy` to
`app,db,localhost,127.0.0.1` inside its services. Cloud-injected proxy settings can
otherwise send an internal service request through an external proxy even when
service DNS and direct HTTP work. These exceptions apply only to this disposable
fixture; host and provider proxy settings remain unchanged. In a real project,
add its internal service names to the existing proxy exceptions rather than
discarding the project's other entries.

## MCP logs on real Compose (F13)

`mcp-logs-compose` (HACK-1134, HACK-1155) starts `hack mcp serve` over stdio
and calls the logs tools against a real Compose project. Every tool call runs
the CLI under test through `HACK_MCP_COMMAND`. The fixture uses cached
`alpine:3.20` with `pull_policy: never`, a private internal network, no
published ports, and Hack internal DNS/TLS turned off. Both log backends are set
to `compose`. It has three services: `ticker` prints a boot marker and then a
numbered line every 0.2 s, `quiet` prints one line, and `bulk` prints 1500
lines of 2048 four-byte emoji (about 12 MiB) and then idles.

The scenario requires these results:

- A `quiet` snapshot completes with `cutoff: null`. A `quiet` tail stops at
  `maxMs` with a `time` cutoff and only its one line.
- A `ticker` tail stops at `maxMs` with a `time` cutoff and live lines in
  order. Another stops at exactly 5 log events with an `events` cutoff.
- A `bulk` snapshot stops at 8 MiB with a `bytes` cutoff and
  `outputTruncated`. It keeps an ordered prefix of whole lines. No result
  payload may contain U+FFFD, so a split code point fails the run. Where the
  cut falls varies from run to run, so a single pass does not prove that this
  run cut inside a code point; `tests/mcp-logs-contract.test.ts` covers that
  case deterministically.
- With `DOCKER_HOST` pointing at a missing socket, a snapshot and a tail both
  return the closed `backend_error`. The tail ends at end of stream, not at
  `maxMs`.
- `docker restart` on the exact owned `ticker` container during a tail: the
  tail still ends in one typed outcome within its bound. Lines repeated across
  the restart are logged, not asserted (see `docs/reference/mcp-logs.md`). The
  stored history then holds `BOOT 1` and `BOOT 2` once each, with ordered
  lines. A new tail streams only the new boot. A new MCP session does not
  replay lines older than the previous session's last line.
- `hack run quiet -- false` exits 1, and an `exit 7` child exits 7 with its
  output. The MCP `hack.project.run` result reports `ok: false` and
  `exitCode: 7`, and a `true` child reports `ok: true`.

Cleanup removes only containers, networks and volumes with the fixture's
owner label.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=mcp-logs-compose
```

## Native file qualification

`native-config-files` requires the current compiled CLI, its matching compiler and
cached `oven/bun:1.4.2-slim`. It pins the existing image, uses no builds or published
ports, and does not pull or activate DNS/trust. The primary and two linked worktrees
deliver distinct binary configs, encrypted managed secrets and empty files through
literal dollar-containing targets and a private runtime home outside the checkout.
The actual container checks exact bytes, mode 0444, absent unset env and EROFS on
writes. Missing-key restart must refuse before a Docker tripwire. Saved down then
retires exact members despite malformed authored input and unavailable source/key;
stopping the primary must preserve both linked containers. Metadata-only baseline
checks preserve IDs, birth/running state, complete mount rows and counts without
reading container environment values.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=native-config-files
```

`native-config-file-stop-unknown` is selected explicitly and requires kept roots.
Its owned Docker wrapper runs the real stop and then waits past the CLI child
deadline. A source-free retry must stop resources while refusing retirement:
the exact pending generation, immutable reference, unchanged stop-armed journal
and material remain. The wrapper never forges a reaping receipt or changes saved
state. Expected retention is the result being qualified; there is no interface in
this slice to clear that uncertainty. Unexpected cleanup still fails the harness.

```sh
HACK_E2E_KEEP=1 HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=native-config-file-stop-unknown
```

These maintained scenarios are prepared source, not evidence of a successful live
run. Source/whole/CI and compiled synthetic engine acceptance remain separate.

`native-config-protected-files` is a separate explicit selector for synthetic
0444 configs and protected 0400/0600 file secrets. It requires kept fixture roots,
the exact current compiled CLI/compiler and source hashes, an explicitly pinned
Compose plugin, cached Bun/PostgreSQL images and an inherited exact-source
`HACK_E2E_PROTECTED_FILES_SLOT_RELEASED` grant. A private launcher must supply those
pins after source and artifact qualification; the selector does not manufacture
the grant or use caller Docker credentials. It publishes no ports and performs no
pulls, builds, DNS changes or trust changes.

Retained fixture inputs use only the closed file8 source subset: no worktree
policy or authored pull policy. Cached image selection is fenced independently,
and the controlled Compose bootstrap keeps its fixed `--pull never` option.
The pre-effect mode control first refuses an explicit 0444 grant on its owned
0400 source, then changes only the declaration to 0400 and must reach the
rejecting, never-forwarding Docker shim. Canonical mapper and shim controls cover
this prerequisite separately from guest/runtime acceptance.

This selector runs only retained adoption. Ordinary new-material delivery uses
`native-config-vm-files`; no host snapshot-version oracle is applied here.
Two real linked retained checkouts bind their original readonly sources, observed guest UID/GID and
0400/0600 mode, original container/bridge/volume identities and distinct SQL
markers. Guest checks compare exact synthetic bytes through private stdin, prove
access by the observed owner, EACCES for a different non-root UID, ENOENT in an
ungranted workload and EROFS for an explicitly privileged write. No original file
is chmodded; only newly created synthetic files receive their initial modes.

A closed Docker forwarder refuses the exact whole-ID start only after the real
pending receipt is durable. Source material is then withheld while shipping saved
down recovery and rollback settle the original resources. This finite interrupted
operation control does not claim guest cancellation after arbitrary parent death.
An earlier active-source control withholds only the synthetic material directory:
restart and exec must refuse with the exact state diagnostic before effects or
journal changes, then restored source incarnation must permit normal exec.
Each SQL marker is seeded once, reads survive restart, and stopping/rolling back
one checkout preserves its sibling. Saved stop/rollback precedes exact non-force
removal: every original ID, creation birth, label, mount, policy and endpoint is
rechecked; volumes also require zero consumers. Final inventory compares the
original daemon, stopped containers, networks, volume births, image IDs and tags.
Unknown effects or cleanup failures retain private captures and fail the selector.

This selector is maintained acceptance source, with live guest/adoption evidence
still required. It does not replace the existing version-1/0444 managed-file
fixtures or admit file/build/job/health/custom-network intersections.

## Native config process-policy qualification

`native-config-process-policy` is registered in the optional `docker-e2e` CI job. It needs the
current compiled CLI, matching compiler and cached `oven/bun:1.4.2-slim`; it resolves
the immutable image ID and never pulls, publishes ports, or activates DNS/trust.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=native-config-process-policy
```

The fixture observes `SIGUSR1` delivery, delayed graceful exit and forced termination
after authored grace. Persistent monotonic heartbeats distinguish grace enforcement
from merely setting a Compose field. A double-forked child is observed after adoption
by PID 1 and then after reaping by the actual init process. Failure counters and engine
restart counts prove two `on-failure` retries before a successful third start.
Readback uses the same retained volume through a separate native profile. Unsupported
resource/logging declarations, including inactive workloads, must refuse before any
engine access or lifecycle hook. These refusal controls do not qualify resource
limits, reservations, logging policy or the full advanced signals/resources corpus.

Cleanup checks exact native ownership and separately removes its captured read-only
evidence reader. An incomplete teardown fails and preserves both private roots and
recovery identities; ordinary successful cleanup remains unchanged.

The initial-observation replay reports the original query count, protocol match and
ownership outcome. Future replay refusals may also include a fixed callsite reason
for the exact hash-pinned ownership source. Only the immediate owning caller is
matched; source drift, unknown stacks and other failures report `unavailable`.
This diagnostic emits no stack, source path, identifiers, labels or reply values,
and changes no ownership decision, query or budget. It does not reproduce wall
timing, establish the original caller mode, or recover replies that were not saved.

Each replay and the startup diagnostic also report a closed member-key histogram
for the bridge the `network-member-id` predicate inspected: counts of `hex64`,
`epPrefixed` (Docker `ep-` placeholder endpoints) and `other` keys, plus the fixed
service names observed in the `restarting` state. The keys themselves are never
emitted. This evidence classifies the flake; the diagnostics do not change the guard.

The startup readiness guard itself admits one `ep-` placeholder only in the first scan
of a query, and only for a selected on-failure container that the same scan inspected
as `restarting` or `running`. `running` is included because containers are inspected
before the bridge, so the retry container can exit and begin its restart between the
two reads. That container stays unready, and the recheck scan must see its container
ID. A placeholder that persists, or one that names any other container, still refuses
with `network-member-id`.

## Native config routing qualification

`native-config-routing` is an optional `docker-e2e` CI scenario using the current compiled
CLI and matching config compiler. Prepare `oven/bun:1.4.2-slim` and
`lucaslorentz/caddy-docker-proxy:2.10.0-alpine` locally first; the scenario resolves
cached immutable image IDs and never pulls. It requires the existing `hack-dev`
network and refuses any running global Caddy selector before creating its fixture.
Stopped user proxy containers and the network are preserved and checked unchanged.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 bun tests/e2e/run.ts --only=native-config-routing
```

The isolated proxy publishes no host ports and uses private tmpfs mounts instead
of anonymous data/config volumes. Requests run inside the captured proxy with exact
hostname resolution and its verified public root CA, without an insecure or
app-local fallback. The scenario checks primary and OAuth alias origins, two linked
worktrees, primary domain replacement, down/up, sibling and proxy canaries, and
foreign hostname admission before engine effects. The same required scenario also
combines finite down hooks with live routing: before sees its exact retained data
and CA-valid TLS routes; after sees its own container/network/dispatch absence while
its claims remain held. A known after-hook exit 17 keeps the stop pending and claims
held until explicit saved recovery skips the hooks. A later successful stop retires
only the primary claims. Both modes check unchanged sibling container/network IDs,
generation, data, volume creation and TLS routes; saved-source drift refuses before
hooks or teardown. Before each down, a valid managed host value is refreshed after up; both hook
phases must receive that new value while guest values remain unchanged. In-flight
env changes are separately covered by source-CLI before/after regressions with a
controlled engine stand-in; this Docker fixture does not claim to exercise that race.
Unknown hook completion is covered by the separate generation regressions; this
fixture does not create an unrecoverable orphan to simulate it.
It retires native routes and claims before removing only its exact owned proxy.
This proves same-engine Caddy
routing and fixture CA TLS; host DNS, system trust and browser access remain separate
acceptance gates. If owned teardown is incomplete, the scenario fails and retains
both fixture roots and a private identity receipt for recovery. Successful cleanup
keeps the normal harness behavior. `HACK_E2E_KEEP=1` also keeps fixtures for debugging
when an earlier assertion fails but owned teardown succeeds.

## Domain migration routing qualification

The local `domain-migration-files` scenario checks the real CLI with both default
and native backend selections. It verifies preview, old/new alias coexistence,
refusal to overwrite a later edit, and exact-byte rollback. Runtime tripwires
fail the scenario if Docker or the selected native binary is invoked. This
offline check does not prove running routes, retained volumes, DNS or TLS.

The `domain-migration` scenario belongs to the separate `host-ingress` tier and is
excluded from the default local/Docker suite. Select it explicitly with
`--only=domain-migration`; missing prerequisites then fail the run rather than skip.
Docker skip enforcement remains unchanged for the portable Docker tier.

This scenario requires `HACK_E2E_DOMAIN_ROUTING=1`,
a locally installed `node:24.11.0-bookworm-slim` image, existing Caddy ingress on
`hack-dev`, and its exported public CA (default `~/.hack/caddy/pki/caddy-local-authority.crt`,
override with `HACK_E2E_DOMAIN_CA`). It makes no global DNS or trust changes.
Build the current host CLI first with `bun run build`.

```sh
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 HACK_E2E_DOMAIN_ROUTING=1 bun tests/e2e/run.ts --only=domain-migration
```

By default, probes use `--resolve` with the published localhost ingress
(`HACK_E2E_DOMAIN_INGRESS` overrides `127.0.0.1`). This proves old/new/branch route
responses and TLS, including a separate `/usr/bin/curl` probe without a CA override;
it does not prove host DNS or browser permission. Both probes use `/usr/bin/curl`
to qualify the macOS system client rather than an arbitrary PATH installation.
Both probes check the exact fixture
container identity. The scenario uses isolated Hack state, retains legacy routes,
and verifies owned containers and networks are gone after Hack-managed teardown.

After the operator has configured native DNS, add `HACK_E2E_DOMAIN_DNS=1` to the
same command. That mode omits `--resolve` from **both** probes and requires native
hostname resolution and trusted TLS for every old/new/branch name. It never falls
back to explicit address resolution. Browser permission still requires separate
verification.

## Isolation model (HACK_HOME)

Every CLI invocation runs with `HACK_HOME=<fresh tempdir>` plus
`HACK_NO_INTERACTIVE=1`, `NO_COLOR=1`,
`TERM=dumb`, and stdin closed. Global state (projects registry, global
config) must land under `HACK_HOME`, never under the real `~/.hack`.

Because the CLI must honor `HACK_HOME` for this to be safe, the runner
executes a fail-fast canary before any scenario:

1. **Probe A (read-only)** — `hack config get --global name` with `HACK_HOME`
   set; the CLI must report its global-config path under the temp dir. If it
   doesn't, `HACK_HOME` is not honored and the whole run aborts (exit 2)
   without writing anything.
2. **Probe B (write)** — a throwaway canary project is registered via
   `hack config get name`; the canary name must NOT appear in the real
   `~/.hack/projects.json` afterwards (the entry is removed best-effort if it
   does — a targeted removal, so concurrent legitimate registry writes are
   never clobbered) and a `projects.json` containing the canary must appear
   under `HACK_HOME`.

If the canary fails, fix the `HACK_HOME` override seam
(`src/lib/config-paths.ts`, `src/lib/projects-registry.ts`) before trusting
any e2e result.

## Tiers

- **Tier 1 (`local`)** — runs everywhere; no docker needed:
  `automation-check`, `init`, `env-secrets`, `worktree-secrets`,
  `worktree-registry`, `worktree-branch-default`, `agent-docs-sync`,
  `agent-surface-freeze`, `doctor` (doctor tolerates missing docker — it must
  report, not crash), and `lifecycle-session-recovery`. The lifecycle recovery
  scenario skips when tmux is unavailable unless `HACK_E2E_REQUIRE_TMUX=1`
  makes that capability mandatory (as it is in the dedicated Docker/tmux CI
  job).
- **Tier 2 (`docker`)** — opt-in via `HACK_E2E_DOCKER=1`; requires a running
  docker daemon, the machine's global `hack-dev` network (`hack global
  install`), and pulls `oven/bun:1`: `cache-prune`, `up-down`,
  `lifecycle-host-process`, `worktree-parallel-up`. When docker or the network
  is missing these SKIP with a reason instead of failing. Lifecycle host
  processes only start via `hack up` (no standalone lifecycle command), which
  is why that scenario is tier 2.

## Agent surface freeze

`agent-surface-freeze` is the negative control for surprise agent config
writes (HACK-1124, HACK-1132, HACK-1155). It seeds a scenario-owned HOME with
sentinel client config (`~/.claude/settings.json`, `~/.claude.json`,
`~/.claude/skills/`, `~/.codex/config.toml`, `~/.codex/skills/`,
`~/.cursor/mcp.json`, `~/.cursor/rules/`, `~/.ai/skills/`, including stale
`hack-cli` copies). It also commits customized `AGENTS.md`, `CLAUDE.md`,
`.cursor/rules/hack.mdc`, `.codex/skills/hack-cli/SKILL.md`,
`.claude/settings.local.json` and `.mcp.json` into two fixtures. It then runs
`init --auto`, `init --auto --with codex`, `agent prime`,
`agent prime --check`, `agent onboard`, `agent patterns`, `doctor --json`,
`doctor --fix --no-interactive`, `setup sync --check`, refresh-only
`setup sync --all-scopes`, the read-only `setup migrate --all-scopes` preview,
and `setup migrate --all-scopes --apply --skip-plugin-check all` twice each
(`setup sync --check` exits 1 because the customized files are reported as
preserved; the migration apply exits 0 and removes nothing because no seeded
file is Hack-owned). After
every run it requires byte-identical hashes for those trees, no new entries
under them, and `git status` changes only under `.hack/`. Each command must
also exit with its expected code, so a usage error cannot pass as "no write".

Every call sets `HOME` and `HACK_HOME` to scenario temp dirs, so the
contributor's real HOME is never read or written. `DOCKER_HOST` points at a
missing socket and `HACK_MUTAGEN_PATH` at a stub. This keeps
`doctor --fix` free of Docker and network effects even on a Docker CI shard.
The scenario stops the isolated hackd that `doctor --fix` starts. The positive
control, an explicit `setup agents --agents-md`, must change exactly
`AGENTS.md`.

## Fixture

`fixture.ts` scaffolds, per scenario, a fresh git repo with:

- root `package.json` (workspaces `apps/*`, `packages/*`) + `turbo.json`
- `apps/web` / `apps/api` — `Bun.serve` servers ("ok web" / JSON) with
  Dockerfiles; compose runs them via `oven/bun:1` + volume mount (no build
  step) for speed
- `packages/shared` — tiny ts lib consumed by both apps (relative import so
  containers need no `bun install`)
- optional `.hack/` (hack.config.json, docker-compose.yml with caddy labels
  `caddy` / `caddy.reverse_proxy` / `caddy.tls=internal` on the `hack-dev`
  network, `hack.env.default.yaml`) following `src/templates.ts`; project
  name/dev_host are random (`e2e-<hex>.hack`) so runs can never collide with
  real projects
- helpers for linked worktrees (`git worktree add`) and commits

## Cleanup guarantees

- Per scenario, the fixture temp root and the `HACK_HOME` temp dir are
  removed in a `finally` (skip with `HACK_E2E_KEEP=1`).
- Docker scenarios run `hack down` (primary + branch instances) AND a raw
  `docker compose -p <project> down --volumes --remove-orphans` sweep in
  their own `finally`, keyed by the random fixture name.
- The canary restores the real registry snapshot best-effort if a leak is
  ever detected (and aborts the run).

## Adding a scenario

1. Create `tests/e2e/scenarios/<name>.ts` exporting a `Scenario`
   (`name`, `tier`, `summary`, `run(ctx)`); files must NOT end in `.test.ts`
   (the unit runner globs `tests/**/*.test.ts`).
2. Use `ctx.cli({ args, cwd })` for every CLI call (isolation is applied for
   you), `expect`/`expectExit`/`extractJsonObject` from `harness.ts` for
   assertions, and `ctx.skip("reason")` for legitimate environment gaps.
3. Build fixtures with `createMonorepoFixture` under `ctx.tempRoot`.
4. Register it in the `ALL_SCENARIOS` list in `run.ts`.
5. Docker scenarios: call `requireDockerPreconditions` first and wrap the
   body in `try/finally` with `downBestEffort`.

## Native build acceptance

`native-config-build` is an optional `docker-e2e` CI scenario using the cached
`oven/bun:1.4.2-slim` base and the current compiled CLI/compiler. Its native-only
project builds a selected multistage target through a checkout-anchored context
with literal dollar characters and a context-relative nested Dockerfile. A second
job qualifies the default Dockerfile. Actual profile/argv, completed-job readiness,
changed COPY inputs under `pull_policy: "build"`, and retained data are checked.
The default-Dockerfile job omits the policy: changed COPY inputs must still reuse
its original image and marker. Exact workload image IDs independently require
that reuse and the explicit builder's changed image. This proves build decisions,
not BuildKit cache efficiency or cache reclamation.

Build arguments, platform(s), additional contexts, cache import/export, no-cache,
build pull/network options, secrets and SSH remain unsupported. Active and inactive
declarations require their exact compiler diagnostic and a separate redacted `up`
refusal before hook or Docker tripwires. This scenario qualifies the existing basic
build subset; it does not close the full advanced-build corpus requirement.

Cleanup checks captured full image IDs, fixed Dockerfile fixture labels, exclusive
generated tags and baseline absence before ID-only non-forced removal with
`--no-prune`. A generated repository's self-digest is accepted only when its hash
equals that inspected full image ID; foreign repositories or mismatched digests
still refuse cleanup. The cached base and preexisting images remain.
An already absent superseded image receives no deletion: two successful full
inventories must prove the same pinned daemon, baseline continuity, old-ID
absence and its verified current owned replacement. Current-image verification
and removal remain unchanged. Ordinary builder cache is recorded before/after
and retained; there is no general cache prune or cache
reclamation claim. Failed exact cleanup retains the private fixture and recovery
identities. Host DNS/trust, registry network denial and advanced builder features
are separate gates.

The protected-file selector admits Darwin's exact root-owned `/usr/bin/git` with
positive shared system link count, while every private artifact and alternate Git
selection remains single-link. It pins and rechecks that exact link count, owner
IDs, physical path, mode, inode and bytes throughout the attempt. This prerequisite
does not add engine authority or prove guest/lifecycle acceptance.
