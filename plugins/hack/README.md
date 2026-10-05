# Hack agent plugin

Optional Hack integration for Codex, Claude Code, and Cursor. Install the `hack`
executable first; the plugin uses it from PATH.

The bundle contains four skills:

- `hack-cli`: services, logs, environments, worktrees and diagnostics.
- `hack-init`: configure a new or existing project for Hack.
- `hack-install`: installation, stable/prerelease selection, upgrade and rollback.
- `hack-remote`: prepare an existing project on another machine or in Codex Cloud.

It also contains `hack mcp serve`, Claude primer hooks, and a Cursor rule selected
when relevant. It is generated from Hack's canonical guidance and versioned with
the CLI. Portable clients use root `plugin.json` and `mcp.json`; older clients
retain their compatibility manifests. The repository marketplace is not evidence
of an OpenAI directory listing.

## Private Codex installation

If the client already has a Hack MCP registration, or only needs skills, retain
that selection and disable the bundle's MCP entry in the client configuration:

```toml
[plugins."hack@hack-dance".mcp_servers.hack]
enabled = false
```

This keeps the four plugin skills available without launching a second bundled
server. A standalone registration remains independently configured. Preserve
existing customized skills; resolve overlapping installation paths deliberately.

From a reviewed checkout:

```sh
codex plugin marketplace add /absolute/path/to/hack-checkout
codex plugin add hack@hack-dance
codex plugin list --json --marketplace hack-dance
```

Start a fresh client, confirm all four plugin skills load, and call a harmless
MCP tool such as `hack.projects.list` against an isolated registry. Inspect
actual discovered tool names first.
The server and Claude hooks still resolve `hack` from the client's PATH; installing
the plugin does not switch them to `hack-next`. Use the explicit candidate CLI
for candidate work. A separately configured MCP integration must pin the intended
executable and home before it can operate on that channel.

Personal local plugins do not automatically appear in Codex Cloud. Make the
needed skills available in the cloud repository/environment and verify a new
cloud task loads them. Follow the `hack-remote` workflow and
[managed environment guide](../../docs/guides/codex-managed-environments.md).
Full runtime availability and app acceptance must be verified on that host.

## Distribution boundary

This bundle uses local stdio MCP. Public OpenAI submission currently requires an
HTTPS MCP endpoint or coordination with OpenAI for local MCP support; see the
[official packaging guidance](https://developers.openai.com/plugins/build/plugins).
Do not expose a workstation runtime publicly or remove MCP just to submit a
skills-only listing. Confirm any existing account registration before creating
another. Private installation, account registration and public publication are
separate steps.

See [installation and migration guidance](../../docs/integrations.md#optional-native-plugins).
Existing standalone setup remains supported. Installation never deletes legacy
content, changes global policy, or triggers broad integration sync. Use one integration
path per client to avoid duplicate skills, hooks, and MCP registrations.

Contributors: run `bun run generate:agent-plugins` after changing canonical guidance.
Root portable manifests are derived from `.codex-plugin/plugin.json` and
`.mcp.json`; edit those sources and regenerate. Do not edit generated skills,
portable manifests or rules directly. Validate actual component loading in
a fresh client session before describing an installation as working.
