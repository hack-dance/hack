# User Testing

Testing surface findings, required tools, and validation concurrency for this mission.

**What belongs here:** user-facing validation surfaces, tooling, setup notes, concurrency limits, and validation gotchas.

---

## Validation Surface

### CLI surface
- Primary tools: `./dist/hack`, repo-local Bun commands, global `hack` for runtime orchestration only.
- Use for: auth status, Linear sync/status, tickets, env, runtime/session flows, project ownership/admin parity.
- Notes: prefer repo-bound CLI validation (`./dist/hack`) after a build so command behavior matches the current branch.
- Notes: repo-bound GitHub CLI validation can use the project config directly because `.hack/hack.config.json` now enables `dance.hack.github` alongside the Linear and tickets extensions.

### Broker / HTTP surface
- Primary tools: `curl`, declared local service commands from `.factory/services.yaml`, and later hack-managed routed hosts.
- Use for: broker health, auth/session APIs, org/team/project admin APIs, integration-management APIs, env/gateway endpoints.
- Notes: early mission work should harden env-sensitive auth-broker tests so these checks are trustworthy.

### Web surface
- Primary tools: `agent-browser` against the routed host returned by `hack open --json` once `apps/web` exists.
- Use for: sign-in/account UX, org/team/project admin, GitHub/Linear management, env/status views, outage-mode optionality checks.
- Notes: no shell-installed browser runner was found during dry run; browser user testing must rely on `agent-browser`.
- Notes: `hack up -d` currently exposes the routed web host at `https://hack-cli.hack` and the broker host at `https://auth.hack-cli.hack`.
- Notes: the live broker enables Better Auth email/password routes, so validator sessions can create authenticated broker cookies through `POST https://auth.hack-cli.hack/api/auth/sign-up/email` without depending on an external GitHub login.
- Notes: for `agent-browser` web validation, a reliable local auth bootstrap is:
  1. create a disposable account with `curl -c <cookiejar> -X POST https://auth.hack-cli.hack/api/auth/sign-up/email ...`
  2. parse `__Secure-better-auth.session_token` from the cookie jar
  3. in the browser session, open `https://auth.hack-cli.hack/health`
  4. run `agent-browser --session <id> cookies set __Secure-better-auth.session_token <value>`
  5. open `https://auth.hack-cli.hack/auth/account?bridge=1&redirect=https%3A%2F%2Fhack-cli.hack%2Faccount`
  This mints the shared `hack_web_broker_session` cookie for `https://hack-cli.hack/account` without relying on GitHub OAuth.
- Notes: for protected routed-page verification that does not need to prove browser-owned sign-in continuity, an alternate bootstrap is to mint a scoped broker management token, set `hack_web_broker_session` directly in the browser session, and then open the protected `https://hack-cli.hack/...` route. Use this only for state inspection or scoped management-page checks; it is not evidence for browser-owned auth return flows.
- Notes: that bridge-cookie bootstrap is not enough to validate browser-owned auth return flows by itself. When a feature claims post-login deep-link continuity, also start from a real browser-owned entry such as `https://hack-cli.hack/auth?redirect=https%3A%2F%2Fhack-cli.hack%2Faccount` and confirm the user is returned to the requested trusted destination after sign-in.

## Validation Concurrency

### CLI validators
- Max concurrent validators: `2`
- Rationale: machine headroom is ample, but some CLI flows share project state, runtime state, and repo-bound artifacts. Two concurrent validators is conservative without creating noisy artifact races.

### Broker / local HTTP validators
- Max concurrent validators: `1` per service
- Rationale: local HTTP surfaces currently depend on fixed ports and shared local state. Serialize broker/runtime validation per declared service.

### Web / browser validators
- Max concurrent validators: `1`
- Rationale: browser validation depends on a single local runtime plus `agent-browser`, and the highest-signal checks involve auth/session and routed-host state that should not overlap.

## Known Validation Gaps To Fix Early

- `services/auth-broker` config/auth verification has env-sensitive paths that can produce weak signals until hardened.
- The repo does not yet have a real `apps/web` runtime or hack-managed local web host; milestone 2 must establish that path before meaningful browser validation can pass.
- Detached-worktree `./dist/hack linear sync-project --from linear` runs can hit hidden-ref `refs/hack/tickets` push rejections; for isolated validation, prefer repo-bound `documents|milestones|status-updates pull` plus focused Linear sync regressions unless you intentionally want to exercise remote ticket-ref writes.

## Flow Validator Guidance: CLI surface

- Use the current repo root (for example `<repo>`) and prefer `./dist/hack` after a local `bun run build`.
- Stay repo-bound: do not use the globally installed `hack` binary for product behavior except runtime orchestration commands explicitly assigned by the coordinator.
- Treat `.hack/linear/**` as managed output. Do not delete unmanaged scratch files and do not create or validate against `.hack/.hack/linear/**`.
- For env-only auth assertions, set explicit process env in the command invocation rather than mutating shell startup files.
- When committing validation evidence, replace local absolute paths with placeholders such as `<repo>`, `<isolated-worktree:...>`, `<mission-dir>`, and `<tmp>`.
- Because CLI assertions in this milestone share repo-local Linear artifacts and profile state, validators for this surface must run serialized unless given a separate working copy.

## Flow Validator Guidance: Broker / local HTTP surface

- Use `http://127.0.0.1:8080` only when you intentionally start the standalone `auth-broker-local` service from `.factory/services.yaml`.
- When the hack-managed stack is already up, prefer the routed broker host `https://auth.hack-cli.hack` for broker/API evidence and browser auth bridging.
- For routed-host shell checks, use `curl -k` and set `NODE_TLS_REJECT_UNAUTHORIZED=0` for isolated CLI/curl probes unless local trust has already been configured outside the validator session.
- Treat a failed health check on both `http://127.0.0.1:8080/health` and `https://auth.hack-cli.hack/health` as a blocker before continuing with broker-dependent assertions.
- Do not bind additional fixed ports or start a second broker instance unless the coordinator gives a separate port and evidence directory.

## Flow Validator Guidance: Web surface

- Use a single `agent-browser` session against the routed host `https://hack-cli.hack`; re-use the same session across `/`, `/auth`, and `/auth/account` instead of opening parallel browsers.
- Re-snapshot after every navigation and always capture annotated screenshots for the shell, sign-in page, account page, and any redirect from `https://auth.hack-cli.hack/auth*`.
- Keep browser validation read-mostly: avoid mutating shared org/team state from the browser because this milestone only ships the shell and auth entrypoints, while durable org/team mutations are better exercised through isolated broker API cookies.
- When an authenticated broker session is required, create it through the real Better Auth email/password API on `https://auth.hack-cli.hack/api/auth/sign-up/email`, store cookies in an isolated temp directory, and treat those cookies as the isolation boundary for the corresponding API checks.
