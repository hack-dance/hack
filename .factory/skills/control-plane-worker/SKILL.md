---
name: control-plane-worker
description: Implement or verify Hack's local CLI, runtime, env, lifecycle, sessions, and optional agent integrations. The skill name is retained for Factory compatibility.
---

# Hack CLI worker

Read the repository `AGENTS.md` and `WORKFLOW.md`. If a Factory mission supplies
additional instructions, acceptance claims, or `worker-base`, use them for that
mission; do not assume those files or tools exist in ordinary tasks.

1. Identify the requested behavior, source, and verification path. Recover missing
   context from the repo before asking for information that may already be present.
2. Add or update a meaningful regression test for changed behavior. Pure docs or
   metadata changes need appropriate validation, not mandatory characterization tests.
3. Implement the smallest coherent change and update affected docs or canonical
   agent guidance. Preserve user changes and generated-runtime ownership.
4. Test the current branch with repo-local Bun commands or `./dist/hack`. Use the
   relevant `.factory/services.yaml` commands; do not rely on an installed older CLI
   as proof of a code change. Isolate stateful env, lifecycle, daemon, and Docker tests.
5. Complete required checks and report exact results and remaining uncertainty.
   Known warning-only diagnostics do not become a new blocker unless the change
   worsens them. Failed required checks still need repair.
6. Stop only task-owned temporary processes. Record useful learning and actionable
   follow-up within authorization; skip empty handoff or ticket paperwork.

Do not restore retired hosted auth, tickets, GitHub/Linear, or dashboard features.
The macOS app and remote/gateway/node/dispatch are unsupported and require an explicit
request; they are not baseline validation dependencies. Surface genuine credential,
permission, or infrastructure blockers while continuing independent authorized work.
Never copy secrets, bypass native approvals, or broaden runtime cleanup to get a green check.
