# AX task catalog contract (provisional)

Status: **provisional decision record** (HACK-1157, WU26-CATALOG). Every
command name, tool name, file name, field, reason and vocabulary value on this
page can still change in the agent-experience (AX) compatibility review. It is
not a stable interface promise.

The task catalog lets an agent discover a small set of reviewed recipes for
scripts that already exist in a repository: what to run (exact argv and
Compose service), with which env scope, what it needs, what it changes, how
to check it and how to clean up. Discovery is read-only. **The catalog has no
execution path.** Running a recipe stays under WU26's execution policy, which
is not implemented here.

## Decisions

1. **Source of truth: `.hack/tasks.json`.** Recipes live in one checked-in
   file in the project directory, reviewed through normal code review. It is
   a separate file, not a `hack.config.json` key, so the published config
   schema and the WU31 config generation stay unchanged, and so a recipe can
   pin other files without pinning itself. The catalog digest is reported
   separately (`catalog.sha256`).
2. **Recipes point at existing scripts.** A recipe names a Compose service and
   exact argv, and pins the scripts behind it. There is no second scripting
   language and no inline code: shell `-c`, interpreter inline-code flags
   (`node -e`, `python -c` and similar), `eval`, an `env` wrapper and bare
   shell syntax (`|`, `&&`, `$(…)`, backticks) are refused.
3. **Repository and log text grant no authority.** A recipe that passes every
   check is `reviewed`: its pins still match what a reviewer approved. Results
   still say `authority: "none"` and `execution: "unavailable"`. A recipe that
   claims any provenance other than `repository_script` (for example `log`,
   `suggested_action` or `agent_generated`) is refused.
4. **Registration runs nothing.** Reading the catalog, listing it or
   inspecting a recipe starts no task process. The only child processes are
   the target inspector's read-only Git queries.
5. **Refused recipes are not echoed.** A refused recipe is reported by index,
   id and reason only. Its argv, text and any smuggled values are never
   returned, so an injected command is not handed back as runnable text.
6. **No fallback.** Ambiguous, stale, untrusted, out-of-scope or
   capability-missing recipes are refused. Nothing falls back to a broader
   runner, env scope or host process.
7. **Targets use the WU31 schema.** Each result embeds the full
   [`hack.target.v0`](./ax-target-result-contract.md) target, and target
   refusals pass through unchanged. Recipes are judged against that target's
   env selection and Compose services; if the config generation changes
   during the read, the result is `generation_changed_during_read`.

## Commands

| Surface | Name (_provisional_) | Class |
| --- | --- | --- |
| CLI | `hack project task list [--project=…\|--path=…] [--branch=…] [--env=…] [--expect-generation=…] [--json]` | read-only |
| CLI | `hack project task inspect <task> [same options]` | read-only |
| MCP | `hack.project.task.list` (inputs `projectName`, `path`, `branch`, `env`, `expectGeneration`) | read-only |
| MCP | `hack.project.task.inspect` (`task` plus the same inputs) | read-only |

The MCP tools spawn the same CLI command with `--json` and re-validate its
envelope. `data` is `null` when the output does not match this contract.

## Catalog file

```json
{
  "schema": "hack.tasks.v0",
  "tasks": [
    {
      "id": "check",
      "summary": "Install locked dependencies, then run typecheck and lint checks.",
      "runner": {
        "kind": "compose_service",
        "service": "toolchain",
        "definition_sha256": "<sha256 of the canonical service definition>"
      },
      "argv": ["check"],
      "workdir": null,
      "env": { "overlay": null, "keys": [] },
      "requires": ["checkout_read", "checkout_write", "named_volumes", "network_egress"],
      "effects": ["reads_checkout", "writes_checkout", "writes_named_volumes", "network_egress", "creates_ephemeral_container"],
      "prerequisites": ["A container engine that Hack can reach."],
      "checks": ["Exit status 0 means typecheck and the check script passed."],
      "cleanup": ["The one-shot container exits; dependencies stay in a named volume."],
      "provenance": {
        "source": "repository_script",
        "inputs": [
          { "path": ".hack/toolchain/run.sh", "sha256": "<sha256 of the file>" },
          { "path": "package.json", "pointer": "/scripts/check", "sha256": "<sha256 of the canonical JSON value>" }
        ],
        "review": "HACK-1157"
      }
    }
  ]
}
```

Rules (all _provisional_):

- The file is at most 256 KiB with at most 64 recipes. Unknown keys are
  invalid at every level. The file must be a regular file, not a symlink.
- `id` matches `^[a-z0-9][a-z0-9._-]{0,63}$`. Two recipes with the same id are
  both refused as `ambiguous_task`.
- `argv` has 1 to 64 non-empty strings without control characters, and does
  not start with `-`. It is passed to the service's entrypoint as given.
- `workdir` is an absolute path inside the service, or `null` for the
  service default.
- `env.overlay` is the overlay the recipe was reviewed for (`null` is base
  layers). `env.keys` lists key names only; values are never accepted.
- `summary`, `prerequisites`, `checks`, `cleanup` and `provenance.review` are
  short descriptive text. `checks` and `cleanup` must not be empty.
- `provenance.inputs` pins 1 to 16 checkout-relative files. A pin with a
  `pointer` (RFC 6901) pins one JSON value inside the file, for example one
  `package.json` script, so unrelated edits do not make the recipe stale.
  Paths may not be absolute, contain `.` or `..` segments, enter `.git`, or
  enter Hack's generated `.hack/.internal` and `.hack/.branch` state. A pinned
  file must be a regular file (not a symlink) inside the checkout, at most
  1 MiB.
- Digests are lowercase SHA-256 hex. A whole-file pin hashes the file's bytes.
  A pointer pin and `definition_sha256` hash canonical JSON: object keys
  sorted, no whitespace. The service definition is the parsed
  `services.<name>` mapping from `.hack/docker-compose.yml`.

### Capabilities and effects

A `compose_service` runner may grant `checkout_read`, `checkout_write`,
`named_volumes`, `network_egress` and `managed_env`. Hack never grants
`host_ports`, `host_network`, `docker_socket`, `home_mount`, `privileged`,
`ssh_agent` or `credential_store` to a catalog recipe. A recipe that requires
any of those, or an unknown capability, is refused as `missing_capability`;
the refusal names the known ones and counts the unknown ones.

Effects are a closed list, and each one needs a required capability:

| Effect | Requires |
| --- | --- |
| `reads_checkout` | `checkout_read` |
| `writes_checkout` | `checkout_write` |
| `writes_named_volumes` | `named_volumes` |
| `network_egress` | `network_egress` |
| `creates_ephemeral_container` | a `compose_service` runner |

A recipe that scopes env keys must require `managed_env`. A recipe whose
effects are not covered by its requirements is `recipe_invalid`.

**Host profiles.** The schema accepts `{ "kind": "host", "profile": "…" }`,
but no host profile is approved in this release because Hack cannot enforce a
host boundary yet. Every host recipe is refused as `unapproved_host_profile`.

## Checks and refusals

Recipes are checked in this order; the first failing check is the reason.

| `reason` (_provisional_) | `code` | `retry` | When |
| --- | --- | --- | --- |
| `recipe_invalid` | `E_CONFIG_INVALID` | `fix_catalog` | Entry has no valid id |
| `ambiguous_task` | `E_CONFIG_INVALID` | `fix_catalog` | Another recipe uses the same id |
| `untrusted_provenance` | `E_CONFIG_INVALID` | `fix_catalog` | Claimed source is not `repository_script` |
| `inline_command` | `E_CONFIG_INVALID` | `fix_catalog` | Argv evaluates inline code or shell syntax |
| `recipe_invalid` | `E_CONFIG_INVALID` | `fix_catalog` | Shape, bounds or effect/capability consistency fails |
| `unapproved_host_profile` | `E_CONFIG_INVALID` | `fix_catalog` | Host runner |
| `missing_capability` | `E_CONFIG_INVALID` | `fix_catalog` | Requires a capability the runner does not grant |
| `env_scope_mismatch` | `E_USAGE` | `fix_selector` | Target env overlay differs from the recipe's |
| `service_not_found` | `E_SERVICE_NOT_FOUND` | `fix_catalog` | Service not declared in the target's Compose file |
| `input_path_invalid` | `E_CONFIG_INVALID` | `fix_catalog` | Pinned file is a symlink, special file, outside the checkout or too large |
| `input_missing` | `E_CONFIG_INVALID` | `review` | Pinned file or JSON value is absent |
| `stale_recipe` | `E_CONFIG_INVALID` | `review` | A pinned digest no longer matches |

Whole-catalog refusals (`detail.stage: "catalog"`):

| `reason` | `code` | `retry` |
| --- | --- | --- |
| `invalid_task_id` | `E_USAGE` | `fix_selector` |
| `task_not_found` | `E_USAGE` | `fix_selector` |
| `catalog_parse_failed` | `E_CONFIG_PARSE` | `fix_catalog` |
| `catalog_invalid` | `E_CONFIG_INVALID` | `fix_catalog` |
| `catalog_too_large` | `E_CONFIG_INVALID` | `fix_catalog` |
| `catalog_changed_during_read` | `E_USAGE` | `reinspect` |

Messages are fixed text that never repeats a task id, path, argv or catalog
value. `detail` is `{ reason, stage, retry, provisional: true }`, plus
`missing_capabilities` and `unknown_capabilities` for `missing_capability`,
and `stale` for `stale_recipe`. `stale` lists the observed digest of each
mismatched input by index and the observed service definition digest (or
`null` when it still matches). It never includes file content. `retry` is
advice only and carries no execution authority.

## Results

`list` returns every recipe with its status:

```json
{
  "ok": true,
  "data": {
    "schema": "hack.task.list.v0",
    "provisional": true,
    "observed_at": "2026-10-19T12:00:00.000Z",
    "authority": "none",
    "execution": "unavailable",
    "target": { "schema": "hack.target.v0", "…": "full target" },
    "catalog": { "file": "tasks.json", "present": true, "sha256": "…" },
    "tasks": [
      { "index": 0, "id": "check", "status": "reviewed", "recipe": { "…": "full recipe" } },
      { "index": 1, "id": "from-log", "status": "refused",
        "refusal": { "reason": "untrusted_provenance", "stage": "recipe", "retry": "fix_catalog", "provisional": true } }
    ]
  }
}
```

An absent catalog is not an error: `catalog.present` is `false` and `tasks`
is empty. `inspect` returns `schema: "hack.task.inspect.v0"` with the same
`target` and `catalog` and one reviewed `task`. Inspecting a refused recipe
returns that recipe's refusal envelope (exit 1).

## Reviewing a recipe

1. Read the scripts and the Compose service the recipe will rely on.
2. Write the recipe with placeholder digests (64 zeros).
3. Run `hack project task inspect <task> --json`. The `stale_recipe` refusal
   lists the observed digests. Check them against your review (for a whole
   file, `shasum -a 256 <path>`), then copy them into the recipe.
4. Confirm `hack project task list --json` reports `reviewed`.

Any later edit to a pinned script, pinned JSON value or the service
definition makes the recipe `stale_recipe` until someone reviews the change
and updates the pins. This repository's own catalog (`models`, `check` and
`rust-check` in the toolchain service) is checked by
`tests/project-task-catalog.test.ts`, so a toolchain change fails that test
until its recipes are re-reviewed.

## Evidence

| Concern | Result | Evidence |
| --- | --- | --- |
| Discovery of reviewed recipes, with provenance and effects | listed in full | paired CLI/MCP fixture |
| Registration runs nothing | no child process except `git`; canary file never created | spawn-recorder fixture |
| Stale recipe (script edited after review) | `stale_recipe` with observed digest | paired fixture |
| Stale service definition | `stale_recipe` with observed definition digest | domain test |
| Log-injected command | `untrusted_provenance`, `inline_command`; argv never echoed | paired fixture |
| Wrong env scope | `env_scope_mismatch`; the reviewed scope passes | paired fixture |
| Missing capability | `missing_capability` naming `docker_socket`, counting unknown | paired fixture |
| Ambiguous id, host runner, unknown service, missing or escaping input | closed refusals | paired fixture |
| Malformed, foreign, oversized or symlinked catalog | whole-catalog refusals | domain test |
| Catalog or config edited during the read | `catalog_changed_during_read`, `generation_changed_during_read` | domain test (test seam) |
| Malformed task id | CLI `invalid_task_id`; MCP `invalid_arguments`, not spawned | paired fixture |
| Drifted or forged CLI output | `data: null` or foreign fields dropped | domain test |

## Known gaps

- **Execution.** There is none. Running a reviewed recipe, injecting managed
  env, enforcing mounts, network and resource limits, timeouts, cleanup and
  output policy all remain WU26 gates.
- **Review authority.** `reviewed` means pins match. It does not prove who
  reviewed the recipe: anyone who can edit the repository can edit pins.
  Execution must not treat `reviewed` as authorization.
- **Transitive content.** Pins cover the named files and JSON values only.
  Nested scripts (for example a `package.json` script that calls another),
  dependencies, lockfiles and base images that a pinned file does not pin by
  digest are not covered.
- **Compose policy.** The service definition is pinned, not analyzed. The
  catalog does not check that the reviewed service lacks host ports, sockets
  or home mounts; the reviewer must.
- **Env keys.** Only the overlay selection is compared. Whether the overlay
  exists or supplies the scoped keys is not checked.
- **Host profiles.** None are approved, so host-side scripts cannot be
  catalogued yet.
- **Input reads are not atomic.** Pinned inputs are read once; an edit during
  the read is reported on the next read, not detected in the same one. The
  catalog file and the config generation are re-read and compared.
