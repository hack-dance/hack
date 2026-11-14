# Give an agent an explicit project task

Start with [Install](../install.md) and [Getting started](../getting-started.md).
Decide which executable and backend the agent should use before asking it to change
project configuration. Agent setup is optional; a shell-capable client can use the
CLI and the [LLM index](/v5/llms.txt) directly.

A useful task names the project, the host it runs on, the Hack version and the
expected outcome. Ask the agent to inspect existing configuration before changing
it and to verify the application's own behavior afterwards.

## Onboarding prompt

`hack agent onboard` prints an onboarding prompt for an existing repository. It
inventories the repo and describes what a Hack setup should cover. It installs
nothing. Review the prompt, then hand it to your agent. `hack init --with
claude|codex` does the same for a new project and launches the selected agent.

The `hack-init` skill in the [hack plugin](../integrations.md) asks the CLI for this
same prompt, so an agent with the plugin can onboard a project on request.

## Policy stays with its owner

Hack does not modify `AGENTS.md`, `CLAUDE.md`, client rule files or global agent
settings, and it does not run guidance checks or skill updates. Repository policy
is yours. Project environment injection and lifecycle hooks are runtime features;
follow [Environment and secrets](../../env.md) and [Lifecycle](../../lifecycle.md)
when they are part of the requested work.

## Clients without a shell

A client without shell access can use the separate MCP server; see
[Agent integrations](../integrations.md#the-separate-hack-mcp-plugin) and
[MCP tools](../../reference/mcp-tools.md).

Foreground MCP `run` and `exec` calls use a 120-second server limit by default.
Set `timeoutMs` up to 600000, or use `hack.project.command.start` for long work.
A server timeout returns an error with `timedOut: true` and an explanation.
Codex MCP setup writes a 660-second tool-call limit when none is configured;
an explicit user limit is preserved, even if smaller.

Use `hack version --json` to read the running CLI version, release channel,
install kind and executable path without starting services or checking the
network. The JSON fields are `version`, `channel`, `install_kind` and
`binary_path`; a source run reports Bun as its executable and `source` as its
install kind.
