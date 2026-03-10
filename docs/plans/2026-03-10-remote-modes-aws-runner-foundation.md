# Remote Modes, AWS Nodes, and Runner Foundation

## Summary

`hack` currently has enough remote functionality to prove the model, but the product language and implementation boundaries are still too blurry. We need to intentionally separate three different use cases:

1. Managed standalone runtime
2. Remote workspace offload
3. Explicit remote run / instance

This plan uses `event-agent` as the reference deployment for managed standalone runtime and AWS-backed remote execution.

## Product Model

### Managed standalone runtime

A long-lived remote machine runs `hack` for itself and orchestrates a project much like a developer laptop would. Controller visibility is useful, but not required for operation.

Reference shape:
- `event-agent` QA runner on EC2
- remote host owns project bootstrap, env hydration, and service orchestration
- `hack` should provide generic runner primitives, not project-specific shell glue

### Remote workspace offload

A developer keeps a local primary workspace and offloads lifecycle/runtime work to a controller-known node. This is the current `local_edit_remote_run` shape and is where Mutagen sync and optional devcontainer attach belong.

Key requirements:
- controller-visible node
- gateway endpoint
- SSH `source` metadata for sync and attach parity
- branch-aware workspaces and route bridging

### Explicit remote run / instance

A project should be able to launch a remote action without forcing a permanent project-mode change. This includes:

- one-off remote runs
- branch-scoped remote instances
- optional attach/open actions for those instances

Project execution mode should remain a default, not the only expression of remote behavior.

## Terminology

- Node: controller-known machine with gateway reachability and optional SSH source metadata
- Instance: per-project or per-branch runtime running on a node
- Run: dispatched job targeting a workspace or instance

Topology should stay focused on nodes and connectivity.
Project detail should own default behavior and explicit remote actions.

## Event-Agent Lessons

- Managed standalone runtime is a valid first-class mode and should not be forced into the same UX path as local workspace offload.
- `hack` should own node/runtime bootstrap, registration, auth verification, cleanup primitives, and dispatch contracts.
- Project-specific pieces should remain repo-owned:
  - env hydration
  - secrets shaping
  - service orchestration
  - EC2 wake/start/stop policies
  - application-specific automation
- AWS parity is incomplete unless the node can also participate in source-backed flows like Mutagen sync and devcontainer attach.

## Implementation Tracks

### Runner primitives

Umbrella:
- `T-00199` Add unattended runner primitives for node registration and auth

Implementation tickets:
- `T-00210` Add `hack workspace reset` for unattended runners
- `T-00211` Add `hack dispatch run --local` and typed PR terminal states
- `T-00214` Migrate `event-agent` QA runner to new `hack` runner primitives

Implemented in this pass:
- `hack node auth verify`
- `hack node ensure`

### Remote mode foundation

Implementation ticket:
- `T-00209` Define remote mode taxonomy and explicit remote actions UX

This work should drive CLI docs, Desktop project settings IA, and Topology language before larger app changes land.

### AWS node backend

Umbrella:
- `T-00198` Add AWS provider bootstrap for remote hack nodes

Implementation tickets:
- `T-00212` Implement AWS EC2 + SSM bootstrap for remote nodes
- `T-00213` Add AWS Desktop/Topology integration and source-backed parity flows

## UX Direction

### Keep project defaults

Projects still need a saved default execution behavior.

### Add explicit remote actions

Users should also be able to:
- start a remote instance
- run on remote once
- open a remote instance
- attach a devcontainer

Those actions should work without mutating the saved project default.

### Preserve branch instances

Branch instances are the right isolation model for parallel remote work. The product should make them more visible rather than inventing a second parallel concept.

## Acceptance Bar

This initiative is complete when:

- managed standalone runtime, remote workspace offload, and explicit remote run are documented and reflected in product surfaces
- AWS-backed nodes can be bootstrapped and used with the same parity expectations as other source-backed nodes
- `event-agent` can adopt the generic runner primitives without reintroducing bespoke shell behavior
