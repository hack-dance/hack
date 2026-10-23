# AX target and result contract (provisional)

Status: **provisional decision record** (HACK-1144, WU31). Every command name,
tool name, field, reason and retry value on this page can still change in the
agent-experience (AX) compatibility review. It is not a stable interface
promise. Fields and codes that the review must confirm are marked
_provisional_ below.

This page records how Hack names the thing an agent wants to act on (the
**target**), how a read-only inspector reports it, and how adapters (CLI and
MCP) share one result shape. The first implementation is the read-only
inspector `hack project target` and its MCP tool `hack.project.target`.

## Decisions

1. **A target is an exact tuple, not a name.** It is the project, the checkout,
   the runtime instance, an optional service, the env overlay selection and a
   config generation, plus the selector kind and the observation time. A
   project name alone is never a target.
2. **Git branch is not runtime identity.** The checkout reports its current Git
   branch, but the runtime instance is a separate field. An explicit instance
   selector (`--branch`) wins over the branch-derived default, and the
   inspector never creates, switches or deletes Git branches or worktrees.
3. **References grant no authority.** A resolved target identifies scope only
   (`authority: "none"`). A caller that acts on it must revalidate at its own
   effect boundary, for example by passing the generation it inspected.
4. **Equal names are not merged.** Registration ownership is decided by the
   exact checkout root (or a recorded linked worktree of a registration), never
   by name. Two registrations that share a name are refused as
   `ambiguous_project` when selected by name, and are never renamed.
5. **Generation covers Hack config only.** The generation fingerprints
   `.hack/hack.config.json`, `.hack/hack.toml` and `.hack/docker-compose.yml`.
   Ordinary source edits do not change it. Qualifying an immutable source
   revision is a separate, explicit concern and is not part of this contract.
6. **No fake atomic snapshot.** The inspector reads the generation before and
   after resolving the other fields. If it changed during the read, the result
   is the `generation_changed_during_read` refusal, not a mixed snapshot.
7. **Snapshot reads have no side effects.** No registry write (not even the
   last-seen touch other commands perform), no engine or Docker call, no
   startup, repair or global sync, and no Git mutation. The only child
   processes are read-only Git queries that existing project commands already
   run.
8. **Readiness is not claimed.** The snapshot does not probe the runtime. It
   reports `runtime: { observed: false, reason: "not_probed" }` instead of
   guessing whether containers exist or are healthy.
9. **One semantics across adapters.** The MCP tool spawns the same CLI command
   and passes selection through unresolved, so every resolution refusal comes
   from the same code. There is no MCP-only selection policy. The MCP server
   only checks input grammar before spawning; any value it accepts is then
   judged by the CLI.
10. **Errors reuse existing codes.** Refusals reuse the stable CLI error codes
    in `HACK_ERROR_CODES`. The closed `detail.reason` is the discriminator.
    Adding a dedicated code (for example for staleness) is left to the
    compatibility review.

## Commands

| Surface | Name (_provisional_) | Class |
| --- | --- | --- |
| CLI | `hack project target [--project=…\|--path=…] [--branch=…] [--service=…] [--env=…] [--expect-generation=…] [--json]` | read-only |
| MCP | `hack.project.target` (inputs `projectName`, `path`, `branch`, `service`, `env`, `expectGeneration`) | read-only |

The MCP tool runs `hack project target --json` with the same options. Its
`data` is the CLI envelope, re-validated against this contract (`null` when
the CLI output does not match). `stdout` is withheld because `data` carries the
same envelope.

## Result envelope

The CLI prints exactly one envelope with `--json` and exits 0 on success and 1
on a refusal.

```json
{
  "ok": true,
  "data": {
    "schema": "hack.target.v0",
    "provisional": true,
    "observed_at": "2026-10-19T12:00:00.000Z",
    "authority": "none",
    "selector": {
      "kind": "path",
      "branch_explicit": false,
      "env_explicit": false,
      "expected_generation": null
    },
    "project": {
      "name": "alpha",
      "registration": { "id": "alpha", "name": "alpha", "match": "worktree" },
      "project_dir": "/work/alpha-login/.hack"
    },
    "checkout": {
      "root": "/work/alpha-login",
      "kind": "linked",
      "git_branch": "feature/login"
    },
    "instance": {
      "branch": "feature-login",
      "source": "worktree",
      "compose_project": "alpha--feature-login"
    },
    "service": null,
    "services": ["api", "web"],
    "env": { "overlay": null, "source": "base" },
    "generation": {
      "id": "cfg-v0:0123456789abcdef0123456789abcdef",
      "scope": "hack_config",
      "inputs": [
        { "file": "hack.config.json", "present": true },
        { "file": "hack.toml", "present": false },
        { "file": "docker-compose.yml", "present": true }
      ]
    },
    "runtime": { "observed": false, "reason": "not_probed" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `selector.kind` | `project` (by registered name), `path` or `cwd` |
| `project.registration` | The registration that owns this exact checkout root (`match: root`) or lists it as a linked worktree (`match: worktree`); `null` when unregistered |
| `checkout.kind` | `primary`, `linked` (a linked Git worktree) or `not_git` |
| `instance.source` | `explicit` (`--branch`), `worktree` (derived from a linked worktree's branch) or `default` |
| `instance.branch` | The instance slug. An explicit `--branch` is slugged like `hack up --branch` (`Feature/X` becomes `feature-x`) |
| `instance.compose_project` | The Compose project name commands use for this instance (`<base>--<branch>` for a branch instance) |
| `services` | Service names declared in the Compose file, sorted; `[]` when the file is absent or has no `services` key. A Compose file that is not YAML, whose top level is not a mapping, or whose `services` is not a mapping is refused as `compose_parse_failed` |
| `env.source` | `explicit`, `project_default` (configured default overlay) or `base`; selection only, overlay existence is not checked |
| `generation.id` | `cfg-v0:` plus 32 hex characters; pass it back as `--expect-generation` |

All fields are _provisional_.

## Refusals

A refusal is `{ ok: false, error: { code, message, detail } }`. `message` is
fixed text that never repeats caller input, paths or registry values.
`detail` is `{ reason, stage, retry, provisional: true }`, plus
`observed_generation` for `stale_generation` only.

| `reason` (_provisional_) | `code` | `stage` | `retry` |
| --- | --- | --- | --- |
| `conflicting_selectors` | `E_USAGE` | `selector` | `fix_selector` |
| `invalid_selector` | `E_USAGE` | `selector` | `fix_selector` |
| `project_not_found` | `E_PROJECT_NOT_FOUND` | `project` | `fix_selector` |
| `ambiguous_project` | `E_USAGE` | `project` | `fix_selector` |
| `registered_root_missing` | `E_PROJECT_NOT_FOUND` | `project` | `fix_project` |
| `path_not_found` | `E_PROJECT_NOT_FOUND` | `project` | `fix_selector` |
| `no_project_context` | `E_PROJECT_NOT_FOUND` | `project` | `fix_selector` |
| `project_inputs_unsupported` | `E_CONFIG_INVALID` | `project` | `fix_project` |
| `adoption_state_unsafe` | `E_CONFIG_INVALID` | `project` | `fix_project` |
| `config_parse_failed` | `E_CONFIG_PARSE` | `project` | `fix_project` |
| `compose_parse_failed` | `E_CONFIG_PARSE` | `project` | `fix_project` |
| `detached_checkout` | `E_USAGE` | `instance` | `fix_selector` |
| `service_not_found` | `E_SERVICE_NOT_FOUND` | `service` | `fix_selector` |
| `stale_generation` | `E_USAGE` | `generation` | `reinspect` |
| `generation_changed_during_read` | `E_USAGE` | `generation` | `reinspect` |
| `generation_input_too_large` | `E_CONFIG_INVALID` | `generation` | `fix_project` |
| `input_permission_denied` | `E_PERMISSION` | `project` | `fix_project` |
| `input_unreadable` | `E_CONFIG_INVALID` | `project` | `fix_project` |

A filesystem fault while reading an input (for example a Compose file with no
read permission, or a directory where a config file belongs) is reported as
`input_permission_denied` (`EACCES`, `EPERM`) or `input_unreadable` (any other
filesystem error). The OS message is never surfaced, because it contains the
absolute path.

The shared project input guards that every project command runs are mapped
too. Native or conflicting project files are `project_inputs_unsupported`. A
`.hack` or `.hack/.internal` the caller cannot search (for example mode `000`
or `0644`) is a permission fault, not an adoption problem: it is
`input_permission_denied` even when the project has never used adoption, and
its message names the permission fix (make the directories readable and
searchable by your user, for example `chmod u+rwx .hack`) before anything
else. A legacy adoption state that is unparseable or interrupted is
`adoption_state_unsafe`, whose message points at explicit adoption recovery.
A non-directory where the project directory belongs is `input_unreadable`.
When the guard cannot check whether a project input exists (for example a
`.dev` file, or a `.dev` directory the caller cannot search, beside a valid
`.hack`), the refusal is `input_permission_denied` (`EACCES`, `EPERM`) or
`input_unreadable` (any other fault), like a read fault.

`retry` is advice for the caller. Like suggested actions and application logs,
it carries no execution authority.

The CLI parser refuses a malformed `--project` or `--env` value before the
inspector runs, as it does for every command. That refusal is
`{ ok: false, error: { code: "E_USAGE", message } }` with no `detail`. The MCP
server refuses grammar-invalid `branch`, `service`, `env`, `projectName` length
or `expectGeneration` before spawning, as `invalid_arguments` with
`spawned: false`. These are input-shape refusals; every resolution refusal
above is identical on both surfaces.

These parser refusals are the only detail-less errors in the contract. A
non-filesystem fault outside the catalogue (a defect) still makes the CLI print
`E_UNEXPECTED` with free text and no `detail`. That envelope is off contract:
the MCP adapter accepts a detail-less error only when its code is `E_USAGE`, so
it returns `data: null` for any other.

## Result semantics for future operations

These rules are recorded for the operations that will consume targets (WU20,
WU21). The inspector itself only produces snapshots.

- Separate **accepted work**, **terminal result** and **bounded observation**.
  Work that failed but was observed successfully is not task success.
- Report partial results and freshness windows honestly; never present a
  stitched read as an atomic snapshot.
- Preserve the compatible `ok`/`data`/`error`/`detail` envelope and documented
  child exit codes.
- Never include secret values or ciphertext in inspect or env metadata.

## Compatibility matrix

| Concern | CLI `hack project target` | MCP `hack.project.target` | Evidence |
| --- | --- | --- | --- |
| Two projects, selection by name | yes | yes | paired fixture |
| Two branches (linked worktree default, explicit instance) | yes | yes | paired fixture |
| Explicit instance slug (`Feature/X` gives `<base>--feature-x`) | yes | yes | paired fixture |
| Env selection: project default, explicit overlay, `base` | yes | yes | paired fixture |
| Conflicting selectors | `conflicting_selectors` | same | paired fixture |
| Stale generation | `stale_generation` | same | paired fixture |
| Source edit keeps generation | yes | yes | paired fixture |
| Ambiguous equal names, moved checkout, unknown project | closed refusals | same | paired fixture |
| Two registrations owning one checkout | `ambiguous_project` | same | paired fixture |
| Malformed Hack config or Compose file, oversized input | `config_parse_failed`, `compose_parse_failed`, `generation_input_too_large` | same | paired fixture |
| Unreadable input (directory in place of a file, no read permission) | `input_unreadable`, `input_permission_denied` | same | paired fixture (permission case skipped as root) |
| Input guard refusals (native/legacy conflict, unsafe adoption state, non-directory project dir) | `project_inputs_unsupported`, `adoption_state_unsafe`, `input_unreadable` | same | paired fixture |
| Unsearchable `.hack` or `.hack/.internal` on a never-adopted project | `input_permission_denied` (permission fix named first) | same | paired fixture and domain test (skipped as root) |
| Uncheckable input presence (`.dev` file or unsearchable `.dev` beside a valid `.hack`) | `input_unreadable`, `input_permission_denied` | same | paired fixture and domain test (unsearchable case skipped as root; `EPERM` through the classifier seam) |
| Detached linked worktree, no project, missing path | closed refusals | same | paired fixture |
| Unknown service | `service_not_found` | same | paired fixture |
| Config changed during read | `generation_changed_during_read` | same code path | domain test |
| No registry, state or Git writes | yes | yes (audit log only) | paired fixture |
| Malformed selector | `invalid_selector` / parser `E_USAGE` | `invalid_arguments`, not spawned | paired fixture |
| Drifted CLI output, detail-less non-`E_USAGE` error, data claiming authority | n/a | `data: null`; foreign fields dropped | stubbed CLI fixture |

The fixtures live in `tests/project-target-inspect.test.ts`.

## Known gaps

- **Runtime readback.** The snapshot never observes containers, so it does not
  prove an instance exists, is running or is healthy. Actual container and env
  readback for two projects and two branches needs a host with an engine and
  is not covered here.
- **Concurrent sessions and slow or failed probes.** Not exercised: the
  inspector has no runtime probe yet.
- **Env overlays.** Selection only; overlay existence and resolved keys are not
  checked. Use `hack env list` or `hack.project.env.keys` for key metadata.
- **Compose validity.** The inspector refuses a Compose file it cannot parse
  as a YAML mapping, but it does not run `docker compose config`, so a file
  that parses but that Compose would reject (for example an invalid service
  definition) is still reported as a target.
- **Generation scope.** Worktree-local overrides, env files and native
  `hack.project.json` inputs are not part of the generation. Native projects
  are refused as `project_inputs_unsupported`.
- **Pagination and byte limits.** The result is small and unpaginated; the
  rule that critical blockers survive pagination applies to later list
  operations.
- **Capability-limited clients and unknown provenance.** Not modeled.
- WU20, WU21 and WU28 runtime and AX gates remain open.
