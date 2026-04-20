# CLI Reference

Hack v3 is the local-first CLI surface.

## Core commands

- `hack init`
- `hack up`
- `hack down`
- `hack restart`
- `hack open`
- `hack logs`
- `hack ps`
- `hack projects`
- `hack projects prune`
- `hack env`
- `hack host exec`
- `hack host shell`
- `hack session`
- `hack doctor`
- `hack daemon`
- `hack crash-capture`
- `hack tickets`

`hack doctor` now also classifies stale project registry entries, orphaned runtime containers,
stale lifecycle session metadata, and stale materialized env compatibility output. It points to
`hack projects prune` for local runtime cleanup, `hack down` when persisted lifecycle state no
longer matches a live mux session, and `hack env materialize` when `.hack/.env` or
`.hack/.env.state.json` drift.

## Removed surfaces

These commands remain only as migration stubs:

- `hack auth`
- `hack linear`
- `hack org`
- `hack team`

Built-in GitHub workflows were also removed. Use native `git` and `gh`.

## Unsupported experimental

These commands remain source-available but are outside the supported v3 product contract:

- `hack remote`
- `hack gateway`
- `hack node`
- `hack dispatch`

## First-run path

```bash
hack global install
hack init
hack up --detach
hack open
```

## Environment model

Canonical env files:

- `.hack/hack.env.default.yaml`
- `.hack/hack.env.<overlay>.yaml`
- `.hack/hack.env.local.yaml`
- `.hack/hack.env.<overlay>.local.yaml`

Use `hack env add`, `hack env unset`, `hack env list`, `hack env materialize`, `hack env exec`, and `hack env shell` to work with them.

Use `--local` on env mutations when you want to write to the worktree-local override file instead of the shared repo file.

`hack env materialize` is only for compatibility output. `hack doctor` will tell you when the
materialized `.hack/.env` or `.hack/.env.state.json` is stale and should be regenerated.

## Tickets

Tickets remain optional and local-first:

```bash
hack tickets create --title "Investigate flaky lifecycle cleanup"
hack tickets list
hack tickets show T-00001
hack tickets status T-00001 in_progress
```
