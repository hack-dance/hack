# CLI Reference

This reference mirrors the CLI spec in `src/cli/spec.ts`. Run `hack help` or `hack help <command>` for interactive help.

If you are new to Hack, scan the CLI in this order:

1. `Global commands` for machine setup
2. `Core workflows` for day-to-day local development
3. `Collaboration & integrations` for env, sessions, tickets, Linear, and SSH access
4. `Beta workflows` for remote control plane and multi-node execution
5. `Extension commands` when you need the lower-level namespace surface

If you are new to Hack, scan the CLI in this order:

1. `Global commands` for machine setup
2. `Core workflows` for day-to-day local development
3. `Collaboration & integrations` for env, sessions, tickets, Linear, and SSH access
4. `Beta workflows` for remote control plane and multi-node execution
5. `Extension commands` when you need the lower-level namespace surface

This is the full command reference, including beta and extension surfaces.
If you are new to `hack`, start with [Core docs](core.md) and come back here when you need
command-level detail.

## Conventions

- Commands that accept both `--path` and `--project` treat them as mutually exclusive.
- `--branch` runs branch-specific instances (compose project name + hostnames).
- `--profile` accepts comma-separated compose profiles.
- Options marked repeatable can be passed multiple times.

## Adjacent capabilities

These commands usually matter after the basic `hack init` / `hack up` / `hack open` loop is already
working. You do not need all of them for every repo.

- **GitHub**: Use `hack x github` when you want `hack` to help with connected-account setup and pull
  request workflows. It becomes relevant once a branch is ready to open, update, or hand off for
  review.
- **Linear**: Use `hack linear` when repo work should stay connected to Linear issues or projects. It
  becomes relevant when the repo maps to a Linear workflow and you want sync without leaving the CLI.
- **Tickets**: Use `hack tickets` when you want lightweight repo-local work tracking that stays in git.
  It becomes relevant as soon as you want to capture follow-up work without depending on an external
  tracker.
- **Sessions**: Use `hack session` when you want a reusable terminal workspace you can return to or hand
  off. It becomes relevant when you keep long-running shells, agent runs, or SSH workspaces alive.
- **Env**: Use `hack env` when a project needs explicit local config or secrets. It becomes relevant as
  soon as `hack up`, `hack run`, or remote workflows depend on values that should not be hardcoded.

## Local vs broker-mediated administration

This reference documents the commands that exist today. Hack stays local-first by default.

- Local runtime and project operations do not require Hack account auth.
- Shared administration is a separate trust boundary.
- If an operation would mutate shared identity, membership, project ownership, access grants, or shared
  secret custody, it should be broker-mediated and authenticated rather than silently falling back to a
  local write.

Current practical rule:
- `hack up`, `hack down`, `hack logs`, `hack session`, `hack tickets`, and local `hack env` operations are
  local-first surfaces.
- The teams-and-organizations admin model is defined in `docs/architecture.md` and `docs/env.md` until the
  corresponding shared-admin command surfaces land.

## Top-level commands

| Command | Summary | Group |
| --- | --- | --- |
| `hack global` | Manage machine-wide infra (DNS/TLS, Caddy proxy, logs) | Global |
| `hack auth` | Manage Hack auth sessions and recipient-side invitations | Global |
| `hack org` | Manage organizations and org-scoped membership lifecycle | Global |
| `hack team` | Manage teams and team-scoped membership lifecycle | Global |
| `hack projects` | Show all projects (registry + running docker compose) | Global |
| `hack status` | Show project status (shortcut for `hack projects --details`) | Global |
| `hack usage` | Show resource usage across running projects | Global |
| `hack init` | Initialize a repo (generate .hack/ with compose + config) | Core workflows |
| `hack up` | Start project services (docker compose up) | Core workflows |
| `hack down` | Stop project services (docker compose down) | Core workflows |
| `hack restart` | Restart project services (down then up) | Core workflows |
| `hack ps` | Show project status (docker compose ps) | Core workflows |
| `hack logs` | Tail logs (compose by default; Loki for queries/history via --loki/--query) | Core workflows |
| `hack run` | Run a one-off command in a service container (docker compose run --rm) | Core workflows |
| `hack open` | Open a URL for the project (default: https://<project>.hack) | Core workflows |
| `hack tui` | Open the project TUI (services + logs) | Core workflows |
| `hack branch` | Manage branch aliases for a project | Core workflows |
| `hack project` | Inspect or manage project metadata | Project |
| `hack config` | Read/write hack.config.json values | Core workflows |
| `hack auth` | Manage Hack account sign-in | Collaboration & integrations |
| `hack linear` | Connect Linear and sync repo work with Linear projects/issues | Collaboration & integrations |
| `hack env` | Set project env vars and local secrets | Collaboration & integrations |
| `hack session` | Manage persistent project workspaces with tmux-first onboarding | Collaboration & integrations |
| `hack ssh` | Show SSH connection info for remote access to this machine | Collaboration & integrations |
| `hack tickets` | Track repo-local work without leaving git | Collaboration & integrations |
| `hack internal` | Manage hack-managed internal overrides | Internal |
| `hack gateway` | Beta: manage the remote control plane entrypoint | Beta workflows |
| `hack node` | Beta: manage remote execution nodes | Beta workflows |
| `hack dispatch` | Beta: run branch-scoped jobs on remote nodes | Beta workflows |
| `hack remote` | Beta: guided remote access and gateway helpers | Beta workflows |
| `hack x` | Run extension commands | Extension commands |
| `hack setup` | Install integrations for coding agents | Agent integrations |
| `hack agent` | Agent utilities | Agent integrations |
| `hack mcp` | Manage MCP server integrations for coding agents | Agent integrations |
| `hack doctor` | Validate local setup (docker, networks, DNS, global infra, project config) | Diagnostics |
| `hack crash-capture` | Capture runtime crash diagnostics into `.tmp/` for triage | Diagnostics |
| `hack daemon` | Manage the local hack daemon (hackd) | Diagnostics |
| `hack log-pipe` | Read log lines from stdin and pretty-print them | Diagnostics |
| `hack help` | Show help for a command | Diagnostics |
| `hack update` | Update hack to the latest release | Diagnostics |
| `hack version` | Print version | Diagnostics |
| `hack secrets` | Manage secrets in OS keychain (Bun.secrets) | Secrets |
| `hack the` | Fun commands | Fun |

## Global commands

### hack global

Usage: `hack global <subcommand>`

Subcommands:

| Subcommand   | Summary                                                      |
| ------------ | ------------------------------------------------------------ |
| `install`    | Bootstrap `~/.hack` and start Caddy + Grafana/Loki/Alloy     |
| `up`         | Start global infra containers                                |
| `down`       | Stop global infra containers                                 |
| `status`     | Show status for global infra (containers + networks)         |
| `logs`       | Tail global infra logs (`caddy`, `grafana`, `loki`, `alloy`) |
| `ca`         | Export Caddy Local CA cert (print path or PEM)               |
| `cert`       | Generate local TLS certs via mkcert (for non-Caddy services) |
| `trust`      | Trust Caddy Local CA (macOS) so https://\*.hack is trusted   |
| `logs-reset` | Wipe Loki/Grafana volumes (fresh logs + dashboards)          |

#### hack global logs

Usage: `hack global logs [service] [options]`

Arguments:

| Name      | Type   | Required | Description                                                |
| --------- | ------ | -------- | ---------------------------------------------------------- |
| `service` | string | no       | Filter to one global service (caddy, grafana, loki, alloy) |

Options:

| Flag             | Type    | Default | Description                                               |
| ---------------- | ------- | ------- | --------------------------------------------------------- |
| `-f`, `--follow` | boolean | true    | Follow logs (default)                                     |
| `--no-follow`    | boolean | false   | Print logs and exit                                       |
| `--tail <n>`     | number  | 200     | Tail last N log lines                                     |
| `--pretty`       | boolean | false   | Pretty-print logs (best-effort JSON parsing + formatting) |

#### hack global ca

Usage: `hack global ca [options]`

Options:

| Flag      | Type    | Default | Description                                                    |
| --------- | ------- | ------- | -------------------------------------------------------------- |
| `--print` | boolean | false   | Print the CA cert PEM to stdout (instead of printing its path) |

#### hack global cert

Usage: `hack global cert <hosts...> [options]`

Arguments:

| Name    | Type     | Required | Description                                 |
| ------- | -------- | -------- | ------------------------------------------- |
| `hosts` | string[] | yes      | One or more hostnames to generate certs for |

Options:

| Flag          | Type    | Default         | Description                                 |
| ------------- | ------- | --------------- | ------------------------------------------- |
| `--install`   | boolean | false           | Run mkcert -install before generating certs |
| `--out <dir>` | string  | `~/.hack/certs` | Directory for generated cert/key            |

### hack auth

Usage: `hack auth <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `login` | Open a browser and sign in to Hack auth |
| `logout` | Clear the locally stored Hack auth session |
| `status` | Show whether Hack auth is configured locally |
| `whoami` | Resolve the current Hack auth identity via the broker |
| `invites` | List pending invitations for the authenticated user |
| `invite` | Act on a specific invitation |

#### hack auth login

Usage: `hack auth login [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--no-open` | boolean | false | Print the browser URL instead of opening it automatically |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |
| `--redirect <url>` | string | - | Return to this URL after browser sign-in finishes |

#### hack auth logout

Usage: `hack auth logout [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack auth status

Usage: `hack auth status [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth whoami

Usage: `hack auth whoami [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth invites

Usage: `hack auth invites [options]`

Recipient-side lifecycle command. Lists pending org and team invites that the authenticated user can accept or decline explicitly.

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth invite

Usage: `hack auth invite <subcommand>`

Recipient-side invitation actions. Acceptance and decline stay under `hack auth` so admins cannot implicitly activate access for someone else.

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `accept` | Accept a pending invitation and activate membership |
| `decline` | Decline a pending invitation and mark it removed |

#### hack auth invite accept

Usage: `hack auth invite accept <invite-id> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `invite-id` | string | yes | Pending invite identifier |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth invite decline

Usage: `hack auth invite decline <invite-id> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `invite-id` | string | yes | Pending invite identifier |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

### hack org

Usage: `hack org <subcommand>`

Admin-side organization surface. Org membership is the parent grant for team access.

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `create` | Create an organization without creating any teams implicitly |
| `list` | List organizations visible to the authenticated user |
| `show` | Show one organization and its current membership context |
| `member` | Manage org memberships and invitation lifecycle |

#### hack org create

Usage: `hack org create <slug> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Organization slug |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name <display-name>` | string | - | Human-friendly name to store alongside the slug |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org list

Usage: `hack org list [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org show

Usage: `hack org show <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org member

Usage: `hack org member <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `list` | List org members and pending invites |
| `invite` | Create pending org membership for an email address |
| `add` | Grant active org membership immediately to an existing user |
| `remove` | Remove org membership or cancel a pending org invite |

Lifecycle semantics:

- `invite` creates `pending`
- `add` creates `active`
- `remove` transitions `pending` or `active` membership to `removed`
- Removing org access also transitions matching team memberships and team invites in that organization to `removed`

#### hack org member list

Usage: `hack org member list <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--state <pending|active|removed|all>` | string | - | Filter membership rows by lifecycle state |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- Default output should focus on actionable memberships rather than removed audit history.
- Use `--state removed` or `--state all` to inspect audit-visible removals.

#### hack org member invite

Usage: `hack org member invite <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |
| `target` | string | yes | Invitee email address |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--team <team>` | string | - | Seed one or more team-scoped invites alongside the org invite |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org member add

Usage: `hack org member add <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |
| `target` | string | yes | Existing Hack user id, slug, or email |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- `add` is immediate-access semantics and should fail when the target cannot be resolved to an existing Hack user.
- Use `invite` instead when the person does not already have a Hack account.

#### hack org member remove

Usage: `hack org member remove <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |
| `target` | string | yes | Membership target to revoke or cancel |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack team

Usage: `hack team <subcommand>`

Admin-side team surface. Team membership is always nested under one organization.

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `create` | Create a team inside an existing organization |
| `list` | List teams for one organization |
| `show` | Show one team and its parent org context |
| `member` | Manage team memberships and invitation lifecycle |

#### hack team create

Usage: `hack team create <slug> --org <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Team slug |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--name <display-name>` | string | - | Human-friendly name to store alongside the slug |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- Team creation requires explicit org targeting and does not add members implicitly.

#### hack team list

Usage: `hack team list --org <org> [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team show

Usage: `hack team show <team> --org <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team member

Usage: `hack team member <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `list` | List team members and pending invites |
| `invite` | Create pending team membership for an email address |
| `add` | Grant active team membership immediately to an existing user |
| `remove` | Remove team membership or cancel a pending team invite |

Lifecycle semantics:

- Team membership depends on active org membership in the same organization
- `invite` creates `pending`
- `add` creates `active`
- `remove` transitions `pending` or `active` membership to `removed`
- Removing team access does not change the parent org membership

#### hack team member list

Usage: `hack team member list <team> --org <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--state <pending|active|removed|all>` | string | - | Filter membership rows by lifecycle state |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team member invite

Usage: `hack team member invite <team> --org <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |
| `target` | string | yes | Invitee email address |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- Final implementation should pair this with an org invite when the recipient is not already an org member.

#### hack team member add

Usage: `hack team member add <team> --org <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |
| `target` | string | yes | Existing Hack user id, slug, or email |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team member remove

Usage: `hack team member remove <team> --org <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |
| `target` | string | yes | Membership target to revoke or cancel |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack auth

Usage: `hack auth <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `login` | Open a browser and sign in to Hack auth |
| `logout` | Clear the locally stored Hack auth session |
| `status` | Show whether Hack auth is configured locally |
| `whoami` | Resolve the current Hack auth identity via the broker |
| `invites` | List pending invitations for the authenticated user |
| `invite` | Act on a specific invitation |

#### hack auth login

Usage: `hack auth login [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--no-open` | boolean | false | Print the browser URL instead of opening it automatically |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |
| `--redirect <url>` | string | - | Return to this URL after browser sign-in finishes |

#### hack auth logout

Usage: `hack auth logout [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack auth status

Usage: `hack auth status [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth whoami

Usage: `hack auth whoami [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth invites

Usage: `hack auth invites [options]`

Recipient-side lifecycle command. Lists pending org and team invites that the authenticated user can accept or decline explicitly.

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth invite

Usage: `hack auth invite <subcommand>`

Recipient-side invitation actions. Acceptance and decline stay under `hack auth` so admins cannot implicitly activate access for someone else.

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `accept` | Accept a pending invitation and activate membership |
| `decline` | Decline a pending invitation and mark it removed |

#### hack auth invite accept

Usage: `hack auth invite accept <invite-id> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `invite-id` | string | yes | Pending invite identifier |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth invite decline

Usage: `hack auth invite decline <invite-id> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `invite-id` | string | yes | Pending invite identifier |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

### hack org

Usage: `hack org <subcommand>`

Admin-side organization surface. Org membership is the parent grant for team access.

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `create` | Create an organization without creating any teams implicitly |
| `list` | List organizations visible to the authenticated user |
| `show` | Show one organization and its current membership context |
| `member` | Manage org memberships and invitation lifecycle |

#### hack org create

Usage: `hack org create <slug> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Organization slug |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--name <display-name>` | string | - | Human-friendly name to store alongside the slug |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org list

Usage: `hack org list [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org show

Usage: `hack org show <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org member

Usage: `hack org member <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `list` | List org members and pending invites |
| `invite` | Create pending org membership for an email address |
| `add` | Grant active org membership immediately to an existing user |
| `remove` | Remove org membership or cancel a pending org invite |

Lifecycle semantics:

- `invite` creates `pending`
- `add` creates `active`
- `remove` transitions `pending` or `active` membership to `removed`
- Removing org access also transitions matching team memberships and team invites in that organization to `removed`

#### hack org member list

Usage: `hack org member list <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--state <pending|active|removed|all>` | string | - | Filter membership rows by lifecycle state |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- Default output should focus on actionable memberships rather than removed audit history.
- Use `--state removed` or `--state all` to inspect audit-visible removals.

#### hack org member invite

Usage: `hack org member invite <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |
| `target` | string | yes | Invitee email address |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--team <team>` | string | - | Seed one or more team-scoped invites alongside the org invite |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack org member add

Usage: `hack org member add <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |
| `target` | string | yes | Existing Hack user id, slug, or email |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- `add` is immediate-access semantics and should fail when the target cannot be resolved to an existing Hack user.
- Use `invite` instead when the person does not already have a Hack account.

#### hack org member remove

Usage: `hack org member remove <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `org` | string | yes | Organization slug or id |
| `target` | string | yes | Membership target to revoke or cancel |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack team

Usage: `hack team <subcommand>`

Admin-side team surface. Team membership is always nested under one organization.

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `create` | Create a team inside an existing organization |
| `list` | List teams for one organization |
| `show` | Show one team and its parent org context |
| `member` | Manage team memberships and invitation lifecycle |

#### hack team create

Usage: `hack team create <slug> --org <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | string | yes | Team slug |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--name <display-name>` | string | - | Human-friendly name to store alongside the slug |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- Team creation requires explicit org targeting and does not add members implicitly.

#### hack team list

Usage: `hack team list --org <org> [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team show

Usage: `hack team show <team> --org <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team member

Usage: `hack team member <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `list` | List team members and pending invites |
| `invite` | Create pending team membership for an email address |
| `add` | Grant active team membership immediately to an existing user |
| `remove` | Remove team membership or cancel a pending team invite |

Lifecycle semantics:

- Team membership depends on active org membership in the same organization
- `invite` creates `pending`
- `add` creates `active`
- `remove` transitions `pending` or `active` membership to `removed`
- Removing team access does not change the parent org membership

#### hack team member list

Usage: `hack team member list <team> --org <org> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--state <pending|active|removed|all>` | string | - | Filter membership rows by lifecycle state |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team member invite

Usage: `hack team member invite <team> --org <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |
| `target` | string | yes | Invitee email address |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- Final implementation should pair this with an org invite when the recipient is not already an org member.

#### hack team member add

Usage: `hack team member add <team> --org <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |
| `target` | string | yes | Existing Hack user id, slug, or email |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack team member remove

Usage: `hack team member remove <team> --org <org> <target> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `team` | string | yes | Team slug or id |
| `target` | string | yes | Membership target to revoke or cancel |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--org <org>` | string | - | Parent organization slug or id |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack projects

Usage: `hack projects [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Filter to a registered project name |
| `--details` | boolean | false | Show per-project service tables |
| `--meta` | boolean | false | Include git/worktree/session/env metadata (implies --details) |
| `--include-global` | boolean | false | Include global infra projects under `~/.hack` |
| `--all` | boolean | false | Include unregistered docker compose projects |
| `--json` | boolean | false | Output JSON (machine-readable) |

Subcommand:

#### hack projects prune

Usage: `hack projects prune [options]`

Options:

| Flag               | Type    | Default | Description                                   |
| ------------------ | ------- | ------- | --------------------------------------------- |
| `--include-global` | boolean | false   | Include global infra projects under `~/.hack` |

### hack status

Usage: `hack status [options]`

Options:

| Flag               | Type    | Default | Description                                   |
| ------------------ | ------- | ------- | --------------------------------------------- |
| `--project <name>` | string  | -       | Filter to a registered project name           |
| `--include-global` | boolean | false   | Include global infra projects under `~/.hack` |
| `--all`            | boolean | false   | Include unregistered docker compose projects  |
| `--json`           | boolean | false   | Output JSON (machine-readable)                |

### hack usage

Usage: `hack usage [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Filter to a registered project name |
| `--include-global` | boolean | false | Include global infra projects under `~/.hack` |
| `--watch` | boolean | false | Refresh usage continuously |
| `--interval <ms>` | number | - | Refresh interval (ms) for `--watch` |
| `--no-host` | boolean | false | Skip host process metrics |
| `--json` | boolean | false | Output JSON (machine-readable); not supported with `--watch` |

## Core workflows

### hack init

Usage: `hack init [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--manual` | boolean | false | Skip discovery and define services manually (or generate a minimal compose in --auto) |
| `--auto` | boolean | false | Run non-interactive init with sensible defaults |
| `--name <slug>` | string | - | Project slug (default: repo name) |
| `--dev-host <host>` | string | - | DEV_HOST override |
| `--oauth` | boolean | false | Enable OAuth-safe alias host |
| `--oauth-tld <tld>` | string | `gy` | OAuth alias TLD override |
| `--no-discovery` | boolean | false | Skip discovery and generate a minimal compose |

### hack project

Usage: `hack project [options]`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `owner` | Inspect or manage project ownership |

#### hack project owner show

Usage: `hack project owner show [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--json` | boolean | false | Output JSON (machine-readable) |

Notes:

- This is a read-only ownership inspection surface.
- If the project config cannot be parsed, the command fails instead of guessing a local owner.

### hack up

Usage: `hack up [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `-d`, `--detach` | boolean | false | Run in background (docker compose up -d) |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |
| `--target <auto \| local \| remote>` | string | `auto` | Execution routing target (`auto` follows project execution mode and node affinity) |

### hack down

Usage: `hack down [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |
| `--target <auto \| local \| remote>` | string | `auto` | Execution routing target (`auto` follows project execution mode and node affinity) |

### hack restart

Usage: `hack restart [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |
| `--target <auto \| local \| remote>` | string | `auto` | Execution routing target (`auto` follows project execution mode and node affinity) |

### hack ps

Usage: `hack ps [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack logs

Usage: `hack logs [service] [options]`

Arguments:

| Name      | Type   | Required | Description                                        |
| --------- | ------ | -------- | -------------------------------------------------- |
| `service` | string | no       | Filter logs by service (shortcut for `--services`) |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `-f`, `--follow` | boolean | true | Follow logs (default) |
| `--no-follow` | boolean | false | Print logs and exit |
| `--tail <n>` | number | 200 | Tail last N log lines |
| `--pretty` | boolean | false | Pretty-print logs (best-effort JSON parsing + formatting) |
| `--json` | boolean | false | Output JSON (NDJSON stream) |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |
| `--compose` | boolean | false | Read logs from docker compose (bypass Loki) |
| `--loki` | boolean | false | Force Loki backend (no compose fallback) |
| `--services <csv>` | string | - | Filter Loki logs by service(s), comma-separated |
| `--query <logql>` | string | - | Raw LogQL selector/query |
| `--since <time>` | string | - | Start time for Loki logs (RFC3339 or duration like 15m) |
| `--until <time>` | string | - | End time for Loki logs (RFC3339 or duration like 15m) |

Notes:

- `--compose` cannot be combined with `--loki`, `--services`, `--query`, `--since`, or `--until`.
- `--json` cannot be combined with `--pretty`.
- `--until` cannot be combined with `--follow`.

### hack run

Usage: `hack run <service> [-- <cmd...>] [options]`

Arguments:

| Name      | Type     | Required | Description                                     |
| --------- | -------- | -------- | ----------------------------------------------- |
| `service` | string   | yes      | Compose service name                            |
| `cmd`     | string[] | no       | Command to run (defaults to service entrypoint) |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--workdir <path>` | string | - | Working directory inside the container (docker compose run -w) |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |

### hack open

Usage: `hack open [target] [options]`

Arguments:

| Name     | Type   | Required | Description                                         |
| -------- | ------ | -------- | --------------------------------------------------- |
| `target` | string | no       | `www` (default), `logs`, a subdomain, or a full URL |

Options:

| Flag                 | Type    | Default | Description                                    |
| -------------------- | ------- | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string  | -       | Target a registered project by name            |
| `--branch <name>`    | string  | -       | Run against a branch-specific instance         |
| `--json`             | boolean | false   | Output JSON with `{ "url": "..." }`            |

Notes:

- `hack open` with no target opens `https://<dev_host>.hack`.
- `hack open logs` opens Grafana (`https://logs.hack`).
- If `target` includes a scheme (e.g. `https://...`) it is used as-is.
- If `target` has no dots, it is treated as a subdomain of `dev_host`.

### hack tui

Usage: `hack tui [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

Notes:

- In the TUI, press `i` on a selected lifecycle host process to jump into its interactive mux session (useful for sudo/auth prompts during startup scripts).

### hack branch

Usage: `hack branch <subcommand>`

Subcommands:

| Subcommand | Summary                                  |
| ---------- | ---------------------------------------- |
| `add`      | Register a branch alias for this project |
| `list`     | List registered branch aliases           |
| `remove`   | Remove a branch alias                    |
| `open`     | Open the branch host in a browser        |

#### hack branch add

Usage: `hack branch add <name> [options]`

Arguments:

| Name   | Type   | Required | Description          |
| ------ | ------ | -------- | -------------------- |
| `name` | string | yes      | Branch name or alias |

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |
| `--note <text>`      | string | -       | Optional note for the branch entry             |

#### hack branch list

Usage: `hack branch list [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

#### hack branch remove

Usage: `hack branch remove <name> [options]`

Arguments:

| Name   | Type   | Required | Description          |
| ------ | ------ | -------- | -------------------- |
| `name` | string | yes      | Branch name or alias |

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

#### hack branch open

Usage: `hack branch open <name> [options]`

Arguments:

| Name   | Type   | Required | Description          |
| ------ | ------ | -------- | -------------------- |
| `name` | string | yes      | Branch name or alias |

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

### hack config

Usage: `hack config <subcommand>`

Subcommands:

| Subcommand | Summary                            |
| ---------- | ---------------------------------- |
| `get`      | Read a value from hack.config.json |
| `set`      | Update a value in hack.config.json |

#### hack config get

Usage: `hack config get <key> [options]`

Arguments:

| Name  | Type   | Required | Description                             |
| ----- | ------ | -------- | --------------------------------------- |
| `key` | string | yes      | Dot path (e.g. `logs.snapshot_backend`) |

Options:

| Flag                 | Type    | Default | Description                                    |
| -------------------- | ------- | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string  | -       | Target a registered project by name            |
| `--global`           | boolean | false   | Read global `~/.hack/hack.config.json`         |

#### hack config set

Usage: `hack config set <key> <value> [options]`

Arguments:

| Name    | Type   | Required | Description                                          |
| ------- | ------ | -------- | ---------------------------------------------------- |
| `key`   | string | yes      | Dot path (e.g. `logs.snapshot_backend`)              |
| `value` | string | yes      | JSON value or raw string (parsed as JSON when valid) |

Options:

| Flag                 | Type    | Default | Description                                    |
| -------------------- | ------- | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string  | -       | Target a registered project by name            |
| `--global`           | boolean | false   | Write global `~/.hack/hack.config.json`        |

## Collaboration & integrations

### hack auth

Usage: `hack auth <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `login` | Open a browser and sign in to Hack auth |
| `logout` | Clear the locally stored Hack auth session |
| `status` | Show whether Hack auth is configured locally |
| `whoami` | Resolve the current Hack auth identity via the broker |

#### hack auth login

Usage: `hack auth login [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |
| `--no-open` | boolean | false | Print the browser URL instead of opening it automatically |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |
| `--redirect <url>` | string | - | Return to this URL after browser sign-in finishes |

#### hack auth logout

Usage: `hack auth logout [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |

#### hack auth status

Usage: `hack auth status [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth whoami

Usage: `hack auth whoami [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

## Collaboration & integrations

### hack auth

Usage: `hack auth <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `login` | Open a browser and sign in to Hack auth |
| `logout` | Clear the locally stored Hack auth session |
| `status` | Show whether Hack auth is configured locally |
| `whoami` | Resolve the current Hack auth identity via the broker |

#### hack auth login

Usage: `hack auth login [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |
| `--no-open` | boolean | false | Print the browser URL instead of opening it automatically |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |
| `--redirect <url>` | string | - | Return to this URL after browser sign-in finishes |

#### hack auth logout

Usage: `hack auth logout [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |

#### hack auth status

Usage: `hack auth status [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

#### hack auth whoami

Usage: `hack auth whoami [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON |
| `--broker-url <url>` | string | - | Override the Hack auth broker base URL |

### hack env

Usage: `hack env <subcommand>`

Notes:

- The current `hack env` surface is local-first.
- `hack env set` and `hack env unset` manage local project env state and configured local secret backends.
- Shared env grants, value custody, and rotation are planned as explicit broker-mediated flows rather than
  implicit extensions of local env commands.

Subcommands:

| Subcommand | Summary                                            |
| ---------- | -------------------------------------------------- |
| `list`     | List env contract vars and resolution state        |
| `set`      | Set an env value (.hack/.env or secret backend)    |
| `unset`    | Unset an env value (.hack/.env and secret backend) |
| `backend`  | Manage env/secret backend strategy                 |

#### hack env list

Usage: `hack env list [options]`

Options:

| Flag                 | Type    | Default | Description                                       |
| -------------------- | ------- | ------- | ------------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search)    |
| `--project <name>`   | string  | -       | Target a registered project by name               |
| `--json`             | boolean | false   | Output JSON (machine-readable)                    |
| `--show-secrets`     | boolean | false   | Print secret values (secret backend) in plaintext |

#### hack env set

Usage: `hack env set [spec] [options]`

`spec` can be `KEY` or `KEY=VALUE`. If omitted, hack will prompt interactively.

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--secret` | boolean | false | Store value in configured secret backend instead of .hack/.env |

#### hack env unset

Usage: `hack env unset [key] [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

#### hack env backend

Usage: `hack env backend <subcommand>`

Subcommands:

| Subcommand | Summary                                     |
| ---------- | ------------------------------------------- |
| `status`   | Show configured env/secret backend strategy |
| `use`      | Select env/secret backend strategy          |

#### hack env backend status

Usage: `hack env backend status [options]`

Options:

| Flag     | Type    | Default | Description                    |
| -------- | ------- | ------- | ------------------------------ |
| `--json` | boolean | false   | Output JSON (machine-readable) |

#### hack env backend use

Usage: `hack env backend use <keychain|encrypted_file|cloud> [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--provider <aws \| gcp \| azure \| vault>` | string | - | Cloud provider when backend is `cloud` |
| `--store-path <path>` | string | - | Encrypted file path when backend is `encrypted_file` |
| `--secret-project <id>` | string | - | Optional cloud account/project identifier |
| `--secret-prefix <prefix>` | string | - | Optional cloud secret name prefix |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack session

Usage: `hack session [subcommand]`

With no subcommand, opens an interactive picker of active sessions and available projects.

Subcommands:

| Subcommand | Summary                                    |
| ---------- | ------------------------------------------ |
| `list`     | List active sessions                       |
| `start`    | Start or attach to a session for a project |
| `stop`     | Stop (kill) a session                      |
| `attach`   | Attach to an existing session              |
| `exec`     | Execute a command in a session             |
| `panes`    | List panes in a tmux session               |
| `capture`  | Capture recent output from a tmux session  |
| `tail`     | Tail output from a tmux session            |

#### hack session start

Usage: `hack session start [project] [options]`

Options:

| Flag              | Type    | Default | Description                                   |
| ----------------- | ------- | ------- | --------------------------------------------- |
| `--up`            | boolean | false   | Run hack up -d before attaching               |
| `--new`           | boolean | false   | Force create new session even if one exists   |
| `--name <suffix>` | string  | -       | Custom suffix for new session (e.g., agent-1) |

#### hack session panes

Usage: `hack session panes <session> [options]`

Options:

| Flag       | Type    | Default | Description                          |
| ---------- | ------- | ------- | ------------------------------------ |
| `--json`   | boolean | false   | Output NDJSON stream (start/log/end) |
| `--pretty` | boolean | false   | Output human-friendly text           |

#### hack session capture

Usage: `hack session capture <session> [options]`

Options:

| Flag                | Type    | Default | Description                             |
| ------------------- | ------- | ------- | --------------------------------------- |
| `--target <target>` | string  | -       | Tmux pane target (default: active pane) |
| `--lines <n>`       | number  | 200     | Number of lines to capture              |
| `--json`            | boolean | false   | Output NDJSON stream (start/log/end)    |
| `--pretty`          | boolean | false   | Output human-friendly text              |

#### hack session tail

Usage: `hack session tail <session> [options]`

Options:

| Flag                 | Type    | Default | Description                             |
| -------------------- | ------- | ------- | --------------------------------------- |
| `--target <target>`  | string  | -       | Tmux pane target (default: active pane) |
| `--lines <n>`        | number  | 200     | Number of lines to capture              |
| `--interval-ms <ms>` | number  | 500     | Polling interval in milliseconds        |
| `--max-ms <ms>`      | number  | 5000    | Stop tailing after N milliseconds       |
| `--json`             | boolean | false   | Output NDJSON stream (start/log/end)    |
| `--pretty`           | boolean | false   | Output human-friendly text              |

### hack ssh

Usage: `hack ssh [session] [options]`

Options:

| Flag                  | Type    | Default | Description                                  |
| --------------------- | ------- | ------- | -------------------------------------------- |
| `-H`, `--host <host>` | string  | -       | SSH host (hostname or IP)                    |
| `-u`, `--user <user>` | string  | -       | SSH username                                 |
| `-t`, `--tailscale`   | boolean | false   | Use Tailscale SSH                            |
| `-d`, `--direct`      | boolean | false   | Use direct SSH (requires --host)             |
| `-p`, `--port <port>` | string  | -       | SSH port for direct connection (default: 22) |

### hack tickets

Usage: `hack tickets <args...>`

`hack tickets` is a convenience alias for the tickets extension (`hack x tickets ...`). Run `hack tickets` with no args to see available subcommands.

### hack linear

Usage: `hack linear <args...>`

`hack linear` is a convenience alias for the Linear extension (`hack x linear ...`).
Run `hack linear` with no args to see available subcommands. Use `hack linear status` to check the
active Linear profile, repo route, and available next steps.

Examples:

- `hack linear documents list|pull|plan|apply`
- `hack linear milestones list|pull|plan|apply`
- `hack linear status-updates list|pull|plan|publish`
- `hack linear status-updates publish --path .hack/linear/projects/<project-id>/status-updates/drafts/<yyyy-mm-dd>-<slug>.md`

## Internal commands

### hack internal

Usage: `hack internal <subcommand>`

Subcommands:

| Subcommand    | Summary                             |
| ------------- | ----------------------------------- |
| `extra-hosts` | Manage internal Compose extra_hosts |

#### hack internal extra-hosts

Usage: `hack internal extra-hosts <subcommand> [options]`

Options:

| Flag                  | Type   | Default | Description                       |
| --------------------- | ------ | ------- | --------------------------------- |
| `-p`, `--path <path>` | string | -       | Start directory (defaults to cwd) |

Subcommands:

| Subcommand | Summary                              |
| ---------- | ------------------------------------ |
| `set`      | Set an internal extra_hosts entry    |
| `unset`    | Remove an internal extra_hosts entry |
| `list`     | List internal extra_hosts entries    |

#### hack internal extra-hosts set

Usage: `hack internal extra-hosts set <hostname> <target> [options]`

#### hack internal extra-hosts unset

Usage: `hack internal extra-hosts unset <hostname> [options]`

#### hack internal extra-hosts list

Usage: `hack internal extra-hosts list [options]`

## Beta workflows

### hack gateway

Usage: `hack gateway <subcommand>`

Subcommands:

| Subcommand | Summary                                   |
| ---------- | ----------------------------------------- |
| `enable`   | Enable the gateway and start hackd        |
| `setup`    | Guided gateway setup (enable + token)     |
| `disable`  | Disable the gateway (does not stop hackd) |

#### hack gateway enable

Usage: `hack gateway enable [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

#### hack gateway setup

Usage: `hack gateway setup [options]`

Options:

| Flag                 | Type    | Default | Description                                         |
| -------------------- | ------- | ------- | --------------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search)      |
| `--project <name>`   | string  | -       | Target a registered project by name                 |
| `--qr`               | boolean | true    | Force QR output after setup (default)               |
| `--no-qr`            | boolean | false   | Skip QR output after setup                          |
| `--yes`              | boolean | false   | Skip confirmation prompts when printing QR payloads |

#### hack gateway disable

Usage: `hack gateway disable [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

### hack node

Usage: `hack node <subcommand>`

Subcommands:

| Subcommand     | Summary                                                       |
| -------------- | ------------------------------------------------------------- |
| `init`         | Initialize this host as a node and emit enrollment bundle     |
| `pair`         | Pair node with one-command or expiring verification-code flow |
| `ssh`          | Manage SSH bootstrap for node pairing and remote runs         |
| `add`          | Add a node from an enrollment bundle                          |
| `list`         | List registered nodes                                         |
| `status`       | Probe node health and report live status                      |
| `use`          | Set default node                                              |
| `remove`       | Remove node registration                                      |
| `workspace`    | Inspect and repair node workspace map entries                 |
| `routes`       | Inspect and repair controller-side remote route bridge        |
| `provider`     | Manage provider-specific node bootstrap workflows             |
| `devcontainer` | Manage remote node devcontainer lifecycle and attach hints    |

Examples:

```bash
# on a node host
hack node init --name "aws-dev-1" --endpoint "https://gateway.example.com"

# one-command pairing from controller with host-only inference (source + endpoint auto-detected)
hack node pair --host "node-a.tailnet.ts.net" --name "aws-dev-1" --default

# one-command pairing from controller (works with Tailscale DNS/IP too)
hack node pair --source "remote-user@node-a.tailnet.ts.net" --endpoint "http://127.0.0.1:7788" --name "aws-dev-1" --default

# node-initiated publish of pairing request to controller (creates inbox entry)
hack node pair request --controller "you@controller-mac.local" --source "remote-user@node-a.tailnet.ts.net" --endpoint "http://127.0.0.1:7788" --default

# interactive pairing walkthrough (guided prompts + remote approve/complete)
hack node pair walkthrough --source "remote-user@node-a.tailnet.ts.net" --endpoint "http://127.0.0.1:7788" --default

# secure pairing ceremony (expiring code)
hack node pair start --source "remote-user@node-a.tailnet.ts.net" --endpoint "http://127.0.0.1:7788" --name "aws-dev-1"
# review pending requests (controller inbox)
hack node pair list --status pending
# on node (or over ssh), using session + code from start output
hack node pair approve --session <pair-session-id> --code <one-time-code> --endpoint "http://127.0.0.1:7788" --json > approved-bundle.json
# back on controller
hack node pair complete --session <pair-session-id> --bundle approved-bundle.json --default
# controller one-shot approve + complete for existing pending request
hack node pair fulfill --session <pair-session-id> --code <one-time-code> --default

# repair/setup passwordless SSH explicitly (also run automatically by `hack node pair`)
hack node ssh setup --source "remote-user@node-a.tailnet.ts.net"

# on controller
hack node add --bundle ./node-bundle.json
hack node list
hack node status --watch
hack node use <node-id>

# inspect/repair node workspace mappings on a remote node host
ssh <user@node-host> 'hack node workspace list --json'
ssh <user@node-host> 'hack node workspace resolve --project <name|id> --json'
ssh <user@node-host> 'hack node workspace attach --project <name|id> --path <absolute-path> --json'
ssh <user@node-host> 'hack node workspace remove --project <name|id> --json'

# inspect/repair controller-side remote route bridge
hack node routes status
hack node routes status --json
hack node routes repair

# Railway provider bootstrap (existing service + auto domain endpoint)
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-name>" \
  --railway-environment production \
  --default

# Railway provider bootstrap (create service from node runtime image first)
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --create-service \
  --railway-service hack-node-runtime \
  --railway-image hackdance/hack:latest \
  --name "railway-node-1" \
  --labels railway,linux,container \
  --default

# Railway provider bootstrap (private tailnet endpoint, no public domain)
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-name>" \
  --railway-private \
  --tailscale-auth-key "tskey-auth-..." \
  --default

# Railway provider bootstrap (private auth key from global config)
hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].config.authKey' "tskey-auth-..."
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-name>" \
  --railway-private \
  --default

hack node devcontainer up --node <node-id> --project my-project --branch feature/foo
hack node devcontainer attach --node <node-id> --id <session-id> --ide vscode --ssh-host node.example.com --ssh-alias hack-node-dev
```

`hack node status --watch` uses a short-lived auth lookup cache (60s) to avoid repeated macOS keychain prompts while polling.

`hack node devcontainer attach` supports SSH-specific guidance flags:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--ssh-host <host>` | string | node endpoint host | Override SSH host used in attach commands |
| `--ssh-port <port>` | number | `22` | SSH port for attach commands |
| `--ssh-user <user>` | string | - | Optional SSH user |
| `--ssh-alias <alias>` | string | `hack-node-<id-prefix>` | Alias used for Remote-SSH commands |

### hack node workspace

Usage: `hack node workspace <subcommand>`

Subcommands:

| Subcommand | Summary                                                |
| ---------- | ------------------------------------------------------ |
| `list`     | List node-local workspace map entries                  |
| `resolve`  | Resolve a map entry by controller project selector     |
| `attach`   | Attach an existing local workspace to project selector |
| `remove`   | Remove a map entry by project selector                 |

Examples:

```bash
hack node workspace list --json
hack node workspace resolve --project my-project --json
hack node workspace attach --project my-project --path "$HOME/.hack/projects/my-project" --json
hack node workspace remove --project my-project --json
```

### hack node routes

Usage: `hack node routes <subcommand>`

Subcommands:

| Subcommand | Summary                                             |
| ---------- | --------------------------------------------------- |
| `status`   | Show controller-side remote route bridge state      |
| `repair`   | Re-render and re-apply persisted route bridge stack |

Examples:

```bash
hack node routes status
hack node routes status --json
hack node routes repair
```

### hack dispatch

Usage: `hack dispatch <subcommand>`

Subcommands:

| Subcommand | Summary                                  |
| ---------- | ---------------------------------------- |
| `run`      | Dispatch a command to a node workspace   |
| `status`   | Show dispatched run status               |
| `logs`     | Show or follow persisted/remote run logs |

#### hack dispatch run

Usage: `hack dispatch run --project <name|id> [options] -- <command...>`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name \| id>` | string | - | Project name or id |
| `--node <id \| default \| auto>` | string | auto | Target node id, or use default/auto |
| `--provider <provider>` | string | - | Provider route override used when resolving profile/bootstrap intent |
| `--profile <profile-id>` | string | - | Provider profile route override |
| `--bootstrap-if-needed` | boolean | false | Allow guarded provider bootstrap handoff when no reachable node is found |
| `--branch <branch>` | string | current | Target branch on selected node |
| `--ticket <ticket-id>` | string | - | Ticket id to associate with run metadata |
| `--runner <generic \| codex \| claude \| cursor>` | string | `generic` | Runner identity for policy and audit |
| `--approve` | boolean | false | Approve high/critical risk commands non-interactively |
| `--pr` | boolean | false | Push branch + create/update GitHub PR on successful run |
| `--pr-base <branch>` | string | `main` | Base branch used with `--pr` |
| `--pr-title <title>` | string | auto | Override PR title |
| `--pr-body <markdown>` | string | auto | Override PR body |
| `--github-profile <profile-id>` | string | inherited | GitHub profile override for `--pr` mode |
| `--json` | boolean | false | Output machine-readable run payload |

Note: when the target node does not already have the project workspace, dispatch sends bootstrap metadata (git origin + project name) to `/v1/node/workspaces/ensure` so the node can clone/register the repo automatically.

Route precedence for dispatch:

1. Command flags (`--node`, `--provider`, `--profile`).
2. Project `controlPlane.execution.nodeId` (fallback: legacy `controlPlane.nodeId`).
3. Project `controlPlane.routing.provider/profile`.
4. Global `controlPlane.providers.defaultProvider/defaultProfile`.
5. Provider hard defaults.

GitHub profile precedence for `--pr`:

1. Command `--github-profile`.
2. Project `controlPlane.routing.overrides.github.profile`.
3. Global `controlPlane.extensions["dance.hack.github"].config.defaultProfile`.

Scope note for `--pr`:

- `hack dispatch run --pr` currently covers the PR update workflow only: push the branch, then create or update the PR.
- It does not imply broader GitHub workflow support such as review submission, standalone PR comments, merge actions, or repo-admin actions.
- The broader first-class GitHub workflow model lives in the GitHub extension docs and `docs/plans/2026-03-13-github-first-class-workflows-design.md`, and is intentionally sequenced beyond the current `--pr` path.

`--pr` requires GitHub auth to resolve for the selected profile. Set that up with
`hack x github oauth-connect` or `hack x github connect` before using PR automation.

#### hack dispatch status

Usage: `hack dispatch status <run-id> [--json]`

#### hack dispatch logs

Usage: `hack dispatch logs <run-id> [--follow] [--tail <n>] [--json]`

### hack remote

Usage: `hack remote <subcommand>`

If you run `hack remote` with no subcommand, it prints status and offers to run setup.

Subcommands:

| Subcommand | Summary                              |
| ---------- | ------------------------------------ |
| `setup`    | Run the guided gateway setup         |
| `status`   | Show remote/gateway status           |
| `monitor`  | Open a remote status TUI             |
| `qr`       | Print a QR payload for remote access |

#### hack remote setup

Usage: `hack remote setup [options]`

Options:

| Flag                 | Type    | Default | Description                                         |
| -------------------- | ------- | ------- | --------------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search)      |
| `--project <name>`   | string  | -       | Target a registered project by name                 |
| `--qr`               | boolean | true    | Force QR output after setup (default)               |
| `--no-qr`            | boolean | false   | Skip QR output after setup                          |
| `--yes`              | boolean | false   | Skip confirmation prompts when printing QR payloads |

#### hack remote status

Usage: `hack remote status [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

#### hack remote monitor

Usage: `hack remote monitor [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string | -       | Run against a repo path (overrides cwd search) |
| `--project <name>`   | string | -       | Target a registered project by name            |

#### hack remote qr

Usage: `hack remote qr [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--gateway-url <url>` | string | - | Gateway base URL to embed in QR output |
| `--token <token>` | string | - | Gateway token to embed in QR output |
| `--ssh` | boolean | false | Emit an SSH QR payload instead of a gateway payload |
| `--ssh-host <host>` | string | - | SSH host for QR payload (required with --ssh) |
| `--ssh-user <user>` | string | - | SSH user for QR payload (defaults to `$USER` when set) |
| `--ssh-port <port>` | number | - | SSH port for QR payload (omitted defaults to 22) |
| `--yes` | boolean | false | Skip confirmation before printing sensitive QR payloads |

## Extension commands

### hack x

Usage: `hack x <namespace> <command> [args...]`

Arguments:

| Name   | Type     | Required | Description                             |
| ------ | -------- | -------- | --------------------------------------- |
| `args` | string[] | no       | Extension command args (passed through) |

Notes:

- `hack x list` lists available extensions.
- `hack x <namespace> help` lists commands for a namespace.

## Agent integrations

### hack setup

Usage: `hack setup <subcommand>`

Subcommands:

| Subcommand | Summary                                                |
| ---------- | ------------------------------------------------------ |
| `cursor`   | Install Cursor rules for hack CLI usage                |
| `claude`   | Install Claude Code hooks for hack CLI usage           |
| `codex`    | Install Codex skill for hack CLI usage                 |
| `tickets`  | Install Codex skill for hack tickets usage             |
| `agents`   | Install AGENTS.md / CLAUDE.md snippets                 |
| `sync`     | Refresh agent docs, skills, and MCP configs            |
| `mcp`      | Install MCP configs for hack CLI usage (no-shell only) |

#### hack setup cursor

Usage: `hack setup cursor [options]`

Options:

| Flag                 | Type    | Default | Description                                      |
| -------------------- | ------- | ------- | ------------------------------------------------ |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search)   |
| `--global`           | boolean | false   | Use global (user) scope instead of project scope |
| `--check`            | boolean | false   | Check whether integration is installed           |
| `--remove`           | boolean | false   | Remove integration files/config                  |

#### hack setup claude

Usage: `hack setup claude [options]`

Options:

| Flag                 | Type    | Default | Description                                      |
| -------------------- | ------- | ------- | ------------------------------------------------ |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search)   |
| `--global`           | boolean | false   | Use global (user) scope instead of project scope |
| `--check`            | boolean | false   | Check whether integration is installed           |
| `--remove`           | boolean | false   | Remove integration files/config                  |

#### hack setup codex

Usage: `hack setup codex [options]`

Options:

| Flag                 | Type    | Default | Description                                      |
| -------------------- | ------- | ------- | ------------------------------------------------ |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search)   |
| `--global`           | boolean | false   | Use global (user) scope instead of project scope |
| `--check`            | boolean | false   | Check whether integration is installed           |
| `--remove`           | boolean | false   | Remove integration files/config                  |

#### hack setup agents

Usage: `hack setup agents [options]`

Options:

| Flag                 | Type    | Default | Description                                    |
| -------------------- | ------- | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search) |
| `--all`              | boolean | false   | Target all supported docs                      |
| `--agents-md`        | boolean | false   | Target AGENTS.md                               |
| `--claude-md`        | boolean | false   | Target CLAUDE.md                               |
| `--check`            | boolean | false   | Check whether integration is installed         |
| `--remove`           | boolean | false   | Remove integration files/config                |

#### hack setup sync

Usage: `hack setup sync [options]`

Options:

| Flag                 | Type    | Default | Description                                    |
| -------------------- | ------- | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search) |
| `--global`           | boolean | false   | Target global (user) scope only                |
| `--all-scopes`       | boolean | false   | Target both project and global (user) scopes   |
| `--check`            | boolean | false   | Check whether integrations are installed       |
| `--remove`           | boolean | false   | Remove generated integration files/config      |

Automatic guardrail:

- In interactive project sessions, `hack` auto-checks docs/skills/MCP drift and attempts auto-sync.
- Override mode with `HACK_SETUP_SYNC_MODE=warn` (warn-only) or `HACK_SETUP_SYNC_MODE=off` (disable).

#### hack setup mcp

Usage: `hack setup mcp [options]`

Options:

| Flag                 | Type    | Default | Description                                      |
| -------------------- | ------- | ------- | ------------------------------------------------ |
| `-p`, `--path <dir>` | string  | -       | Run against a repo path (overrides cwd search)   |
| `--global`           | boolean | false   | Use global (user) scope instead of project scope |
| `--all`              | boolean | false   | Target all supported clients                     |
| `--cursor`           | boolean | false   | Target Cursor integration                        |
| `--claude`           | boolean | false   | Target Claude integration                        |
| `--codex`            | boolean | false   | Target Codex integration                         |
| `--check`            | boolean | false   | Check whether integration is installed           |
| `--remove`           | boolean | false   | Remove integration files/config                  |

### hack agent

Usage: `hack agent <subcommand>`

Subcommands:

| Subcommand | Summary                         |
| ---------- | ------------------------------- |
| `prime`    | Print agent primer text         |
| `patterns` | Print agent init patterns guide |
| `init`     | Print agent init prompt         |

#### hack agent init

Usage: `hack agent init [options]`

Options:

| Flag                    | Type   | Default | Description                                    |
| ----------------------- | ------ | ------- | ---------------------------------------------- |
| `-p`, `--path <dir>`    | string | -       | Run against a repo path (overrides cwd search) |
| `-c`, `--client <cursor \| claude \| codex \| print>` | string | - | Open init prompt in an agent client (or print) |

### hack mcp

Usage: `hack mcp <subcommand>`

Subcommands:

| Subcommand | Summary                                  |
| ---------- | ---------------------------------------- |
| `serve`    | Run the MCP server over stdio            |
| `install`  | Install MCP config for supported clients |
| `print`    | Print MCP config snippets                |

#### hack mcp install

Usage: `hack mcp install [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `--scope <user \| project>` | string | `user` | Write MCP config to user or project scope |
| `-p`, `--path <dir>` | string    | -       | Run against a repo path (overrides cwd search) |
| `--all`              | boolean   | false   | Target all supported clients                   |
| `--cursor`           | boolean   | false   | Target Cursor MCP config                       |
| `--claude`           | boolean   | false   | Target Claude CLI MCP config                   |
| `--codex`            | boolean   | false   | Target Codex MCP config                        |
| `--docs`             | boolean   | false   | Update AGENTS.md and CLAUDE.md with hack usage |
| `--agents-md`        | boolean   | false   | Update AGENTS.md with hack usage               |
| `--claude-md`        | boolean   | false   | Update CLAUDE.md with hack usage               |

Notes:

- For `--scope project`, `hack mcp install` updates `AGENTS.md` + `CLAUDE.md` by default when no docs flags are provided.
- Use `--scope user` to skip project-doc updates and write only user-level MCP configs.

#### hack mcp print

Usage: `hack mcp print [options]`

Options:

| Flag                 | Type   | Default | Description                                    |
| -------------------- | ------ | ------- | ---------------------------------------------- |
| `--scope <user \| project>` | string | `user` | Print MCP config for user or project scope |
| `-p`, `--path <dir>` | string    | -       | Run against a repo path (overrides cwd search) |
| `--all`              | boolean   | false   | Target all supported clients                   |
| `--cursor`           | boolean   | false   | Target Cursor MCP config                       |
| `--claude`           | boolean   | false   | Target Claude CLI MCP config                   |
| `--codex`            | boolean   | false   | Target Codex MCP config                        |

## Diagnostics commands

### hack doctor

Usage: `hack doctor [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--fix` | boolean | false | Attempt safe auto-remediations (network + CoreDNS + CA) |

### hack crash-capture

Usage: `hack crash-capture [options]`

Collects a post-failure bundle under `.tmp/crash-capture-<timestamp>/` including:

- `metadata.json` with platform/project context
- `commands.json` with command outcomes
- `docker` / `hack` snapshots
- macOS unified log slices (OrbStack + kernel container events) when available

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Capture against a repo path (overrides cwd search) |
| `--since <duration>` | string | `45m` | Look-back window for system logs (for example: `30m`, `2h`) |

### hack daemon

Usage: `hack daemon <subcommand>`

Subcommands:

| Subcommand  | Summary                                    |
| ----------- | ------------------------------------------ |
| `start`     | Start hackd (local daemon)                 |
| `stop`      | Stop hackd                                 |
| `restart`   | Restart hackd                              |
| `status`    | Show hackd status                          |
| `metrics`   | Show hackd metrics                         |
| `logs`      | Show hackd logs                            |
| `clear`     | Clear stale hackd pid/socket files         |
| `install`   | Install hackd as a launchd service (macOS) |
| `uninstall` | Uninstall hackd launchd service (macOS)    |

Autostart + self-heal behavior:

- `controlPlane.daemon.autoStart` controls whether CLI flows auto-recover hackd when the socket is missing.
- On macOS, auto-recovery prefers launchd management and keepalive before CLI fallback starts.
- Configure with:
  - `hack config set --global 'controlPlane.daemon.autoStart' true`
  - `hack config set --global 'controlPlane.daemon.launchd.runAtLoad' true`
  - `hack config set --global 'controlPlane.daemon.launchd.guiSessionOnly' true`

#### hack daemon start

Usage: `hack daemon start [options]`

Options:

| Flag           | Type    | Default | Description                         |
| -------------- | ------- | ------- | ----------------------------------- |
| `--foreground` | boolean | false   | Run hackd in the foreground (debug) |

#### hack daemon status

Usage: `hack daemon status [options]`

Options:

| Flag     | Type    | Default | Description                                                    |
| -------- | ------- | ------- | -------------------------------------------------------------- |
| `--json` | boolean | false   | Output JSON (machine-readable, includes launchd info on macOS) |

#### hack daemon logs

Usage: `hack daemon logs [options]`

Options:

| Flag         | Type   | Default | Description           |
| ------------ | ------ | ------- | --------------------- |
| `--tail <n>` | number | 200     | Tail last N log lines |

#### hack daemon install

Usage: `hack daemon install [options]`

Installs hackd as a launchd service on macOS. The daemon will be managed by launchd and can optionally start automatically on login.

Options:

| Flag               | Type    | Default | Description                               |
| ------------------ | ------- | ------- | ----------------------------------------- |
| `--run-at-load`    | boolean | true    | Start hackd automatically on login        |
| `--no-run-at-load` | boolean | -       | Do not start hackd automatically on login |
| `--gui-only`       | boolean | true    | Only run in GUI sessions (Aqua)           |
| `--no-gui-only`    | boolean | -       | Run in all session types (including SSH)  |

The service uses the label `dance.hack.hackd` and writes its plist to `~/Library/LaunchAgents/dance.hack.hackd.plist`.

#### hack daemon uninstall

Usage: `hack daemon uninstall`

Uninstalls the hackd launchd service on macOS. Removes the plist and unloads the service from launchd.

### hack log-pipe

Usage: `hack log-pipe [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--format <auto \| docker-compose \| plain>` | string | `auto` | How to parse incoming lines from stdin |
| `--stream <stdout \| stderr>` | string | `stdout` | Treat stdin as stdout or stderr |

### hack help

Usage: `hack help [path...]`

Arguments:

| Name   | Type     | Required | Description                                        |
| ------ | -------- | -------- | -------------------------------------------------- |
| `path` | string[] | no       | Command path to show help for (e.g. `global logs`) |

### hack update

Usage: `hack update [options]`

Options:

| Flag          | Type    | Default | Description                                    |
| ------------- | ------- | ------- | ---------------------------------------------- |
| `--check`     | boolean | false   | Check for updates (do not install)             |
| `--yes`       | boolean | false   | Apply update without prompting                 |
| `--tag <tag>` | string  | -       | Update to a specific release tag (e.g. v1.4.0) |
| `--json`      | boolean | false   | Output JSON (machine-readable)                 |

### hack version

Usage: `hack version`

## Secrets

### hack secrets

Usage: `hack secrets <subcommand>`

Subcommands:

| Subcommand | Summary                            |
| ---------- | ---------------------------------- |
| `set`      | Store a secret                     |
| `get`      | Print a secret (exit 1 if missing) |
| `delete`   | Delete a stored secret             |

Options (all subcommands):

| Flag                  | Type   | Default    | Description                       |
| --------------------- | ------ | ---------- | --------------------------------- |
| `--service <service>` | string | `hack-cli` | Override Bun.secrets service name |

Arguments (set/get/delete):

| Name   | Type   | Required | Description                       |
| ------ | ------ | -------- | --------------------------------- |
| `name` | string | no       | Secret name (prompted if omitted) |

## Fun

### hack the planet

Usage: `hack the planet [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--variant <cut \| mash \| cycle \| random>` | string | `cycle` | Animation variant |
| `--loop`        | boolean | true    | Loop until Ctrl+C |
