# Docs IA

Primary v3 docs:

- `README.md` — product boundary and quick start
- `docs/cli.md` — supported CLI surface
- `docs/env.md` — env model and secret handling
- `docs/architecture.md` — local-first runtime architecture
- `docs/sessions.md` — persistent workspace model
- `docs/guides/tickets.md` — optional local ticket workflow
- `docs/guides/codex-managed-environments.md` — portable managed-container setup with `HACK_ENV_SECRET_KEY`
- `.codex/skills/hack-cli/SKILL.md`, `AGENTS.md`, and setup templates in `src/agents/` / `src/mcp/agent-docs.ts` — generated agent-facing local-first guidance

Experimental-only docs:

- `docs/gateway.md`
- `docs/guides/remote-*`

Historical design docs remain under `docs/plans/` but are not the supported product contract.

Factory validation artifacts under `.factory/validation/` are historical evidence from pre-v3 work.
They are not current product guidance; use `.factory/library/` and `.factory/skills/` for current worker context.
