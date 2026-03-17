# Daemon Runtime Reset Repair Design

## Context

`hackd` already fingerprints Docker runtime identity and increments a reset counter when that fingerprint changes. The current behavior is still too opaque and too manual in two places:

- reset detection only tells callers that a reset happened, not what changed
- daemon auto-start only repairs the obvious "socket missing" case, while stale pid/socket state and incompatible daemon state still push users toward manual cleanup

## Goals

- identify which runtime identity fields changed when a reset is detected
- surface reset details in daemon metrics and cached runtime payloads
- auto-repair daemon access when the local state is stale and the repair is safe
- give users a clear next step when the daemon cannot be repaired automatically

## Non-goals

- guessing whether ordinary container churn is a Docker engine reset
- force-restarting a running daemon process automatically when compatibility is uncertain
- changing the direct non-daemon runtime fallback path in this ticket

## Approaches

### 1. Fingerprint-only, better messaging

Keep the current fingerprint logic, but improve status text around stale daemon state.

Pros: minimal risk
Cons: weak drift identification; does not change repair behavior meaningfully

### 2. Identity diff + safe stale-state auto-repair

Track the specific runtime identity fields that changed, expose them through daemon payloads, and teach the daemon client to repair safe stale-state failures automatically before retrying.

Pros: directly addresses detection, observability, and predictable recovery
Cons: requires touching both runtime cache and daemon client/status flows

### 3. Runtime inventory diff + aggressive restart

Compare full runtime inventory between refreshes and auto-restart the daemon whenever access looks degraded.

Pros: stronger automation
Cons: higher false-positive risk; unsafe to restart a live daemon automatically

## Recommendation

Use approach 2. It improves signal quality without conflating normal container churn with engine resets, and it keeps auto-repair bounded to the cases that are safe to repair automatically.

## Design

### Runtime reset detection

- Extend runtime health tracking with reset detail fields:
  - `lastResetSummary`
  - `lastResetReasons`
- Promote more identity fields into the runtime fingerprint and diff:
  - engine id
  - engine name
  - engine version
  - docker host
  - socket path
  - socket inode
- When the fingerprint changes, compute a stable list of changed fields and store a readable summary such as `engine_version_changed, socket_inode_changed`.

### Safe auto-repair

- Expand daemon probing from a boolean `apiOk` into a richer probe with compatibility state.
- In the daemon client, treat these states as safely auto-repairable:
  - socket exists but pid is stale
  - socket exists without pid
  - raw daemon request fails and the daemon is no longer running
- Auto-repair path:
  - start the daemon through the CLI start path
  - rely on `hack daemon start` to clear stale pid/socket files before spawn
  - retry the daemon request once after repair
- Do not auto-restart a currently running but incompatible daemon. That remains guided repair because killing an active daemon can interrupt active sessions or streams.

### Guided repair and visibility

- Extend daemon status reporting with:
  - incompatibility detection
  - `nextStep`
  - `issue`
- Update `hack daemon status` and `hack doctor` messaging so users see whether Hack repaired stale state automatically or needs a manual `hack daemon restart`.
- Add reset summary fields to daemon metrics and cached runtime JSON payloads so users can inspect what changed.

## Testing

- runtime cache tests for reset summary/reasons and version/name-triggered identity changes
- daemon status tests for incompatible daemon guidance
- daemon client tests for safe stale-state auto-repair and retry behavior
