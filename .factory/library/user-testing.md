# User Testing

Testing surface findings, required tools, and validation concurrency for this mission.

**What belongs here:** user-facing validation surfaces, tooling, setup notes, concurrency limits, and validation gotchas.

---

## Validation Surface

### CLI surface
- Primary tools: `./dist/hack`, repo-local Bun commands, global `hack` for runtime orchestration only.
- Use for: auth status, Linear sync/status, tickets, env, runtime/session flows, project ownership/admin parity.
- Notes: prefer repo-bound CLI validation (`./dist/hack`) after a build so command behavior matches the current branch.

### Broker / HTTP surface
- Primary tools: `curl`, declared local service commands from `.factory/services.yaml`, and later hack-managed routed hosts.
- Use for: broker health, auth/session APIs, org/team/project admin APIs, integration-management APIs, env/gateway endpoints.
- Notes: early mission work should harden env-sensitive auth-broker tests so these checks are trustworthy.

### Web surface
- Primary tools: `agent-browser` against the routed host returned by `hack open --json` once `apps/web` exists.
- Use for: sign-in/account UX, org/team/project admin, GitHub/Linear management, env/status views, outage-mode optionality checks.
- Notes: no shell-installed browser runner was found during dry run; browser user testing must rely on `agent-browser`.

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
