# RFC 0001: Multi-Node Hack Cluster + Supervisor Sessions

Status: Draft  
Owner: Hack CLI team  
Last updated: 2026-01-13

## Summary

Enable a multi-node Hack cluster where any machine can host projects, expose them
via the gateway, and be controlled from a single CLI/Desktop. Tailscale is the
default required transport. Each node runs hackd (control plane) and supervisor
(execution plane). Sessions (tmux, agents, long-running tasks) are first-class
and can be streamed over the gateway for remote clients.

## Goals

- Register and manage multiple Hack nodes globally.
- Route project actions to the correct node.
- Default to Tailscale for secure remote control.
- Keep intent in config, runtime in hackd/supervisor.
- Surface supervisor jobs/sessions and stream logs/terminal output remotely.
- Support remote access patterns (SSH/tmux, mobile terminal, editor-remote).

## Non-goals (initial)

- Global scheduling or automatic project placement.
- Distributed filesystem or automatic file sync.
- Centralized supervisor (remains node-local).
- Public internet access without explicit Cloudflare/Tailscale configuration.

## Glossary

- Node: A machine running hackd + supervisor and capable of hosting projects.
- Controller: CLI/Desktop instance issuing commands to nodes.
- Runtime: Local infra (DNS/Caddy/logging) + hackd + gateway.
- Gateway: hackd HTTP/WS entrypoint for remote access and exposures.
- Exposure: A transport path (LAN/Tailscale/Cloudflare) to a gateway.
- Session: A long-running process (tmux, agent, shell) tracked by supervisor.

## Architecture

Each node runs its own control plane and execution plane:

  Controller (CLI/Desktop)
           |
        Gateway
           |
        hackd (control plane)
           |
      supervisor (execution plane)

The controller selects a node, talks to its gateway/hackd, and hackd delegates
execution to the node-local supervisor. All runtime state is re-derived on each
node (no reliance on controller memory).

## Node Registry (Global)

Store a registry under:

  ~/.hack/registry/nodes.json

Schema (draft):

```json
{
  "version": 1,
  "nodes": [
    {
      "id": "node-123",
      "name": "mac-mini",
      "labels": ["home", "arm64"],
      "capabilities": ["runtime", "gateway", "supervisor"],
      "tailscale": {
        "ip": "100.64.1.23",
        "hostname": "mac-mini.tailnet.ts.net"
      },
      "endpoints": {
        "hackd": "https://100.64.1.23:7788"
      },
      "last_seen": "2026-01-13T21:00:00Z",
      "status": "online",
      "version": "1.1.0"
    }
  ]
}
```

## Transport + Auth

Default transport: Tailscale

- Tailscale is required for multi-node control in v1.
- Gateway listens on the tailnet interface.
- hackd endpoints require token auth.
- Tokens are scoped (read, write, admin).

Cloudflare is optional for public access but not required for control plane.

## Project Ownership

Add a project-level node binding:

```
controlPlane.nodeId = "node-123"
```

Project actions route to the owning node. If unset, the local node is assumed.

## Supervisor Sessions (tmux + agents)

Supervisor manages sessions with stable identifiers:

```
session_id = "project:repo:agent:codex"
```

Session types:
- tmux session (named, attachable)
- long-running process (agent, build, watcher)
- shell command (short-lived)

Required capabilities:
- Start/stop/restart sessions
- Stream logs (tail, follow)
- Stream terminal output (PTY) over WebSocket

Remote access patterns:
- SSH/tmux for local terminal workflows
- WebSocket stream for remote UI/clients
- Mobile terminal can attach via gateway session stream

## Gateway + Exposures

Expose gateways per node and per project.

Status semantics:
- configured: extension configured but not running
- running: transport active and reachable
- blocked: missing dependency (hackd down, bind loopback, etc.)
- needs_config: missing required config
- disabled: not configured/enabled

## CLI UX

New commands (draft):

- `hack node add` (register local node, ensure tailscale)
- `hack node list` / `hack node status`
- `hack node use <id>` (set default node)
- `hack project move --node <id>`
- `hack up --node <id>`
- `hack session list`
- `hack session start --project <id> --type tmux|agent`
- `hack session attach <id>`

## Desktop UX

Sidebar groups:
- Nodes
  - Runtime (per node)
  - Gateway (per node)
- Projects (grouped by node)
- Sessions (per node)

Node pages show:
- hackd status
- supervisor status (jobs, sessions)
- gateway exposures
- quick actions (start/stop runtime)

## APIs (draft)

Node status:
- `GET /v1/node/status`

Sessions:
- `GET /v1/sessions`
- `POST /v1/sessions`
- `POST /v1/sessions/:id/stop`
- `GET /v1/sessions/:id/logs`
- `WS /v1/sessions/:id/stream`

## Security

- Tailscale ACLs restrict who can reach gateway endpoints.
- Tokens are required for write/admin actions.
- Read-only tokens allowed for status/logs in Desktop.

## Rollout Plan

Phase 1 (Registry + Read-only):
- Node registry + CLI
- Node status endpoint
- Desktop shows nodes + status

Phase 2 (Remote Control):
- Route commands to remote hackd
- Supervisor status API

Phase 3 (Sessions + Streaming):
- Session API + WebSocket streaming
- tmux-based session implementation

Phase 4 (Gateway Exposures):
- Node-scoped gateway config
- Project-scoped exposures
- Token UI + docs

## Test Plan

- Unit: registry serialization, node routing, status parsing
- Integration: hackd remote status with tailscale mock
- E2E: session start/stream on a local node

## Open Questions

- How far do we go with remote file access (SSH vs sync vs mounts)?
- Do we allow non-tailscale transports in v1 for control plane?
- What is the default lifecycle for sessions (ttl, cleanup)?
