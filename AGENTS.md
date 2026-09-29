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

Carry authorized work through implementation and verification. Continue independent
work while a material question is pending. User instructions take precedence over
skill defaults, subject to higher-priority rules. If a guidance file actually blocks
progress, identify the file and exact rule; do not invent an approval requirement.

## Working context

Read only the focused guide needed for the task:

- [Code quality](.ai/skills/hack-repo-code-quality/SKILL.md): TypeScript/Rust, state and OS boundaries.
- [Verification](.ai/skills/hack-repo-verify/SKILL.md): commands, harnesses, models and proof limits.
- [Work units](.ai/skills/hack-repo-work-unit/SKILL.md): acceptance, feedback loops and experiments.
- [Performance](.ai/skills/hack-repo-performance/SKILL.md): matched benchmarks and resource accounting.
- [TLA+](.ai/skills/hack-repo-tla/SKILL.md): repo-local models, checker tools and trace validation.
- [Operating layer](.ai/README.md): contributor skills, ownership and maintenance.

Internal plans and specs belong in gitignored `_docs/`; never force-add that archive.
Fresh clones do not include it. Linear's Hack project is the v5 planning and status
source of truth; use the work-unit skill below for its program links. The local
`_docs/docs/plans/v5/work-units.md` ledger is supporting context when available,
not a competing backlog. Keep small fixes lightweight.
Report what changed, evidence, and open gates concisely. A component pass is not
whole-product parity, lower resource use, or release readiness.

## Source and conventions

- `src/`, `index.ts`, `packages/cli/`: CLI and runtime code.
- `packages/runtime-core/`: private Rust v5 candidate; `hack-local` is its isolated
  checkout launcher. Follow its [README](packages/runtime-core/README.md).
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
Document public contracts and non-obvious invariants, especially ownership, failure,
concurrency, cancellation and recovery. Keep platform effects behind explicit boundaries.

## Verification

Prefer the repository's Hack-managed `toolchain` service for portable checks; see
[.hack/README.md](.hack/README.md). Use the current branch CLI as the outer command
when testing Hack behavior. Keep host-native virtualization, routing/trust, and
resource benchmarks on the host they qualify. Container checks do not replace them.

For a behavior change, add or update the closest regression test and affected docs.
Run focused checks first, then required CI gates. Documentation-only changes need
link, generation, and contract checks rather than artificial unit tests.
After applicable checks pass, broaden or repeat them only for a new change, failure,
or unresolved concern. Do not skip a required gate or weaken an assertion to get green.

- Build current-branch behavior with `bun run build`; test `./dist/hack`, not an
  unrelated installed version. Use `bun index.ts` for a source invocation.
- CLI typecheck/lint: `bun run --cwd packages/cli typecheck` and
  `bun run --cwd packages/cli check`. Lint changed scripts/tests explicitly as well.
- Full gates: `bun run typecheck`, `bun run check`, `bun run test`.
- CLI interface changes: regenerate `docs/reference/cli.md` with
  `bun run docs:cli-reference`.
- Consumer agent guidance changes: regenerate the affected repository examples and plugin
  bundle (`bun run generate:agent-plugins`); verify consumer renderers stay aligned.
  Do not refresh the contributor's global configuration as a side effect.
  See `docs/agent-guidance.md` for ownership and generation details.
- Rust changes: run `bun run check:local` and `bun run test:local` with the pinned
  toolchain; add all-feature checks for feature-dependent code. The toolchain service
  provides portable `rust`/`rust-check` tasks; native effects require native tests.
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

Base v5 candidate and prerelease implementation PRs on the protected `next` branch;
keep stable-line work targeted at `main`. Verify each PR's base and exact-head checks
before reporting readiness. This does not authorize a merge or publication.

Record useful decisions or regressions in the closest source, test, or doc. When fclt
is available and writeback is authorized, use a project writeback with a concrete
asset and evidence. Drafting does not authorize global promotion or canonical apply.
Do not require fclt, create tickets, start automations, or produce handoff paperwork
for every task. Create follow-up records only for actionable work within authorization.

For the authorized v5 program, use the Linear Hack project as the planning/status
source of truth and preserve repository specs, models and evidence. Read
`.ai/skills/hack-repo-work-unit/SKILL.md` for milestone mapping and checkpoint updates;
the local reconciliation map is `_docs/docs/plans/v5/linear-sync.md`. Update existing
issues with meaningful outcomes, evidence and remaining gates rather than creating
duplicates. Distinguish canceled legacy scope, historical component completion and
current application acceptance. Keep private logs and secrets out of Linear.
