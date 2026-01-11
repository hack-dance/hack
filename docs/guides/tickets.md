# Tickets (git-backed)

The tickets extension is a lightweight, git-backed ticket log intended for small teams and solo dev.
It stores events in a dedicated git ref (`refs/hack/tickets` by default, hidden from branch lists) so
ticket history is versioned and syncable without requiring an external service.

- CLI namespace: `tickets`
- Extension id: `dance.hack.tickets`
- Storage: `.hack/tickets/` (local working state) + a git ref for syncing

## Enable

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

## Setup (recommended)

From inside the repo you want to enable tickets for:

```bash
hack x tickets setup
```

Options:
- `--global` installs the Codex skill into `~/.codex/skills/hack-tickets/` instead of the repo.
- `--agents` / `--claude` / `--all` control which agent-doc files get a tickets snippet.
- `--check` and `--remove` work as expected.

Notes:
- Most tickets commands prompt to run setup if `.hack/tickets/` is tracked, missing from `.gitignore`,
  or if agent docs/skills are missing (TTY + gum only).
- Setup also prompts to repair legacy tickets branches or stray files in the tickets ref.
- In non-interactive or `--json` modes, the CLI prints a warning instead of prompting.

## Basic usage

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
hack x tickets show T-00001
```

Update a ticket:

```bash
hack x tickets update T-00001 --title "Investigate flaky test in CI" --body-file ./notes.md
```

Change status:

```bash
hack x tickets status T-00001 in_progress
```

Dependencies:

```bash
hack x tickets create --title "Ship API" --depends-on T-00001 --blocks T-00002
hack x tickets update T-00001 --depends-on T-00002 --blocks T-00003
hack x tickets update T-00001 --clear-depends-on --clear-blocks
```

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
- The extension reads events, materializes tickets in-memory, and renders `list/show` outputs.
- Ticket writes automatically commit and push to the tickets ref when git sync is enabled and a remote exists.
- `sync` normalizes the event logs, commits, and pushes the tickets ref.

### Storage layout

In your project repo:

- `.hack/tickets/events/events-YYYY-MM.jsonl` — event log segments (UTC month)
- `.hack/tickets/git/bare.git` — a bare repo used to manage the tickets ref
- `.hack/tickets/git/worktree` — a worktree used for reading/writing ticket data

## Configuration

Tickets git configuration lives under `controlPlane.tickets.git`.
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
- A shared ticket stream without adding Jira/Linear.
- A simple paper trail for small projects.

Don’t use it when:
- You need multi-user assignment, workflow states, or strict permissions.
- You need rich issue templates or deep integrations.
