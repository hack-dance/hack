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
| Image-only services and explicit completion jobs | The same logical workload names and image strings |
| Array or bounded string `command` and `entrypoint` | Explicit native exec arrays; Compose string words are split without an implicit shell, complete `$$` pairs become literal `$` arguments, and an empty entrypoint remains explicit |
| `working_dir`, boolean `init` | `working_directory`, `init` |
| `pull_policy` of `always`, `never`, `missing` | The same authored acquisition intent |
| Service `restart` of `no`, `always`, `unless-stopped`, `on-failure[:N]` | Native restart intent; retry counts must fit a positive u32; jobs accept only explicit `no` or omission |
| String `stop_signal`, `stop_grace_period` | Native shutdown signal/grace, validated by the compiler |
| String environment map or `KEY=value` list | Native `default` bindings, preserving managed-value precedence and empty values |
| Nonempty canonical `profiles` lists | Native workload selection and the union of declared profiles |
| Short `depends_on` lists, or long edges with `service_started` / `service_healthy` | Native service `started` / `ready` edges; `required` must be absent/true and `restart` absent/false |
| Long edges with `service_completed_successfully` | The referenced declaration becomes a native job; the edge becomes `job` / `completed` |
| Exact `hack.service.one-shot: "true"` label map or singleton `hack.service.one-shot=true` label list | An explicit standalone native job; the known marker is consumed as semantic provenance, without adding resource labels |
| `healthcheck.test: [CMD, executable, ...args]` with authored positive `interval`, `timeout`, `retries` | Native exec readiness; complete argument dollar pairs decode once, and the compiler validates timings |

Names in this slice use lowercase letters, digits and single hyphen separators.
Overlay aliases additionally accept ASCII case, underscores and spaces and apply
the existing overlay-name normalization; path-like or punctuation-based spellings
refuse. All alias spellings and their original source positions remain in the
report. In command and entrypoint arrays or strings, every dollar must be part
of a complete `$$` pair; the report marks decoded or split fields as normalized
while retaining the raw authored source. String words support ASCII space,
tab, CR and LF separators, single or double quoting, adjacent quoted segments,
empty quoted arguments and backslash escapes. They never imply `/bin/sh -c`;
an explicit shell executable and `-c` argument remain ordinary exec words.
Unquoted shell control characters, unmatched quotes, dangling escapes, a first
empty executable word, single or odd dollars, `$VAR` and `${VAR}` refuse.
Omitted or explicit null command/entrypoint keeps Compose's image-default behavior. Empty or
whitespace-only entrypoint explicitly clears the image entrypoint; empty or
whitespace-only command refuses because the native command model cannot express
Compose's explicit empty override. Dollars in other runtime strings and NUL in runtime values refuse
rather than inheriting ambient environment. Environment list entries without `=`, duplicate
names, nulls and non-string values refuse.

Every unknown field remains a refusal, including fields in inactive profiles.
Builds, volumes/bind mounts, networks, ports, other labels,
routes, host/lifecycle settings, `env_file`, deployment options and extensions
are outside the first slice. They cannot be silently omitted from a complete
conversion.

Completion roles are discovered before declarations are converted, including
inactive declarations. A completed target or explicit one-shot keeps its authored
argv, entrypoint, environment and other supported fields under `jobs`; original
field positions remain in the report with native job targets. Unmarked installers,
command text, service names, `restart: no` and observed exit zero do not infer jobs.
The same target cannot also satisfy a started or healthy service edge. Undeclared
completed targets, optional or restart-propagating edges, mixed or noncanonical
one-shot labels, job health checks and non-`no` job restart policies refuse. Omitted
job restart stays omitted; no native default is invented. Supported profile fields
remain authored selection, and unsupported fields in inactive jobs still refuse.

This is pure conversion, not retained-job adoption. Versions 1–5 do not qualify job
ordering, completion, recovery or replay. The distinct [version-7 retained owner](native-compose-adoption.md)
qualifies only its closed static/default-network family. A job import preview does not upgrade a
receipt, launch or recreate a container, transfer ownership, or qualify application
migration. Two-worktree data acceptance remains a separate live gate.

The service-only adoption baseline continues to refuse jobs. Only the version-7
owner selects its distinct completed-job baseline after verifying the closed
static family. Symbolic conversion is not an ownership grant.

Custom-network job combinations remain refused; no static-bridge import or
retained network authority is added by this completed-job conversion.

Health intervals and timeouts must use integer `ms`, `s`, `m` or `h` durations
that fit the compiler's positive u32 milliseconds. Missing or zero timings,
`CMD-SHELL`, string probes, `NONE`, disabled probes, `start_period` and
`start_interval` refuse: image health settings and image `SHELL` are not acquired,
and the native contract cannot express all of those options. Explicit `disable:
false` is the default enabled setting. Optional edges and restart propagation
refuse. Completed-job conversion is supported as described above; retained-job
execution has its own version and family boundary. Unknown HTTP/TCP fields also refuse.
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
