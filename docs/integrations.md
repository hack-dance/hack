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
