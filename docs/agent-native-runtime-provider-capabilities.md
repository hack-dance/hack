# Agent-Native Runtime Provider Capabilities

Updated: March 13, 2026

This document turns the runtime landscape survey into a concrete capability contract for Hack runtime providers. It is meant to be used alongside [agent-native-runtime-landscape.md](agent-native-runtime-landscape.md), not instead of it.

## Purpose

Hack needs a provider contract that is honest about backend differences while still keeping one stable project and control-plane model for agents and operators.

This document answers three practical questions:

- Which backend capabilities are required for a credible Hack runtime baseline?
- Which capabilities are optional or backend-specific?
- Which areas should remain compatibility layers or be deferred?

## Capability Terms

- `Required`: every Hack runtime provider must support this directly or through a Hack-owned adapter.
- `Optional`: useful capability that should be reported explicitly when present.
- `Deferred`: not part of the baseline provider contract.
- `Adapter-owned`: Hack can provide the behavior above the backend rather than requiring native support.

## Baseline Provider Matrix

Provider classes used below:

- `Local Docker-like (Linux)`: Docker Engine + Compose on a native Linux host.
- `Local Docker-like (macOS VM)`: Docker Desktop, Colima, Lima-backed Docker-like environments.
- `Local Podman rootless`: rootless Podman-style local execution.
- `Remote Docker-backed node`: current Hack remote node model with Docker socket access.
- `Future containerd provider`: a more native Hack-owned runtime substrate.

| Capability | Contract Level | Local Docker-like (Linux) | Local Docker-like (macOS VM) | Local Podman rootless | Remote Docker-backed node | Future containerd provider |
| --- | --- | --- | --- | --- | --- | --- |
| Start/stop/recreate services | Required | Native | Native | Native | Native | Native |
| Project-scoped service graph | Required | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned or native |
| Readiness/health observation | Required | Native + adapter normalization | Native + adapter normalization | Native + adapter normalization | Native + adapter normalization | Native + adapter normalization |
| Restart in same execution context | Required | Native | Native | Native | Native | Native |
| Reschedule to another backend/node | Required at Hack layer | Hack-owned | Hack-owned | Hack-owned | Hack-owned | Hack-owned |
| Stable service identity | Required | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned or native |
| Host/container name resolution policy | Required | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned |
| Ingress policy for developer-facing hosts | Required | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned |
| Route repair after substrate drift | Required | Adapter-owned | Adapter-owned and critical | Adapter-owned | Adapter-owned and critical | Adapter-owned |
| Socket-first local control surface | Required | Native | Native | Native | Native on node | Native |
| Explicit remote exposure gating | Required | Hack-owned | Hack-owned | Hack-owned | Hack-owned | Hack-owned |
| Capability reporting | Required | Hack-owned | Hack-owned and critical | Hack-owned | Hack-owned | Hack-owned |
| Native pause/resume | Optional | Limited | VM-level and backend-specific | Backend-specific | Backend-specific | Plausible future native support |
| Snapshot/export checkpoints | Optional | Limited | Limited | Limited | Limited | Plausible future native support |
| Honest mount semantics reporting | Required | Hack-owned | Hack-owned and critical | Hack-owned | Hack-owned | Hack-owned |
| Workspace-contract import (`devcontainer.json`) | Optional | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned | Adapter-owned |
| Scheduler placement optimization | Deferred | No | No | No | No | No |
| Live-update/build-sync acceleration | Deferred | No | No | No | No | No |

## Minimum Provider Contract

Every Hack runtime provider should expose, at minimum, the following contract to `hackd` and the gateway:

### 1. Execution primitives

- Create, start, stop, restart, and recreate a project-scoped unit of execution.
- Enumerate service instances with stable provider IDs.
- Stream stdout/stderr and exit transitions.

### 2. State observation

- Report whether a service is `running`, `stopped`, `failed`, or `unknown`.
- Report whether health/readiness is native, emulated, or unavailable.
- Report substrate resets or loss of connectivity so Hack can mark cached state stale.

### 3. Networking description

- Declare whether the backend is native-host or VM-mediated.
- Describe whether service-to-service DNS is native or Hack-managed.
- Describe whether host ingress depends on port forwarding, bridge networking, or a Hack-owned proxy.

### 4. Filesystem and mount description

- Report whether mounts are native, VM-bridged, or otherwise translated.
- Report whether hot-reload-sensitive mount behavior should be treated as degraded or best-effort.

### 5. Control-plane posture

- Provide a local transport suitable for socket-first control.
- Never assume ambient remote write access.
- Require explicit opt-in for remote execution paths.

## Provider Capability Schema

The runtime provider contract should report capability flags in Hack terms rather than leaking raw backend assumptions. A provider record should be able to answer at least:

| Field | Meaning |
| --- | --- |
| `execution_kind` | `container`, `vm_container`, `process`, or other future substrate |
| `host_os` | host operating system class |
| `network_mode` | native bridge, rootless bridge, VM port-forwarded, or equivalent |
| `mount_mode` | native, VM-bridged, networked, or unknown |
| `supports_restart` | can retry/recreate in the same execution context |
| `supports_reschedule` | can participate in Hack-driven relocation to another provider/node |
| `supports_health_probes` | native, adapter-emulated, or unavailable |
| `supports_pause_resume` | whether pause/resume semantics exist and at what layer |
| `supports_snapshots` | whether checkpoint/export exists |
| `supports_remote_shells` | whether Hack can expose PTY-backed shells safely |
| `supports_route_repair_hooks` | whether backend emits enough data for route or IP drift repair |
| `control_transport` | unix socket, named pipe, SSH, HTTP-over-localhost, or similar |

## Adopt, Keep, Defer

| Decision | Items |
| --- | --- |
| Adopt now | Socket-first control plane, restart vs reschedule split, Hack-owned networking semantics, backend capability reporting, explicit VM-mediated macOS classification |
| Keep as compatibility layers | Compose project import/export, Docker-backed remote nodes, `devcontainer.json` compatibility, current gateway/gateway-token model |
| Defer | Cluster scheduling, placement optimization, CRD-style control objects, live-update acceleration, containerd-native baseline ownership until Hack wants deeper substrate control |

## Decision Summary

The immediate architectural consequence is straightforward:

- Hack should define one project model and one control-plane model.
- Runtime providers should advertise honest capabilities instead of pretending every backend behaves like local Docker on Linux.
- Networking, stale-state handling, and remote-write posture should remain Hack-owned semantics.
- Compose should remain an adapter path, not the definition of the runtime.

That gives the runtime spec a clear next move: define Hack-native lifecycle and capability terms first, then map current Docker/Compose and remote-node behavior into that contract.
