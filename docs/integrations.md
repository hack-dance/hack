# Local Helpers

Hack no longer ships hosted or broker-backed integrations.

What remains:

- local env management and host/container injection
- local sessions and runtime orchestration
- optional coding-agent setup helpers: `hack init --with claude|codex|both`, `hack agent onboard` /
  `hack agent init` / `hack agent prime`, and scoped `hack setup` commands

`hack setup sync` keeps interactive output compact: it summarizes each scope and only expands the
path and reason for stale, missing, or failed artifacts. Exit status remains the automation contract,
and the individual `hack setup cursor|claude|codex|agents|mcp --check` commands remain available when
you need per-artifact detail.

What does not ship: Hack Tickets, built-in GitHub or Linear integrations, hosted
auth/account/org/team surfaces, and the web dashboard control plane.

Recommended replacements:

- GitHub: native `git` and `gh`
- planning systems: keep them outside Hack and use the tracker selected by the project

## Agent integration freshness

Hack maintains project instructions plus global Cursor, Claude, Codex, and shared `~/.ai/skills`
surfaces. Generated guidance identifies the CLI version that rendered it.

Run checks when Hack is relevant and there is evidence of drift; there is no mandatory startup audit.
Plain `hack agent prime`, including installed SessionStart/PreCompact hooks, prints the current
primer without scanning project or global integrations. Use `hack agent prime --check` for an
explicit read-only inventory, or a targeted `hack setup ... --check` for per-artifact detail.
Outside a Hack project, `hack agent prime --check` inventories global integrations only. Doctor
classifies inventory commands as follow-up investigation and keeps scoped repair guidance separate.
Inventory findings do not block unrelated work, and missing optional integrations need not be installed.

Ordinary commands, `hack update`, and `hack doctor --fix` never modify these surfaces. Doctor may
report freshness findings. Repair only the affected integration and scope covered by the request;
`hack setup sync --all-scopes` remains available for an explicitly requested full refresh.
Existing authorization for that action and scope is sufficient. After repair, read the updated
guidance; restart only if the client cannot reload changed hooks or skills.

## Optional native plugins

Hack also ships an optional native plugin for Codex, Claude Code, and Cursor in
`plugins/hack`. It bundles the `hack-cli` and `hack-init` skills, the `hack mcp serve`
server, Claude primer hooks, and a Cursor rule that the agent can select when relevant.
Install the Hack CLI first and make `hack` available on the client's PATH.

Choose either the native plugin or the existing standalone setup for each client.
Installing a plugin does not migrate or remove existing rules, skills, hooks, or MCP
configuration. If switching an existing installation, inspect the chosen client's
project and user scopes, verify the plugin loads in a fresh session, then explicitly
remove only duplicate Hack-owned entries in that scope. Preserve customized content.
Do not use a broad sync or removal command as a migration step. If validation fails,
disable the plugin and keep using the standalone integration.

Codex:

```bash
codex plugin marketplace add hack-dance/hack
codex plugin add hack@hack-dance
```

Claude Code:

```bash
claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack
claude plugin install hack@hack-dance
```

Cursor: open Customize, find Hack in the configured marketplace, and choose the
project or user installation scope. For local development, copy `plugins/hack` into
`~/.cursor/plugins/local/hack` when that destination is unused, then reload Cursor
and inspect the Hack plugin in Customize. Cursor 3.18.25 rejects symlinks to targets
outside its local-plugin root; use a copy rather than weakening that boundary. See
[Cursor's plugin documentation](https://cursor.com/docs/plugins) for marketplace
and local development support in the installed client version.

After installing, verify in a fresh session that both skills are discoverable,
`hack mcp serve` can initialize, and the client's hooks or rule load. A successful
marketplace registration alone does not prove those components loaded. The plugin's
MCP fallback is for clients without shell access; use the Hack CLI when shell is available.

Plugin updates are managed by the client. Ordinary Hack commands, `hack update`,
`hack doctor --fix`, and primer hooks never install plugins or clean up integrations.
A missing optional plugin is not a broken Hack installation. Model selection and
global instruction, evolution, and writeback policy remain with the user's existing
provider configuration; the Hack plugin adds only Hack-specific guidance.

Contributors: change shared behavior in `src/agents/instruction-source.ts`, then run
`bun run generate:agent-plugins`. The generation tests check bundled guidance against
the canonical renderers. Release preparation regenerates all plugin content after the
version bump and commits the complete bundle with the CLI release.
