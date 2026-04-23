# Extensions & SDK Reference

This page documents the lower-level extension and control-plane surfaces that still ship in the
repo.

If you want the supported product overview first, read [integrations.md](integrations.md) and
[core.md](core.md).

Hack v3 is local-first. The supported product does not include hosted auth, a web dashboard,
built-in GitHub integration, or built-in Linear integration.

## Scope

- Supported local helpers:
  - Tickets: `hack x tickets ...`
- Unsupported experimental workflows:
  - Gateway: `hack x gateway ...`
  - Supervisor: `hack x supervisor ...`
  - Remote node / dispatch flows documented under [beta.md](beta.md)
- Retired from the supported product:
  - `hack auth`
  - `hack linear`
  - built-in GitHub browser/profile flows

## Behavior

- Built-in extensions are registered in `src/control-plane/extensions/builtins.ts`.
- The CLI dispatches extension commands via `hack x <namespace> <command>`.
- Global enablement lives in `~/.hack/hack.config.json` via `controlPlane.extensions`.
- Per-project overrides live in `.hack/hack.config.json`.
- Built-in gateway enablement remains project-scoped through `controlPlane.gateway.enabled`.

## Built-in Extensions

- Tickets:
  - `hack x tickets setup|create|update|list|show|status|sync|tui`
- Unsupported experimental:
  - `hack x gateway token-create|token-list|token-revoke`
  - `hack x supervisor job-create|job-list|job-show|job-tail|job-attach|job-cancel|shell`
  - `hack x cloudflare ...`
  - `hack x tailscale ...`

GitHub and Linear are intentionally not part of the shipped built-in extension set for Hack v3.

## Dispatch Model

```bash
hack x <namespace> <command> [args...]
```

Use `hack x <namespace> help` to list commands for an enabled extension.

## Experimental Boundary

Remote/gateway/supervisor/cloud-provider functionality is still in the repo, but it is not part of
the default local-first product contract.

- Do not depend on it for first-run onboarding.
- Do not expect hosted Hack services or browser auth flows.
- Treat bugs here as experimental unless they break the core local runtime.

## Gateway API Surface

When the unsupported experimental gateway is enabled, the current HTTP/WS surface includes:

- `GET /v1/status`
- `GET /v1/metrics`
- `GET /v1/projects`
- `GET /v1/ps`
- `GET/POST /control-plane/projects/:id/jobs`
- `GET /control-plane/projects/:id/jobs/:jobId`
- `POST /control-plane/projects/:id/jobs/:jobId/cancel`
- `WS /control-plane/projects/:id/jobs/:jobId/stream`
- `POST /control-plane/projects/:id/shells`
- `GET /control-plane/projects/:id/shells/:shellId`
- `WS /control-plane/projects/:id/shells/:shellId/stream`

For usage patterns, see [gateway-api.md](gateway-api.md) and [beta.md](beta.md).
