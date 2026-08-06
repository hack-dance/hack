# Hack agent plugin

Operate and onboard [Hack](https://github.com/hack-dance/hack)-managed local development
environments from Cursor, Claude Code, or Codex.

The plugin bundles:

- `hack-cli`: local runtime, environment, logs, sessions, and diagnostic guidance
- `hack-init`: agent-assisted onboarding through `hack agent onboard`
- `hack mcp serve`: the no-shell MCP fallback
- client-native Cursor rules and Claude Code primer hooks

The `hack` executable must be installed and available on `PATH`. Plugin skills prefer the CLI when
shell access is available and use MCP only when it is not.

## Installation

See the repository's [agent integration guide](../../docs/integrations.md) for the native marketplace
commands for Cursor, Claude Code, and Codex. Start a new agent session after installing or updating
the plugin.

This directory is generated and versioned with the Hack CLI release. Update canonical guidance in
`src/agents/instruction-source.ts`, then run `bun run generate:agent-plugins`.
