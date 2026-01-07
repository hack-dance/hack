---
name: hack-tickets
description: >
  Use the hack tickets extension (git-backed JSONL event log) to create/list/show/sync lightweight tickets.
  Trigger when asked to track work items, decisions, or bugs inside a repo without external issue trackers.
  Prefer `hack x tickets ...` commands; store lives on branch `hack/tickets` by default.
---

# hack tickets

This repo uses the hack tickets extension (`dance.hack.tickets`).

## Enable

Enable globally:

- `hack config set --global 'controlPlane.extensions["dance.hack.tickets"].enabled' true`

Or per-project by adding `.hack/hack.config.json`:

```json
{
  "controlPlane": {
    "extensions": {
      "dance.hack.tickets": { "enabled": true }
    }
  }
}
```

## Commands

- Create: `hack x tickets create --title "..." [--body "..."] [--body-file <path>] [--body-stdin] [--actor "..."] [--json]`
- List: `hack x tickets list [--json]`
- Show: `hack x tickets show <ticket-id> [--json]`
- Status: `hack x tickets status <ticket-id> <open|in_progress|blocked|done> [--json]`
- Sync: `hack x tickets sync [--json]`

## Data model

- Tickets are derived from an append-only event log (JSONL).
- Local state lives in `.hack/tickets/`.
- Sync writes commits to a dedicated branch (`hack/tickets` by default) and pushes to your remote.

## Tips

- Keep ticket titles short; put detail in `--body`.
- Use `--json` for agent workflows and piping.
- Run `hack x tickets sync` before opening PRs if you want tickets to travel with the repo.
