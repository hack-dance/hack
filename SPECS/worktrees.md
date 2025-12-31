# Branch builds (worktree-friendly) spec

## Summary

Enable multiple isolated instances of the same project to run concurrently (e.g. main + worktree), with unique hostnames and compose project names. Provide a safe CLI workflow for branch-specific instances without editing `.hack/` files or invoking Git.

## Goals

- Run multiple branches of the same repo side-by-side without port or hostname conflicts.
- Keep base `.hack` config unchanged; use runtime overrides.
- Provide a single flag to enable branch-specific routing and compose names.
- Make it easy for agents to start/stop branch instances in worktree contexts.

## Non-goals

- Git worktree creation/management.
- Cross-machine orchestration.

## User flows

### Run a branch build from any directory
```
hack up --project my-repo --branch feature-x --detach
hack logs --project my-repo --branch feature-x
```

## CLI changes (proposed)

### New command group (project-level)
- `hack branch add <name>` (register a branch alias for this project)
- `hack branch list`
- `hack branch remove <name>`
- `hack branch open <name>` (open branch host in browser)

Notes:
- These commands do not call Git; they are purely CLI aliases that map to runtime overrides.
- Source of truth is per‑project metadata at `.hack/hack.branches.json` (gitignored by default).
- A global cache (e.g. `~/.hack/hack.branches.json`) is optional and must be derived from per‑project files.

### New option
- `--branch <name>` for project commands:
  - `hack up`, `hack down`, `hack restart`, `hack ps`, `hack logs`, `hack open`.

## Behavior: `--branch`

### Compose project name
- Use `docker compose -p <base>--<branch>` when `--branch` is set.
- `<base>` comes from `hack.config.json` name (or derived slug).
- `<branch>` is sanitized to `[a-z0-9-]` (same sanitizer as project names).

### Hostname aliasing

Given:
- `devHost`: `myapp.hack`
- `aliasHost`: `myapp.hack.gy` (if OAuth alias enabled)
- `branch`: `feature-x`

Rewrite each host in Caddy labels as follows:
- `myapp.hack` → `feature-x.myapp.hack`
- `api.myapp.hack` → `api.feature-x.myapp.hack`
- `myapp.hack.gy` → `feature-x.myapp.hack.gy`
- `api.myapp.hack.gy` → `api.feature-x.myapp.hack.gy`

Rules:
- Only rewrite hosts that are equal to `devHost` or end with `.<devHost>`.
- If OAuth alias is enabled, also rewrite hosts equal to `aliasHost` or ending in `.<aliasHost>`.
- Avoid double-prefix if the host already includes `.<branch>.` before the base.

### Implementation approach (no config mutation)

- Generate a temporary compose override file on `hack up --branch`:
  - Copy `.hack/docker-compose.yml`.
  - Rewrite `labels.caddy` host list for each service using the rules above.
- Call:
  - `docker compose -f base.yml -f branch.override.yml -p <base>--<branch> up`.

### Logs + status
- `hack logs --branch` should use `<base>--<branch>` for Loki selector and compose project name.
- `hack ps --branch` should query the branch project name.

## Naming and sanitization

- Branch names are slugified (lowercase, `/` → `-`, trim repeated `-`).
- If a branch slug is empty, fallback to `branch`.

## hack.branches.json (schema + example)

Location: `.hack/hack.branches.json`

Add a `$schema` key for IDE completion/validation:
```
https://schemas.hack/hack.branches.schema.json
```

### Example

```json
{
  "$schema": "https://schemas.hack/hack.branches.schema.json",
  "version": 1,
  "branches": [
    {
      "name": "feature-x",
      "slug": "feature-x",
      "note": "worktree for PR #123",
      "created_at": "2025-01-01T12:00:00Z",
      "last_used_at": "2025-01-02T09:30:00Z"
    }
  ]
}
```

### JSON schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "hack.branches.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "branches"],
  "properties": {
    "$schema": { "type": "string" },
    "version": { "type": "integer", "const": 1 },
    "branches": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "slug"],
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "slug": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]*$",
            "minLength": 1
          },
          "note": { "type": "string" },
          "created_at": { "type": "string", "format": "date-time" },
          "last_used_at": { "type": "string", "format": "date-time" }
        }
      }
    }
  }
}
```

## Edge cases

- If `--branch` is used without `--project` and no `.hack/` in cwd, return a clear error.
- If `--branch` is used but `devHost` is missing, fail fast and suggest `hack init`.
- If `devHost` is custom and does not share a base suffix with current hosts, no rewrite occurs (warn).

## Backward compatibility

-- No behavior changes unless `--branch` is supplied.
- No changes to `.hack/` files (except optional branch alias metadata if we implement `hack branch add`).

## Open questions

- Should `hack projects` group branch instances under the base project?
- Should `hack open --branch` accept `--service` to open `api` etc?
- Do we want a `--branch` default from git branch when inside a worktree? (requires Git read, but not mutations)
