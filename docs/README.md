# Hack documentation

Hack manages local project services, environment variables, secrets, HTTPS routing,
logs and sessions. Start with [Core docs](core.md) or the
[Agent-first setup guide](guides/agent-first-setup.md).

## Guides and reference

- [Project setup](guides/init-project.md)
- [Environment and secrets](env.md)
- [Lifecycle hooks and startup](lifecycle.md)
- [Persistent sessions](sessions.md)
- [Worktrees, watchers and dependency caches](guides/development-runtime-safety.md)
- [Global settings](guides/global-settings.md)
- [macOS browser connectivity](guides/macos-browser-network.md) and [certificate trust](guides/macos-certificate-trust.md)
- [Managed container environments](guides/codex-managed-environments.md)
- [CLI overview](cli.md) and [generated command reference](reference/cli.md)
- [Architecture](architecture.md)
- [Agent integrations](integrations.md) and [guidance maintenance](agent-guidance.md)
- [Extensions and reference](reference.md)

Remote/gateway/node/dispatch and the retained macOS app are unsupported. Historical
setup guides and internal plans are excluded from the public documentation.

## Contributing

Read [AGENTS.md](../AGENTS.md) and the repository skills in `.ai/skills/` for
contributor workflows. Public docs describe supported behavior; private planning,
review notes and historical evidence belong in the gitignored `_docs/` directory.
That local archive is not included in a fresh clone.

The command reference is generated with `bun run docs:cli-reference`. Agent-facing
setup content is generated from `src/agents/instruction-source.ts` and
`src/agents/onboarding-prompt.ts`. End-to-end checks live in `tests/e2e/`.
