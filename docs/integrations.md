# Local Helpers

Hack no longer ships hosted or broker-backed integrations.

What remains:

- local env management and host/container injection
- local sessions and runtime orchestration
- optional coding-agent integration: the `hack` plugin first (see
  [Optional native plugins](#optional-native-plugins)), plus `hack init --with claude|codex`,
  `hack agent onboard` / `hack agent init` / `hack agent prime`, and opt-in scoped `hack setup`
  export commands

`hack setup sync` keeps interactive output compact: it summarizes each scope and only expands the
path and reason for preserved or failed artifacts (and, with `--check`, the ones sync would change).
Exit status remains the automation contract, `--json` lists every target, and the individual
`hack setup cursor|claude|codex|agents|mcp --check` commands remain available when you need
per-client detail.

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

Standalone install and remove (`hack setup cursor|claude|codex` and `hack setup sync`) change only
files Hack owns: the current render or an unedited render from an earlier release. An edited or
unrecognized `SKILL.md` or `hack.mdc` is reported as `preserved` with a reason and left unchanged;
move or delete it yourself to reinstall. Removal deletes only the owned `SKILL.md` and removes its
skill directory only when nothing else is in it. Claude hook removal drops only the
`hack agent prime` entries and keeps other commands. Preserved files do not change the exit status
of an install, sync, or remove.

### Refresh-only `hack setup sync`

`hack setup sync` refreshes only integrations that are already installed and Hack-owned. It never
creates a missing one. Per target, in the selected scope (project by default, `--global`, or
`--all-scopes`):

| Status | Meaning |
| --- | --- |
| `refreshed` | An installed Hack-owned target was rewritten to the current render |
| `unchanged` | The target already matches the current render |
| `preserved` | The file is customized or unrecognized; it is left byte-identical and the closed reason is reported |
| `missing` | The target is not installed; sync skipped it |
| `installed` | Created only with `--install-missing` |
| `removed` | A recognized retired Hack artifact was deleted (or, with `--remove`, a Hack-owned target) |
| `error` | The target could not be read or parsed; it is left unchanged |

Hack-owned means: a current or known earlier render of a standalone skill or rule file; the
marker-delimited section of `AGENTS.md`/`CLAUDE.md`; the `hack agent prime` entries of the Claude
settings file; and the `hack` entry of an MCP config. A doc, settings file, or MCP config without
the Hack section counts as `missing`, so the file is not modified. Existing MCP entries are
never replaced.

Add `--install-missing` to also create missing integrations in the selected scope; customized
files stay `preserved`. `--check` is read-only: it reports what sync would do with the same flags
and exits non-zero when sync would refresh, install, or remove something, a file is preserved,
or a target errors. A missing target fails `--check` only together with `--install-missing`.
`--json` prints `{ok, data: {action, dryRun, installMissing, counts, targets}}`, where each
target carries `scope`, `target`, `path`, `status`, and, when preserved, `reason`. Messages are
fixed text and never include file contents.

## Standalone MCP configuration

`hack mcp print --claude --scope project` previews a project entry;
`hack mcp install --claude --scope project` installs it. Claude Code reads project
MCP servers from `.mcp.json` and user-scoped servers from `~/.claude.json`, as described
in [Claude's MCP scope documentation](https://code.claude.com/docs/en/mcp#mcp-installation-scopes).
The setup check and removal commands use those same locations. Primer hooks continue
to use `.claude/settings.json`; that file serves a different purpose.

Older Hack versions wrote standalone Claude MCP entries into `settings.json`.
Reinstall in the intended scope to create the entry where Claude loads it. Hack
preserves the old settings file, unrelated fields and other servers. Malformed or
unreadable configuration is refused without replacing it, and parse errors do not
include configuration contents. This is not an automatic migration or a change to
already-running clients. Project-scoped servers remain subject to Claude's workspace
trust and approval rules.

## Optional native plugins

The plugin is the default way to give a coding agent Hack guidance. Hack ships two
plugins for Codex, Claude Code, and Cursor from this repository's marketplace:

| Plugin | Contents | Install when |
| --- | --- | --- |
| `hack` (`plugins/hack`) | Eight skills (`hack-cli`, the focused `hack-branches`, `hack-env` and `hack-diagnose`, `hack-feedback`, `hack-init`, `hack-install`, and `hack-remote`), Claude primer hooks, and a Cursor rule that the agent can select when relevant. No MCP server. | You want Hack guidance in a client. This is the default. |
| `hack-mcp` (`plugins/hack-mcp`) | Only the stdio `hack mcp serve` server. No skills, hooks, or rules. | You explicitly want MCP, usually for a client without shell access. |

The plugin's `hack-cli` routes branch-instance, env and diagnosis requests to the
focused skills; standalone `hack setup` installs keep the broad `hack-cli` skill only.

With shell access, the `hack` plugin and the Hack CLI cover every workflow without a
server process. Install the Hack CLI first and make `hack` available on the client's
PATH; both plugins run it from there. The
[agent client capability matrix](reference/agent-client-capabilities.md) records
which components have been observed loading in each client.

### One integration path per client

Choose one way to deliver each component to each client:

- Guidance: the `hack` plugin, or standalone export with `hack setup cursor`,
  `hack setup claude`, `hack setup codex`, or `hack setup agents`. Standalone export
  is opt-in; use it when a client cannot use the plugin.
- MCP: the `hack-mcp` plugin, or one `hack mcp install` entry (see
  [Standalone MCP configuration](#standalone-mcp-configuration)). Never both for the
  same client.

Setup and onboarding never write `AGENTS.md`, `CLAUDE.md`, rule files, or repository
skill copies unless you ask for them.

Clients discover MCP servers by convention, not only through a manifest key. Claude
Code loads a `.mcp.json` at a plugin's root even when the plugin manifest omits
`mcpServers`, and it also discovers a project's root `.mcp.json` (the file
`hack mcp install --claude --scope project` writes) as a project-scoped server that
needs approval. This is why the `hack` plugin ships no `.mcp.json` or `mcp.json` at
all, and why a repository `.mcp.json` counts as that client's MCP path.

Installing a plugin does not migrate or remove existing rules, skills, hooks, or MCP
configuration. If switching an existing installation, inspect the chosen client's
project and user scopes, verify the plugin loads in a fresh session, then explicitly
remove only duplicate Hack-owned entries in that scope. Preserve customized content.
Do not use a broad sync or removal command as a migration step. If validation fails,
disable the plugin and keep using the standalone integration.

### Upgrading from a plugin that bundled MCP

Earlier `hack` plugin releases also declared `hack mcp serve`. The `hack` plugin is
now skills-only, so an existing install loses its MCP server on update. If you used
that server, add `hack-mcp` (or keep an existing `hack mcp install` entry). If you
had disabled the bundled server in client configuration, you can remove that
override; there is no server left to disable.

### Install

Codex:

```bash
codex plugin marketplace add hack-dance/hack
codex plugin add hack@hack-dance
# Only when MCP is wanted:
codex plugin add hack-mcp@hack-dance
```

Claude Code:

```bash
claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack plugins/hack-mcp
claude plugin install hack@hack-dance
# Only when MCP is wanted:
claude plugin install hack-mcp@hack-dance
```

Cursor: open Customize, find Hack in the configured marketplace, and choose the
project or user installation scope. Add Hack MCP the same way only when MCP is
wanted. For local development, copy `plugins/hack` (and, if needed,
`plugins/hack-mcp`) into `~/.cursor/plugins/local/` when those destinations are
unused, then reload Cursor and inspect the plugins in Customize. Cursor 3.18.25
rejects symlinks to targets outside its local-plugin root; use a copy rather than
weakening that boundary. See
[Cursor's plugin documentation](https://cursor.com/docs/plugins) for marketplace
and local development support in the installed client version.

After installing, verify in a fresh session that all eight skills are discoverable
and the client's hooks or rule load. With `hack-mcp`, also verify that
`hack mcp serve` initializes and lists Hack tools. A successful marketplace
registration alone does not prove those components loaded.

Plugin updates are managed by the client. Ordinary Hack commands, `hack update`,
`hack doctor --fix`, and primer hooks never install plugins or clean up integrations.
A missing optional plugin is not a broken Hack installation. Model selection and
global instruction, evolution, and writeback policy remain with the user's existing
provider configuration; the Hack plugins add only Hack-specific guidance and tools.

Contributors: change shared behavior in `src/agents/instruction-source.ts`, then run
`bun run generate:agent-plugins`. The generator writes both packages; the `hack-mcp`
launch comes from `HACK_MCP_SERVER` in `scripts/generate-agent-plugins.ts`. The
generation tests check bundled guidance against the canonical renderers and fail if
the `hack` package declares or ships MCP. Release preparation regenerates both
packages after the version bump and commits them with the CLI release.
