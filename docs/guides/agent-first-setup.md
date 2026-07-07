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
never go stale on substance.

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

## Copy-paste bootstrap

Paste this into a fresh Claude Code / Codex session started at the repo root:

```text
Set this repository up to run under the hack CLI. Run `hack agent onboard`
(pass --no-interactive to hack commands) and follow the printed onboarding
prompt exactly, phase by phase. If the hack CLI is missing, stop and tell me.
Finish only when `hack doctor` is clean and every routable service responds.
```
