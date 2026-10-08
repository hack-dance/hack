# Experimental native configuration with Compose

A new disposable project can author `.hack/hack.project.json` and run a supported
workload directly through the Compose backend. The compiler validates the native
configuration; Hack privately renders one backend document. No authored Compose
file or legacy `.hack/hack.config.json` is required. See the
[compiler contract](native-config-compiler.md) and
[supported translation](native-compose-renderer.md) before using this experimental
path. Existing-project import and native graph execution are separate work.

Run these commands with the current branch CLI and its matching bundled compiler:

```sh
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project up --detach
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project ps --json
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project open --json
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project logs --compose
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project exec app -- command arg
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project run app -- command arg
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project restart
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project down
```

An unset runtime selection also uses Compose for this authored format. An explicit
selection of another backend refuses; Hack does not change that selection or
silently fall back. Discovery chooses the authored family before legacy project
registration and runtime operations. Native and legacy files at the same root
conflict. Registered names select their exact registered root without ancestor
fallback.

## Execution and completion

The first command slice supports whole-project detached `up`, `restart`, `run`,
`down`, `ps`, plain `logs`, and `exec`. Startup uses the existing configurable
Compose startup budget. Compose owns dependency startup, restart, and exec
health checks. Hack checks the exact proposed generation: each service must be
running, healthy when it declares a health check, and each initializer job must
have exited successfully. An older healthy container does not satisfy a new
generation's readiness.

Compiler-selected HTTP routes use the already running global Caddy proxy and the
external `hack-dev` network on the selected Docker engine. Only routed services
join that ingress. Hack verifies the exact engine, proxy and network before effects,
admits every selected hostname through private cooperative claims, and refuses
observed foreign Caddy site collisions. Startup also checks Caddy's active route
configuration against the ready generation's exact owned upstream addresses.
When Caddy's stored admin config omits a policy added by automatic HTTPS,
Hack also verifies a HEAD request for each selected HTTPS origin inside that
exact proxy, using Caddy's live local root and hostname verification. It discards
the response, follows no redirects, and rechecks dispatch and ownership afterward.
Listening on port 443 alone does not satisfy this check. See
[Caddy's automatic HTTPS contract](https://caddyserver.com/docs/automatic-https).
Rendering labels or receiving a successful Compose exit does not prove routing.
This path does not start or repair global services, change DNS, install trust, or
open a browser. Arbitrary external Docker writers are outside the cooperative
claim boundary; fresh inventory checks detect observed collisions.

The global template uses the official `2.10.0-alpine` Caddy proxy variant, which
includes curl for bounded, read-only checks of its live localhost admin API. The
admin port is not published. An existing distroless proxy refuses this prerequisite
before project effects. Refresh its saved template with `hack global install` or
the guided `hack doctor --fix` repair, keeping `caddy_data`, then restart it.
`hack global up` alone starts the saved template and does not upgrade that file.
Native project startup never performs this global migration automatically.

For projects without routing, `run` can start a cold project's dependencies.
It gives the one-off container a
fresh name, verifies its generation, service, stopped state and exact exit code,
then removes that verified stopped ID without forcing removal. A real nonzero
command exit remains nonzero after verified completion. Failure to start or remove
the one-off leaves execution incomplete; absence alone does not prove completion.
The selected target's direct dependency conditions are checked as authored;
`service_started` does not acquire an extra health requirement.
For routed projects, `run` requires an already-ready current generation and
unchanged effective inputs. Run `up` first for a cold or stopped instance;
those routed runs refuse before hooks or engine operations. The target's
dependency conditions and every saved workload's readiness must hold.

The owned generation store privately publishes a one-off projection that removes
the target's Caddy routing label keys. Its environment, command, mounts,
dependencies and storage identities remain unchanged. Compose receives only this
verified immutable file and `--no-deps`, so the ready graph remains in place.
The adapter reopens completed hostname claims for read-only checks, verifies the
active routes before and after execution, and requires the retained containers'
IDs to remain unchanged. It also checks routing-key absence on the actual stopped
one-off before removing that exact owned ID. Claim drift, unexpected exposure,
container replacement or incomplete cleanup retain pending recovery state;
they do not trigger automatic replay. `down --recover` uses the original saved
generation and retains persistent data. The private projection remains available
for owned inspection and is never replayed.

The source tests exercise projection publication, tamper refusal, readonly claims,
literal delivery, exit status and recovery with substituted engine observations.
The maintained `native-config-routing` Docker fixture additionally observes a
running one-off with no routing keys, exact exit 17 and removal, unchanged main
and sibling container IDs and HTTPS markers, completed claims, retained data and
recovery from a deliberately blocked one-off removal. This fixture passed on an
M3 macOS host with the current compiled CLI and its matching compiler. That
qualification is separate from unit tests and does not establish cold routed-run
support or whole-product parity.

Managed environment selection, native source and selected local configuration
are acquired together. Support preflight precedes private value delivery. Private
input fences are checked before engine effects and after value delivery. They
detect changes; they do not freeze arbitrary external filesystem edits. Generated
documents can contain decrypted values and remain in owned private files with
restricted permissions. They are never part of the public plan or JSON output.
Do not copy these documents into source control or attach them to diagnostics.

## Owned project networks

For an unchanged unrouted running instance, `up` reuses its saved generation only
when the full input revision, selected profiles and freshly rendered private
document match exactly. Compose and readiness checks still run, as do authored
finite hooks. This avoids recreating healthy containers solely because of a new
generation label. Changed inputs, stopped instances and explicit `restart` retain
the new-generation path. Routed warm `up` remains outside this reuse slice.

The compiler's owned bridge declarations and workload attachment maps are lowered
without adding an outbound default attachment to an explicit selection. Custom
network names stay stable for an instance and differ between worktrees. Only
selected networks are allocated. Routing supplies its separately verified ingress
attachment to routed services.

Private saved route validation uses the same owned topology parser as generation
publication. Routed services retain their explicit owned attachments and aliases,
then add exactly the verified ingress without ingress aliases. Extra external
attachments, inconsistent owner/generation labels and malformed topology refuse
before saved mutation or route retirement. Runtime ownership still checks physical
IDs, policy and reciprocal membership separately.

Saved operations verify each owned bridge's exact engine ID, driver, internal
policy and members, and each container's configured attachments and DNS aliases.
Unknown attachments, foreign members or changes between inspection passes refuse.
An active topology must retain every old network and its policy; removing a network
or changing its internal policy requires an owned `down` before the next `up`.
Adding a network retains the old generation's verified topology until completion.

Custom-network `run` refuses before hooks or engine effects until one-off alias
behavior is separately qualified. Explicit `down --recover` can clean a receipt-bound
stopped container after an owned bridge disappeared, or a never-started created
container with empty endpoint metadata on a verified owned bridge. Neither case
relaxes running-container or ingress identity checks or grants deletion authority
over an unknown network. Runtime isolation remains a separate acceptance gate.

Saved `ps` and `logs` can observe these verified CREATED containers while startup
is pending. This read permission does not grant `exec`, readiness or ordinary
mutation authority. Substituting canonical service aliases for a temporary
replacement name requires its fully owned, receipt-selected predecessor in the
same scan. An unknown prefix cannot justify that substitution; an empty alias
set still requires the owned CREATED-container and bridge proofs. Changed
observations refuse.

## Finite host lifecycle hooks

Whole-project `up` and `restart` run `host.up.before` before engine startup, then
`host.up.after` after the exact workloads and routes are ready. Each phase runs in
authored order. A hook
uses either ordered `command.exec` arguments or explicit `command.shell` source
through `/bin/sh -c`. Its relative `cwd` anchors to the selected checkout. Standard
input and native authorization prompts remain attached to the terminal; with
`--json`, child output goes to stderr. Hook output and environment values are not
written to the ownership receipt.

The existing environment owner supplies each hook's selected host baseline and
the compiler's effective bindings. `env_target` can select the default host or a
declared workload's host view. Managed references read that immutable baseline;
literal overrides, empty defaults and explicit unset destinations retain their
meaning. HTTP/HTTPS external endpoint bindings are supported. Other endpoint
owners remain refused. `run` currently refuses projects with any nonempty lifecycle
hooks instead of assigning new lifecycle semantics to a one-off command.

Each hook phase has a separate budget equal to `HACK_COMPOSE_STARTUP_TIMEOUT_MS`;
Compose startup and final route verification each receive their own bounded
budget. A nonzero hook exits with its status and prevents later hooks. A before
failure prevents engine startup. An after failure leaves startup pending without
reporting ready; an owned engine can be stopped with saved `down --recover`.
Cancellation and timeout forward signals to the owned process group. Completion
requires the group to be absent; a hook that leaves descendants is uncertain.

Before hooks can prepare managed environment files or local endpoint bindings. Hack
reacquires source, local, routing and environment inputs after the sequence and
before private generation publication. A changed project name, source contract,
worktree policy, selected profiles or hook sequence refuses startup rather than
silently skipping newly authored hooks.

After hooks cannot rebind a running generation. Before committing readiness, Hack
reacquires and checks the same source, local, routing and environment inputs,
rechecks actual workload readiness, and verifies routes with a fresh bounded
deadline. A changed input, stopped service or failed health check keeps the engine
operation pending. The generation becomes ready only after those checks pass.

Before spawning, Hack synchronizes a private hook intent under the same instance
mutation lock used for engine effects. An interrupted or unverified hook retains
that intent and blocks `up`, `restart` and `run` without replay. Saved `ps --json`
reports `beforeHooksPending` for every phase and `hostHookPhase` as `before`,
`after`, `down.before`, `down.after`, or null, even if no engine generation was created. Older token-only
receipts remain uncertain before intents. An after intent also binds its exact
pending startup operation and generation. Saved
`down` can stop a retained engine generation but reports incomplete cleanup while
hook intent remains. `down --recover` can recover a verified dead CLI mutation
owner; it cannot prove hook process ownership, clear hook uncertainty or rerun a
hook. Explicit recovery for interrupted hooks remains a later lifecycle slice.
An uncertain hook also prevents routing claim retirement after an owned stop.
Normal `down` runs `host.down.before` before stopping the owned engine and
`host.down.after` only after fresh exact container, network and proxy dispatch
absence. Hostname claims remain held through after hooks. A hook failure returns
its exit status and leaves stop pending; a before failure runs no engine mutation.
Private target values for both phases are captured under the instance lock before
any hook journal or spawn. Each phase receives its own finite budget.

The private saved generation binds down hooks to its immutable source revision,
profiles, effective overlay (including no overlay) and original explicit overlay
selection. Normal hook-enabled down rechecks source, local, routing and managed
environment freshness before engine effects and final claim retirement. Hooks
cannot rebind that generation. Any pre-existing pending operation or unknown hook
intent refuses normal hook-enabled down before private value acquisition. Changed
or malformed inputs require explicit recovery. Generations saved without this
binding retain saved-only stop semantics; newly authored hooks cannot attach to an
already-running old generation. Completed stopped generations do not replay hooks.

`down --recover` skips authored down hooks, compiler/source parsing and private
value acquisition. A successful hook-enabled engine recovery reports
`hostHooksSkipped: true`; it does not report skipped or previously failed hooks as
successful. A known finite nonzero with proven group absence clears only its exact
hook intent, so later explicit engine recovery can retire claims after fresh absence.
Unknown completion preserves host intent, pending generation and claims even after
owned engine stop, and still reports incomplete. Persistent host processes and
explicit uncertain-hook recovery remain unsupported. `restart` retains its current
up/recreate contract; down hooks run on explicit `down`.

## Saved operations and recovery

`open --json` returns the saved compiler-selected origin without launching a
browser, recompiling authored input, decrypting environment values, or observing
Docker. `open` without `--json` explicitly opens that same origin in the browser.
The default honors the saved OAuth alias and open preference; `--prefer dev|alias|auto`
and named declared routes select only origins present in the saved routing report.
`--branch` selects its exact saved instance. Missing or malformed saved routing,
pending effects, arbitrary URL targets and logs targets refuse. A stopped instance
may still return its saved origin; this does not assert application reachability.

`ps`, `logs`, `exec`, and `down` use the retained generation. They do not reparse
authored contents or decrypt the current environment. Profile and overlay changes
require `up` or `restart`; an existing `run` also refuses inputs that differ from
its retained generation. Saved operations hold a lease and check engine ownership
before acting. Process cancellation forwards signals and releases the lease after
the child is reaped.

Generation identity is distinct from persistent worktree storage identity.
`down` removes owned containers and networks while retaining persistent volumes.
The following `up` can reuse that data. Ownership checks refuse foreign resources,
including a matching Compose project or resource name with another owner token.

An interrupted or uncertain operation retains its intent. Inspect it with saved
`ps` or `logs`; then explicitly request owned stop recovery:

```sh
HACK_RUNTIME_BACKEND=compose ./dist/hack --path /absolute/project down --recover
```

This can recover a verified same-boot dead mutation owner and stop the retained
pending generation. It does not kill a live writer, steal unknown locks, remove
volumes, prune old generations, or replay a start. Unverified ownership refuses.

Routing references, ingress identity and route proof targets live only in the
private generated document's `x-hack-native-routing` extension. Saved `ps`, `logs`
and `exec` remain usable if the proxy is unavailable. `down` stops owned containers
first, then releases hostname claims only after fresh container absence and exact
proxy route absence. Proxy loss returns a retained-claims diagnostic after the stop.
Replacing or removing routing admits the union of old and new hostnames and removes
owned orphan containers before retiring obsolete claims. Persistent volumes remain.

An uncertain route effect retains its claims and blocks restart and hostname
handoff. `down --recover` may retire those claims using their exact saved references,
fresh absence of all owned containers and routes, and the same verified ingress.
It records a terminal stopped attempt and never completes the interrupted start.
Missing ingress or failed proof keeps the generation pending for another explicit
stop recovery. Unknown host-hook completion still blocks claim retirement and keeps
its hook intent and recovery generation. A pre-effect failure rolls back only claims
newly acquired by that live preparation.

Startup writes pending engine intent before spawning. After the child is reaped,
Hack verifies workload and active-route readiness, then checks the owned generation
and pending intent again. Route claims complete inside a finalizer before the
generation's completed receipt is written. Hack rechecks the generation, engine
ownership and pending intent after the finalizer. A finalizer failure retains pending
engine uncertainty and prevents a ready report. The two private stores do not have
an atomic commit: a crash after claim completion but before receipt publication
still leaves the pending generation for explicit owned stop recovery. Fresh absence
proof remains required before any remaining hostname claims can be released.
Stop likewise retires claims before committing its completed generation receipt,
then rechecks generation, ownership and pending intent. A crash after retirement
leaves the pending generation; retry proves absence again and preserves any later
foreign claim. A receipt already lost by an older version cannot be reconstructed
from orphan generation files by this recovery path.

## Remaining coverage

This slice explicitly refuses foreground or partial-service startup, non-plain
logs, pruning options, persistent host
processes, browser opening, route
bindings, typed host/gateway endpoints, TCP endpoint derivation, and HTTP/TCP
readiness. It preserves ordinary project DNS and outbound networking and adds no
CPU, memory or PID limits. The renderer documents the remaining field refusals.

The Docker end-to-end scenario uses a compiled CLI, a real web/database/initializer
fixture, synthetic encrypted values, dollar-bearing literals, named one-off exits,
retained SQL data and foreign-owner controls. Run it in isolation:

```sh
bun run build:config-compiler
bun run build
HACK_E2E_CLI_BIN=./dist/hack HACK_E2E_DOCKER=1 HACK_E2E_REQUIRE_DOCKER=1 \
  bun tests/e2e/run.ts --only=native-config-compose
```

Container checks do not establish normal browser routing, native trust, host
lifecycle recovery, persistent host ownership, or interactive TTY acceptance.
Those remain separate NC03 gates.

The registered `native-config-down-hooks` Docker scenario requires the current
compiled CLI and a cached exact Bun image. It checks finite before/after order and
managed host isolation around production ownership probes, exit 17 with pending
stop, malformed-source/env recovery with skipped hooks, and the same owned volume
with a preserved data counter across stops. Final cleanup removes only that
freshly verified isolated fixture volume. PTY, cancellation, timeout, orphan
completion and routed claim retirement require their separate lifecycle controls.
