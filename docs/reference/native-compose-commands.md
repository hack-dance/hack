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
`run` refuses selected or retained routing generations until one-off Caddy label
projection is qualified, including an unrouted job in a routed project.

Managed environment selection, native source and selected local configuration
are acquired together. Support preflight precedes private value delivery. Private
input fences are checked before engine effects and after value delivery. They
detect changes; they do not freeze arbitrary external filesystem edits. Generated
documents can contain decrypted values and remain in owned private files with
restricted permissions. They are never part of the public plan or JSON output.
Do not copy these documents into source control or attach them to diagnostics.

## Finite host before hooks

Whole-project `up` and `restart` run `host.up.before` in authored order. A hook
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
owners remain refused. `run` currently refuses projects with nonempty before
hooks instead of assigning new lifecycle semantics to a one-off command.

The entire hook sequence has a separate budget equal to
`HACK_COMPOSE_STARTUP_TIMEOUT_MS`; Compose startup gets its own budget afterward.
A nonzero hook exits with its status and prevents later hooks and engine startup.
Cancellation and timeout forward signals to the owned process group. Completion
requires the group to be absent; a hook that leaves descendants is uncertain.

Hooks can prepare managed environment files or local endpoint bindings. Hack
reacquires source, local, routing and environment inputs after the sequence and
before private generation publication. A changed project name, source contract,
worktree policy, selected profiles or hook sequence refuses startup rather than
silently skipping newly authored hooks.

Before spawning, Hack synchronizes a private hook intent under the same instance
mutation lock used for engine effects. An interrupted or unverified hook retains
that intent and blocks `up`, `restart` and `run` without replay. Saved `ps --json`
reports `beforeHooksPending`, even if no engine generation was created. Saved
`down` can stop a retained engine generation but reports incomplete cleanup while
hook intent remains. `down --recover` can recover a verified dead CLI mutation
owner; it cannot prove hook process ownership, clear hook uncertainty or rerun a
hook. Explicit recovery for interrupted hooks remains a later lifecycle slice.
An uncertain hook also prevents routing claim retirement after an owned stop.

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
`ps`; then explicitly request owned stop recovery:

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
logs, pruning options, `host.up.after`, all `host.down` hooks, persistent host
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
