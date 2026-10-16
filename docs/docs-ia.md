# Docs IA

This page defines the documentation buckets referenced from [docs/README.md](README.md) and the
placement rules for new docs. If you're looking for the docs themselves, start at
[docs/README.md](README.md); this page is for deciding where a doc (or a doc change) belongs.

## The three buckets

### 1. Core (`docs/core.md` index)

The default local-first product story: everything a new user or agent needs without opting into
remote/control-plane features.

- `README.md` — product boundary and quick start
- `docs/core.md` — core docs index
- `docs/architecture.md` — local-first runtime architecture
- `docs/env.md` — env model and secret handling
- `docs/lifecycle.md` — lifecycle hooks and startup processes
- `docs/sessions.md` — persistent workspace model
- `docs/guides/init-project.md` — project init walkthrough
- `docs/guides/global-settings.md` — global config
- `docs/guides/agent-first-setup.md` — agent-assisted onboarding (`hack init --with`, `hack agent onboard`)
- `docs/guides/prerequisite-detection-matrix.md` — environment prerequisite checks
- Generated agent-facing guidance: `AGENTS.md`/`CLAUDE.md` snippets, `.codex/skills/hack-cli/SKILL.md`,
  and `hack-init` skill/MCP prompt content, all rendered from `src/agents/instruction-source.ts`
  (canonical source) via `src/agents/*` and `src/mcp/agent-docs.ts`.

New docs belong here when they describe supported v3 CLI surface a user hits without opting into
remote/gateway/node/dispatch: project lifecycle, env, sessions, worktrees, diagnostics (`hack doctor`),
JSON/`--no-interactive` agent ergonomics, and onboarding.

### 2. Beta (`docs/beta.md` index)

Unsupported experimental remote/control-plane workflows: gateway exposure, remote nodes, remote
execution, remote supervisor jobs. These commands are hidden from default `hack --help` output
(visible via `hack help --all`) and print a warning when invoked.

- `docs/beta.md` — beta docs index
- `docs/gateway.md` — gateway overview
- `docs/supervisor.md` — supervisor jobs
- `docs/guides/remote-node-quickstart.md`, `remote-node-laptop-e2e.md`, `remote-node-railway.md`,
  `remote-node-container.md` — remote node setup paths
- `docs/guides/remote-ssh.md`, `remote-cloudflare.md`, `remote-tailscale.md` — gateway exposure paths
- `docs/guides/remote-supervisor.md` — remote supervisor jobs
- `docs/guides/codex-managed-environments.md` — portable managed-container setup with
  `HACK_ENV_SECRET_KEY` (listed in beta because managed-container orchestration builds on the
  remote/node surface, even though the underlying slim-mode CLI behavior is supported)

New docs belong here when they document `hack remote`/`hack gateway`/`hack node`/`hack dispatch`,
anything gated behind the experimental warning, or workflows that only make sense once a user has
opted into that surface.

### 3. Extensions & reference (`docs/reference.md` index)

Lower-level and generated reference material: full command reference, extension authoring,
control-plane SDK, and API-level detail for the beta surface.

- `docs/reference.md` — reference docs index
- `docs/reference/cli.md` — **generated** exhaustive CLI reference (every command, subcommand,
  option, and flag). Regenerate with `bun run docs:cli-reference`; do not hand-edit.
- `docs/cli.md` — hand-written overview of the supported v3 command surface; links to
  `docs/reference/cli.md` for exhaustive flags instead of duplicating them
- `docs/extensions.md` — extension model, dispatch (`hack x <namespace> <command>`), built-in extensions
- `docs/integrations.md` — what shipped, what was removed, optional agent-setup helpers
- `docs/guides/create-extension.md` — how to author a new extension
- `docs/gateway-api.md` — gateway HTTP/WS API surface (unsupported experimental)
- `docs/sdk.md` — control-plane SDK

New docs belong here when they are exhaustive/generated references, or when they document how to
extend `hack` (authoring extensions, SDK usage) rather than how to use it.

## Placement rules for branch-specific surfaces

- **AX surface** (`--json` envelope, `E_*` error codes, `--no-interactive` / `HACK_NO_INTERACTIVE`,
  `NO_COLOR`): document once in `docs/cli.md` (overview) and `docs/reference/cli.md` (generated,
  per-command); cross-reference from `docs/core.md` and `README.md` rather than restating in every doc.
- **Linked worktrees** (`worktree.auto_branch`, secret-key inheritance via the git common dir,
  `hack doctor` divergent-key checks): core bucket — `docs/architecture.md` and `README.md`.
- **e2e suite** (`bun run test:e2e:local`, `tests/e2e/`): not a user-facing doc surface; mention in
  passing in `docs/README.md` "Repo notes" as how docs claims get verified, not as its own page.
- **Agent onboarding** (`hack init --with`, `hack agent onboard`, `/hack-init` skill, `hack-init`
  MCP prompt): core bucket — `docs/guides/agent-first-setup.md` is the canonical guide.
- **Committed `.hack/.gitignore` + `hack doctor --fix` untracking**: core bucket —
  `docs/architecture.md` and `docs/env.md`.
- **`HACK_HOME`**: core bucket — `docs/architecture.md` (global file locations) and `README.md`
  (env var reference) wherever `~/.hack` is introduced.
- **`hack projects prune`**: core bucket — `docs/core.md` day-to-day workflows and `docs/cli.md`
  command overview.

## Generated-docs contract

`docs/reference/cli.md` is generated from the command specs (`bun run docs:cli-reference`) and
must not be hand-edited. Agent-facing instruction surfaces (`AGENTS.md`/`CLAUDE.md` snippets, the
Codex skill, Cursor rules, the session primer) are all rendered from the canonical section list in
`src/agents/instruction-source.ts`; update that file, not the individual renderers, when agent
guidance needs to change, then regenerate.

## Other repo doc locations (not part of the public docs IA)

- `docs/plans/` — historical design/plan notes, not the supported product contract.
- `.factory/validation/` — historical evidence from retired hosted/web/integration work, not
  current product guidance.
- `.factory/library/` and `.factory/skills/` — current worker context for the factory tooling.
