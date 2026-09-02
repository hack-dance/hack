# Architecture

Durable architecture rules for current Hack work.

## Core Product Boundary

- Hack v3 is CLI-first, local-first, and self-contained.
- Supported product surface: project init, local runtime orchestration, routing/TLS, env and secrets, lifecycle, sessions, diagnostics, MCP/agent setup, and the slim macOS companion.
- Retired product surfaces: hosted auth, account/org/team admin, web dashboard, Hack Tickets, built-in GitHub workflows, and built-in Linear sync.
- Remote/gateway/node/dispatch code may remain source-available, but it is unsupported experimental and must stay out of first-run docs, release gates, and default agent paths.

## Runtime Ownership

- `hack` is the source of truth for project start/stop/open/logs/session flows.
- `.hack/.internal/**` and `.hack/.branch/**` are generated runtime state and should not be hand-edited.
- Branch/worktree instances must clean up only their own runtime, lifecycle, and generated state.
- Doctor output should classify recovery as restartable, repairable, or configuration drift and give one concrete next command.

## Env Ownership

- Canonical shared env files are `.hack/hack.env.default.yaml` and optional `.hack/hack.env.<overlay>.yaml`.
- Worktree-local overrides are `.hack/hack.env.local.yaml` and `.hack/hack.env.<overlay>.local.yaml`.
- `.hack/.env` and `.hack/.env.state.json` are derived compatibility artifacts, not runtime source of truth.
- Secret-key lookup order is checkout-local `.hack.secret.key`, git-common-dir shared key for linked worktrees, then `HACK_ENV_SECRET_KEY`.

## Lifecycle Ownership

- Long-running host helpers belong in `lifecycle.processes` or `startup` entries with `persistent: true`.
- Fixed-port helpers such as AWS SSM tunnels should declare `singleton.ports`.
- Use `onConflict: "adopt"` only when a complete existing listener set is equivalent and should be reused.
- `singleton` adoption is listener-level reuse, not ownership transfer; Hack must leave adopted external processes running on `hack down`.
- Stale mux state should be recovered through lifecycle metadata carefully enough to avoid orphaning Hack-owned processes while not broadening cleanup to unrelated process groups.
