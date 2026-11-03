# Give an agent an explicit project task

Start with [Install](../install.md) and [Getting started](../getting-started.md). Select the intended executable and runtime before asking an agent to change project configuration. Agent setup is optional; shell-capable clients can use the CLI and [versioned LLM index](/v5/llms.txt) directly.

A useful task description names the project, execution host, selected version and expected outcome. Ask for inspection of existing configuration before changes and verification of the application's own behavior. Preserve existing credential flows and native approval boundaries.

## Optional onboarding prompt

The pinned CLI's `agent onboard` command prints a project onboarding prompt. It does not install skills or client instructions. Review that prompt before handing it to your agent; the request defines the work to perform. It is separate from the historical primer hooks.

For clients supporting explicitly selected skills, the shipped hack-init skill asks for that CLI prompt. Review the actual skill first: next.6 ships opt-in skills without automatic guidance injection. [Choose an agent interface](../integrations.md) explains the exact shipped contents and the shipped opt-in model.

## Keep policy with its owner

This setup path does not modify AGENTS.md, CLAUDE.md, client rule files or global agent settings. It does not run guidance freshness checks, sync exports or skill updates. Repository policy remains user-owned.

Project environment injection and lifecycle hooks are runtime features, not agent instruction injection. Follow [Environment and secrets](../../env.md) and [Lifecycle](../../lifecycle.md) when they are part of the requested application workflow. Native candidate limits remain separate from retained Compose command contracts.

## Optional MCP

A no-shell client can use an explicitly configured separate MCP interface; it does not get one merely by selecting the hack skills. See [Integrations](../integrations.md#optional-separate-mcp) and [MCP tools](../../reference/mcp-tools.md). Neither a published manifest nor a printed prompt proves client loading or successful project execution.
