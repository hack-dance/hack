# Runtime Crash Recovery Design

## Context

`hack doctor` already detects many runtime and proxy failure modes, and `hack crash-capture` already snapshots some local state. The gap is operator usability: warnings are isolated, restart versus repair paths are not grouped into a repeatable sequence, and crash bundles require too much manual interpretation.

This issue targets runtime and proxy breakage where users need to answer three questions quickly:

1. Is this likely temporary breakage that a restart can fix?
2. Is this deeper configuration drift that needs repair?
3. If it still fails, what artifact should be collected for diagnosis?

## Goals

- Make crash bundles immediately useful for diagnosis without requiring source familiarity.
- Make restart and proxy recovery steps explicit in `hack doctor`.
- Separate temporary runtime/proxy drift from deeper configuration problems.
- Keep the recovery flow consistent across CLI output and written docs.

## Non-Goals

- Reworking core runtime startup behavior.
- Adding background crash daemons or automatic upload/reporting.
- Expanding `doctor --fix` beyond its current repair scope.

## Approaches Considered

### 1. Add structured recovery guidance plus richer crash bundle summaries (recommended)

Keep the existing commands, but add:
- recovery classification in `hack doctor`
- a readable recovery panel with ordered commands
- structured crash-bundle summaries plus extra diagnostics

Pros:
- Fits existing operator workflow.
- Low risk to core runtime behavior.
- Improves both human UX and diagnostic artifacts.

Cons:
- Requires keeping diagnosis heuristics conservative.

### 2. Add more raw logs only

Pros:
- Small code change.

Cons:
- Does not solve the “what should I do next?” problem.
- Keeps diagnosis dependent on tribal knowledge.

### 3. Auto-run repair actions from every relevant command

Pros:
- Fewer manual steps in ideal cases.

Cons:
- Higher blast radius.
- Too aggressive for ambiguous failure states.

## Recommended Design

Adopt approach 1.

### Doctor Recovery Workflow

`hack doctor` should classify warnings/errors into operator-facing buckets:

- `temporary breakage`
  - global proxy/runtime not running
  - stale project host mapping
  - daemon not running or starting
- `configuration repair`
  - CoreDNS forwarding failure
  - missing CA
  - ingress network/subnet drift
  - dnsmasq/resolver drift
- `manual follow-up`
  - anything not safely auto-classified

After the checks complete, `hack doctor` should print one recovery panel that:

1. lists the immediate restart commands first
2. lists repair commands second
3. finishes with verification and crash-capture collection

That panel should make the intended sequence obvious:

1. `hack global up` for missing proxy/global runtime
2. `hack restart` for stale project host mappings
3. `hack daemon start` or `hack daemon clear && hack daemon start` for daemon drift
4. `hack doctor --fix` for configuration repair
5. `hack doctor` to verify
6. `hack crash-capture --path <repo>` if still broken

### Crash Bundle Improvements

`hack crash-capture` should produce a bundle that is useful before opening individual log files.

New artifacts:
- `summary.json` with captured command outcomes, detected symptoms, and recommended next steps
- `README.txt` with a short human-readable bundle map and recovery sequence

Additional captured state:
- `hack doctor --path <repo>`
- `hack global status --json`
- `hack daemon logs --no-follow`
- global proxy logs where available
- docker network inspection for ingress/logging networks

The bundle should also avoid avoidable capture failures. The current process snapshot uses `rg`; it should fall back to a more portable filter so process capture still works on machines without ripgrep.

### Diagnostics Heuristics

Both `hack doctor` and `hack crash-capture` should share the same conservative recovery diagnosis rules so the bundle summary and live CLI guidance do not drift.

Rules:
- Only classify a step as restartable when the associated check directly implies that restart action.
- Prefer `hack doctor --fix` for DNS/network/CA drift.
- Preserve unknown issues as explicit follow-up items instead of over-claiming a fix path.

## Testing

- Add unit tests for doctor recovery classification and rendered action groups.
- Add unit tests for crash bundle summary generation and human-readable README content.
- Add command-level tests for crash-capture outputs that do not require live Docker access.

## Docs

- Update CLI docs for `hack doctor` and `hack crash-capture`.
- Update README troubleshooting so it mirrors the exact same recovery sequence as the CLI.
