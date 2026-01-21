
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

<!-- hack:tickets:start -->
## Tickets (git-backed)

This project uses `hack` tickets (extension: `dance.hack.tickets`).

Common commands:
- Create: `hack x tickets create --title "..." --body-stdin [--depends-on "T-00001"] [--blocks "T-00002"]`
- List: `hack x tickets list`
- Tui: `hack x tickets tui`
- Show: `hack x tickets show T-00001`
- Update: `hack x tickets update T-00001 [--title "..."] [--body "..."] [--depends-on "..."] [--blocks "..."]`
- Status: `hack x tickets status T-00001 in_progress`
- Sync: `hack x tickets sync`

Recommended body template (Markdown):
```md
## Context
## Goals
## Notes
## Links
```

Tip: use `--body-stdin` for multi-line markdown.

Data lives in `.hack/tickets/` (gitignored on the main branch) and syncs to hidden ref `refs/hack/tickets` by default.
<!-- hack:tickets:end -->

## Project Notes (Obsidian)

This project uses Obsidian for project context, specs, research, and progress tracking.

**Vault**: `~/.vaults/core`
**Project folder**: `30 Projects/Hack CLI/Notes/`

**When to write notes**:
- Project analysis and architecture reviews
- Research findings (e.g., Ghostty VT, libraries, APIs)
- Specs and design decisions
- Session summaries with progress updates
- Any context that should persist across sessions

**How to write notes**:
- Use the `obsidian` skill to interact with the vault
- Name notes with date prefix: `YYYY-MM-DD — Title.md`
- Include tags: `#hack-cli #substrate`

## Landing the Plane (Session Completion)
**When ending a work session**, you MUST complete ALL steps below.

**MANDATORY WORKFLOW:**
1. **File tickets for remaining work** - Create tickets for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Write session summary to Obsidian** - Key decisions, progress, blockers
5. **Hand off** - Provide context for next session
