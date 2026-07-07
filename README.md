<p align="center">
  <img alt="Hack" src="./apps/macos/512@2x.png" width="160" />
</p>

# Hack

Hack is a local-first developer runtime for repo environments.

It gives each project a predictable local runtime, stable HTTPS hostnames, resolved environment
variables, persistent work sessions, diagnostics, and optional git-backed tickets without requiring a
hosted Hack service.

## What Hack Does

Hack is built for local development on machines that run many projects, branches, agents, and
supporting services at the same time.

- Start and stop project runtimes with `hack up`, `hack down`, and `hack restart`.
- Open stable local HTTPS URLs like `https://myapp.hack` with `hack open`.
- Route service subdomains through local Caddy and trusted development TLS.
- Resolve env overlays and secrets from `.hack/` and inject them into compose, host commands, and sessions.
- In a linked git worktree, `hack up` defaults to a branch instance named after the worktree's git
  branch (opt out with `worktree.auto_branch=false`, or target one explicitly with `--branch <name>`).
- Keep tmux-backed project workspaces alive with `hack session`.
- Diagnose Docker, DNS, TLS, env, lifecycle, and stale runtime state with `hack doctor` /
  `hack doctor --fix`.
- Script and automate against a stable surface: `--no-interactive` (or `HACK_NO_INTERACTIVE=1`)
  never prompts, and `up`/`down`/`restart`/`doctor --json` emit a `{ok, data | error: {code,
  message}}` envelope; `NO_COLOR` disables ANSI output.
- Track optional repo-local work with the opt-in `hack tickets` extension.
- Use a slim macOS companion for local project status, controls, logs, and quick actions.

Hack v3 is intentionally self-contained. The supported product is the local CLI/runtime and macOS
companion. Hosted auth, account/org/team management, the web dashboard, built-in GitHub workflows,
and built-in Linear sync are not part of the v3 product.

## Install

Homebrew:

```bash
brew tap hack-dance/tap
brew install hack-dance/tap/hack
```

Shell installer:

```bash
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-install.sh \
  | bash
```

Codex or managed container installer:

```bash
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-codex-install.sh \
  | bash
```

## Quick Start

Bootstrap the global local infrastructure once:

```bash
hack global install
```

Initialize a repo:

```bash
cd /path/to/project
hack init
```

Prefer an agent to drive setup? `hack init --with claude|codex|both` hands the onboarding prompt to
an agent CLI for a new repo; `hack agent onboard` does the same for an existing project.

Run it:

```bash
hack up --detach
hack open
hack logs --pretty
```

Stop it:

```bash
hack down
```

If anything looks wrong, start with:

```bash
hack doctor
hack doctor --fix
```

## Daily Commands

```bash
hack status
hack ps
hack restart
hack open
hack logs --pretty
hack logs <service>
hack exec <service> -- bun test
hack run <service> -- bun db:migrate
hack projects prune
```

`hack projects prune` removes stale entries from the local project registry and stops orphaned
containers.

Host-side commands can use the same resolved project env:

```bash
hack host exec --scope api -- bun test
hack host shell --env qa --scope api
```

Persistent workspaces:

```bash
hack session
hack session start <project>
hack session exec <workspace> "bun test"
```

Optional repo-local tickets (opt-in extension, not part of default agent instructions — `hack tickets
setup` is the one subcommand that bypasses the enable check and auto-enables the extension):

```bash
hack tickets setup
hack tickets create --title "Fix lifecycle cleanup"
hack tickets list
hack tickets show T-00001
hack tickets status T-00001 in_progress
```

## Env And Secrets

Hack uses YAML env files in `.hack/` as the source of truth:

```text
.hack/hack.env.default.yaml
.hack/hack.env.<overlay>.yaml
.hack/hack.env.local.yaml
.hack/hack.env.<overlay>.local.yaml
```

Shared files can be committed. `*.local.yaml` files are worktree-local overrides. Hack owns a
committed `.hack/.gitignore` that keeps machine-local generated files (`.internal/`, `.branch/`,
`.env`, `.env.state.json`, `hack.env*.local.yaml`) out of git; it self-heals on `init`/`up`, and if
generated files ever leak into git, `hack doctor --fix` untracks them (files stay on disk).

Runtime commands read the YAML model directly. Use `hack env materialize` only when an external tool
needs a compatibility `.hack/.env` file on disk.

Secret key lookup is local-first:

1. current checkout `.hack.secret.key`
2. shared key under the git common dir for linked worktrees
3. key inherited from the primary checkout's `.hack.secret.key` (linked worktrees)
4. `HACK_ENV_SECRET_KEY`

Use `HACK_ENV_SECRET_KEY` in CI and managed containers instead of copying `.hack.secret.key` into an
image.

Read more in [Env & secrets](./docs/env.md).

## Lifecycle Processes

Projects often need host-side setup before the compose stack starts: AWS SSO, SSM tunnels, local
proxies, database forwards, or one-off bootstrap commands.

Put that work in `.hack/hack.config.json` under `lifecycle` or `startup` so Hack can run it
consistently during `hack up` and clean up the processes it owns during `hack down`.

For fixed-port helpers, use `singleton.ports` and usually `onConflict: "adopt"` when an existing
healthy listener set should be reused instead of starting duplicate tunnel stacks.

Read more in [Lifecycle](./docs/lifecycle.md).

## Portable Containers

Hack publishes runtime images to Docker Hub and GHCR.

```bash
docker pull hackdance/hack:latest
docker pull hackdance/hack:slim
```

Use `hackdance/hack:latest` when you want the fuller runtime image with Docker CLI, compose, and
remote-node support available.

Use `hackdance/hack:slim` as a smaller base for Codex, CI, or managed containers where you want
`hack`, Bun, env resolution, sessions, and tickets without the full host stack.

For reproducible remote or managed environments, install project dependencies normally, install Hack,
and pass `HACK_ENV_SECRET_KEY` at runtime so encrypted project env can be resolved. Set `HACK_HOME`
alongside it when you also want to redirect global state (registry, daemon, secrets) to an isolated
root instead of `~/.hack`.

Start with [Codex managed environments](./docs/guides/codex-managed-environments.md) for a concrete
setup guide.

## macOS Companion

The macOS app is a thin local companion for Hack-managed projects.

It provides:

- project list and project detail
- global runtime and daemon status
- `up`, `down`, `restart`, and `open` actions
- log entrypoints and a Ghostty-backed bottom panel
- doctor and trust guidance
- menu bar quick actions

The CLI remains the source of truth. The app is there to make local runtime state easier to see and
operate.

## Documentation

Start here:

- [Core docs](./docs/core.md)
- [CLI reference](./docs/cli.md)
- [Initialize a project](./docs/guides/init-project.md)
- [Env & secrets](./docs/env.md)
- [Lifecycle](./docs/lifecycle.md)
- [Sessions](./docs/sessions.md)
- [Tickets](./docs/guides/tickets.md)
- [Portable Codex environments](./docs/guides/codex-managed-environments.md)
- [Architecture](./docs/architecture.md)

Reference and advanced material:

- [Docs index](./docs/README.md)
- [Extensions and reference](./docs/reference.md)
- [Integrations boundary](./docs/integrations.md)
- [Unsupported experimental beta workflows](./docs/beta.md)

Remote, gateway, node, and dispatch commands remain source-available but unsupported experimental.
They are not required for the default local development path.
