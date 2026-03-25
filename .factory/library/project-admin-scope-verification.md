## Shared project admin scope verification

- Repo-bound CLI parity checks against the local Hack runtime need `HACK_AUTH_BROKER_URL=https://auth.hack-cli.hack`; otherwise `project owner show` falls back to the default remote broker URL.
- For local browser verification, a scoped management token can be minted from `services/auth-broker/src/modules/better-auth/management-token.ts` via Bun on the repo root because Bun loads the local auth secret from `.env`.
- Next.js may rewrite `apps/web/next-env.d.ts` and `apps/web/tsconfig.json` during routed web verification; restore those incidental changes before commit.
- Durable `DbProjectStore` parity regressions should use a real backend helper like the temp-directory `drizzle-orm/pglite` setup in `services/auth-broker/tests/project-admin.test.ts`, not an in-memory shim, so schema creation, query semantics, and store-recreation persistence are actually exercised.
