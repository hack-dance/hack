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

## Focused verification techniques

These are advisory examples for the surface being changed, not additional gates.
[AGENTS.md](AGENTS.md#verification) defines the required checks.

- For CLI output changes, capture the process's complete stdout and stderr as well
  as checking the JSON envelope in [cli-result tests](tests/cli-result.test.ts).
  Replay a changed recovery hint with `bun index.ts` from the original directory
  through the shell the hint targets; quoting alone does not prove CLI acceptance.
- For signal handling, distinguish an immediate child signal from an interrupt
  after readiness. Check cleanup and delayed effects, using the real-process
  patterns in [dev-command tests](tests/dev-command.test.ts). For timeout changes,
  check premature termination as well as overruns; see
  [shell-timeout tests](tests/shell-timeout.test.ts).
- For dependency cache invalidation, change a real lockfile or runtime input and
  check the resulting fingerprint and volume name, as in
  [dependency-cache tests](tests/dependency-cache.test.ts).
- For registry cleanup, exercise the public operation with a held file lock as well
  as a stale lock; see [projects-registry tests](tests/projects-registry.test.ts).
  For volume deletion, keep ownership checks distinct from eligibility checks in
  [disposable-cache-volume tests](tests/disposable-cache-volumes.test.ts).
- For platform-gated tests, report how many cases actually executed. If concurrent
  builds write into the checkout or share output, isolate them before attributing
  a failure to the patch. Set fixture permissions explicitly for ownership tests
  while retaining cases that check refusal of unsafe permissions.
- For missing-project fixtures, choose a temporary root whose ancestors contain no
  `.hack` directory. Project discovery walks upward, so an unrelated ancestor can
  turn a refusal test into real project activity; see
  [discovery tests](tests/discovery.test.ts). For process fixtures, observe the
  owned child's exit separately from launcher completion before removing its state.

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
