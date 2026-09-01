# Local Helpers

Hack v3 no longer ships hosted or broker-backed integrations.

What remains:

- local env management and host/container injection
- local sessions and runtime orchestration
- optional coding-agent setup helpers: `hack init --with claude|codex|both`, `hack agent onboard` /
  `hack agent init` / `hack agent prime`, and `hack setup sync --all-scopes`

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

- Audit without writing: `hack setup sync --all-scopes --check`
- Repair project and global integrations: `hack setup sync --all-scopes`
- After repair: reload the agent session so cached rules are discarded

Ordinary commands, `hack update`, and `hack doctor --fix` do not inspect or modify these surfaces.
`hack agent prime` performs a read-only audit at session start and prints a warning before any Hack
operating guidance.
