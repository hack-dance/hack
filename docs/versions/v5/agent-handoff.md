# Give an agent the right context

Read this version's [LLM index](/v5/llms.txt) or [full corpus](/v5/llms-full.txt).
They contain only the selected version's public docs:

```text
https://hack.foo/v5/llms.txt
https://hack.foo/v5/llms-full.txt
```

A useful brief for your agent:

```text
Read the Hack v5 documentation index and the repository's existing agent policy.
Confirm the Hack executable, version, backend, host, project and intended instance
before changing anything. Inspect running services before starting another
instance. Keep secret values out of chat and command arguments. Verify the
application's own health, not just the CLI exit status. Do not create or modify
agent policy, hooks, rules or skills as a side effect.
```

Agents with shell access can use the CLI directly. `hack agent onboard` prints a
project onboarding prompt for an existing repository; `hack init --with claude|codex`
hands first setup to an agent. Neither writes instruction files into your repository.

[Agent integrations](../integrations.md) describes the optional `hack` plugin,
whose skills give Codex, Claude Code and Cursor Hack guidance, and the separate
`hack-mcp` plugin for clients without shell access. A plugin installed on your
laptop does not install anything in a cloud agent; see
[Use a cloud agent or another host](guides/cloud-environments.md).
