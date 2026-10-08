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
HACK_E2E_KEEP=1 bun tests/e2e/run.ts --only=doctor   # keep temp dirs for debugging
HACK_E2E_REQUIRE_TMUX=1 bun tests/e2e/run.ts --only=lifecycle-session-recovery
```

Exit codes: `0` all pass/skip, `1` any scenario failed, `2` isolation canary
failed (nothing ran).

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

## Native config process-policy qualification

`native-config-process-policy` is registered in required Docker CI. It needs the
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

## Native config routing qualification

`native-config-routing` is a required Docker CI scenario using the current compiled
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
  `doctor` (doctor tolerates missing docker — it must report, not crash), and
  `lifecycle-session-recovery`. The lifecycle recovery scenario skips when
  tmux is unavailable unless `HACK_E2E_REQUIRE_TMUX=1` makes that capability
  mandatory (as it is in the dedicated Docker/tmux CI job).
- **Tier 2 (`docker`)** — opt-in via `HACK_E2E_DOCKER=1`; requires a running
  docker daemon, the machine's global `hack-dev` network (`hack global
  install`), and pulls `oven/bun:1`: `cache-prune`, `up-down`,
  `lifecycle-host-process`, `worktree-parallel-up`. When docker or the network
  is missing these SKIP with a reason instead of failing. Lifecycle host
  processes only start via `hack up` (no standalone lifecycle command), which
  is why that scenario is tier 2.

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

`native-config-build` is a required Docker scenario using the cached
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
