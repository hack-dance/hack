# Give an agent the right context

[Agent setup in next.6](guides/agent-setup-v5-branch.md) documents the shipped opt-in model at source `44aaf5156426dfcbb1c8a189b8e20531e5b95613`. Use the actual selected documentation host; source publication does not establish site deployment.

Read this version's [LLM index](/v5/llms.txt) or [full corpus](/v5/llms-full.txt). They contain only the
selected version's allowlisted public docs. Use these canonical URLs when the
public site is deployed; for local review use the same paths on the preview host:

```text
https://hack.foo/v5/llms.txt
https://hack.foo/v5/llms-full.txt
```

A useful instruction to your agent:

```text
Read the selected Hack documentation index and existing repository policy.
Do not create or modify agent policy, hooks, rules or skills as a side effect.
Confirm the CLI version, execution host, project and intended instance.
Follow Install and Getting started for that version. Inspect existing services
before starting another instance. Keep secret values out of chat and command
arguments. Verify the application's own health, not just CLI exit status.
```

[Agent integrations](../integrations.md) describes this version's optional client
setup, with a historical next.5 compatibility boundary. The next.6 plugin manifests select skills only. Choose the selected CLI and
reviewed skills explicitly. A plugin on your laptop does not install tools in a cloud agent.
Agents with shell access can use the CLI directly; MCP is a separate interface,
not a prerequisite for ordinary project use.
