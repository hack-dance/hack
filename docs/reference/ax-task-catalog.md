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
   shell syntax (`|`, `&&`, `$(…)`, backticks) are refused. Every argv
   position is checked, because a service entrypoint may pass any word to
   `exec` (this repository's toolchain does). The check is a denylist of
   known programs (see Known gaps). For a known program it is fail-closed:
   an inline-code or stdin flag (`-s`, `-i`) anywhere after it refuses the
   recipe, even after an option value or a script path, because option
   values and operands cannot be told apart without each program's own
   parser. A shell or interpreter given `-` or no script operand (code from
   stdin), a REPL or eval subcommand (`bun repl`, `deno eval`), a Python
   REPL or eval module (`python -m code`, `idlelib`, `asyncio`, `_pyrepl`,
   `pdb`, `timeit`, `sqlite3` and the IPython family, also as `-mcode` or
   `-um code`, and through `uv run -m`/`--module` or `uv run -`) and a
   `data:` URL module given to Node, Bun, Deno or tsx
   (`node --import data:text/javascript,…`) are refused too. A Python
   module that runs another module, script or callable named in its own
   arguments is a trampoline: `runpy` (`python -m runpy timeit 'code'`),
   `trace` (`--module code`), `cProfile` and `profile`
   (`-m -s time code`, where `-m` is a flag and the module a later operand),
   `profiling.tracing`/`profiling.sampling` (Python 3.15) and `unittest`,
   which calls a named callable (`unittest code.interact`,
   `unittest builtins.breakpoint`). Every argument after a trampoline is
   checked against the REPL modules, `builtins` and `sys` (fail-closed),
   so a trampoline naming another one is caught too. An attached module
   (`python -mpytest`) is the program's operand, so it passes. Only a real
   `-m` counts: a `-m` that is another option's value (`python -W -m --`,
   `python -X -mpytest`, `python -bW -mpytest`,
   `python --check-hash-based-pycs -m …`) leaves no script, so Python
   reads stdin and the recipe is refused, and so is a `-m` whose separate
   module name starts with `-`. Python
   launcher names are matched without their version, ABI and build-variant
   suffix (`python3.12`, `python3.13t`, `python3t`, `pythonw`,
   `python3.12-dbg`, `python3-intel64`). So are SQL
   clients given a statement string (`psql -c`/`--command`,
   `mysql`/`mariadb -e`/`--execute`, `--init-command` and MariaDB's
   `--init-command-add`, which run SQL at connect, `duckdb -c`/`-s`/`-cmd`,
   `sqlite3 -cmd`, and any `sqlite3` or `duckdb` operand after the
   database; both programs strip one leading dash, so `duckdb --c` and
   `sqlite3 --cmd` count too). MySQL and MariaDB read options with
   `my_getopt`, which strips any number of `loose-`/`loose_` prefixes and
   treats `-` and `_` in a name as the same character, so
   `mysql --loose-execute`, `--init_command` and
   `mariadb --loose_init_command_add` count too. `psql -o`/`--output` with
   a value starting with `|` is refused in every spelling (`-o '|cmd'`,
   `-o|cmd`, `-qo|cmd`, `--output=|cmd`, `--out=|cmd`): psql passes it to
   `popen` while it is still parsing options, before it connects. psql's
   other file options (`-f`, `-L`/`--log-file`) use plain `fopen`, so a
   `|` there is a file name. So are the string-to-shell forms of package runners and
   wrappers (`npx -c`, `npm exec -c`, `pnpm -c`, `yarn exec`, `bun exec`,
   `nodemon --exec`, `tsx -e`, `ts-node -e`, `julia -e`, `sudo -s`,
   `doas -s`, `git -c`/`--config`/`--exec`/`--upload-pack`/
   `--receive-pack`/`clone -u`/`submodule foreach`/`bisect`/
   `filter-branch`, a Git `!` alias value such as
   `git config alias.x '!cmd'`, `make --eval`, `nix eval`). A dashed Git
   builtin, by basename or absolute path (`git-clone`,
   `/usr/lib/git-core/git-config`), is read as `git <sub>`, so
   `git-clone -u cmd`, `git-config alias.x '!cmd'`,
   `git-ls-remote --upload-pack=cmd` and `git-fetch-pack --exec=cmd`
   count too. So are `eval`,
   `env`, `xargs`, `su`, `runuser`, `ssh`, `nix-shell`, `concurrently`,
   `watchexec`, `tmux`, `iex`, the vi and Emacs editors, awk or sed
   anywhere in argv, and `watch`, `parallel` or `sg` with a command. Git
   and `psql` accept an unambiguous prefix of a long option, so any prefix
   of a refused long option counts (`git clone --upl=cmd`,
   `psql --comm`). MariaDB's `my_getopt` still accepts a unique prefix
   (`mariadb --exec=SQL` runs the SQL), so refusing a prefix is required
   for `mariadb`. MySQL 8 and later reject an abbreviated name
   (`mysql --exec` fails), so for `mysql` refusing one is only
   fail-closed. A refused one-letter option counts with
   its value attached (`git clone -u/path/cmd`, `psql -cSQL`,
   `mysql -eSQL`, `python -c'code'`) and inside a cluster of flags
   (`psql -1c`, `mysql -Be`). For `psql`, `mysql`, `mariadb` and Python,
   a cluster is read only up to the first option that takes a value, so
   `psql -hlocalhost`, `psql -Ucustomer`, `mysql -uroot -psecret` and
   `python -mcompileall` pass. `clone -u` counts when any operand is
   `clone`, so a Git global option that takes a value
   (`git --attr-source HEAD clone -u cmd`) cannot hide the subcommand.
   Accepted forms include `psql -f script.sql`,
   `mysql --batch db`, `sqlite3 -csv app.db`,
   `duckdb -f script.sql data.duckdb`,
   `duckdb -storage-version v1.2.0 data.duckdb`, `python -m pytest`,
   `python -mpytest`, `python -m unittest discover -s tests`,
   `psql -o out.txt -f script.sql`, `git-clone url dir`,
   `git clone url dir`, `git push -u origin main`, `git add -u` and
   `git config alias.st status`.
3. **Repository and log text grant no authority.** A recipe that passes every
   check is `reviewed`: its pins still match what a reviewer approved. Results
   still say `authority: "none"` and `execution: "unavailable"`. A recipe that
   claims any provenance other than `repository_script` (for example `log`,
   `suggested_action` or `agent_generated`) is refused.
4. **Registration runs nothing.** Reading the catalog, listing it or
   inspecting a recipe starts no task process. The only child processes are
   read-only Git queries: the target inspector's, and one `git ls-files`
   per pinned recipe that proves its pins are tracked files.
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
   during the read, the result is `generation_changed_during_read`. The
   runtime instance does not change how a recipe is judged, but the embedded
   target still names one. A detached linked worktree (for example one made
   with `git worktree add --detach`) has no implicit instance, so it is
   refused as `detached_checkout` unless the caller names one with
   `--branch` (MCP `branch`).

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
  Paths may not be absolute or contain `.` or `..` segments. They may not
  enter any `.git` directory or the machine-local entries of a project
  directory, `.hack` or the legacy `.dev` (`.internal`, `.branch`, `.env`,
  `.env.state.json`, `hack.env.local.yaml`, `hack.env.*.local.yaml`,
  `tickets`), and may not name a secret or key file (`.hack.secret.key`,
  Hack's legacy secrets files, `.env` and `.env.*`, `*.key`, `*.pem`,
  `*.p8`, `*.p12`, `*.pfx`). Names are compared case-insensitively, because
  the default macOS filesystem is. A pinned file must be a regular file (not
  a symlink), at most 1 MiB, and its path with directory symlinks resolved
  must pass the same rules: inside the checkout, and not an alias for
  excluded state. It must also be tracked in the checkout's Git index,
  checked before any of its bytes are read. A stale refusal reports the
  observed digest, and the name rules above cannot list every local secret
  file (`.npmrc`, `.netrc`, `secrets.json`, ...), so only files whose
  content is already shared through the repository can be pinned. A
  checkout without Git cannot pin anything. The tracked-file query runs
  with every inherited `GIT_*` variable removed, so a caller's `GIT_DIR`,
  `GIT_INDEX_FILE`, `GIT_WORK_TREE` or config override cannot make a file
  count as tracked through another index.
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
| `input_path_invalid` | `E_CONFIG_INVALID` | `fix_catalog` | Pinned file is a symlink, special file, too large or not tracked by Git, or its resolved path leaves the checkout or reaches excluded state |
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
| Registration runs nothing | no child process except `git` (at least one `git` call recorded, so an empty log cannot pass); canary file never created | spawn-recorder fixture |
| Stale recipe (script edited after review) | `stale_recipe` with observed digest | paired fixture |
| Stale service definition | `stale_recipe` with observed definition digest | domain test |
| Log-injected command | `untrusted_provenance`, `inline_command`; argv never echoed | paired fixture |
| Log line with option values before `-c` (`exec bash --noprofile --norc -e -o pipefail -c …`) | `inline_command` even with `repository_script` provenance | paired fixture |
| Option-value, `env`-anywhere, awk/sed, `Rscript -e`, stdin and REPL forms | `inline_command`; reviewed script argv still passes | domain test |
| Package-runner, TypeScript-runner, privilege-wrapper, `git -c`, `make --eval`, `deno run -` and editor forms | `inline_command`; `npm run`, `npx tsc`, `tsx script.ts`, `sudo -u`, `git status`, `make test` still pass | domain test |
| `data:` URL modules (`node --import data:…`, `deno run data:…`), `git bisect run`, `git filter-branch` and `julia -e` | `inline_command`; `node --import ./register.js`, `git log`, `julia -t 4 script.jl` still pass | domain test |
| `git fetch`/`clone --upload-pack`, `git push --receive-pack` and a dash version suffix (`node-22 -e`) | `inline_command`; `git push -u origin main`, `git fetch origin`, `node-22 script.js` still pass | domain test |
| SQL statement strings (`psql -c`, `mysql -e`, `mariadb -e`, `duckdb -c`/`--c`/`--s`/`--cmd`, `sqlite3 --cmd`, `sqlite3 app.db 'SQL'`), including abbreviated long options | `inline_command`; `psql -f script.sql`, `sqlite3 -csv app.db`, `sqlite3 --separator , app.db`, `duckdb --f script.sql data.duckdb` still pass | domain test |
| Python REPL and eval modules (`python -m code`, `-mcode`, `-m idlelib`, `-m timeit`) | `inline_command`; `python -m pytest`, `python -m codecs` still pass | domain test |
| `my_getopt` spellings (`mysql --loose-execute`, `--init_command`, `mariadb --loose-execute=…`, `--init-command-add`) | `inline_command`; `mysql --loose-skip-column-names db`, `--default_character_set=utf8mb4`, `--skip-pager` still pass | domain test |
| One-letter inline options with an attached value or in a flag cluster (`psql -cSQL`, `psql -1c`, `mysql -eSQL`, `python -c'code' x.py`) | `inline_command`; `psql -hlocalhost`, `psql -Ucustomer`, `mysql -uroot -psecret`, `python -mcompileall` still pass | domain test |
| Python launcher names (`python3.13t`, `python3t`, `pythonw`, `python3.12-dbg`, `python3-intel64`) and `uv run -m`/`--module`/`-` with a REPL module or stdin | `inline_command`; `python3.13t script.py`, `python3-intel64 script.py`, `uv run -m pytest`, `uv run pytest` still pass | domain test |
| Python trampolines naming a REPL or eval target (`python -m runpy timeit 'code'`, `trace --module code`, `cProfile -m -s time code`, `profiling.tracing`, `unittest code.interact`/`builtins.breakpoint`, also through `uv run -m`) | `inline_command`; `python -m runpy pytest`, `python -m trace --count script.py`, `python -m unittest discover -s tests` still pass | domain test |
| An attached `-m` module (`python -mpytest`) as the program's operand | accepted, also after a value option's value (`python -W ignore -mpytest`); `python -mcode`, `python -m`, `python -Ximporttime` and a `-m` taken as an option's value (`python -W -m --`, `python -X -mpytest`) still refused (stdin) | domain test |
| `psql -o`/`--output` piped to a command (`-o '\|cmd'`, `-o\|cmd`, `-qo\|cmd`, `--output=\|cmd`, `--out=\|cmd`) | `inline_command`; `psql -o out.txt`, `psql -F'\|'`, `psql -L '\|log'` (a file name) still pass | domain test |
| Dashed Git builtins (`/usr/lib/git-core/git-clone -u cmd`, `git-config alias.x '!cmd'`, `git-ls-remote --upload-pack=cmd`, `git-fetch-pack --exec=cmd`) | `inline_command`; `git-clone url dir`, `git-push -u origin main`, `git-config alias.st status` still pass | domain test |
| Git plumbing helpers read as their porcelain (`git-bisect--helper --bisect-run cmd`, `/usr/lib/git-core/git-bisect--helper.exe run cmd`, `git bisect--helper --bisect-run cmd`, `git-submodule--helper foreach cmd`) | `inline_command`; `git-submodule--helper status`, `git-difftool--helper a b`, `git add bisect--helper.txt` still pass | domain test |
| `duckdb -storage-version VER db` | accepted; a SQL operand after the database is still refused | domain test |
| `git clone -u` (also after `--attr-source <tree>` or an unknown global option), abbreviated or attached `--upload-pack`/`--receive-pack`/`--exec`, `clone --config`, and `!` alias values (`git config alias.x '!cmd'`, `git -c alias.x=!cmd`) | `inline_command`; `git clone url dir`, `git push -u origin main`, `git add -u`, `git config alias.st status` still pass | domain test |
| Caller `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` naming another index that tracks a secret | `input_path_invalid` with no digest; a foreign `GIT_DIR` does not hide the checkout's own index | domain test |
| Pin through a symlinked directory (outside the checkout, or aliasing `.hack`) | `input_path_invalid` | paired fixture |
| Pointer pin into a gitignored, untracked secrets file | `input_path_invalid` with no digest; the same pin is checked once the file is tracked | paired fixture, domain test |
| Pin of a file removed from the Git index, or in a checkout without Git | `input_path_invalid` | domain test |
| Pins of `.git`, `.hack` or `.dev` local state or secret files, in any letter case | `recipe_invalid` | domain test |
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
- **Inline-code detection is a denylist.** It covers the shells,
  interpreters and string-to-shell wrappers listed above. A program it does
  not know that evaluates an argument (for example `chroot` or `nsenter`
  with no command, `make` variable values such as `X=${shell id}`, or a
  reviewed script that evaluates its arguments) is not detected; the
  reviewer must check argv, and WU26 execution must not rely on this check
  as a sandbox. For a known program it is fail-closed, so it can also refuse
  an ordinary argument that looks like an inline flag (`script.sh -c`,
  `git clean -x`, `git -C dir status`, `git push -u origin clone`,
  `make -e`, `python -I`, `mysql -E`, a Git argument such as `--grep=!x`
  that starts a value with `!`, or a script argument named like a REPL
  module after a Python trampoline, as in
  `python -m cProfile script.py code`). Which Git short options take a value
  depends on the subcommand (`-m` is a message for `commit` but a flag in
  `rebase -mx cmd`), so a Git value attached to its option is read as more
  flags: `git log -Scache` and `git commit -mcleanup` are refused because
  the value contains `c`. Pass the value as its own argument instead
  (`git log -S cache`, `git commit -m cleanup`). Bare `R` is not refused,
  because a one-letter word is too common as an ordinary argument. A SQL
  client that reads statements from stdin (`psql db`, `mysql db`,
  `sqlite3 app.db` with no SQL operand) is not refused; only a statement
  string in argv is. Code a program loads from a file is not inspected
  either: for example, a reviewed script that loads a data file with
  `pickle` or `marshal`, or reads a config file that it evaluates. A Git
  `<sub>--helper` plumbing command (`git-bisect--helper`,
  `git submodule--helper`) is read as `git <sub>`, so it meets the rules for
  that subcommand, but a helper's own options are not modeled: the
  `--add-exec-commands` mode of older Git's `rebase--helper` is not
  refused. Git config writes other than `!` aliases (for example
  `git config core.pager cmd` or `include.path`) are not detected. Nor are
  `mysql`/`mariadb` option files named in argv (`--defaults-extra-file`,
  which can set `init-command`) or `--pager`, which runs a command only in
  interactive mode.
- **Tracked pins hash working-tree bytes.** A pin must be tracked by Git,
  but its digest is of the file in the working tree. An uncommitted local
  edit to a tracked file (for example a credential added to a tracked
  config, including one hidden with `git update-index --skip-worktree`) is
  hashed and its digest can appear in a stale refusal.
- **Input reads are not atomic.** Pinned inputs are read once; an edit during
  the read is reported on the next read, not detected in the same one. The
  catalog file and the config generation are re-read and compared.
