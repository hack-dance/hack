# Tickets (git-backed)

This page is part of [Extensions & reference](../reference.md).
If you are learning the core local product flow, start with [Core docs](../core.md).

> Tickets is an optional, opt-in extension. Enable `dance.hack.tickets` in config (or run
> `hack x tickets setup`, which enables it for you) before it does anything, and any
> agent/integration syncing only happens once it's enabled. Tickets is no longer part of default
> agent instructions — only use it when the project explicitly opts into it.

The tickets extension is a lightweight, git-backed ticket log intended for small teams and solo dev.
It stores events in a dedicated git ref (`refs/hack/tickets` by default, hidden from branch lists) so
ticket history is versioned and syncable without requiring an external service.

- CLI namespace: `tickets`
- Extension id: `dance.hack.tickets`
- Storage: `.hack/tickets/` (local working state) + a git ref for syncing

## Enable

The primary path is `hack x tickets setup` (or the top-level alias `hack tickets setup`) — it
enables the extension in the project's `.hack/hack.config.json` as its first step, then installs
the skill and agent-doc snippets. `setup` is special-cased to run even when the extension is
disabled, so this is the only command that works before tickets is turned on.

From inside the repo you want to enable tickets for:

```bash
hack x tickets setup
```

Options:
- `--global` installs the Codex skill into `~/.codex/skills/hack-tickets/` instead of the repo. The
  default (project) scope installs to `<repo>/.codex/skills/hack-tickets/SKILL.md`.
- `--agents` / `--claude` / `--all` control which agent-doc files get a tickets snippet.
- `--check` and `--remove` work as expected.
- `--json` prints a machine-readable result shaped like
  `{ skill, docs, repo: { gitignore, tracking } }` instead of the human-readable summary.

Notes:
- Most tickets commands prompt to run setup if `.hack/tickets/` is tracked, missing from `.gitignore`,
  or if agent docs/skills are missing (TTY + gum only).
- Setup also prompts to repair legacy tickets branches or stray files in the tickets ref.
- In `--json` mode this setup-health check is skipped entirely and silently — no warning is
  printed. In non-interactive terminals (no TTY, or `gum` unavailable) the CLI instead prints a
  `Tickets setup incomplete: ...` warning rather than prompting. Note that the global
  `--no-interactive` flag / `HACK_NO_INTERACTIVE` env var is **not** consulted by this check — it
  gates purely on TTY-and-`gum`-availability, independent of that flag.

### Manual / global-only enable

Manually editing config is mainly useful for enabling tickets globally (so it's available in every
project) or for config-only workflows where you don't want to run `setup` yet.

Enable the extension globally:

```bash
hack config set --global 'controlPlane.extensions["dance.hack.tickets"].enabled' true
```

Or enable per-project by adding `.hack/hack.config.json`:

```json
{
  "$schema": "https://schemas.hack/hack.config.schema.json",
  "name": "my-project",
  "dev_host": "my-project.hack",
  "controlPlane": {
    "extensions": {
      "dance.hack.tickets": { "enabled": true }
    }
  }
}
```

This `controlPlane.extensions["dance.hack.tickets"].enabled` flag is **extension enablement** —
it's what gates whether any `hack x tickets` / `hack tickets` command runs at all. It is a
different flag from `controlPlane.tickets.git.enabled` (see [Configuration](#configuration)),
which is **git-sync enablement** for an already-enabled extension. Don't conflate the two: an
extension can be enabled with git-sync disabled (fully local, no ref push/pull), though the
default for both is on.

## Basic usage

Every `hack x tickets <command>` below also works as the top-level alias `hack tickets <command>`
(for example `hack tickets list`). The alias requires the extension to already be enabled, except
for `setup`, which can enable it for you.

Create a ticket:

```bash
hack x tickets create --title "Investigate flaky test" --body "Found in CI on macOS"
```

For big unstructured bodies, prefer a file or stdin:

```bash
hack x tickets create --title "Deep dive" --body-file ./notes.md
```

```bash
echo "long body..." | hack x tickets create --title "Deep dive" --body-stdin
```

`create` and `update` also accept: `--owner`, `--source`, `--assignee` / `--clear-assignee`,
`--tags` / `--tag` / `--clear-tags`, `--actor`, `--json`, and external-linkage flags
(`--external-system`, `--external-id`, `--external-key`, `--external-url`,
`--external-project-id`, `--external-project-name`, `--external-team-id`) for linking a ticket to
an external tracker record.

Open the TUI:

```bash
hack x tickets tui
```

List tickets:

```bash
hack x tickets list
```

Show a ticket:

```bash
hack x tickets show <ticket-id>
```

Update a ticket:

```bash
hack x tickets update <ticket-id> --title "Investigate flaky test in CI" --body-file ./notes.md
```

Change status:

```bash
hack x tickets status <ticket-id> in_progress
```

Dependencies:

```bash
hack x tickets create --title "Ship API" --depends-on <ticket-id-a> --blocks <ticket-id-b>
hack x tickets update <ticket-id-a> --depends-on <ticket-id-b> --blocks <ticket-id-c>
hack x tickets update <ticket-id-a> --clear-depends-on --clear-blocks
```

Append an immutable comment (unlike `update`, comments are never edited or removed, only added):

```bash
hack x tickets comment <ticket-id> --body "Repro'd on CI, filing upstream issue" [--source hack]
```

Add a review note:

```bash
hack x tickets review-note <ticket-id> --body "LGTM once tests are green"
```

Attach a structured document to a ticket (`--kind` is required; `--role` defaults to the kind):

```bash
hack x tickets document <ticket-id> --kind spec --role spec --body-file ./spec.md
```

`--kind` accepts `description | spec | notes`; `--role` accepts `description | spec | notes | handoff`.

Resolve a sync conflict recorded during `sync`:

```bash
hack x tickets resolve-conflict <ticket-id> --conflict-id <id> --resolution accept_local --summary "kept local edit"
```

`--resolution` accepts `accept_local | accept_remote | merged | ignore`.

Sync to git remote (normalizes logs and pushes the tickets ref when a remote exists):

```bash
hack x tickets sync
```

Recommended body template (Markdown):

```md
## Context
## Goals
## Notes
## Links
```

Tip: use `--body-stdin` for multi-line markdown.

## How it works

- Ticket history is an append-only event log (`ticket.created`, etc.) stored as monthly JSONL files.
- Each event carries a normalized journal envelope (`eventId`, schema version, occurrence/recording times, source metadata, and idempotency key).
- The journal is the portable source of truth for tickets.
- The extension projects journal state into a local SQLite cache for durable reads and rebuilds that cache automatically when it is missing or stale.
- Ticket writes automatically commit and push to the tickets ref when git sync is enabled and a remote exists.
- `sync` normalizes the event logs, commits, and pushes the tickets ref.
- Read paths fall back to the last healthy local tickets state when the git remote is temporarily unreachable, so `list` and `show` still work offline after an initial hydration.
- When git remote auth fails, tickets surfaces return explicit SSH guidance and do not wait on interactive prompts. Check with `ssh -T git@github.com`.

### Storage layout

Local tickets state under your project:

- `.hack/tickets/events/events-YYYY-MM.jsonl` — event log segments (UTC month)
- `.hack/tickets/projection.sqlite` — local SQLite projection cache rebuilt from the journal
- `.hack/tickets/git/bare.git` — a bare repo used to manage the tickets ref
- `.hack/tickets/git/worktree` — a worktree used for reading/writing ticket data
- `.hack/tickets/git/worktree/.hack/tickets/events/events-YYYY-MM.jsonl` — local checkout of the durable event log

Path inside the tickets ref:

- `.hack/tickets/events/events-YYYY-MM.jsonl` — portable event log segments (UTC month)

### Durability and portability

The durable portable layer is the event log in the tickets ref.

- inside the ref, `.hack/tickets/events/*.jsonl` is the source of truth
- locally, those files are materialized under `.hack/tickets/git/worktree/.hack/tickets/events/*.jsonl`
- `list`, `show`, and related views are rebuilt by replaying the event log
- deleting local projection state must not lose ticket history

Rebuildable local state includes:

- `.hack/tickets/git/bare.git`
- `.hack/tickets/git/worktree`
- `.hack/tickets/git/.mutation.lock` — coordination lock for concurrent tickets writes
- `.hack/tickets/git/bare.git/index.lock` — transient git index lock; if left stale (e.g. after a
  crash), the CLI removes it automatically and retries

These paths exist to coordinate sync and local writes. They can be recreated from the repo and the tickets ref.

### Hidden refs and legacy branch compatibility

By default, tickets sync to the hidden ref `refs/hack/tickets`.

Compatibility rules:

- the CLI fetches the hidden ref first
- if the hidden ref is missing, it falls back to the legacy branch ref `refs/heads/hack/tickets`
- when legacy ref data is imported, event logs are deduped by `eventId` and normalized before the next push

If your remote rejects hidden refs, set `controlPlane.tickets.git.refMode` to `heads` and use `refs/heads/hack/tickets` instead.

Portability rules:

- Only the journal under `.hack/tickets/events/` is portable ticket state.
- The hidden ref stores only the journal tree; it does not include `projection.sqlite` or other local cache files.
- After `hack x tickets sync`, the checked-out tickets worktree materializes that journal under `.hack/tickets/git/worktree/.hack/tickets/events/`.
- The SQLite projection is local-only and can be deleted safely.
- After sync or clone, peers rebuild `.hack/tickets/projection.sqlite` from the journal on first read.

## Configuration

Tickets git configuration lives under `controlPlane.tickets.git`. This `enabled` flag is
**git-sync enablement**, not extension enablement — it only takes effect once
`controlPlane.extensions["dance.hack.tickets"].enabled` is already `true` (see
[Manual / global-only enable](#manual--global-only-enable)). With git-sync `enabled: true` (the
default) writes auto-commit and push to the tickets ref; with it `false`, tickets stays fully
local.

Defaults:

- `enabled: true`
- `branch: "hack/tickets"`
- `remote: "origin"`
- `forceBareClone: false`
- `refMode: "hidden"`

Example override:

```bash
hack config set --global 'controlPlane.tickets.git.branch' 'hack/tickets'
hack config set --global 'controlPlane.tickets.git.remote' 'origin'
hack config set --global 'controlPlane.tickets.git.refMode' 'hidden'
```

Notes:
- If your remote rejects hidden refs, set `refMode` to `heads` to use `refs/heads/<branch>` and
  protect the branch in your git hosting UI.

## When to use this

Use tickets when you want:
- A local-first backlog that works offline.
- A shared ticket stream without adding another external tracker.
- A simple paper trail for small projects.

Don’t use it when:
- You need multi-user assignment, workflow states, or strict permissions.
- You need rich issue templates or deep integrations.
