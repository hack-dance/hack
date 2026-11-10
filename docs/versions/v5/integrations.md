# Use Hack with an agent

With shell access, an agent can use the CLI directly. Complete [Install](install.md),
make the intended `hack` executable available on the agent's PATH, and give it this
version's [documentation index](/v5/llms.txt) or [full corpus](/v5/llms-full.txt).
Plugins and MCP are optional additions. They do not install Hack or prepare its
runtime.

v5 retired automatic instruction injection. Hack no longer writes `AGENTS.md` or
`CLAUDE.md` sections, Cursor rules, session hooks or global skill copies, and the
old `hack setup sync` and `hack agent prime` paths refuse with a retirement notice.
Existing customized files are left alone. Guidance now arrives through the
plugin below, which the client's own plugin manager installs and updates.

## The `hack` plugin

The `hack` plugin ships eight skills and nothing else: no hooks, no rules, no MCP
server.

| Skill | Purpose |
| --- | --- |
| hack-cli | Everyday workflows: services, URLs, logs, exec and workspaces |
| hack-branches | Parallel branch instances and aliases |
| hack-env | Env layers and value-safe configuration changes |
| hack-diagnose | Read-first diagnosis and the error-code reference |
| hack-init | Project onboarding through the CLI's onboarding prompt |
| hack-install | Installation and executable or channel selection |
| hack-remote | Prepare a project on another host or in a cloud environment |
| hack-feedback | Report a Hack problem with redacted evidence |

Install it from this repository's marketplace:

```sh
# Codex
codex plugin marketplace add hack-dance/hack
codex plugin add hack@hack-dance

# Claude Code
claude plugin marketplace add hack-dance/hack --sparse .claude-plugin plugins/hack plugins/hack-mcp
claude plugin install hack@hack-dance
```

In Cursor, install Hack from Customize. The plugin finds `hack` on the client's
PATH; during the prerelease that is whichever executable you put there. The
[plugin README](https://github.com/hack-dance/hack/blob/4e51bc3f8119e154f49e040e606b6ed7f727d6d3/plugins/hack/README.md)
has per-client notes. A plugin registered in a client is not proof that it loaded;
check the client's plugin list.

## The separate `hack-mcp` plugin

Clients without shell access can add `hack-mcp`. It declares one stdio server,
`hack mcp serve`, and no skills. Use one Hack MCP registration per client, either
this plugin or a single `hack mcp install` entry, never both. The
[MCP tools](../reference/mcp-tools.md) and [MCP logs](../reference/mcp-logs.md)
references describe the tool surface and its finite log cutoffs.

## Project onboarding

`hack agent onboard` prints an onboarding prompt for an existing project, and
`hack init --with claude|codex` hands a new project's setup to an agent. Both
describe the work to do; neither installs skills or edits client configuration.
See [Explicit agent setup](guides/agent-first-setup.md).
