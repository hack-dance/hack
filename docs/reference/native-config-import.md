# Read-only native import preview

`hack config import --dry-run --path /exact/project/root --json` previews a
bounded conversion of the active `.hack/hack.config.json` and
`.hack/docker-compose.yml` pair. It does not discover an ancestor project.
The JSON report contains source document names, field pointers, line/column
positions, mapping status and fixed refusal codes. Human output uses the same
information. Neither output includes authored values, compiler plans or hashes.
`--dry-run` is required; adoption and draft export are unavailable.

A complete preview means every authored field belongs to the supported subset
and the resulting private candidate passes the matching native compiler in memory.
It does not write `hack.project.json`, change active input selection, register
projects, read managed environment values or keys, or inspect/change engine
resources. Any refusal discards the private candidate; no partial conversion is
reported as successful.

## Supported subset

| Legacy input | Native mapping |
| --- | --- |
| Required explicit canonical `name` | The same project name; no directory-name fallback |
| String `$schema` | Editor metadata; no runtime field |
| `defaultEnvConfig`, `default_env_config`, `env.defaultOverlay`, `env.default_overlay` | `environment.default_overlay`; all present aliases must select the same overlay |
| Boolean `worktree.auto_branch` / `autoBranch` and `inherit_local` / `inheritLocal` | The equivalent native worktree policy; conflicting aliases refuse |
| Optional Compose `name` | Must exactly equal the explicit project name |
| Image-only services | The same logical service names and image strings |
| Array `command` and `entrypoint` | Explicit native exec arrays; complete Compose `$$` pairs become literal `$` arguments, and an empty entrypoint remains explicit |
| `working_dir`, boolean `init` | `working_directory`, `init` |
| `pull_policy` of `always`, `never`, `missing` | The same authored acquisition intent |
| `restart` of `no`, `always`, `unless-stopped`, `on-failure[:N]` | Native restart intent; retry counts must fit a positive u32 |
| String `stop_signal`, `stop_grace_period` | Native shutdown signal/grace, validated by the compiler |
| String environment map or `KEY=value` list | Native `default` bindings, preserving managed-value precedence and empty values |
| Nonempty canonical `profiles` lists | Native service selection and the union of declared profiles |
| Short `depends_on` lists, or long edges with `service_started` / `service_healthy` | Native service `started` / `ready` edges; `required` must be absent/true and `restart` absent/false |
| `healthcheck.test: [CMD, executable, ...args]` with authored positive `interval`, `timeout`, `retries` | Native exec readiness; complete argument dollar pairs decode once, and the compiler validates timings |

Names in this slice use lowercase letters, digits and single hyphen separators.
Overlay aliases additionally accept ASCII case, underscores and spaces and apply
the existing overlay-name normalization; path-like or punctuation-based spellings
refuse. All alias spellings and their original source positions remain in the
report. In exec arrays only, every dollar must be part of a complete `$$` pair;
the report marks decoded fields as normalized while retaining the raw source.
Single or odd dollars, `$VAR`, `${VAR}`, shell-form commands and ambiguous
expressions refuse. Dollars in other runtime strings and NUL in runtime values refuse
rather than inheriting ambient environment. Environment list entries without `=`, duplicate
names, nulls and non-string values refuse. Shell-form commands/entrypoints and
empty commands refuse.

Every unknown field remains a refusal, including fields in inactive profiles.
Builds, volumes/bind mounts, networks, ports, labels,
routes, host/lifecycle settings, `env_file`, deployment options and extensions
are outside the first slice. They cannot be silently omitted from a complete
conversion.

Health intervals and timeouts must use integer `ms`, `s`, `m` or `h` durations
that fit the compiler's positive u32 milliseconds. Missing or zero timings,
`CMD-SHELL`, string probes, `NONE`, disabled probes, `start_period` and
`start_interval` refuse: image health settings and image `SHELL` are not acquired,
and the native contract cannot express all of those options. Explicit `disable:
false` is the default enabled setting. Optional edges, restart propagation and
`service_completed_successfully` refuse. Completed jobs remain a required later
conversion and retained execution slice. Unknown HTTP/TCP fields also refuse.
The compiler rejects missing, cyclic or inactive dependency targets and ready
edges whose target has no explicit readiness. Refusals include inactive profiles.

## Parsing and input boundary

The pinned maintained `yaml` AST parser checks decoded key uniqueness, strict
syntax and source positions. JSON additionally passes strict `JSON.parse` syntax
validation before AST inspection; escaped equivalent JSON keys still refuse.
Exactly one document is required. YAML anchors, aliases, merge keys, explicit tags
and directives refuse. YAML 1.1 compatibility warnings also refuse, so ambiguous
plain scalars such as `on` require explicit quotes. Input bytes, AST nodes and
depth have fixed budgets. Parser diagnostics contain no source excerpts.

Selected files must be bounded readable regular files with one hard link.
Symlinked roots/directories/files, missing or competing authored inputs, invalid
UTF-8 and changed input identities or bytes refuse. Stable descriptor reads and
final rechecks surround compiler validation; they do not lock external editors.
Cancellation stops the owned compiler and returns a fixed redacted error.

Presence of root `.env`, `.hack/.env` or `.hack/hack.local.json` explicitly
refuses this first slice without reading them. Linked worktrees and separate Git
directories use `.git` files; those layouts explicitly refuse, including when
the selected project is nested beneath that Git root. Ordinary `.git` directories
are inspected only for marker type and identity.

The private owner result freezes its report and candidate. The candidate is
non-enumerable and available only through explicit private API access; ordinary
JSON serialization and object spread contain the report alone. Public callers
must never serialize that candidate into logs, receipts or command output.

## Identity and remaining adoption work

Preview preserves the explicit logical project name, service names and supported
authored intent. It does not transfer registry IDs, Compose project/resource
ownership, named volumes, checkout/worktree identity or saved runtime generations.
Existing managed environment files remain untouched; their values are not copied
into the authored candidate.

NC04 adoption remains open. Locked publication, input-family transition, local and
linked-worktree policy, unsupported intent conversion, existing resource ownership,
volume reuse and recovery require separate implementation and acceptance.
A successful preview is neither execution admission nor application acceptance.

The separate private [legacy Compose binding prerequisite](native-compose-adoption.md)
can verify qualified existing instance and named-volume identities without changing
configuration or resources. It does not expand this command's conversion subset
or complete the adoption transaction.
