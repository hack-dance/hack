# Account shell cold-bootstrap hydration note

- The `/account` route can still throw a React hydration mismatch on the first authenticated bridge redirect even when `ControlPlaneShell` server markup is structurally correct.
- The reliable fix in local Next 16/Turbopack dev was to keep the route dynamic (`dynamic = "force-dynamic"`, `fetchCache = "force-no-store"`) **and** wrap `AccountShellPage` in an explicit `Suspense` fallback so the first server/client render agrees during the broker-to-web bootstrap.
- The fallback lives in `apps/web/src/components/account-shell-loading.tsx` and preserves the skip link plus `#main-content` focus target so keyboard/reduced-motion checks stay valid while the async account loaders settle.
- Browser proof path: create a disposable Better Auth account, set `__Secure-better-auth.session_token` in `agent-browser`, open `https://auth.hack-cli.hack/auth/account?bridge=1&redirect=https%3A%2F%2Fhack-cli.hack%2Faccount`, and inspect `agent-browser errors` for hydration failures.
- Running the routed web dev server can rewrite `apps/web/next-env.d.ts` and `apps/web/tsconfig.json`; restore those incidental changes before final validators/commit unless the feature explicitly owns them.
