# Contributing to Hack

## Scope and authority

Hack's supported product is the local-first CLI: project setup, container runtime,
routing/TLS, environment management, host commands, lifecycle processes, sessions,
diagnostics, daemon, and optional agent integrations.

Hosted account/auth/team flows, the web dashboard, Hack Tickets, and built-in
GitHub/Linear integrations are retired. Remote/gateway/node/dispatch and the retained
macOS app are unsupported; work on them only when explicitly requested. Do not add
them to onboarding, default workflows, or core release requirements.

Preserve existing user changes. Infer routine details from the request and code;
ask only when a gap blocks correctness or authority. Existing authorization covers
the same action and scope. Honor read-only requests and native credential approvals.
Publishing, production changes, destructive operations, and broader configuration
changes still need authorization for their actual scope. Never bypass a protected
branch or publishing gate merely to finish a task.

## Source and conventions

- `src/`, `index.ts`, `packages/cli/`: CLI and runtime code.
- `src/agents/instruction-source.ts`: canonical consumer guidance. Onboarding prompts
  live in `src/agents/onboarding-prompt.ts`; client renderers own framing only.
- `plugins/hack/`: generated optional plugin bundle. `docs/` contains product docs.
- `packages/db/` and `services/`: retained internal code; not default hosted dependencies.
- For explicitly requested native work, read `apps/macos/AGENTS.md`.

Use the Bun version pinned in `package.json`, and `bun install --frozen-lockfile`.
Use strict TypeScript, named option objects where they improve call clarity, and
`unknown` plus narrowing for untrusted values. Follow the repository's Biome/Ultracite
configuration rather than maintaining a second formatting specification here.
Prefer existing patterns and Bun APIs; do not migrate unrelated dependencies.
Keep `src/commands/project.ts` and `src/commands/global.ts` small: extract decision
logic into focused helpers with meaningful tests when complexity grows.

## Verification

For a behavior change, add or update the closest regression test and affected docs.
Run focused checks first, then required CI gates. Documentation-only changes need
link, generation, and contract checks rather than artificial unit tests.

- Build current-branch behavior with `bun run build`; test `./dist/hack`, not an
  unrelated installed version. Use `bun index.ts` for a source invocation.
- CLI typecheck/lint: `bun run --cwd packages/cli typecheck` and
  `bun run --cwd packages/cli check`. Lint changed scripts/tests explicitly as well.
- Full gates: `bun run typecheck`, `bun run check`, `bun run test`.
- CLI interface changes: regenerate `docs/reference/cli.md` with
  `bun run docs:cli-reference`.
- Agent guidance changes: regenerate the affected repository examples and plugin
  bundle (`bun run generate:agent-plugins`); verify consumer renderers stay aligned.
  Do not refresh the contributor's global configuration as a side effect.
  See `docs/agent-guidance.md` for ownership and generation details.
- Use `tests/e2e/` for CLI workflows. Run runtime tests in isolated fixtures; do not
  overlap stateful tests against the same checkout, daemon, ports, or containers.

Match proof to the behavior: env changes need overlay/target/worktree coverage;
lifecycle changes need shell, stdin, process-group, ownership and recovery coverage;
agent changes need source/render parity and actual client loading when relevant.
Distinguish local tests, hosted CI, installed versions, and published artifacts.
A required check failing is a blocker; unrelated optional integration warnings are not.

## Runtime and secrets

Use Hack for its managed runtime. Never hand-edit `.hack/.internal/` or `.hack/.branch/`.
Inspect with `hack doctor` and apply only authorized repairs. Do not kill or prune
resources without proving ownership. Preserve native trust and destructive-cleanup gates.
Use managed env injection for commands needing secrets; never print secrets or place
them in prompts, command arguments, logs, or source control. Read only non-secret
configuration and variable names when inspecting setup.

## Commits, releases, and writeback

Use Conventional Commits. A squash PR title must carry the final release intent:
`feat` for optional capabilities, `fix` for corrections, and `!` plus migration detail
for breaking changes. Describe the final behavior, validation, release signal, and
material remaining gaps in the PR. Let the repository's release workflow publish;
verify the release and installed executable separately.

Record useful decisions or regressions in the closest source, test, or doc. When fclt
is available and writeback is authorized, use a project writeback with a concrete
asset and evidence. Drafting does not authorize global promotion or canonical apply.
Do not require fclt, create tickets, start automations, or produce handoff paperwork
for every task. Create follow-up records only for actionable work within authorization.
