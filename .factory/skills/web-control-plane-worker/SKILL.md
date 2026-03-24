---
name: web-control-plane-worker
description: Implements browser-facing Next.js control-plane slices and verifies them end-to-end with agent-browser.
---

# Web Control Plane Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill for features that primarily touch:
- `apps/web/**`
- shared auth/UI modules consumed by the web app
- browser-facing admin, integration-management, or env/status surfaces
- vertical slices that require visible browser verification against the local routed host

## Required Skills

- `agent-browser` — mandatory for every feature that changes visible UI or user flows in `apps/web`.
- `hack-cli` — invoke when starting or inspecting the local runtime (`hack up`, `hack ps`, `hack open`) or when the feature touches `.hack/**` source-of-truth files.
- `linear` — invoke when the feature changes repo-bound Linear project/status surfaces and you need to verify synced project state or status-update behavior.

## Work Procedure

1. Read the assigned feature, `mission.md`, mission `AGENTS.md`, `.factory/services.yaml`, and relevant `.factory/library/*.md` files. Identify the exact user-visible flows and assertions this feature completes.
2. Write the failing tests first. Cover the smallest meaningful mix of component, route, integration, or contract tests needed for the slice before editing implementation.
3. Implement the smallest coherent vertical slice across `apps/web` and any supporting broker/shared modules it truly needs. Preserve browser-owned auth UX, durable shared state, and CLI optionality.
4. Start the local runtime with Hack-managed commands or the declared services manifest, then use `hack open --json` to determine the routed host. Use `agent-browser` to exercise each changed user flow end-to-end.
5. Verify not only the happy path but also loading/error/repair states. For navigation and shell work, include keyboard navigation and reduced-motion checks. For integration/admin flows, verify the visible state against the underlying broker or CLI output when the feature requires parity.
6. Run focused tests, then the smallest meaningful `typecheck`/`check` commands for the touched surfaces. Stop any runtime processes or watchers you started.
7. If the feature depends on missing backend contracts, missing runtime wiring, or a requirement that would make the web app mandatory for local workflows, return to the orchestrator with a concrete blocker report.

## Example Handoff

```json
{
  "salientSummary": "Added the apps/web account shell and browser-owned sign-in/account entrypoints, then verified identity continuity between the browser, broker current-user endpoint, and ./dist/hack auth status. The new shell is keyboard navigable and honors reduced-motion preferences.",
  "whatWasImplemented": "Created the initial authenticated app shell in apps/web, wired browser-owned sign-in/account routes to the broker-backed auth/session APIs, and added context rendering for the active user/org/team. Updated the shared auth wiring so the broker no longer serves the primary interactive auth shell for this slice.",
  "whatWasLeftUndone": "Project registration and integration-management pages were not part of this feature and remain for later slices.",
  "verification": {
    "commandsRun": [
      {
        "command": "bun test apps/web tests/auth-command.test.ts services/auth-broker/tests/session-auth.test.ts",
        "exitCode": 0,
        "observation": "Focused web + auth continuity tests passed after the new shell and handoff wiring landed."
      },
      {
        "command": "bun run typecheck",
        "exitCode": 0,
        "observation": "Workspace typecheck passed with the new apps/web additions."
      },
      {
        "command": "hack up -d && hack open --json",
        "exitCode": 0,
        "observation": "Hack-managed runtime exposed the routed local host used for browser verification."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Used agent-browser to sign in from the routed web host and land on the account shell.",
        "observed": "The shell rendered the signed-in user plus active org/team context, and the broker current-user endpoint matched the same identity."
      },
      {
        "action": "Navigated the shell with keyboard-only input and with reduced-motion enabled.",
        "observed": "Focus states remained visible, navigation stayed usable, and motion effects collapsed to reduced-motion-safe transitions."
      },
      {
        "action": "Compared the signed-in shell context with ./dist/hack auth status --json.",
        "observed": "Browser, broker, and CLI all reported the same active user/org/team context after sign-in handoff."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "apps/web/app/(auth)/sign-in/page.test.tsx",
        "cases": [
          {
            "name": "sign-in route consumes the shared provider contract",
            "verifies": "The browser-owned auth UX renders the same enabled providers the broker exposes."
          }
        ]
      },
      {
        "file": "apps/web/app/(app)/account-shell.test.tsx",
        "cases": [
          {
            "name": "account shell renders the active user and org/team context",
            "verifies": "The web shell stays in parity with broker current-user state after login."
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature needs backend contracts or durable state that do not exist yet.
- The local runtime cannot expose a stable routed host for browser verification.
- The UI slice cannot be completed without violating CLI optionality or auth ownership rules.
- Browser verification reveals a wider architectural mismatch that should be decomposed into a follow-up backend/platform feature first.
