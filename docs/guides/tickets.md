# Tickets (git-backed)

The tickets extension is a lightweight, git-backed ticket log intended for small teams and solo dev.
It stores events in a dedicated branch (`hack/tickets` by default) so ticket history is versioned and
syncable without requiring an external service.

- CLI namespace: `tickets`
- Extension id: `dance.hack.tickets`
- Storage: `.hack/tickets/` (local working state) + a git branch for syncing

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

List tickets:

```bash
hack x tickets list
```

Show a ticket:

```bash
hack x tickets show T-00001
```

Change status:

```bash
hack x tickets status T-00001 in_progress
```

Sync to git remote (pushes the tickets branch when a remote exists):

```bash
hack x tickets sync
```

## How it works

- Ticket history is an append-only event log (`ticket.created`, etc.) stored as monthly JSONL files.
- The extension reads events, materializes tickets in-memory, and renders `list/show` outputs.
- `sync` commits and pushes the tickets branch.

### Storage layout

In your project repo:

- `.hack/tickets/events/events-YYYY-MM.jsonl` — event log segments (UTC month)
- `.hack/tickets/git/bare.git` — a bare clone used to manage the tickets branch
- `.hack/tickets/git/worktree` — a worktree used for reading/writing ticket data

## Configuration

Tickets git configuration lives under `controlPlane.tickets.git`.
Defaults:

- `enabled: true`
- `branch: "hack/tickets"`
- `remote: "origin"`

Example override:

```bash
hack config set --global 'controlPlane.tickets.git.branch' 'hack/tickets'
hack config set --global 'controlPlane.tickets.git.remote' 'origin'
```

## When to use this

Use tickets when you want:
- A local-first backlog that works offline.
- A shared ticket stream without adding Jira/Linear.
- A simple paper trail for small projects.

Don’t use it when:
- You need multi-user assignment, workflow states, or strict permissions.
- You need rich issue templates or deep integrations.
