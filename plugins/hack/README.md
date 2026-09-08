# Hack agent plugin

Optional Hack integration for Codex, Claude Code, and Cursor. Install the `hack`
executable first; the plugin uses it from PATH.

The bundle contains `hack-cli` and `hack-init` skills, `hack mcp serve`, Claude
primer hooks, and a Cursor rule selected when relevant. It is generated from
Hack's canonical guidance and versioned with the CLI.

See [installation and migration guidance](../../docs/integrations.md#optional-native-plugins).
Existing standalone setup remains supported. Installation never deletes legacy
content, changes global policy, or triggers broad integration sync. Use one integration
path per client to avoid duplicate skills, hooks, and MCP registrations.

Contributors: run `bun run generate:agent-plugins` after changing canonical guidance.
Do not edit generated skills or rules directly. Validate actual component loading in
a fresh client session before describing an installation as working.
