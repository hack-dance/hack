---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

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
- Create: `hack x tickets create --title "..." --body-stdin` (pipe long context)
- List: `hack x tickets list`
- Show: `hack x tickets show T-00001`
- Status: `hack x tickets status T-00001 in_progress`
- Sync: `hack x tickets sync`

Data lives in `.hack/tickets/` and syncs to branch `hack/tickets` by default.
<!-- hack:tickets:end -->

## Landing the Plane (Session Completion)
**When ending a work session**, you MUST complete ALL steps below.

**MANDATORY WORKFLOW:**
1. **File tickets for remaining work** - Create tickets for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Hand off** - Provide context for next session
