# @hack/db

Shared database package for Hack services/apps using Drizzle + Neon/Postgres.

## Commands

```bash
bun run --cwd packages/db typecheck
bun run --cwd packages/db db:generate
bun run --cwd packages/db db:migrate
bun run --cwd packages/db db:push
bun run --cwd packages/db db:studio
```

## Environment

Copy `.env.example` and set `DATABASE_URL` for your Neon project.

Optional Neon auth related values are parsed by `src/env.ts`:

1. `NEON_PROJECT_ID`
2. `NEON_AUTH_API_URL`
3. `NEON_AUTH_CLIENT_ID`
4. `NEON_AUTH_CLIENT_SECRET`

The auth fields are scaffolded for upcoming integration work; initial schema and
runtime only require `DATABASE_URL`.

