# Prerequisite Detection Matrix

This guide defines the prerequisite contract for guided interception in the CLI.
The implementation-facing source of truth lives in `src/cli/prerequisites.ts`.

## Scope

This matrix covers the prerequisite families called out in HACK-441:

- Docker runtime
- Global install state
- tmux/zellij mux availability
- GitHub auth/config
- Linear auth/config

The goal is not to make every command fail earlier. The goal is to decide, in a repeatable way, whether a missing prerequisite should:

- block: stop and show the missing prerequisite inline
- guide: intercept into a repair/setup path
- warn: continue and surface degraded or diagnostic state

## Check Catalog

| Check ID | Domain | What it means | Primary guidance |
| --- | --- | --- | --- |
| `docker_cli` | Docker | `docker` is installed and on `PATH` | Install Docker Desktop or OrbStack |
| `docker_daemon` | Docker | `docker info` succeeds | Start Docker or route into `hack global install` |
| `global_bootstrap` | Global | `hack global install` has generated `~/.hack` artifacts | `hack global install` |
| `global_services` | Global | Caddy/CoreDNS/Loki are reachable for routed hosts, Loki logs, or Caddy-managed CA export | `hack global up` or `hack global install` |
| `mux_backend` | Mux | `sessions.mux` resolves to an installed tmux or zellij backend | Install tmux/zellij or change `sessions.mux` |
| `tmux_binary` | Mux | tmux exists for tmux-backed session commands | Install tmux directly, then optionally run `hack setup tmux` |
| `github_profile` | GitHub | A GitHub profile is resolvable from flags/config | `hack x github connect` or `hack x github use` |
| `github_token` | GitHub | The selected GitHub profile resolves a usable token | `hack x github connect` or `hack x github oauth-connect` |
| `github_gh_cli` | GitHub | `gh` exists for browser bootstrap | Install GitHub CLI |
| `linear_profile` | Linear | A Linear profile is resolvable from flags/config | `hack linear connect` or `hack linear use` |
| `linear_token` | Linear | The selected Linear profile resolves a usable token | `hack linear connect` or `hack linear oauth-connect` |
| `linear_broker_auth` | Linear | A Hack broker management token exists for broker-owned flows | `hack auth login` |
| `linear_oauth_client` | Linear | Local OAuth client credentials exist for direct OAuth fallback | Configure local Linear OAuth env/auth-ref values |

## Command Matrix

| Command(s) | Checks | Missing behavior | Notes |
| --- | --- | --- | --- |
| `hack global install` | `docker_cli`, `docker_daemon`, `mux_backend` | guide, guide, warn | Bootstrap should repair Docker issues inline, but only warn about missing mux tooling |
| `hack global up`, `hack global status`, `hack global logs`, `hack global logs-reset` | `global_bootstrap`, `docker_cli`, `docker_daemon` | guide, guide, guide | These commands operate on the generated global stack |
| `hack global down` | `docker_cli`, `docker_daemon` | guide, guide | Conditional: only when a managed global stack already exists; otherwise teardown should stay idempotent |
| `hack global ca`, `hack global trust` | `global_bootstrap`, `docker_cli`, `docker_daemon`, `global_services` | guide, guide, guide, guide | CA export/trust depends on an installed and running Caddy-managed global stack |
| `hack up`, `hack down`, `hack restart`, `hack ps`, `hack run`, `hack tui` | `docker_cli`, `docker_daemon` | guide, guide | Core Docker-backed runtime commands |
| `hack projects prune` | `docker_cli`, `docker_daemon` | guide, guide | Operational cleanup should repair Docker availability before mutating runtime state |
| `hack status`, `hack projects` | `docker_cli`, `docker_daemon` | warn, warn | Inventory/diagnostic commands should preserve degraded runtime visibility instead of intercepting |
| `hack up`, `hack restart` | `mux_backend` | guide | Only when lifecycle host processes or mux-backed pre-start hooks are configured |
| `hack open` | `global_services` | guide | Routed `*.hack` access should repair global routing instead of failing opaquely |
| `hack logs` | `docker_cli`, `docker_daemon`, `global_services` | guide, guide, warn | Default logs may fall back from Loki to compose logs |
| `hack logs --loki`, `hack logs --query` | `global_services` | guide | Explicit Loki mode should not silently fall back |
| `hack logs --compose` | `docker_cli`, `docker_daemon` | guide, guide | Explicit compose logs bypass Loki entirely, so only Docker availability matters |
| `hack session`, `hack session list`, `hack session start`, `hack session attach`, `hack session exec`, `hack session stop`, `hack ssh` | `tmux_binary` | guide | The current session and session-aware SSH implementation is tmux-backed even when mux config exists elsewhere |
| `hack session panes`, `hack session capture`, `hack session tail`, `hack setup tmux` | `tmux_binary` | guide | tmux-only surfaces |
| `hack x github status`, `hack x github profiles` | `github_profile`, `github_token` | warn, warn | Diagnostics should expose missing state instead of intercepting it |
| `hack x github use` | `github_profile` | guide | Profile selection should redirect into setup when there is no resolvable target |
| `hack x github oauth-connect` | `github_gh_cli` | guide | Browser bootstrap is `gh`-driven |
| `hack x github pr-upsert` | `github_profile`, `github_token` | guide, guide | Mutating GitHub API command |
| `hack linear status`, `hack linear profiles` | `linear_profile`, `linear_token` | warn, warn | Diagnostics should keep unresolved state visible |
| `hack linear use` | `linear_profile` | guide | Profile selection should redirect into setup when there is no resolvable target |
| `hack linear connect` | `linear_broker_auth`, `linear_oauth_client` | guide, guide | Conditional: broker auth only when broker OAuth is selected and local OAuth fallback is unavailable; direct OAuth config only when fallback is the chosen path |
| `hack linear oauth-connect` | `linear_broker_auth`, `linear_oauth_client` | guide, guide | Same split as `hack linear connect`, but on the explicit OAuth path |
| `hack linear connections`, `hack linear seed-local-access`, `hack linear deliveries`, `hack linear apply-delivery`, `hack linear subscriptions`, `hack linear set-subscription`, `hack linear remove-subscription` | `linear_broker_auth` | guide | These commands are broker-backed and should route into Hack auth first |
| `hack linear projects`, `hack linear sync-issue`, `hack linear sync-project` | `linear_profile`, `linear_token` | guide, guide | Linear API actions should repair auth/config before invoking the API |
| `hack linear project-bind`, `hack linear project-link` | `linear_profile`, `linear_token` | guide, guide | Conditional: only when the command must resolve project metadata remotely instead of using a fully specified local binding |
| `hack linear run-autosync` | `linear_profile`, `linear_token`, `linear_broker_auth` | guide, guide, guide | Autosync needs both Linear API access and broker-backed subscription/delivery access |

## Decision Rules

### Use `guide`

Use guided interception when the command is operational and the missing prerequisite is something Hack can clearly repair or route the user toward:

- Docker is missing or not running for Docker-backed workflows
- `hack global install` has never been run
- Routed global services are missing for `hack open` or explicit Loki commands
- tmux is missing for the current session and SSH implementation, or mux is missing for lifecycle-backed host-process flows
- GitHub or Linear action commands are missing resolvable profile/token state
- broker-owned Linear flows are missing Hack account auth

### Use `warn`

Use a warning when the command is itself diagnostic or the CLI can still continue in a degraded but useful mode:

- `hack global install` with missing tmux/zellij
- `hack logs` when Loki is unavailable but compose fallback still works
- `hack x github status` and `hack x github profiles`
- `hack linear status` and `hack linear profiles`

### Use `block`

The current matrix leaves `block` for cases where guided repair is not appropriate, but the ticket scope does not require a first blocking case. The important contract is that operational commands guide, diagnostics warn, and only irreparable/unowned failures should block later.

## Commands That Should Invoke Checks

The explicit command set currently covered by the source-of-truth matrix is:

```text
global install
global up
global status
global logs
global logs-reset
global down
global ca
global trust
up
down
restart
ps
run
tui
projects prune
status
projects
open
logs
logs --loki
logs --query
logs --compose
session
session list
session start
session attach
session exec
session stop
ssh
session panes
session capture
session tail
setup tmux
x github status
x github profiles
x github use
x github oauth-connect
x github pr-upsert
linear status
linear profiles
linear use
linear connect
linear oauth-connect
linear connections
linear seed-local-access
linear projects
linear project-bind
linear project-link
linear sync-issue
linear sync-project
linear run-autosync
linear deliveries
linear apply-delivery
linear subscriptions
linear set-subscription
linear remove-subscription
```

`hack linear ...` entries also apply to the equivalent `hack x linear ...`
alias path.

## Notes for Follow-on Implementation

- Preserve the current distinction between diagnostics and actions. Status commands should not disappear behind setup wizards.
- Keep conditional checks conditional. `mux_backend` only matters for lifecycle-backed `hack up`/`hack restart` when lifecycle host processes are configured.
- Keep cleanup and local-only config commands out of shared interception. `x github disconnect`, `linear disconnect`, `linear assignee-mappings`, `linear set-assignee-mapping`, `linear remove-assignee-mapping`, and `linear project-unlink` should use command-local validation instead of the prerequisite matrix.
- Docker detection should distinguish CLI missing from daemon unavailable because the repair path is different.
- GitHub and Linear setup flows already contain parts of this guidance. Interception should centralize the decision, not duplicate every downstream error string.
