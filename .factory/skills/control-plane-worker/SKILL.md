---
name: control-plane-worker
description: Implements local-first CLI, runtime, env, lifecycle, tickets, and macOS companion features for Hack.
---

# Control Plane Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that primarily touch:
- `src/**` CLI and control-plane code
- `.hack/docker-compose.yml`, `.hack/hack.config.json`, or other source-of-truth Hack runtime files
- local runtime orchestration, env/runtime hardening, lifecycle processes, tickets, sessions, MCP/agent setup, docs, or the slim macOS companion

Do not use this skill for retired v3 surfaces:
- hosted auth/account/org/team management
- web dashboard work
- built-in GitHub workflows
- built-in Linear sync/project-artifact flows

## Required Skills

- `hack-cli` — invoke when the feature touches `.hack/**`, runtime orchestration, lifecycle/session flows, tickets, env, or any `hack up/ps/open/down` verification.

## Work Procedure

1. Read the assigned feature, `mission.md`, mission `AGENTS.md`, `.factory/services.yaml`, and relevant `.factory/library/*.md` files. Restate the exact assertions or outcomes the feature must complete.
2. Investigate existing code paths and add the failing test or regression harness first. Prefer the narrowest relevant suites under `tests/*.test.ts`. If the feature has no `fulfills` claims, still add characterization or regression coverage for the changed behavior.
3. Implement the smallest coherent change set in CLI, runtime config, tickets, env, lifecycle, macOS, or agent setup. Never hand-edit `.hack/.internal/**` or `.hack/.branch/**`; only change source-of-truth files.
4. Run focused validators first, then the smallest meaningful `typecheck`/`check` commands for the touched surfaces. For repo-bound CLI behavior, build and validate with `./dist/hack` or repo-local Bun entrypoints. When invoking `bun test` from the repo root against files outside `./tests`, use absolute paths or explicit `./`-prefixed paths that Bun actually honors in this repo so targeted commands do not silently skip files.
   - If the assigned feature is explicitly about fixing a known red baseline, capture the failing baseline evidence once, then continue the repair work and rerun the gate before handoff.
   - If repo-bound GitHub CLI routes cannot reach the changed auth code because `dance.hack.github` is not enabled in project config yet, use a direct resolver or similarly narrow deterministic smoke and record why the repo-bound path was unavailable.
   - If no safe repo-bound hook exists to force a failure mode (for example local-sync failure injection), deterministic regression tests are acceptable proof as long as you explain why a live manual repro would mutate real project state.
   - For daemon/gateway request-target hardening, raw-socket regression coverage against the proxy transport is preferred. If you also need live proof without mutating shared user daemon state, an isolated temp-HOME `bun index.ts daemon start --foreground` smoke is an acceptable validation pattern; record the isolation setup in the handoff.
   - For lifecycle changes, verify shell semantics, process-group cleanup, stale pane/process metadata reconciliation, singleton listener behavior, and doctor recovery guidance.
   - For env changes, verify overlay order, worktree-local override behavior, linked-worktree secret-key lookup, host-vs-compose target behavior, and materialization drift detection.
5. Capture any blockers, discovered issues, or scope mismatches immediately. If a feature needs credentials, unavailable infrastructure, or a change that would reintroduce hosted/web/integration dependencies, return to the orchestrator instead of guessing.
6. Stop any processes you started and produce a detailed handoff with exact commands, observations, tests added, and remaining issues.
9. If `bun run check` succeeds and only re-surfaces the known warning-only complexity diagnostics already documented in mission `AGENTS.md`, do not return to the orchestrator for that reason and do not record them as new discovered issues unless your feature directly worsened the warned files.

## Example Handoff

```json
{
  "salientSummary": "Hardened lifecycle singleton behavior for local tunnel helpers so Hack adopts a healthy existing listener set, fails partial conflicts, and avoids duplicate host process churn.",
  "whatWasImplemented": "Updated lifecycle config parsing, runtime startup decisions, docs, and regression coverage for singleton ports and adopt/fail behavior.",
  "whatWasLeftUndone": "Remote/gateway/node/dispatch were intentionally left untouched because they are unsupported experimental in v3.",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/project-lifecycle-singleton.test.ts tests/project-config.test.ts tests/project-config-schema.test.ts",
        "exitCode": 0,
        "observation": "Targeted lifecycle singleton/config regression suite passed."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "Workspace typecheck passed."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Ran hack doctor before and after hack down in a repo with stale lifecycle state.",
        "observed": "Doctor classified stale lifecycle metadata and pointed to hack down; cleanup removed only the matching lifecycle state."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/project-lifecycle-singleton.test.ts",
        "cases": [
          {
            "name": "adopts a complete singleton listener set",
            "verifies": "Hack does not start duplicate fixed-port tunnel helpers when all configured ports are already listening and onConflict is adopt."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature needs credentials, accounts, or third-party setup that are not already present.
- Hack global/runtime infrastructure is unavailable and cannot be restored within the mission boundaries.
- The change would reintroduce hosted auth, built-in GitHub/Linear, web dashboard, or remote dependencies into the supported v3 product.
- The feature requires a larger decomposition because the claimed assertions cannot be completed coherently in one session.
