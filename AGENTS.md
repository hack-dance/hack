
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Coding Style & Naming Conventions

TypeScript (strict). Runtimes: Bun 1.3+, Node 23. Prettier: 2 spaces, no semicolons, double quotes, width 100. Import order: @ianvs/prettier-plugin-sort-imports + Tailwind plugin. ESLint (flat): any disallowed; unused vars warned (prefix \_ to ignore). Naming: React components PascalCase; files kebab-case (e.g., user-profile.ts); packages @repo/<name>. Comments: avoid writing inline comments everywhere, unless absolutely necessary for a todo or an important thing to take note of. Instead write tsdoc style block level comments at the method/class/function/route level. Focus on comments that provide value in regards to better type inference and clarity of usage. Using things like params/returns/etc..

Always default to useing named paramaters in functions eg myFunction({ ctx, other }) vs myFunction(ctx, other)
Never use any types and always default to leveraging generics and smart types to sensure the best possible tpye inference across the project.

## Commits And Releases

- Use Conventional Commits for every commit you author in this repo.
- Format commits as `<type>(<scope>): <summary>` when a scope is useful, or `<type>: <summary>` when it is not.
- Prefer these types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `revert`.
- Use `feat` for user-facing capability changes that should trigger a feature release signal.
- Use `fix` for behavior corrections, regressions, and release-blocking repairs.
- Use `build` or `ci` for release pipeline, packaging, notarization, versioning, or workflow-only changes.
- Do not use vague commit subjects like `update stuff`, `misc fixes`, or `wip`.
- If a change is breaking, mark it explicitly with `!` in the type or scope position and include a `BREAKING CHANGE:` footer explaining the migration impact.
- If work lands through a squash merge, the PR title must also follow Conventional Commits so release automation can classify it correctly.
- Before pushing or merging, make sure the final commit history or squash title still preserves the intended release signal.
- Every PR must make the release decision explicit: should this change trigger a release signal, and if not, why not.
- If a changeset or equivalent release artifact is expected for that release signal, include it in the same patch instead of leaving the decision to bot feedback.

## Verification Guardrails

- Docs currency is non-negotiable: ANY interface or behavior change (commands, flags, config keys, file layouts, env vars, defaults) must update the affected docs/ pages in the same patch — no matter what.
- The CLI reference is generated: after changing the CLI surface, run `bun run docs:cli-reference` and commit `docs/reference/cli.md` (a drift test fails otherwise).
- Agent-facing behavior phrasing lives in `src/agents/instruction-source.ts`; update it (not the generated surfaces) and run `hack setup sync --all-scopes`.
- If a change affects `hack run`, `hack exec`, env resolution, runtime-state reconciliation, or lifecycle shell/process semantics, the patch must include both targeted tests and matching docs updates.
- For env-sensitive command changes, verify the requested env, effective env, cached runtime-state env, and target-service-running matrix instead of a single happy path.
- For lifecycle changes, verify `sh -c` semantics, process-group cleanup, stale pane/process metadata reconciliation, and interactive stdin behavior.
- Real end-to-end coverage lives in `tests/e2e/` (`bun run test:e2e:local`, docker tier via `test:e2e:local:docker`) — extend it when adding user-facing workflows.
- When a semantic contract changes, update the closest durable doc or skill instruction in the same patch so future work starts from the current rules.

## Command Complexity

- Treat `src/commands/project.ts` and `src/commands/global.ts` as complexity-sensitive surfaces.
- Before adding new branch-heavy logic there, prefer extracting a small helper with a narrow contract and direct tests.
- Do not grow top-level command handlers when the real change is a decision table, state transition, or reusable readiness check.

## Landing the Plane (Session Completion)
**When ending a work session**, you MUST complete ALL steps below.

**MANDATORY WORKFLOW:**
1. **File tickets for remaining work** - Create tickets for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Hand off** - Provide context for next session


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun x ultracite fix` before committing to ensure compliance.

<!-- hack:agent-docs:start -->
## hack CLI (local dev + MCP)

Use `hack` as the single interface for local-first runtime orchestration (compose, DNS/TLS, logs, env, and persistent project workspaces).

Integration freshness:
- These instructions were generated by hack CLI v3.5.1; treat cached rules from another version as potentially stale.
- At session start, audit project and global integrations with `hack setup sync --all-scopes --check`.
- If anything is stale, missing, or deprecated, run `hack setup sync --all-scopes`, then reload the agent session so cached instructions are replaced.
- Never copy or hand-edit generated Hack rules to refresh them; update the CLI and run the sync command.
- Content revision: `6ef36575c6e7` (version alone is not a freshness guarantee).

Product boundary:
- Supported v3 surface: project init, up/down/restart, open, logs, env, host exec/shell, sessions, doctor, and daemon.
- Removed surfaces: hosted auth/account/org/team flows, web dashboard, built-in GitHub workflows, and built-in Linear sync.
- Experimental and unsupported: remote/gateway/node/dispatch commands. They are hidden from default help (list with `hack help --all`) and warn on use; do not use them unless explicitly requested.

Operating rules:
- Prefer `hack` over raw `docker` / `docker compose` for project workflows.
- Do not start/stop services from Docker Desktop UI for `hack`-managed projects.
- Treat `.hack/.internal` and `.hack/.branch` as hack-managed artifacts; do not hand-edit generated files there.
- Use `--json` for machine-readable output when available; `hack up/down/restart/doctor --json` emit an `{ok, data | error: {code, message}}` envelope with stable E_* error codes.
- Scripted/agent runs: pass `--no-interactive` (or set `HACK_NO_INTERACTIVE=1`) so commands never block on prompts — they apply documented defaults or fail fast with E_INTERACTIVE_REQUIRED.
- Use MCP only when shell access is unavailable.
- If runtime state looks wrong, run `hack doctor`, then `hack doctor --fix` before manual repair.

Core objects:
- Project: a repo with `.hack/` config + compose file.
- Service: a compose service (e.g. api, web, worker).
- Instance: a running project; branch instances are separate copies started with `--branch`.

Config + schema:
- Project config: `.hack/hack.config.json`
- Global config: `~/.hack/hack.config.json`
- Schema URL: `https://schemas.hack/hack.config.schema.json`
- Prefer CLI writes: `hack config get <path>`, `hack config set <path> <value>`, `hack config set --global <path> <value>`

Hostname routing + Caddy labels:
- Primary host comes from `dev_host` (default: `<project>.hack`).
- Subdomain pattern is `<sub>.<dev_host>` (for example: `api.myapp.hack`).
- OAuth alias (when enabled) also routes `<dev_host>.<tld>` and `<sub>.<dev_host>.<tld>` (default tld: `gy`).
- Browser launches automatically prefer a routed OAuth alias when enabled; custom development hosts outside `.hack` stay on the primary host. Set `open.prefer` or pass `hack open --prefer <auto|alias|dev>` to override.
- Not every compose service is routable: only services with Caddy labels and on `hack-dev` are exposed.
- Required labels for HTTP services: `caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`.
- Quick checks: `hack open`, `hack open <sub>`, `hack open --json`.

TLS + valid-hostname constraints:
- `hack` uses Caddy internal PKI for HTTPS on routed hosts; trust CA with `hack global trust`.
- Containers get a combined public+local trust bundle (SSL_CERT_FILE etc.) once `hack global trust` has run; public TLS (package registries, external APIs) keeps working alongside `*.hack` trust.
- If the combined bundle is missing, only Node gets `*.hack` trust (NODE_EXTRA_CA_CERTS); OpenSSL-based tools keep public roots — run `hack global trust` to enable both.
- `.hack` is local-first and great for dev, but it is not a public suffix.
- Use OAuth alias hosts (for example `*.hack.gy`) when providers require public-suffix-style callback domains.
- Alias hosts are still local-dev routes unless you add an external tunnel/remote ingress path.

Project files (managed vs generated):
- Source-of-truth files: `.hack/docker-compose.yml`, `.hack/hack.config.json`, `.hack/hack.env.default.yaml`, and optional `.hack/hack.env.<overlay>.yaml`.
- Worktree-local env override files: `.hack/hack.env.local.yaml` and `.hack/hack.env.<overlay>.local.yaml`.
- Local-only files: `.hack.secret.key`, optional `.hack/.env` compatibility output, `.hack/.env.state.json`, and `.hack/.internal/` (runtime/local machine state; keep gitignored).
- Generated (do not hand-edit): `.hack/.internal/compose.override.yml`, `.hack/.internal/compose.env.override.yml`, `.hack/.internal/compose.runtime.override.yml`, `.hack/.branch/compose.<branch>.override.yml`, `.hack/.branch/compose.<branch>.runtime.override.yml`.
- Managed via CLI: `.hack/.internal/extra-hosts.json` (use `hack internal extra-hosts ...` commands).
- Lifecycle runtime files: `.hack/.internal/lifecycle/state.json`, `.hack/.internal/lifecycle/*.log`.
- Ignore rules: hack owns a committed `.hack/.gitignore` (self-healing on init/up) covering machine-local generated files (`.internal/`, `.branch/`, `.env`, `.env.state.json`, `hack.env*.local.yaml`); keep it committed, and if generated files leaked into git, `hack doctor --fix` untracks them (files stay on disk).

Linked git worktrees:
- Secret key inherits from the primary checkout automatically through the shared git common dir; set `HACK_ENV_SECRET_KEY` for CI or detached environments.
- `hack up` in a linked worktree defaults to a branch instance named after the worktree's git branch; a detached linked worktree requires an explicit `--branch`, unless config `worktree.auto_branch=false` explicitly opts into the base instance.
- Before `hack up` or `hack restart` auto-targets a new branch instance, Hack warns when the same worktree already owns a non-terminal instance; pass `--branch <name>` to make the target explicit.
- Implicit `hack down` retargets a uniquely owned same-checkout runtime after a Git branch rename, including Created and stopped containers; when multiple runtimes belong to the checkout, pass `--branch <name>` explicitly.
- `hack doctor` flags divergent secret keys and dev_host collisions across checkouts.

Advanced networking (extra_hosts + local proxies/tunnels):
- Static host mappings: set `internal.extra_hosts` in `.hack/hack.config.json`.
- Dynamic host mappings: `hack internal extra-hosts set <hostname> <target>` / `unset` / `list`.
- For host-local proxies/tunnels, prefer `host-gateway` as target when possible.
- After mapping changes or proxy IP churn: `hack restart` and then `hack doctor`.

Standard workflow:
- If `.hack/` is missing: `hack init`
- Start services: `hack up --detach` (or `hack up -d`)
- Check status: `hack ps` or `hack status`
- Open app URL: `hack open --json`
- Restart: `hack restart`
- Stop services: `hack down`

Running things (decision guide):
- One-off command in a fresh service container (deps started as needed): `hack run <service> <cmd...>`.
- Command inside an already-running service container: `hack exec <service> -- <cmd...>`.
- Host script that needs hack-stored env: `hack host exec --env <overlay> --scope <service> -- <cmd...>` — this is THE way to run repo scripts; never read .env files directly.
- Interactive host shell with injected env: `hack host shell --env <overlay> --scope <service>`.
- Browser/host URL: use `hack open <service> --json` (OAuth aliases are preferred when enabled). Container-to-container traffic should use Compose DNS.

Logs (default is compose):
- Fast tail: `hack logs --pretty`
- Per-service tail: `hack logs <service>`
- Machine snapshot: `hack logs --json --no-follow`
- Loki history/query: `hack logs --loki --since 2h --pretty` or `hack logs --loki --query '{project="<name>"}'`
- Force compose backend: `hack logs --compose`
- Global infra logs: `hack global logs caddy --no-follow --tail 200`

Lifecycle + startup:
- Put host setup in `.hack/hack.config.json` under `startup`/`lifecycle` (not ad-hoc terminal tabs).
- Use `lifecycle.up.before` for pre-start hooks and `lifecycle.processes` for long-running host tasks.
- Lifecycle hooks and processes receive the selected overlay's `global` values plus `host` overrides; service-scoped values remain container-specific unless a host command explicitly selects that scope.
- For fixed-port host helpers such as SSM tunnels or local proxies, set `singleton.ports` and usually `onConflict: "adopt"` so Hack reuses a healthy existing listener instead of starting duplicate tunnel stacks.
- `singleton` is a listener guard, not process ownership transfer; adopted external processes are left running on `hack down`.
- Inspect lifecycle status via `hack projects --details` and stream via `hack logs <service-or-process>`.
- Lifecycle session recovery is ownership-proven: Hack adopts healthy token-, definition-, and environment-matched sessions, replaces owned stale sessions, and refuses to kill same-name sessions without deterministic ownership proof.
- `hack doctor --fix` reaps an orphan lifecycle session only when mux ownership is proven and its Compose instance is absent; unverified same-name sessions are never modified.
- After `hack up` or `hack restart`, running services and successful one-shot services (`exited` with code 0) count as successful. Hack recognizes dependency installers, `hack.service.one-shot=true`, and services referenced by Compose `condition: service_completed_successfully`; other states return `E_STARTUP_INCOMPLETE`, and `hack doctor` warns about containers stuck in `Created`.
- Detached startup is bounded; a hung Compose operation returns `E_STARTUP_TIMEOUT`, terminates its process group, and `hack doctor --fix` can start exact containers left in `Created`.
- Target only affected services with `hack up <service...> --detach`, `hack restart <service...>`, or `hack env apply --service <service>`; scoped operations skip project lifecycle hooks and implicit dependency startup.
- Use `hack env explain <KEY> --env <overlay> --service <service> --target <host|compose>` for redacted source, precedence, availability, and delivery diagnostics.
- Dependency installer services are detected generically by command or `hack.dependencies.bootstrap=true`; registry env references are preflighted before container mutation. Optional `hack.dependencies.cache-volume`, `hack.dependencies.lockfiles`, and `hack.dependencies.runtime-files` labels enable lockfile/runtime-keyed volumes shared across compatible worktrees.
- `hack down --prune-caches` can remove only confirmed Compose-owned named volumes mounted exclusively at `.next` destinations or explicitly labeled `hack.cache.disposable=true`; it is confirmation-gated, requires `--yes` for JSON/scripted runs, and never performs broad volume pruning.

Workspaces (mux-managed, tmux-first by default):
- Picker: `hack session` for persistent project workspaces.
- Reuse/create: `hack session start <project>`
- Env-scoped workspace: `hack session start <project> --env qa --service api --detach`
- Force isolated agent workspace: `hack session start <project> --new --name agent-1` (`<project>--agent-1`).
- Execute in workspace: `hack session exec <workspace> "<command>"`
- Execute in workspace with injected env: `hack session exec <workspace> --env qa --service api "bun db:migrate"`
- Stop workspace: `hack session stop <workspace>`

Host-side env helpers:
- One-off host command with injected env: `hack host exec --env qa --scope api -- bun db:migrate`
- Host commands default to a host-local env view; use `--target compose` when you explicitly want container-oriented addresses.
- `--scope` selects which env scope to inject; it does not move execution into that service container.
- Interactive host shell with injected env: `hack host shell --env qa --scope api`
- Run inside an already-running service container: `hack exec api -- bun test`

Branch instances (parallel envs):
- Use a branch instance when you need two versions running at once (PR review, experiments, migrations) or want to keep a stable environment while testing another branch.
- Target one with `--branch <name>` on up/open/logs/down (for example: `hack up --branch <name> --detach`).
- Linked worktrees pick a branch instance automatically (see Linked git worktrees).
- Containers receive `HACK_RUNTIME_METADATA` plus `HACK_DEV_URL`, `HACK_ALIAS_URL`, and current-service URL fields derived from effective Caddy routes. Use Compose DNS for internal traffic and this metadata for browser-facing links, OAuth callbacks, and webhooks.

Run commands inside services:
- One-off: `hack run <service> <cmd...>` (uses `docker compose run --rm`)
- Example: `hack run api bun test`
- Use `--workdir <path>` to change working dir inside the container.
- Use `hack ps --json` to list services and status.

Project targeting:
- From repo root, commands use that project automatically.
- Else use `--project <name>` (registry) or `--path <repo-root>`.
- List projects: `hack projects --json`

Global infra:
- Bootstrap once: `hack global install`
- Start/stop/status: `hack global up`, `hack global down`, `hack global status`
- Use `hack global up` before Loki/Grafana queries if global logging is offline.

Daemon (optional):
- Start for faster JSON status/ps: `hack daemon start`
- Check status: `hack daemon status`

Docker compose notes:
- Prefer `hack` commands; they include the right files/networks.
- Use `docker compose -f .hack/docker-compose.yml exec <service> <cmd>` only if you need exec into a running container.

Agent integration maintenance:
- Project-level hack commands auto-check integration drift and attempt auto-sync (project docs, Cursor/Claude integrations, shared global skills, and MCP).
- When drift is detected, Hack reports it before repair and tells the agent to reload after repair; it never silently leaves the session using cached rules.
- Set `HACK_SETUP_SYNC_MODE=warn` to only warn, or `HACK_SETUP_SYNC_MODE=off` to disable.
- Refresh project + user integrations: `hack setup sync --all-scopes`
- Audit integration state only: `hack setup sync --all-scopes --check`
- Remove generated integration artifacts: `hack setup sync --all-scopes --remove`
- After upgrading CLI: `hack update` then `hack setup sync --all-scopes`
- When changing hack itself: interface or behavior changes must update docs/ in the same change (regenerate the CLI reference with `bun run docs:cli-reference`).

Agent setup (CLI-first):
- Cursor plugin: run `hack setup cursor`, then install Hack with `/add-plugin` or enable it from Settings > Plugins as directed.
- Claude Code plugin: run `hack setup claude`, then install or enable `hack@hack-dance` as directed.
- Codex plugin: run `hack setup codex`, then install or enable Hack from `/plugins` as directed.
- Refresh all local agent integrations: `hack setup sync --all-scopes`
- Agent-assisted onboarding: `hack init --with claude|codex|both` (new repos) or `hack agent onboard` (existing projects) print/hand off the full setup prompt; the `/hack-init` skill and the `hack-init` MCP prompt return the same content.
- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)
- Init patterns: `hack agent patterns`
- MCP (no-shell only): `hack setup mcp`
- MCP install (explicit): `hack mcp install --all --scope project`
<!-- hack:agent-docs:end -->

## Learned Workspace Facts

- Hack v3 intentionally removed the web dashboard, auth broker, built-in GitHub workflows, and built-in Linear sync from the supported product.
- Future repo work should default to the local-first CLI/runtime and the slim macOS companion unless the product boundary is explicitly reopened.
- Remote/gateway/node/dispatch should stay unsupported experimental and outside core release gates unless they break local core behavior.
