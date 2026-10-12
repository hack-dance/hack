---
name: hack-init
description: >
  Stand up or adopt hack in a project (agent-assisted onboarding).
  Trigger when asked to set a repo up with hack, migrate a project onto
  hack, or finish/repair a partial hack setup.
---

# hack init (agent-assisted onboarding)

Fetch the current onboarding guidance from the installed Hack CLI.

1. Fetch the canonical onboarding prompt:
   - With shell access: run `hack agent onboard` (works for new and existing projects).
   - Without shell access: only if the `hack-mcp` plugin or another Hack MCP server is installed, fetch the `hack-init` MCP prompt from it; otherwise report that onboarding needs shell access or an explicitly selected Hack MCP server.
2. Apply the relevant phases to the authorized workflow; preserve native approvals, credential safety, and runtime ownership.
3. Verify the requested services and host workflows. Report remaining blockers; unrelated optional integration warnings do not prevent completion.
