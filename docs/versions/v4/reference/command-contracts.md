# Command and output contracts

Pinned source: `91b14bf0abb17602142425de0d02628a3e8a2615`. This supplements the [generated command reference](../../reference/cli.md). Command registration and document shape do not establish backend admission.

## Scope and coverage

The recursive public inventory has **84 leaves**, **284 leaf-owned option occurrences**, and **536 effective option occurrences**, including three global/built-in flags per leaf. The three additional leaf sections below complete the pinned generated reference within this public scope. No declared effective flags or short aliases are missing from matching sections; generic value placeholders explain initial spelling-only differences. Counts are occurrences, not unique names. Parent namespaces are not leaves.

Retired gateway/node/remote/dispatch, hosted account/team/Tickets, internal helpers, extension dispatch and fun commands are excluded. SSH remote access is excluded. Retained fields within local commands do not establish support for retired backends.

## Global flags and parsing

Every leaf accepts `--no-interactive`, `--help, -h`, and `--version, -v`. The first also has `HACK_NO_INTERACTIVE=1`; it applies documented defaults or refuses required interaction. Help/version return early with status 0. These are the only inherited flags: parent options are not inherited. Omitted booleans parse false; omitted strings/numbers parse undefined. Handler/config fallbacks are separate. A nonboolean OptionSpec defaultValue supplies a value when the flag is present without its value; it is not an unconditional omitted-flag default.

## Additional command details

### `hack project owner show`

Show the local ownership metadata for the current project.

Arguments: none.

| Option | Type | Meaning / declared fallback |
| --- | --- | --- |
| `--path, -p <dir>` | string | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | string | Target a registered project by name (from ~/.hack/projects.json) |
| `--json` | boolean | Output JSON (machine-readable) |
| `--no-interactive` | boolean | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | boolean | Show help |
| `--version, -v` | boolean | Show version |

Source: `src/commands/project-admin.ts:16 (ownerShowSpec)`. No command alias is declared.

### `hack env backend status`

Show configured env/secret backend strategy.

Arguments: none.

| Option | Type | Meaning / declared fallback |
| --- | --- | --- |
| `--json` | boolean | Output JSON (machine-readable) |
| `--no-interactive` | boolean | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | boolean | Show help |
| `--version, -v` | boolean | Show version |

Source: `src/commands/env.ts:375 (backendStatusSpec)`. No command alias is declared.

### `hack env backend use <backend>`

Select env/secret backend strategy.

Arguments: `backend` — required.

| Option | Type | Meaning / declared fallback |
| --- | --- | --- |
| `--provider <aws\|gcp\|azure\|vault>` | string | Cloud secret provider when backend is cloud |
| `--store-path <path>` | string | Encrypted file path when backend is encrypted_file |
| `--key-path <path>` | string | Stable key file path when backend is encrypted_file |
| `--provision-key` | boolean | Provision a stable key file for encrypted_file backend |
| `--secret-project <id>` | string | Optional cloud project/account identifier |
| `--secret-prefix <prefix>` | string | Optional cloud secret name prefix |
| `--json` | boolean | Output JSON (machine-readable) |
| `--no-interactive` | boolean | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | boolean | Show help |
| `--version, -v` | boolean | Show version |

Source: `src/commands/env.ts:384 (backendUseSpec)`. No command alias is declared.

## Complete public leaf and flag inventory

“Present” means a matching usage section; flags were compared separately. It does not prove every handler default is described. All rows also accept the three global/built-in flags above. Arguments are exact spec names.

| Leaf usage | Own flags (aliases and value hints) | Pinned generated section |
| --- | --- | --- |
| `hack global install` | none | Present |
| `hack global up` | none | Present |
| `hack global down` | none | Present |
| `hack global status` | `--json` | Present |
| `hack global logs [service]` | `--follow, -f`; `--no-follow`; `--tail <n>`; `--pretty` | Present |
| `hack global ca` | `--print` | Present |
| `hack global cert <hosts...>` | `--install`; `--out <dir>` | Present |
| `hack global trust` | none | Present |
| `hack global logs-reset` | none | Present |
| `hack global authorize` | none | Present |
| `hack status` | `--project <name>`; `--include-global`; `--all`; `--meta`; `--json` | Present |
| `hack usage` | `--project <name>`; `--details`; `--include-global`; `--watch`; `--interval <value>`; `--no-host`; `--json` | Present |
| `hack projects prune` | `--project <name>`; `--include-global`; `--dry-run`; `--json` | Present |
| `hack project owner show` | `--path, -p <dir>`; `--project <name>`; `--json` | Missing; drafted above |
| `hack init` | `--path, -p <dir>`; `--manual`; `--auto`; `--name <slug>`; `--dev-host <host>`; `--oauth`; `--oauth-tld <tld>`; `--no-discovery`; `--with <claude\|codex\|both>` | Present |
| `hack up [services...]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--branch <name>`; `--detach, -d`; `--profile <name[,name...]>`; `--target <auto\|local\|remote>`; `--json` | Present |
| `hack down` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--branch <name>`; `--profile <name[,name...]>`; `--target <auto\|local\|remote>`; `--prune-caches`; `--yes`; `--json` | Present |
| `hack restart [services...]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--branch <name>`; `--profile <name[,name...]>`; `--target <auto\|local\|remote>`; `--json` | Present |
| `hack ps` | `--path, -p <dir>`; `--project <name>`; `--branch <name>`; `--profile <name[,name...]>`; `--json` | Present |
| `hack tui` | `--path, -p <dir>`; `--project <name>` | Present |
| `hack run <service> [cmd...]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--branch <name>`; `--workdir <path>`; `--profile <name[,name...]>` | Present |
| `hack exec <service> [cmd...]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--branch <name>`; `--workdir <path>`; `--profile <name[,name...]>` | Present |
| `hack logs [service]` | `--path, -p <dir>`; `--project <name>`; `--branch <name>`; `--follow, -f`; `--no-follow`; `--tail <n>`; `--pretty`; `--json`; `--profile <name[,name...]>`; `--compose`; `--loki`; `--services <csv>`; `--query <logql>`; `--since <time>`; `--until <time>` | Present |
| `hack open [target]` | `--path, -p <dir>`; `--project <name>`; `--branch <name>`; `--prefer <auto\|alias\|dev>`; `--json` | Present |
| `hack branch add <name>` | `--path, -p <dir>`; `--project <name>`; `--note <text>` | Present |
| `hack branch list` | `--path, -p <dir>`; `--project <name>` | Present |
| `hack branch remove <name>` | `--path, -p <dir>`; `--project <name>` | Present |
| `hack branch open <name>` | `--path, -p <dir>`; `--project <name>`; `--prefer <auto\|alias\|dev>` | Present |
| `hack log-pipe` | `--format <auto\|docker-compose\|plain>`; `--stream <stdout\|stderr>` | Present |
| `hack doctor` | `--path, -p <dir>`; `--fix`; `--migrate-env-config`; `--json` | Present |
| `hack crash-capture` | `--path, -p <dir>`; `--since <duration>` | Present |
| `hack daemon start` | `--foreground` | Present |
| `hack daemon stop` | none | Present |
| `hack daemon restart` | none | Present |
| `hack daemon status` | `--json` | Present |
| `hack daemon metrics` | none | Present |
| `hack daemon logs` | `--tail <n>` | Present |
| `hack daemon clear` | none | Present |
| `hack daemon install` | `--run-at-load`; `--no-run-at-load`; `--gui-only`; `--no-gui-only` | Present |
| `hack daemon uninstall` | none | Present |
| `hack secrets set [name]` | `--service <service>` | Present |
| `hack secrets get [name]` | `--service <service>` | Present |
| `hack secrets delete [name]` | `--service <service>` | Present |
| `hack env list` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--json`; `--show-secrets`; `--service <global\|service>` | Present |
| `hack env explain <key>` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--json`; `--service <global\|service>`; `--target <host\|compose>` | Present |
| `hack env apply` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--json`; `--service <global\|service>` | Present |
| `hack env add [key] [value]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--secret`; `--local`; `--service <global\|service>` | Present |
| `hack env set [key] [value]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--secret`; `--local`; `--service <global\|service>` | Present |
| `hack env materialize` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--service <global\|service>` | Present |
| `hack env exec [command...]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--service <global\|service>`; `--target <host\|compose>`; `--shell <command>`; `--timeout <seconds>`; `--lifetime <command\|persistent>` | Present |
| `hack env shell` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--service <global\|service>`; `--target <host\|compose>` | Present |
| `hack env unset [key]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--local`; `--service <global\|service>` | Present |
| `hack env backend status` | `--json` | Missing; drafted above |
| `hack env backend use <backend>` | `--provider <aws\|gcp\|azure\|vault>`; `--store-path <path>`; `--key-path <path>`; `--provision-key`; `--secret-project <id>`; `--secret-prefix <prefix>`; `--json` | Missing; drafted above |
| `hack host ps` | `--project <name>`; `--json` | Present |
| `hack host exec [command...]` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--scope <global\|service>`; `--target <host\|compose>`; `--shell <command>`; `--timeout <seconds>`; `--lifetime <command\|persistent>` | Present |
| `hack host shell` | `--path, -p <dir>`; `--project <name>`; `--env <name\|base>`; `--scope <global\|service>`; `--target <host\|compose>` | Present |
| `hack config get <key>` | `--path, -p <dir>`; `--project <name>`; `--global` | Present |
| `hack config set <key> <value>` | `--path, -p <dir>`; `--project <name>`; `--global` | Present |
| `hack mcp serve` | none | Present |
| `hack mcp install` | `--scope <user\|project>`; `--path, -p <dir>`; `--all`; `--cursor`; `--claude`; `--codex`; `--docs`; `--agents-md`; `--claude-md` | Present |
| `hack mcp print` | `--scope <user\|project>`; `--path, -p <dir>`; `--all`; `--cursor`; `--claude`; `--codex` | Present |
| `hack setup tmux` | `--check`; `--remove` | Present |
| `hack setup cursor` | `--path, -p <dir>`; `--global`; `--check`; `--remove` | Present |
| `hack setup claude` | `--path, -p <dir>`; `--global`; `--check`; `--remove` | Present |
| `hack setup codex` | `--path, -p <dir>`; `--global`; `--check`; `--remove` | Present |
| `hack setup agents` | `--path, -p <dir>`; `--all`; `--agents-md`; `--claude-md`; `--check`; `--remove` | Present |
| `hack setup sync` | `--path, -p <dir>`; `--global`; `--all-scopes`; `--check`; `--remove` | Present |
| `hack setup mcp` | `--path, -p <dir>`; `--global`; `--all`; `--cursor`; `--claude`; `--codex`; `--check`; `--remove` | Present |
| `hack session list` | none | Present |
| `hack session start [project]` | `--up`; `--new`; `--name <value>`; `--detach, -d`; `--env <name\|base>`; `--service <global\|service>` | Present |
| `hack session stop <workspace>` | none | Present |
| `hack session attach <workspace>` | none | Present |
| `hack session exec <workspace> <command>` | `--env <name\|base>`; `--service <global\|service>` | Present |
| `hack session panes <workspace>` | `--json`; `--pretty` | Present |
| `hack session capture <workspace>` | `--target <target>`; `--lines <n>`; `--json`; `--pretty` | Present |
| `hack session tail <workspace>` | `--target <target>`; `--lines <n>`; `--interval-ms <ms>`; `--max-ms <ms>`; `--json`; `--pretty` | Present |
| `hack agent prime` | `--check` | Present |
| `hack agent patterns` | none | Present |
| `hack agent init` | `--path, -p <dir>`; `--client, -c <cursor\|claude\|codex\|print>` | Present |
| `hack agent onboard` | `--path, -p <dir>` | Present |
| `hack update` | `--check`; `--yes`; `--tag <tag>`; `--json` | Present |
| `hack version` | none | Present |
| `hack help [path...]` | `--all` | Present |

## Declared defaults and option semantics

This table preserves declarations/descriptions that state defaults. Other handler/backend defaults are not implied by absence here.

| Leaf / option | Source declaration |
| --- | --- |
| `hack global logs [service]` / `--follow, -f` | Follow logs (default for `hack logs`) |
| `hack global logs [service]` / `--tail <n>` | Tail last N log lines Flag-present fallback: `200`. |
| `hack global cert <hosts...>` / `--out <dir>` | Directory for generated cert/key (default: ~/.hack/certs) |
| `hack init` / `--auto` | Run non-interactive init with sensible defaults |
| `hack init` / `--name <slug>` | Project slug (default: repo name) |
| `hack init` / `--oauth-tld <tld>` | OAuth alias TLD override (default: gy) |
| `hack logs [service]` / `--follow, -f` | Follow logs (default for `hack logs`) |
| `hack logs [service]` / `--tail <n>` | Tail last N log lines Flag-present fallback: `200`. |
| `hack log-pipe` / `--format <auto\|docker-compose\|plain>` | How to parse incoming lines from stdin Flag-present fallback: `auto`. |
| `hack log-pipe` / `--stream <stdout\|stderr>` | Treat stdin as stdout or stderr (stderr forces ERROR level + writes to stderr) Flag-present fallback: `stdout`. |
| `hack daemon logs` / `--tail <n>` | Tail last N log lines Flag-present fallback: `200`. |
| `hack daemon install` / `--gui-only` | Only run in GUI sessions (default) |
| `hack secrets set [name]` / `--service <service>` | Override Bun.secrets service name Flag-present fallback: `hack-cli`. |
| `hack secrets get [name]` / `--service <service>` | Override Bun.secrets service name Flag-present fallback: `hack-cli`. |
| `hack secrets delete [name]` / `--service <service>` | Override Bun.secrets service name Flag-present fallback: `hack-cli`. |
| `hack env explain <key>` / `--target <host\|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `hack env exec [command...]` / `--target <host\|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `hack env exec [command...]` / `--lifetime <command\|persistent>` | Declare intended lifetime for diagnostics (default: command; does not detach) |
| `hack env shell` / `--target <host\|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `hack host exec [command...]` / `--target <host\|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `hack host exec [command...]` / `--lifetime <command\|persistent>` | Declare intended lifetime for diagnostics (default: command; does not detach) |
| `hack host shell` / `--target <host\|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `hack mcp install` / `--scope <user\|project>` | Write MCP config to user or project scope Flag-present fallback: `user`. |
| `hack mcp print` / `--scope <user\|project>` | Write MCP config to user or project scope Flag-present fallback: `user`. |
| `hack session start [project]` / `--new` | Create an isolated workspace instead of reusing the default project workspace |
| `hack session capture <workspace>` / `--target <target>` | Tmux pane target (default: active pane) |
| `hack session capture <workspace>` / `--lines <n>` | Number of lines to capture Flag-present fallback: `200`. |
| `hack session tail <workspace>` / `--target <target>` | Tmux pane target (default: active pane) |
| `hack session tail <workspace>` / `--lines <n>` | Number of lines to capture Flag-present fallback: `200`. |
| `hack session tail <workspace>` / `--interval-ms <ms>` | Polling interval in milliseconds Flag-present fallback: `500`. |
| `hack session tail <workspace>` / `--max-ms <ms>` | Stop tailing after N milliseconds Flag-present fallback: `5000`. |

## Ownership inspection

`project owner show` searches from cwd or `--path`, or selects a registered `--project`; do not combine path/project. Missing project and config parse failures refuse. JSON success is a bare object and exits 0:

| Field | Type and meaning |
| --- | --- |
| `project_root` | string; resolved root |
| `project_slug` | string or null; sanitized configured name, null if blank |
| `ownership.mode` | local/shared |
| `ownership.owner_type` | user/team/organization |
| `ownership.owner_id` | string or null |
| `ownership.managed_by` | local/broker |

Defaults are local/user/null/local. These are retained local metadata, not hosted team/broker support. No owner mutation leaf exists here.

## Env backend strategy

Status reads effective settings for cwd's project when found, global settings otherwise. It takes no project/path/env selectors. Use writes **global** settings and rereads global settings. It does not migrate YAML project-key values or establish cloud-provider qualification.

Backend is required: exactly `keychain`, `encrypted_file` or `cloud`. Provider accepts exactly `aws|gcp|azure|vault` and is required for cloud even if a provider was previously configured. Invalid nonempty backend/provider is a usage error. Inputs are trimmed; empty optional paths/project/prefix are omitted. Store/key paths apply only to encrypted_file; cloud project/prefix apply only with cloud/provider. Omitted settings are retained. Provision-key defaults false and applies only to encrypted_file.

Fresh schema defaults: keychain, allow_env_auth_refs true, store_plaintext_in_backend false; file path `~/.hack/secrets.enc.json`, key path `~/.hack/secrets-file.key`; cloud prefix `hack`, provider/project unspecified. These are config defaults, not flag defaults reapplied on every use. The key environment variable name is `HACK_SECRETS_FILE_KEY`. Providers describe retained compatibility strategies, not qualified cloud onboarding.

Both JSON successes are bare objects and return 0:

| Field | status | use |
| --- | --- | --- |
| `backend` | selected enum | selected enum |
| `allow_env_auth_refs` | boolean | boolean |
| `store_plaintext_in_backend` | boolean | boolean |
| `encrypted_file` | object: string path/keyPath | same |
| `encrypted_file_key_env` | string variable name | same |
| `cloud` | object: optional provider/project strings, string secretPrefix; undefined properties omitted | same |
| `status` | object below | absent |
| `encrypted_file_key_provisioned` | absent | null or {keyPath:string, source:env/file/keychain/generated} |

Status has string storage_mode/trust_model/portability/plaintext_compatibility and classification. Classification has string trust_model/custody/portability and shared_state (local_only/plaintext_compatible/portable_bundle/broker_managed). These descriptive names do not grant remote/team features.

## JSON results and exits

The generated page's universal envelope claim is too broad. Decode by command and backend. The shared helper emits `{ok:true,data:T}` or `{ok:false,error:{code,message,detail?}}`; detail is unknown. Its mapper returns 0/1. Handlers can instead return child exit codes, bare objects, reports or JSON-lines.

Thrown usage errors with an explicit `--json` token become E_USAGE; other thrown errors preserve HackCliError codes or become E_UNEXPECTED, with exit 1. Returning 1 directly does not automatically create an error envelope. Unknown command or namespace paths may print help and exit 1. Help/version return early with status 0, including when JSON was requested. Valid JSON alone proves neither success nor readiness.

| Command | Output contract | Exit / open shape |
| --- | --- | --- |
| up/down/restart, retained Compose owner | shared envelope; data action (up/down/restart), project:string, branch:string/null, composeProject:string, services.{started,completed,stopped,failed}:sorted string arrays, durationMs:number; optional cacheVolumesRemoved:string[] | JSON up implies detach. Structured startup/lifecycle failures use error envelope. |
| ps, Compose | bare {project,branch,composeProject,items}; branch nullable; items parsed engine records | daemon-assisted JSON may be forwarded; engine rows are open. Compose failure can return child nonzero with stderr and no success object. |
| open | bare {url:string} | JSON reports URL; does not launch browser |
| projects/status | bare listing below | runtime_ok false is report data, not necessarily command failure |
| projects prune | shared envelope, preview/apply variants below | dry-run reports candidates; apply reports removals |
| project owner show | bare ownership object above | success 0 |
| env backend status/use | bare strategy objects above | success 0 |
| env list | bare modern-YAML or legacy report below | raw report may include values |
| env apply | forwards restart service --path repo with selected env/JSON flags | returns child restart output and exit code, not an env-list report; native subset/JSON limits still apply |
| env explain | bare value-free explanation below | inspect available/scope; no value |
| doctor | shared envelope with checks[], summary:string[], counts.{ok,warn,error}:numbers | can emit ok:true and exit 1 when checks contain errors |
| usage | bare projects[], total nullable, host[], host_total nullable, runtime_ok:boolean, runtime_error nullable; details adds containers[] | failures exit 1; optional error string. No samples exits 0 with warning:no_usage_samples. Watch uses the interactive redraw path even with JSON selected; do not treat watch as a JSON report stream. |
| global status | bare generated_at/caddy/logging/networks/gateway/summary | exits 0 even if summary health false; gateway is retained unsupported data, excluded from public contract |
| daemon status | bare report below | running returns 0; starting/stale/unavailable may return 1 |
| host ps | bare {generatedAt,snapshotAvailable,commands,lifecycle} | timestamp string, availability boolean; nested telemetry remains specialized |
| setup sync | human status list; no JSON option at this pin | v5 JSON/target report and install-missing must not be backported |
| session panes/capture/tail | JSON-lines events below | no shared envelope |
| update | command-owned object with ok:boolean, string error on failure | error is not shared error.{code,message}; success varies by check/install outcome; exit follows ok |

Config get has no JSON flag: non-string values serialize as JSON, strings print plainly. Daemon metrics prints retained metrics JSON without a JSON flag; nested internal transport data is not a supported general API. MCP serve speaks MCP; log-pipe formats a stream. Other leaves without JSON do not inherit it.

### Report details

Direct projects/status fields: generated_at, filter, include_global, include_unregistered, include_meta, runtime_ok, runtime_error, runtime_checked_at, runtime_last_ok_at, runtime_reset_at, runtime_reset_count, runtime_reset_summary, runtime_reset_changes, runtime_last_repair_at, runtime_repair_action, runtime_repair_outcome, runtime_next_step, projects[]. Optional detail_level:summary selects summary projection. Project records use summary/full projections with optional meta. Nullable recovery metadata is not liveness proof; nested engine/meta variants remain open.

Prune preview and apply are separate shapes. Apply includes runtimeOk/runtimeError, removedRegistryEntries[] (id/name/repoRoot/projectDir/reason), removedOrphanedProjects[] (project/workingDir/reason/containerCount), removedContainerCount. Preview includes dryRun:true, runtimeOk, registryCandidates[] (name/projectDir/reason), orphanedProjects[] and candidateContainerCount. It does not add runtimeError merely because apply has it. Orphan records are typed in the table below.

Doctor checks contain id/status/detail/durationMs; status is ok/warn/error. summary is string[]; counts are numbers. Additional diagnostics depend on version/check and remain specialized shapes.

Daemon status fields: status, running, api_ok, api_reachable, api_compatible, process_running, stale, stale_reason, issue, next_step, pid, socket_path, socket_exists, log_path, log_exists, launchd. Launchd is null or {installed,loaded,running,pid,exit_status,plist_path}. Unavailable/nullable observations must not be treated as proof of process absence or authority to signal a PID.

Env explain: key:string, available/secret:boolean, format:project_env_config_v1/legacy_env_contract; environment/effective_scope/source:string|null; requested_scope:string, target:host/compose, delivered_to/precedence:string[]. It emits no value.

Env list: project and env_selection (requested/default/effective selections, overlay_path, overlay_exists). Modern YAML adds format:project_env_config_v1, selected_scope, scopes, files, unknown_scopes, status/storage descriptions, vars[], missing_required. Legacy reports have storage/status, materialization and key projections. Rows in vars[] contain key/required/source/services/resolved_from/storage/value. Secret values are masked unless show-secrets is explicitly selected; ordinary plaintext is not thereby hidden. Modern reports include materialized when show-secrets is selected, otherwise materialized_keys. Legacy reports additionally contain warnings[] (kind/key/overlay_path/services/message). CLI reports differ from MCP's narrower value-free keys projection. Nested modern/legacy variants remain versioned report shapes; application values are not new stable reference keys.

## Compose/Loki log records

Logs JSON is newline-delimited events, not an array or envelope. Finite snapshots and follow share vocabulary. Follow is default; no-follow requests finite output. Omitted tail falls back to 200. JSON conflicts with pretty; compose conflicts with explicit Loki selection (loki/services/query/since/until); follow with until refuses.

| Event field | Presence / type |
| --- | --- |
| type | required start/log/heartbeat/error/end |
| ts | required string; ISO generation time or log entry timestamp |
| backend | optional in declared type; builders include compose/loki |
| project/branch | optional strings, omitted without context |
| services | optional string[], start context when supplied |
| follow | optional boolean; start builder includes it |
| since/until | optional strings, start context when supplied |
| entry | optional LogJsonEntry; log includes it |
| message | optional string; error includes it |
| reason | optional string; end includes nonempty reason |

Compose ends with eof or exit:<code>. Loki finite snapshots can end without reason; handled query failure emits error/end(error), follow ends closed/error. Error can precede start. Heartbeat has a builder, but these emitters do not establish periodic delivery. End settles a stream, not a workload.

| Entry field | Type / meaning |
| --- | --- |
| source | required compose/loki |
| message/raw | required strings: parsed message/original line |
| stream | optional stdout/stderr, Compose |
| project/service/instance | optional strings from context/prefix/labels |
| labels | optional string-to-string map, Loki |
| timestamp | optional ISO string |
| timestamp_ns | optional nanosecond timestamp string, not number |
| level | optional debug/info/warn/error after normalization |
| fields | optional string-to-string map of application fields |

Optional fields are omitted, not declared nullable. Map keys are open application data. The TypeScript declaration is not a runtime-validated closed JSON schema. Global logs has no JSON option.

## Session JSON-lines

Panes/capture/tail are tmux inspection surfaces and default to JSON unless pretty is selected. Capture/tail default to active target and 200 lines. Tail defaults interval-ms to 500 and max-ms to 5000. JSON and pretty together refuse. Panes snapshots emit start, log per pane, end(snapshot); capture emits log per captured line and end(snapshot). Tail emits changes and a finite budget ends with timeout. Refusals can precede event creation.

All events have type start/log/error/end, ts:string (ISO), session:string. Pane logs add pane:{target:string,active:boolean,windowIndex:number,windowName:string,paneIndex:number,command:string,path:string|null}. Capture/tail events also have target:string, lines:number, follow:boolean, optional intervalMs/maxMs:number. Log adds line:string; error adds message:string; end may add reason:string. These are separate from project log entry/backend events.

## Remaining limits

Leaf/flag presence is reconciled. Handler defaults outside the reviewed tables are not an exhaustive semantic audit. Engine rows, optional diagnostic subtypes, listing metadata, setup target results, update success variants, nested env variants and candidate reports remain bounded open/specialized shapes. No closed schema, backend parity, client-loading proof or installed runtime acceptance is claimed. Config-file/MCP field work remains in the separate audit. Private compiler/daemon/guest/provider protocols and retired APIs are excluded.

V4 owner selection sanitizes a supplied registered name before lookup. V4 has no DNS leaves, authored-native contract, config validate/plan/import/adopt leaves or project task leaves. Do not copy v5 native limits or sensitive env-get error suppression into v4.

## Parent command sections

These sections are also present in the pinned reference. Some parents handle direct invocation (for example projects/session); namespace options do not pass to children. Counts above count terminal leaves only.

| Section | Own options; all also have global/built-ins |
| --- | --- |
| `hack project` |  |
| `hack project owner` |  |
| `hack branch` |  |
| `hack config` |  |
| `hack session` |  |
| `hack global` |  |
| `hack projects` | `--project <name>`; `--details`; `--summary`; `--timings`; `--no-daemon`; `--meta`; `--include-global`; `--all`; `--json` |
| `hack daemon` |  |
| `hack mcp` |  |
| `hack setup` |  |
| `hack agent` |  |
| `hack secrets` | `--service <service>` |
| `hack env` |  |
| `hack env backend` |  |
| `hack host` |  |

## Stable shared error codes

`E_DOCKER_UNAVAILABLE`, `E_GLOBAL_INFRA_DOWN`, `E_CONFIG_PARSE`, `E_CONFIG_INVALID`, `E_PROJECT_NOT_FOUND`, `E_SERVICE_NOT_FOUND`, `E_COMPOSE_FAILED`, `E_STARTUP_INCOMPLETE`, `E_DEPENDENCY_BOOTSTRAP_FAILED`, `E_STARTUP_TIMEOUT`, `E_LIFECYCLE_FAILED`, `E_ENV_KEY_MISSING`, `E_PERMISSION`, `E_INTERACTIVE_REQUIRED`, `E_USAGE`, `E_UNEXPECTED`. Optional error.detail is unknown; direct-return failures need not use this envelope.

Update success fields: ok:true, current/latest:string, updateAvailable/installed:boolean, target:{platform:string,arch:string}, binaryPath/assetsDir:string, optional mutagen provisioning report. Handled failure is {ok:false,error:string}. 

## Typed corrections for generated value placeholders

These were display-only mismatches, not missing flags. The generated `<value>` placeholder means a value is required when the flag is used; none of these options has a short alias or an OptionSpec defaultValue.

| Command / exact spelling | Type | Omission / handler behavior |
| --- | --- | --- |
| `hack usage --interval <value>` | number, milliseconds | Omitted: configured usage.watchIntervalMs. Finite positive input is floored and clamped to at least 250 ms; nonpositive/invalid resolved interval falls back to 2000 ms. Watch uses human redraw output. |
| `hack session start [project] --name <value>` | string; workspace suffix | Omitted: reuse base workspace unless --new requests the next numeric suffix. A truthy supplied suffix is passed to the session-name builder; it is not a project selector. |

## Prune preview field types

The preview uses the shared success envelope. Its data object is:

| Field | Type / meaning |
| --- | --- |
| dryRun | literal true |
| runtimeOk | boolean; whether runtime inventory succeeded |
| registryCandidates | array of {name:string, projectDir:string, reason:string} |
| orphanedProjects | array of {project:string, workingDir:string|null, reason:string, containerIds:readonly string[]} |
| candidateContainerCount | number; sum of orphan container IDs |

Preview omits runtimeError. A successful envelope describes a completed preview, not a guarantee that the runtime is healthy. Apply has the distinct removal fields already listed above. Neither form is permission to delete resources.
