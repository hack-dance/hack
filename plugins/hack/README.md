# Hack agent plugin

Optional Hack integration for Codex, Claude Code, and Cursor, and the default way to
give an agent Hack guidance. Install the `hack` executable first; the plugin uses it
from PATH.

The bundle contains four skills:

- `hack-cli`: services, logs, environments, worktrees and diagnostics.
- `hack-init`: configure a new or existing project for Hack.
- `hack-install`: installation, stable/prerelease selection, upgrade and rollback.
- `hack-remote`: prepare an existing project on another machine or in Codex Cloud.

It also contains Claude primer hooks and a Cursor rule selected when relevant. It
ships no MCP server: no `mcpServers` declaration and no `.mcp.json` or `mcp.json`
file. It is generated from Hack's canonical guidance and versioned with the CLI.
Portable clients use root `plugin.json`; older clients retain their compatibility
manifests. The repository marketplace is not evidence of an OpenAI directory listing.

## MCP is a separate plugin

Install the companion [`hack-mcp`](../hack-mcp/README.md) plugin only when MCP is
wanted, usually for a client without shell access. With shell access, these skills
and the Hack CLI cover the same workflows. Keep one Hack MCP registration per client:
either `hack-mcp` or one `hack mcp install` entry, not both.

Earlier releases of this plugin bundled `hack mcp serve`. Updating removes that
server. Add `hack-mcp` if you relied on it. A client setting that disabled the old
bundled server has nothing left to disable and can be removed.

## Private Codex installation

From a reviewed checkout:

```sh
codex plugin marketplace add /absolute/path/to/hack-checkout
codex plugin add hack@hack-dance
codex plugin list --json --marketplace hack-dance
```

Start a fresh client and confirm all four plugin skills load. If you also installed
`hack-mcp`, call a harmless MCP tool such as `hack.projects.list` against an isolated
registry, after inspecting the actual discovered tool names.
The Claude hooks and the `hack-mcp` server still resolve `hack` from the client's
PATH; installing a plugin does not switch them to `hack-next`. Use the explicit
candidate CLI for candidate work. A separately configured MCP integration must pin
the intended executable and home before it can operate on that channel.

Personal local plugins do not automatically appear in Codex Cloud. Make the
needed skills available in the cloud repository/environment and verify a new
cloud task loads them. Follow the `hack-remote` workflow and
[managed environment guide](../../docs/guides/codex-managed-environments.md).
Full runtime availability and app acceptance must be verified on that host.

## Distribution boundary

This bundle has no MCP server. The separate `hack-mcp` bundle uses local stdio MCP;
public OpenAI submission of a local MCP server currently requires an HTTPS MCP
endpoint or coordination with OpenAI; see the
[official packaging guidance](https://developers.openai.com/plugins/build/plugins).
Do not expose a workstation runtime publicly. Confirm any existing account
registration before creating another. Private installation, account registration
and public publication are separate steps.

See [installation and migration guidance](../../docs/integrations.md#optional-native-plugins).
Existing standalone setup remains supported. Installation never deletes legacy
content, changes global policy, or triggers broad integration sync. Use one integration
path per client to avoid duplicate skills, hooks, and MCP registrations.

Contributors: run `bun run generate:agent-plugins` after changing canonical guidance.
The root portable manifest is derived from `.codex-plugin/plugin.json`; edit that
source and regenerate. The generator refuses a client manifest that declares
`mcpServers`; MCP belongs in `hack-mcp`. Do not edit generated skills, portable
manifests or rules directly. Validate actual component loading in a fresh client
session before describing an installation as working.
