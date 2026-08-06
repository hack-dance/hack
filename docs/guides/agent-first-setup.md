# Agent-first setup

Let a coding agent (Claude Code, Codex) stand a project up under hack — or adopt an
existing setup — instead of doing it by hand. One canonical onboarding prompt drives
every entry point below; the content lives in the CLI, so it is always current for
your installed version.

## Entry points (same prompt, four ways in)

| You have | Use |
| --- | --- |
| A fresh repo + an agent CLI installed | `hack init --with claude\|codex\|both` |
| An existing hack project | `hack agent onboard` (prints the prompt) |
| A Codex session with the Hack plugin installed | `/hack-init` |
| A no-shell MCP client | the `hack-init` MCP prompt (`hack setup mcp`) |

## New repo: `hack init --with`

```bash
cd /path/to/repo
hack init --auto --with claude   # or codex, or both
```

- Runs the normal init, then launches the agent CLI interactively with the full
  onboarding prompt (`claude "<prompt>"` / `codex "<prompt>"`).
- If the agent CLI is not on PATH, the prompt is printed with copy-paste
  instructions instead.
- If `.hack/` already exists, init is skipped and the handoff proceeds in
  existing-project mode.
- With `--no-interactive` (or `HACK_NO_INTERACTIVE=1`, or no TTY) nothing is
  spawned — the prompt is always printed.

## Existing project: `hack agent onboard`

```bash
hack agent onboard          # prints the onboarding prompt for this project
hack agent onboard | pbcopy # copy it for any agent session
```

The prompt picks up the project name and dev host from `.hack/hack.config.json`
when present.

## Agent-side skill: `/hack-init`

The official Hack plugins for Cursor, Claude Code, and Codex bundle the same `hack-init` skill;
run `hack setup cursor`, `hack setup claude`, or `hack setup codex` for exact marketplace guidance.
The skill tells the agent to run `hack agent onboard` (or fetch the
`hack-init` MCP prompt) and follow it — the content stays in the CLI, so installed skills never go
stale on substance.

## What the prompt covers

1. Inventory — package manager, workspaces, services and ports, databases/queues,
   `.env*` files (they become `hack env` candidates), scripts that need env.
2. Setup — `hack init --auto` or config edits, compose services with Caddy labels
   on the `hack-dev` network, dev_host/subdomain design, `hack env add`
   (`--secret` for secrets; `.env` files get replaced by hack env +
   `hack host exec`).
3. Platform nuances — deps container pattern (named `node_modules` volume so
   macOS-host installs never poison linux containers) and an ops/tooling
   container for migrations and one-off jobs.
4. Running things — the `hack run` / `hack exec` / `hack host exec` /
   Caddy-hostname decision guide.
5. Verification loop — `hack up --json` → `hack ps --json` → `hack open --json`
   → curl or `hack logs`, iterating until `hack doctor` is clean.

## Partial adoption (backing services only)

Full containerization (every process in compose) is the default recommendation, but
it is not the only supported shape. hack works fine running only the backing
services — postgres, temporal, redis, and similar — while app dev servers (`bun
dev`, `dotnet watch`, `vite`) stay on the host.

**When to choose it:**
- Heavy native toolchains (.NET, large native builds) develop faster on the host
  than in a container.
- The hot-path dev server (the one you restart constantly) benefits from host-native
  file watching, debuggers, or hot reload that containers make slower or flakier.
- The team already has a working host-based dev workflow and containerizing it is
  not worth the churn.

**What hack still gives you in this shape:**
- Stable hostnames and TLS for the backing services via Caddy (`postgres.<project>.hack`,
  `temporal.<project>.hack`, ...), so host processes and containers address them the
  same way.
- Branch instances for the containerized services (`--branch <name>`), even though
  the host-run app processes are not branch-isolated on their own.
- Committed, hack-managed env (`hack env add`) for connection strings and secrets,
  instead of hand-maintained `.env` files.
- Lifecycle hooks (`startup`/`lifecycle` in `.hack/hack.config.json`) for host-side
  setup — tunnels, SSO bootstrap — that would otherwise be ad-hoc terminal steps.

**How to wire it:**
- Define only the backing services in `.hack/docker-compose.yml`; add Caddy labels
  where a stable hostname is useful (databases usually don't need one — connect by
  container port — but admin UIs, queues, or shared services often do).
- Give host dev servers their connection info via `hack host exec --scope <svc> --
  <cmd>` (injects the resolved env without touching `.env` files) or `hack env list`
  for a one-off lookup.
- App URLs can stay on plain `localhost:<port>` for the fast path, or get promoted
  to a routed compose service later if you want a stable `*.hack` hostname for them
  too — the two are not mutually exclusive and can be migrated incrementally.

**Tradeoffs vs full containerization:**
- No single `hack up` brings up the whole stack for a newcomer — they still need to
  start the host dev servers themselves (document that step).
- Host-run app processes are not branch-isolated by hack; running two branches side
  by side means varying ports/env per worktree yourself.

Partial adoption is a valid end state, not an incomplete migration — do not treat it
as something to "finish" into full containerization unless the tradeoffs above
actually bite.

## Copy-paste bootstrap

Paste this into a fresh Claude Code / Codex session started at the repo root:

```text
Set this repository up to run under the hack CLI. Run `hack agent onboard`
(pass --no-interactive to hack commands) and follow the printed onboarding
prompt exactly, phase by phase. If the hack CLI is missing, stop and tell me.
Finish only when `hack doctor` is clean and every routable service responds.
```
