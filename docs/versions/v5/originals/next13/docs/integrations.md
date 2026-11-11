# Agent integrations

Hack is a local CLI. An agent with shell access can use it directly, with `--json`
for structured results and `--no-interactive` to avoid prompts. Everything below is
optional and none of it installs Hack or prepares its runtime.

v5 retired automatic instruction injection. Hack no longer writes `AGENTS.md` or
`CLAUDE.md` sections, Cursor rules, session hooks or global skill copies, and
`hack setup sync`, `hack setup cursor|claude|agents` and `hack agent prime` refuse
with a retirement notice. Existing customized files are left alone. Ordinary
commands, `hack update` and `hack doctor --fix` never write agent files.

Also gone: Hack Tickets, the built-in GitHub and Linear integrations, hosted
accounts, organizations and teams, and the web dashboard. Use `git`, `gh` and your
tracker's own tools.

## Optional native plugins

The `hack` plugin (`plugins/hack`) is the default way to give a coding agent Hack guidance. It ships eight
skills and nothing else: no hooks, no rules, no MCP server.

| Skill | Purpose |
| --- | --- |
| `hack-cli` | Everyday workflows: services, URLs, logs, exec and workspaces; routes to the focused skills below |
| `hack-branches` | Parallel branch instances and aliases |
| `hack-env` | Env layers and value-safe configuration changes |
| `hack-diagnose` | Read-first diagnosis and the `--json` error-code reference |
| `hack-feedback` | Privacy-reviewed feedback drafts about Hack |
| `hack-init` | Project onboarding through the CLI's onboarding prompt |
| `hack-install` | Installation, stable or prerelease selection, upgrade and rollback |
| `hack-remote` | Prepare a project on another host or in a cloud environment |

### Install

Codex:

```bash
codex plugin marketplace add hack-dance/hack
codex plugin add hack@hack-dance
```

Claude Code:

```bash
claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack plugins/hack-mcp
claude plugin install hack@hack-dance
```

Cursor: open Customize, find Hack in the configured marketplace, and choose the
project or user installation scope. For local development, copy `plugins/hack`
into `~/.cursor/plugins/local/`; Cursor rejects symlinks outside its local-plugin
root. See [Cursor's plugin documentation](https://cursor.com/docs/plugins).

After installing, verify in a fresh session that the eight skills are discoverable.
A successful marketplace registration alone does not prove they loaded. Plugin
updates are managed by the client. The skills find `hack` on the client's PATH;
during the v5 prerelease that is whichever executable you put there, not `hack-next`.

The [agent client capability matrix](reference/agent-client-capabilities.md) records
which components have been observed loading in each client.

## The separate `hack-mcp` plugin

Clients without shell access can add `hack-mcp` (`plugins/hack-mcp`). It declares one stdio server,
`hack mcp serve`, and no skills:

```bash
codex plugin add hack-mcp@hack-dance
claude plugin install hack-mcp@hack-dance
```

Alternatively, `hack mcp print --claude --scope project` previews a project MCP
entry and `hack mcp install --claude --scope project` writes it (`--codex` and
`--cursor` likewise). Claude Code reads project servers from `.mcp.json` and
user-scoped servers from `~/.claude.json`. Keep one Hack MCP registration per
client: either the plugin or one `hack mcp install` entry, never both. The
`hack` plugin ships no `.mcp.json` so that a repository `.mcp.json` remains the
client's own MCP path.

Clients discover MCP servers by convention. Claude Code loads a `.mcp.json` at a
plugin's root even when the plugin manifest omits `mcpServers`, and treats a project's
root `.mcp.json` as a project-scoped server that needs approval.

The [MCP tool contract](reference/mcp-tools.md) lists every tool with its inputs
and results; the [MCP logs contract](reference/mcp-logs.md) explains finite cutoffs
and cursors.

### One integration path per client

Choose one way to deliver each component to each client. Guidance: the `hack`
plugin, or the standalone `hack setup codex` skill when a client cannot use the
plugin. MCP: the `hack-mcp` plugin, or one `hack mcp install` entry. Never both for
the same client.

### Migrate standalone files to the plugin

`hack setup migrate` moves one scope at a time from standalone Hack skill and rule
files to the plugin. The default run is a read-only preview; `--apply` backs up and
removes only Hack-owned files whose plugin replacement is verified, and
`--rollback-manifest <manifest>` restores them. Customized or unrecognized files
are preserved. Check that the plugin loads in a fresh session before applying.

### Upgrading from a plugin that bundled MCP

Earlier `hack` plugin releases also declared `hack mcp serve`. The plugin is now
skills-only, so an existing install loses that server on update. Add `hack-mcp`, or
keep an existing `hack mcp install` entry, if you used it.

## Onboarding a project

`hack agent onboard` prints an onboarding prompt for an existing repository, and
`hack init --with claude|codex` hands a new project's setup to the selected agent.
Both describe the work to do; neither installs skills or edits client
configuration. The plugin's `hack-init` skill asks the CLI for the same prompt. See
[Agent-first setup](guides/agent-first-setup.md).

## Remaining explicit opt-ins

`hack setup codex` installs the standalone Codex skill for a client that cannot use
the plugin, and `hack setup mcp` writes MCP configuration for a no-shell client.
`hack setup tmux` installs the recommended tmux binding for `hack session`. These
write only files Hack owns and are never run as a side effect.

## Contributors

Shared guidance lives in `src/agents/instruction-source.ts`. Change it there, then
run `bun run generate:agent-plugins`, which writes both plugin packages and refuses a
`hack` manifest that declares MCP. See [Maintaining agent guidance](agent-guidance.md).
