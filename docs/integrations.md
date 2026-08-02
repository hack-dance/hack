# Local Helpers

Hack v3 no longer ships hosted or broker-backed integrations.

What remains:

- local env management and host/container injection
- local sessions and runtime orchestration
- optional coding-agent setup helpers: `hack init --with claude|codex|both`, `hack agent onboard` /
  `hack agent init` / `hack agent prime`, and `hack setup sync --all-scopes`
- user-installed native Hack plugins for Cursor, Claude Code, and Codex, all generated from the
  same `hack-cli`, `hack-init`, rules, hooks, and `hack mcp serve` sources

`hack setup sync` keeps interactive output compact: it summarizes each scope and only expands the
path and reason for stale, missing, or failed artifacts. Exit status remains the automation contract,
and the individual `hack setup cursor|claude|codex|agents|mcp --check` commands remain available when
you need per-artifact detail.

What was removed:

- Hack Tickets agent integration; legacy commands remain compatibility-only and are deprecated
- built-in GitHub integration
- built-in Linear integration
- hosted auth/account/org/team surfaces
- web dashboard control plane

Removed surfaces still exist as explicit tombstone commands (`hack auth`, `hack org`, `hack team`,
`hack linear`) that print a removal reason and the replacement, so hitting them redirects you
instead of failing hard.

Recommended replacements:

- GitHub: native `git` and `gh`
- planning systems: keep them outside Hack and use the tracker selected by the project

## Native agent plugins

The repository is a marketplace for all three supported plugin clients. Each client reads its own
native manifest while the payload under `plugins/hack/` is shared and versioned with Hack.

### Cursor

Add the GitHub marketplace:

```bash
cursor-agent plugin marketplace add hack-dance/hack
```

Open `/plugin` in Cursor, choose the **Hack Dance** marketplace, and install **Hack**. Cursor bundles
the generated Hack rule, both skills, and the MCP server. `hack setup cursor --check` verifies the
installed plugin when the Cursor Agent CLI is available. `hack setup cursor` safely removes matching
legacy `.cursor/rules/hack.mdc` and standalone MCP entries, then prints install guidance. It exits
nonzero until the plugin is installed and enabled, so scripted setup cannot mistake cleanup for a
ready Cursor integration.

### Claude Code

Add and install the GitHub marketplace:

```bash
claude plugin marketplace add hack-dance/hack \
  --sparse .claude-plugin \
  --sparse plugins/hack
claude plugin install hack@hack-dance
```

Start a new Claude Code session after installation. The plugin bundles the SessionStart/PreCompact
primer hooks, both skills, and the MCP server. `hack setup claude --check` verifies the installed and
enabled plugin. `hack setup claude` safely removes matching legacy hooks, the generated
`.claude/skills/hack-init` skill, and standalone MCP entries before printing install guidance.
It exits nonzero until the plugin is installed and enabled.

### Codex

Add the upstream Git marketplace once:

```bash
codex plugin marketplace add hack-dance/hack \
  --sparse .agents/plugins \
  --sparse plugins/hack
```

Open `/plugins`, install and enable **Hack** from the **Hack Dance** marketplace, then start a new
Codex session. `hack setup codex --check` verifies the installed/enabled state; `hack setup codex`
removes unmodified legacy `.codex/skills/hack-cli`, `.codex/skills/hack-init`, and standalone Codex
MCP entries, then prints install guidance when the plugin is missing. User-edited legacy skills and
customized MCP entries are never deleted. It exits nonzero until the plugin is installed and enabled.

For all three commands, `--global` selects where legacy standalone artifacts are audited or removed;
plugin installation state itself is client-wide. `--remove` removes only legacy Hack-managed
artifacts and never uninstalls the native plugin from the client.

The plugins are cached and enabled by their clients. Projects keep only their `.hack/` configuration
and genuinely project-specific agent guidance. Upgrade the Codex marketplace with
`codex plugin marketplace upgrade hack-dance`, then start a new session to load the new plugin
version.

## Agent integration freshness

Hack maintains project instructions plus shared `~/.ai/skills` surfaces. Generated guidance
identifies the CLI version that rendered it. Native plugin installation is managed by each client;
`setup sync` only cleans up safe-to-remove legacy Cursor, Claude Code, and Codex copies.

- Audit without writing: `hack setup sync --all-scopes --check`
- Repair project and global integrations: `hack setup sync --all-scopes`
- After repair: reload the agent session so cached rules are discarded

Interactive project commands announce detected drift before auto-repair. `hack agent prime` performs
the same read-only audit at session start and prints a warning before any Hack operating guidance.
