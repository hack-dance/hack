---
name: control-plane-worker
description: Implements CLI, broker, database, runtime, integration, and closeout features for the Hack control plane.
---

# Control Plane Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that primarily touch:
- `src/**` CLI and control-plane code
- `services/auth-broker/**`
- `packages/db/**`
- `.hack/docker-compose.yml`, `.hack/hack.config.json`, or other source-of-truth Hack runtime files
- Linear/GitHub auth resolution, project sync, status updates, env/runtime hardening, or mission closeout/audit work

## Required Skills

- `hack-cli` — invoke when the feature touches `.hack/**`, runtime orchestration, gateway/session flows, tickets, or any `hack up/ps/open/down` verification.
- `linear` — invoke when the feature changes repo-bound Linear project sync, status-update publishing, artifact layout, or mission closeout behavior.

## Work Procedure

1. Read the assigned feature, `mission.md`, mission `AGENTS.md`, `.factory/services.yaml`, and relevant `.factory/library/*.md` files. Restate the exact assertions or outcomes the feature must complete.
2. Investigate existing code paths and add the failing test or regression harness first. Prefer the narrowest relevant suites (`tests/*.test.ts`, `services/auth-broker/tests/*.test.ts`, `packages/db/tests/*.test.ts`). If the feature has no `fulfills` claims, still add characterization or regression coverage for the changed behavior.
3. Implement the smallest coherent change set in CLI, broker, database, or Hack runtime config. Never hand-edit `.hack/.internal/**` or `.hack/.branch/**`; only change source-of-truth files.
4. Run focused validators first, then the smallest meaningful `typecheck`/`check` commands for the touched surfaces. For repo-bound CLI behavior, build and validate with `./dist/hack` or repo-local Bun entrypoints. For HTTP features, use declared service commands and `curl` health/API checks.
5. If the feature touches Linear project/state behavior, use repo-bound `./dist/hack linear ...` flows to verify the effect and record the exact commands/results. Do not rely on manual remote edits as the primary proof.
6. Capture any blockers, discovered issues, or scope mismatches immediately. If a feature needs new credentials, unavailable infrastructure, or a change that would violate CLI optionality/auth ownership, return to the orchestrator instead of guessing.
7. Stop any processes you started and produce a detailed handoff with exact commands, observations, tests added, and remaining issues.

## Example Handoff

```json
{
  "salientSummary": "Hardened Linear unattended auth and artifact-path behavior so env-only mode fails closed without keychain fallback and repo-bound artifact commands no longer treat .hack/.hack/linear as authoritative. Added regression tests and verified the current branch CLI with ./dist/hack.",
  "whatWasImplemented": "Updated the Linear auth resolver and command guidance paths, added canonical-path normalization/rejection in project artifact helpers, and extended regression coverage for env-only failure, refresh persistence, and legacy artifact-root handling. The repo-bound CLI now reports the correct repair guidance for broker-vs-local failures.",
  "whatWasLeftUndone": "Did not touch the future apps/web runtime wiring; that remains for later milestones.",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test tests/linear-auth.test.ts tests/linear-project-artifacts.test.ts tests/linear-commands.test.ts tests/prerequisites-matrix.test.ts",
        "exitCode": 0,
        "observation": "Targeted Linear/auth regression suite passed after adding the new fail-closed and canonical-path cases."
      },
      {
        "command": "bun run build",
        "exitCode": 0,
        "observation": "Rebuilt ./dist/hack for repo-bound CLI verification."
      },
      {
        "command": "./dist/hack linear status --json",
        "exitCode": 0,
        "observation": "Repo-bound Linear status still resolves the bound Hack project/profile after the auth-path changes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Ran a manual repo-bound artifact pull/apply smoke and inspected the working tree.",
        "observed": "Only .hack/linear/projects/<project-id>/... changed; the legacy .hack/.hack/linear tree was not used as the active artifact root."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "tests/linear-auth.test.ts",
        "cases": [
          {
            "name": "env-only mode fails closed when the env token is missing",
            "verifies": "No keychain fallback or silent success occurs when HACK_LINEAR_PREFER_ENV_TOKEN_ONLY=true without a configured token."
          }
        ]
      },
      {
        "file": "tests/linear-project-artifacts.test.ts",
        "cases": [
          {
            "name": "legacy .hack/.hack/linear paths are rejected or ignored",
            "verifies": "Artifact commands only treat the canonical .hack/linear tree as authoritative."
          }
        ]
      }
    ]
  },
  "discoveredIssues": [
    {
      "severity": "medium",
      "description": "The broader auth-broker config harness is still environment-sensitive when repo-root env files leak into tests outside the focused Linear suites.",
      "suggestedFix": "Keep the planned validation-harness-hardening feature near the top of the mission queue."
    }
  ]
}
```

## When to Return to Orchestrator

- The feature needs credentials, accounts, or third-party setup that are not already present.
- Hack global/runtime infrastructure is unavailable and cannot be restored within the mission boundaries.
- The change would introduce a second auth authority or make a critical local-first workflow web-only.
- The feature requires a larger decomposition because the claimed assertions cannot be completed coherently in one session.
