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
| Basic build-only services and explicit completion jobs | String context or a closed object containing `context`, `dockerfile`, `target`; legacy `.hack` context rebased to the checkout root |
| Array or bounded string `command` and `entrypoint` | Explicit native exec arrays; Compose string words are split without an implicit shell, complete `$$` pairs become literal `$` arguments, and an empty entrypoint remains explicit |
| `working_dir`, boolean `init` | `working_directory`, `init` |
| `pull_policy` of `always`, `never`, `missing` for images, or `build` for builds | The same authored acquisition intent; omitted policy stays omitted |
| Service `restart` of `no`, `always`, `unless-stopped`, `on-failure[:N]` | Native restart intent; retry counts must fit a positive u32; jobs accept only explicit `no` or omission |
| String `stop_signal`, `stop_grace_period` | Native shutdown signal/grace, validated by the compiler |
| String environment map or `KEY=value` list | Native `default` bindings, preserving managed-value precedence and empty values |
| One explicitly declared project-owned Compose `bridge` network with boolean `internal`, attached explicitly to every workload and optional static aliases | The same logical native bridge policy and per-workload aliases; no implicit default attachment or physical-ID claim |
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
Compose's explicit empty override. Outside argv and basic build paths, dollars in runtime strings and NUL in runtime values refuse
rather than inheriting ambient environment. Environment list entries without `=`, duplicate
names, nulls and non-string values refuse.

Every unknown field remains a refusal, including fields in inactive profiles.
Advanced builds, volumes/bind mounts, other network shapes, ports, other labels,
routes, host/lifecycle settings, `env_file`, deployment options and extensions
are outside the first slice. They cannot be silently omitted from a complete
conversion.

The network mapping accepts one named non-default, non-ingress bridge only. It
requires explicit `internal: true` or `false`, optional `driver: bridge`, and
one explicit attachment per workload, including inactive jobs. Unknown
network/attachment fields, custom physical names, external networks, IPAM,
driver options, implicit or mixed default attachments, and duplicate or
workload-colliding aliases refuse. Import preview preserves the authored
logical topology; it does not claim that a running Compose bridge belongs to
the project. The separate adoption owner must prove the existing bridge and
container endpoints before a retained-ID transition.

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

This is pure conversion, not retained-job adoption. Existing retained adoption
owners still refuse job candidates: their receipt versions do not qualify job
ordering, completion, recovery or replay. A job import preview does not upgrade a
receipt, launch or recreate a container, transfer ownership, or qualify application
migration. Job-aware retained lifecycle and two-worktree data acceptance remain
separate work.

Retained resource planning uses its own closed adoption baseline and refuses jobs
before acquiring existing engine resource bindings, even when pure conversion
can preserve a job's named mounts. Symbolic conversion is not an ownership grant.

Pure preview can preserve a completed job's explicit attachment and aliases on
the same owned bridge. Retained storage/adoption still refuses custom-network
job combinations: neither the job nor network receipt proves their combined
ordering, endpoint ownership, recovery or replay.

Health intervals and timeouts must use integer `ms`, `s`, `m` or `h` durations
that fit the compiler's positive u32 milliseconds. Missing or zero timings,
`CMD-SHELL`, string probes, `NONE`, disabled probes, `start_period` and
`start_interval` refuse: image health settings and image `SHELL` are not acquired,
and the native contract cannot express all of those options. Explicit `disable:
false` is the default enabled setting. Optional edges and restart propagation
refuse. Completed-job conversion is supported as described above; retained-job
execution remains a separate slice. Unknown HTTP/TCP fields also refuse.
The compiler rejects missing, cyclic or inactive dependency targets and ready
edges whose target has no explicit readiness. Refusals include inactive profiles.

## Pure basic build preview

The [Compose build contract](https://docs.docker.com/reference/compose-file/build/)
allows a short context string or an object. This preview accepts only relative
local context paths and optional relative `dockerfile` and canonical `target`.
It converts the raw `.hack/docker-compose.yml` declaration: legacy context paths
start at `.hack/`, while native contexts start at the checkout root. Thus
`build: ..` maps to native context `.`, `build: .` maps to `.hack`, and
`context: ../app` maps to `app`. An object without `context` uses the legacy
default directory `.hack`. An omitted Dockerfile remains omitted for the native
compiler's `Dockerfile` default; an explicit Dockerfile stays relative to the
build context. Lexical path normalization and complete `$$` pair decoding do not
read files or evaluate environment variables. Source pointers and positions
remain those of the raw declaration, and the report contains no path values.
For a converted job, native build target pointers use `/jobs/<name>/build` while
source pointers retain the original `/services/<name>/build` declaration.

Context paths escaping the checkout root, Dockerfiles escaping their context,
absolute/home-relative/remote paths, ambiguous dollar expressions and malformed
fields refuse. Build arguments, cache options, SSH, secrets, labels, network,
inline Dockerfiles, platforms, tags and every other build option remain refused,
even when empty or in an inactive profile. `build.pull` is unsupported; the
workload's `pull_policy: build` is a separate supported acquisition requirement.
Combined `build` and `image` refuse because the native model requires exactly one
source. Invalid builds cannot fall back to an authored image or a default policy.

This expands read-only preview only. Retained-container adoption still uses its
separate image-only mapping and refuses builds. The mapper runs no Compose
normalization, builder or runtime command, and does not validate Dockerfile
contents, path existence or filesystem identity. The authoritative compiler still
must validate the whole private candidate before a complete CLI preview; actual
build import and adoption acceptance remain open.

The maintained config-only correspondence gate is
`bun scripts/check-native-config-import-build.ts`. Select the prepared matching
sidecar with an absolute `HACK_CONFIG_COMPILER_BINARY` and the installed standalone
Compose plugin with an absolute `HACK_IMPORT_COMPOSE_BINARY`. It compares the
actual normalized Compose projections of the raw legacy and compiled/rendered
native inputs for default context, checkout-root context, nested Dockerfile/stage
and literal dollars, including an inactive profile selected explicitly for the
comparison. Context and lexically resolved Dockerfile paths must match; stage, source and
policy presence must remain exact. These are Compose's serialized config strings,
including its escaped-dollar representation; the comparison does not decode them
again or certify the builder's actual filesystem paths. No builder or engine command is admitted.
Compose receives an isolated empty Docker configuration and a nonexistent engine
socket. The aggregate gate is bounded to 90 seconds with bounded child captures.
An optional fresh absolute `HACK_IMPORT_BUILD_EVIDENCE_DIR` retains private
captures and the result; a failure keeps its temporary evidence and returns
nonzero. The result records matched projections and requires the command's final
zero exit; it cannot independently certify completion after a late write or
cancellation. This proves config correspondence, not build or adoption acceptance.

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
