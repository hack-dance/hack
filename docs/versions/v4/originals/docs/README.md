# Docs

Hack runs the whole project — services, env, secrets, TLS, logs — at its own local
HTTPS URL, for every project on your machine at once. These docs cover how.

The docs are split into three areas so the default path stays on core local workflows.

## Choose a path

### [Core docs](core.md)

Use this path for the main product story:

- local project setup (including agent-assisted onboarding via `hack init --with` / `hack agent onboard` — see the [agent-first setup guide](guides/agent-first-setup.md))
- isolated runtime orchestration (including branch instances and linked worktrees)
- stable local hostnames
- env and secret management
- lifecycle hooks
- persistent sessions
- diagnostics (`hack doctor` / `hack doctor --fix`)

Start here if you want to understand and use `hack` without remote or beta complexity by default.

### [Beta workflows](beta.md)

Use this path when you intentionally want remote and control-plane features:

- gateway exposure
- remote nodes
- remote execution
- remote supervisor jobs

Beta material stays accessible, but it is explicitly labeled as unsupported experimental and kept
out of the default path.

### [Extensions & reference](reference.md)

Use this path for:

- full command reference: [CLI overview](cli.md) plus the generated [CLI reference](reference/cli.md) (every command and flag)
- extension configuration and authoring
- integrations
- gateway API and SDK details

This section is easy to find, but it does not lead the product story.

## Quick links

- New to `hack`: [Core docs](core.md)
- Setting up with a coding agent: [Agent-first setup](guides/agent-first-setup.md)
- Reviewing watcher, worktree-down, or disposable cache behavior:
  [Development runtime safety](guides/development-runtime-safety.md)
- Looking for command or API details: [Extensions & reference](reference.md), including the generated [CLI reference](reference/cli.md)
- Need unsupported experimental remote workflows: [Beta workflows](beta.md)
- Need the bucket definitions: [Docs information architecture](docs-ia.md)

## Repo notes

- Working notes and historical design docs live in `docs/plans/`; they are not the supported product contract
- Root scripts orchestrate workspace tasks through Turbo
- Package-local commands remain available via `bun run --cwd <workspace> <script>`
- Agent-facing docs and setup output are generated from `src/agents/instruction-source.ts` via `src/agents/*` and `src/mcp/agent-docs.ts`; update the canonical source (not the rendered surfaces) when changing AGENTS/Codex/MCP guidance.
- The generated [CLI reference](reference/cli.md) is rendered from the command spec (`bun run docs:cli-reference`); a drift test fails when it is stale.
- End-to-end coverage that backs docs claims lives in `tests/e2e/` (`bun run test:e2e:local`).
- `.factory/validation/` contains historical evidence from retired hosted/web/integration work and is not the current product contract.
