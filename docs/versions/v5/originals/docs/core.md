# Core Docs

Core docs are the default path through `hack`.

This section stays focused on local project orchestration: initialize a repo, run it on an isolated
network, reach it on stable local hostnames, manage env and lifecycle, and keep working sessions
alive. You do not need gateway, remote nodes, or extension setup to use this path.

## Start here

- [Initialize a project](guides/init-project.md) — or let an agent drive it with
  `hack init --with claude|codex` (existing projects: `hack agent onboard`)
- [Architecture](architecture.md)
- [Env & secrets](env.md)
- [Lifecycle](lifecycle.md)
- [Sessions](sessions.md)
- [macOS certificate trust](guides/macos-certificate-trust.md)
- [CLI overview](cli.md) — supported command surface and agent/scripted ergonomics

## Day-to-day core workflows

- Install + quick start: [root README](../README.md)
- Local runtime checks:
  - `hack up --detach`
  - `hack open`
  - `hack logs --pretty`
  - `hack status` / `hack ps`
  - `hack down` / `hack restart`
- If runtime state looks wrong, run `hack doctor`, then `hack doctor --fix` before manual repair.
- `hack up`/`down`/`restart`/`doctor` accept `--json` for a stable `{ok, data | error: {code,
  message}}` envelope with `E_*` error codes, and a global `--no-interactive` (or
  `HACK_NO_INTERACTIVE=1`) so scripted/agent runs never block on prompts.
- In a linked git worktree, `hack up` defaults to a branch instance named after the worktree's git
  branch (`worktree.auto_branch`), and the secret key is inherited automatically from the primary
  checkout via the shared git common dir. A detached linked worktree has no branch name to derive;
  pass `--branch <name>`, or set `worktree.auto_branch=false` when intentionally targeting the base
  instance.

## Reference

Use [Reference](reference.md) for the full command table and extension authoring.
