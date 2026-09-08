# Hack contributor workflow

Read [AGENTS.md](AGENTS.md) for the product boundary, authority, conventions, and
verification requirements. Consumer setup is documented separately in
[agent integrations](docs/integrations.md).

1. Identify the requested behavior, affected source, and evidence needed. Keep simple
   work implicit; make uncertain or consequential scope explicit.
2. Install the pinned dependencies with `bun install --frozen-lockfile`.
3. Change the closest source and relevant tests/docs. Build with `bun run build` and
   exercise `./dist/hack` for current-branch CLI behavior.
4. Run focused tests and the required typecheck, lint, test, and E2E gates for the diff.
   Do not run runtime/lifecycle tests concurrently against shared fixtures.
5. Regenerate changed CLI references and agent/plugin outputs. Repository generation
   must not change the developer's global client settings.
6. Review and publish through the normal PR/release gates when authorized. State
   separately what passed locally, on CI, in an installed client, and after release.
7. Preserve useful learning in the closest durable asset. Create tickets or other
   follow-up records only for actionable, authorized work.

Useful commands:

```bash
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli check
bun test tests/<relevant-suite>.test.ts
bun run test:e2e:local
bun run docs:cli-reference
bun run generate:agent-plugins
```

The retained macOS app and remote/gateway/node/dispatch paths are unsupported and
excluded from normal product/release work. Use their scoped docs only for explicit
maintenance requests.
