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
Rendering labels or receiving a successful Compose exit does not prove routing.
This path does not start or repair global services, change DNS, install trust, or
open a browser. Arbitrary external Docker writers are outside the cooperative
claim boundary; fresh inventory checks detect observed collisions.

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

## Saved operations and recovery

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

An uncertain route effect retains its claims, even after `down --recover` proves
the owned containers stopped. A saved reference cannot complete a prior interrupted
attempt. Such claims prevent restart and hostname handoff; explicit route-owner
recovery remains unimplemented. A pre-effect failure rolls back only claims newly
acquired by that live preparation.

## Remaining coverage

This slice explicitly refuses foreground or partial-service startup, non-plain
logs, pruning options, host hooks/processes, browser opening, route
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
lifecycle, or interactive TTY acceptance. Those remain separate NC03 gates.
