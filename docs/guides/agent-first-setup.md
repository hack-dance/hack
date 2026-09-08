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
| An agent session with the hack skills installed | `/hack-init` |
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

`hack setup claude` and `hack setup codex` install a thin `hack-init` skill
(`.claude/skills/hack-init/SKILL.md` / `.codex/skills/hack-init/SKILL.md`).
The skill tells the agent to run `hack agent onboard` (or fetch the `hack-init`
MCP prompt) and follow it — the content stays in the CLI, so installed skills
fetch guidance matching the installed CLI.

## What the prompt covers

1. Inventory — package manager, services, ports, backing services, and required
   variable names. Preserve the existing credential flow without copying secrets.
2. Setup — configure the requested container or host workflow, routing, and managed
   env injection. Verify replacements before removing any old env files.
3. Platform nuances — isolate Linux native dependencies from host installs when
   needed. Reuse existing tooling; add an ops container only when justified.
4. Running things — choose `hack run`, `hack exec`, or `hack host exec` for the target.
5. Verification — check expected long-running services, successful one-shot exits,
   actual routed URLs with normal TLS verification, and the requested host workflow.
   Preserve native trust approvals, ownership, and destructive-cleanup gates.
   Unrelated optional integration warnings do not block completion.

## Partial adoption (backing services only)

Choose the shape that fits the requested workflow. Hack can run only the backing
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
- Stable hostnames and TLS for HTTP services and admin UIs via Caddy. Raw database
  protocols use their configured host ports or container-network addresses.
- Branch instances for the containerized services (`--branch <name>`), even though
  the host-run app processes are not branch-isolated on their own.
- Managed environment configuration and secret injection. Commit only non-secret
  values; use the configured secret backend for credentials.
- Lifecycle hooks (`startup`/`lifecycle` in `.hack/hack.config.json`) for host-side
  setup — tunnels, SSO bootstrap — that would otherwise be ad-hoc terminal steps.

**How to wire it:**
- Define only the backing services in `.hack/docker-compose.yml`; add Caddy labels
  where a stable hostname is useful (databases usually don't need one — connect by
  container port — but admin UIs, queues, or shared services often do).
- Give host dev servers their connection info via `hack host exec --scope <svc> --
  <cmd>` (injects the resolved env without touching `.env` files) without exposing secret values.
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
prompt for the requested scope. Preserve native approvals, existing credential
flows, runtime ownership, and publishing gates. If the CLI is missing, report
that blocker and continue independent setup work. Verify the chosen services
and host workflows, and distinguish reachability from certificate trust.
```
