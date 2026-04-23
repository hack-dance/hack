# Environment

Environment variables, external dependencies, and setup notes for current Hack work.

## Local-first Assumptions

- Bun is the canonical runtime and validator path for this repo.
- Use repo-local commands and `./dist/hack` for current-branch CLI behavior after build.
- Use global `hack` only when validating installed runtime orchestration intentionally.
- Do not add new required hosted services, auth brokers, web dashboards, GitHub apps, or Linear credentials to the supported path.

## Env and Secrets

- Canonical shared env files: `.hack/hack.env.default.yaml` and `.hack/hack.env.<overlay>.yaml`.
- Worktree-local override files: `.hack/hack.env.local.yaml` and `.hack/hack.env.<overlay>.local.yaml`.
- Derived compatibility files: `.hack/.env` and `.hack/.env.state.json`.
- Local checkout key: `.hack.secret.key`.
- Linked-worktree shared key: stored under the git common dir so sibling worktrees can decrypt committed secrets.
- Portable/CI/container key: `HACK_ENV_SECRET_KEY`.

## Managed Containers

- Use `hackdance/hack:slim` for repo-local managed-agent containers when Docker Hub is available.
- Inject `HACK_ENV_SECRET_KEY` from the runtime or secret manager; never bake `.hack.secret.key` into an image.
- Slim/codex mode should use repo-local commands such as `hack env list`, `hack host exec`, `hack host shell`, and `hack tickets`.
- Machine-wide surfaces such as `hack global install`, Caddy/CoreDNS/Loki/Grafana, and local CA bootstrap are not expected in slim mode.

## Runtime and Lifecycle

- Prefer `hack doctor` and `hack doctor --fix` before manual runtime/network repair.
- For lifecycle changes, verify `sh -c` semantics, stdin behavior, process-group cleanup, stale mux metadata recovery, and singleton listener handling.
- For daemon/gateway request-target hardening, use an isolated temp-HOME repo-built daemon (`bun index.ts daemon start --foreground`) when live proof would otherwise mutate shared user daemon state.

## Outage and Drift Proofs

- For stale env compatibility output, use `hack doctor` and `hack env materialize`.
- For stale lifecycle state, use `hack doctor`, then `hack down`, then rerun `hack doctor`.
- For tickets remote auth failures, prefer explicit SSH guidance and bounded timeouts over interactive prompts.
