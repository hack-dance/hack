# Native configuration validation

This is an experimental, pure compiler for a bounded subset of the planned
`.hack/hack.project.json` format. The pure compiler does not discover projects, execute workloads,
import Compose, migrate data, decrypt environment values, perform host admission,
or change how existing projects run. A successful compile is syntax and semantic
validation, not backend capability or application acceptance. The CLI can acquire
the selected project and permitted local settings for offline resolution.

The CLI recognizes this filename as a project boundary. Native runtime and adoption
are not enabled yet: legacy project commands refuse with
`E_NATIVE_PROJECT_UNSUPPORTED`. If active `.hack/` or `.dev/` Compose, JSON or TOML
inputs also exist, they refuse with `E_NATIVE_PROJECT_CONFLICT`. The marker still
blocks fallback when malformed, a future version, a directory or a dangling link.
Filesystem inspection failures also refuse. Generated internal files, branch files,
backups and a root-level Compose file are not competing authored Hack inputs.

Discovery never crosses a native boundary to select an ancestor Compose project.
Registered name/ID lookup checks the stored root directly. Project listing marks
blocked registered entries `unavailable`, includes `input_diagnostic`, and continues
listing other entries without parsing the blocked legacy configuration. Global
configuration and explicit offline validation remain available. Init, legacy env
repair, config writes and domain migration/rollback refuse before modifying native
input; a refused rollback preserves its recovery journal. Selection is checked
again at mutation boundaries, but this is not atomic protection against concurrent
external edits. Locked adoption belongs to a later integration step.
`hack env get` retains its fixed redacted failure message and empty stdout.

The standalone `packages/config-compiler` Rust package has no dependency on the
native runtime, virtualization, Docker, or platform provider APIs. It uses the
repository's pinned Rust 1.97.1 and committed Cargo lockfile when building. The
compiled executable requires no host Rust installation, network, or VM.

Standalone Unix release archives contain the matching host `hack-config-compiler`
beside `hack` for Linux x86-64/arm64 and macOS arm64/x86-64. Normal and slim release
installers copy it into the same bin directory as `hack` or `hack-real`. Both native
schemas, `hack.project.schema.json` and `hack.local.schema.json`, ship under
`assets/schemas` and install with the other schemas under `HACK_INSTALL_ASSETS`
(default `~/.hack/assets`). Legacy project schemas and installer behavior remain
available. This packaging does not change the opt-in native candidate channel or
enable native workload execution.

The CLI uses the adjacent compiler and checks its protocol before validation or
planning. An unavailable compiler refuses with `E_COMPILER_MISSING`; an incompatible
protocol refuses with `E_COMPILER_VERSION`. It never downloads a compiler or searches
`PATH`. `HACK_CONFIG_COMPILER_BINARY` is an explicit absolute-path override for a
reviewed compiler; ordinary standalone installations need no override. Keep the
compiled CLI and compiler together when relocating executables. The slim shell
wrapper retains its configured absolute installation path.

## Supported authored core

`schema_version` must be `1`; `name` is required. Services, jobs, storage, profiles
and project environment selection default to empty. Source defaults to
`{"root":".","mode":"host-mounted"}`. Unknown fields, explicit nulls and unsupported
versions refuse; omitted fields retain their documented defaults.

```json
{
  "schema_version": 1,
  "name": "example",
  "services": {
    "web": {
      "image": "example/web:1",
      "pull_policy": "missing",
      "command": { "exec": ["web", "--port", "3000"] },
      "entrypoint": { "exec": [] },
      "init": true,
      "shutdown": { "signal": "SIGTERM", "grace": "45s" },
      "restart": { "kind": "on-failure", "max_retries": 3 },
      "working_directory": "/app",
      "mounts": [{ "source": ".", "target": "/app", "access": "read-only" }],
      "environment": { "TOKEN": { "env_ref": "TOKEN" } }
    }
  }
}
```

- Each workload selects exactly one `image` or `build`. Basic build accepts a
  relative `context`, a relative `dockerfile` (default `Dockerfile`) and optional
  `target`. Advanced build settings are not accepted in this slice.
- Optional `pull_policy` is a canonical string: image-only workloads accept
  `always`, `never` or `missing`; build-only workloads accept `build`. The names
  follow [Compose's pull policies](https://docs.docker.com/reference/compose-file/services/#pull_policy):
  registry refresh, cached image only, cache-or-pull, or rebuilding the declared
  source, respectively. This initial format keeps image and build mutually
  exclusive. It rejects explicit null, `if_not_present`, timed policies such as
  `daily`, `weekly` or `every_12h`, and other values. Inactive workloads are still
  validated. Omission stays absent in the normalized plan and preserves earlier
  plan hashes; the compiler does not invent an acquisition default.
- Acquisition policy is intent only. Validation and metadata planning do not
  inspect an image cache, contact a registry, build an image or authenticate a
  registry. Backend lowering and execution must qualify details such as Compose's
  special handling of the `latest` tag under `missing`. Local settings cannot
  inject workload acquisition policies. `acquisition_plan_version: 1` is required
  before sending authored policies to a compiler, including inactive policies.
  Successful replies are checked against the original project identity, selected
  workload namespace, image/build kind, image value and exact policy presence/value.
  This acquisition check does not authenticate every normalized build field; Rust
  retains ownership of build validation and path normalization.
- Omitted command preserves image defaults. `{ "exec": ["program", "argument"] }`
  and `{ "shell": "explicit shell source" }` are distinct. Empty commands and NUL
  bytes refuse. Argument order is preserved.
- Optional `entrypoint` uses the same explicit `exec` or `shell` tags. Its
  `{ "exec": [] }` form clears the image entrypoint; an empty `command.exec`
  still refuses. A nonempty argv needs a nonempty executable. Omission preserves
  image defaults. Optional `init` is a strict boolean; explicit false stays false.
- Optional `shutdown` has `signal`, `grace`, or both. Signals use the 31 canonical
  `SIG`-prefixed Linux names enumerated in the schema; aliases, numeric
  signals and realtime signal tokens refuse. Grace is a positive integer in
  `ms`, `s`, `m` or `h`, normalized to milliseconds up to 4,294,967,295 ms.
  Empty objects, nulls and unknown fields refuse. Omitted signal/grace remains
  omitted rather than guessing an image default.
- Optional `restart` is `{ "kind": "no" }`, `{ "kind": "always" }`,
  `{ "kind": "unless-stopped" }` or `{ "kind": "on-failure" }`. Only
  `on-failure` accepts `max_retries`, a positive integer up to 4,294,967,295.
  Jobs reject `always` and `unless-stopped`, including inactive jobs, to preserve
  their successful-exit completion contract. Omitted restart means no automatic
  restart without adding a serialized default to the plan.
- These process fields are validated intent. Backend signal support, entrypoint
  clearing, init behavior, restart execution and shutdown precision require
  separate runtime qualification. Planning accepts grace values above 30 seconds;
  an existing backend admission limit is not an authored-format restriction.
  Local settings cannot supply workload process definitions. All four fields
  remain absent when omitted, preserving existing plans and hashes. Compiler
  protocol capability `process_plan_version: 1` is required when authored process
  settings are present, even when the workload is inactive.
- Mounts select exactly one relative `source` or declared `storage`, an absolute
  container `target` and explicit `access`: `read-only` or `read-write`. Targets
  must be unique after lexical normalization. Mount order is preserved.
- Declared storage currently accepts only `kind: persistent`, `scope: worktree`.
  This is a symbolic resource declaration; it grants no creation or deletion
  authority. Cache, shared and external storage remain unsupported.
- Environment values use exactly one of `{literal:"public text"}`,
  `{default:"public fallback"}`, `{env_ref:"KEY"}` or `{unset:true}`. Empty strings
  are valid. `unset:false`, bare values, nulls and combined tags refuse. Variable
  destination names match `[A-Za-z_][A-Za-z0-9_]*`; managed `env_ref` names match
  the owning store's `[A-Z_][A-Z0-9_]*`. Public literals are authored configuration;
  never copy secrets into them. The compiler never reads managed stores or process
  environment. Required references stay symbolic during validation. Explicit
  metadata planning checks managed-layer selection, missing keys and remapping
  collisions; secret delivery and runtime admission remain separate steps.
- Project `environment.default_overlay` may select a canonical named overlay;
  omission selects base. Names must already match `[a-z0-9]+(?:-[a-z0-9]+)*`;
  noncanonical spellings refuse rather than selecting a normalized different name.
  Project null refuses; null is supported only in local settings and explicit
  command selection.
- Project `worktree.auto_branch` and `worktree.inherit_local` are strict booleans,
  both defaulting to true. They appear in the normalized plan. This validation
  command uses inheritance policy and previews the verified linked-worktree branch
  namespace for routing. It does not create branch instances.
- Dependencies are `{service:"db",condition:"started"|"ready"}` or
  `{job:"init",condition:"completed"}`. References must match the declared kind.
  Ready dependencies require explicit readiness. Services and jobs share one name
  namespace. Duplicate edges and cycles refuse, including in disabled workloads.
- Readiness accepts tagged `exec`, `http` and `tcp` definitions. Exec adds
  `command`; HTTP adds `port` and an absolute `path`; TCP adds `port`. All require
  `interval`, `timeout` and positive `retries`. Durations are positive integer
  `ms`, `s`, `m` or `h`, normalized to millisecond strings up to 4,294,967,295 ms.
  Port range is 1–65,535. Preserving a check does not promise backend enforcement.
- Root `profiles:["dev"]` declares profiles. A workload's `profiles:["dev"]`
  assigns membership. Unprofiled workloads are enabled by default; explicit
  selections enable matching workloads. Unknown selections and dependencies from
  enabled workloads onto disabled workloads refuse. Profiles do not automatically
  enable dependencies or hide invalid authored definitions.

Project, workload, storage, build target and profile names are canonical lowercase
ASCII letters/digits followed by letters/digits, `.`, `_` or `-`, at most 63 bytes.
Names and profile lists must be unique in their applicable namespace. Relative
paths use POSIX syntax, stay project-relative, and reject absolute paths, `..`,
backslashes and drive syntax. Lexical `.` and repeated separators normalize; no
filesystem or symlink resolution occurs. Working directories and mount targets
must be absolute POSIX container paths without `..`.

Network/security/resources, cache protocols, advanced build options, backend options, arbitrary extensions,
and other local settings are not yet implemented. They refuse rather than being
silently dropped. This foundation does not replace the full native contract or
qualify a migrated advanced project.

## Routing and domain previews

Optional `routes` declares project origins, aliases and named HTTP routes:

```json
{
  "schema_version": 1,
  "name": "example",
  "services": { "web": { "image": "example/web:1" } },
  "routes": {
    "domain": "hack.local",
    "aliases": { "oauth": { "domain": "hack.gy" } },
    "oauth_alias": "oauth",
    "http": {
      "web": { "service": "web", "port": 3000, "hostname": "project" }
    }
  },
  "open": { "prefer": "auto" }
}
```

`routes.domain` is a canonical lowercase DNS suffix. The effective suffix is
explicit `--domain`, checkout local, inherited verified primary local, project,
global `default_domain`, then `hack.local`, in that order. A global domain is
read as one scalar from a bounded regular config file; private global fields are
not sent to the compiler. Invalid or redirected policy files refuse.

Generated origins are `https://[branch.]NAME.SUFFIX`. Branch names are derived
from a verified linked Git worktree and normalized with the existing branch
namespace rules. Primary checkouts, non-Git projects, CI, slim mode and
`worktree.auto_branch:false` omit that namespace. Detached linked worktrees refuse
when a branch is required. `inherit_local:false` disables primary settings without
disabling branch isolation.

`routes.origin` pins an explicit HTTP(S) project origin. An alias selects exactly
one `domain` or `origin`; generated domain aliases follow the same branch namespace,
while explicit origins remain pinned. Origins normalize scheme/host case and
default ports. Credentials, paths (including `/`), queries, fragments, wildcards,
ambiguous numeric hosts and invalid ports refuse. Canonical loopback IPv4, bracketed
IPv6 and `localhost` are allowed. Generated names must be valid DNS labels.

Each `routes.http` entry requires a declared **service**, a port in 1–65,535 and
`hostname`: `project` uses the base origin; another canonical relative DNS name
prefixes each project/alias hostname. IP origins cannot be prefixed. Upstream
`protocol` defaults to `http`; it is separate from the browser origin's scheme.
Unknown services, job targets, duplicate origins and expanded route/alias collisions
refuse, including in inactive declarations. Inactive routes stay in the portable
plan but are omitted from the selected routing report. Expansion is bounded before
allocation and charged to the shared planning output budget.

`open.prefer` accepts `auto` (default), `alias` or `dev`. `auto` selects the
explicit `routes.oauth_alias` when present, otherwise the project origin; `alias`
requires that selection; `dev` selects the project origin. Alias names have no
implicit OAuth meaning. Local `open.prefer` overrides inherited/project settings.
`hack.local` remains the development default; an OAuth provider that requires a
public suffix can use an explicitly selected `hack.gy` or custom-domain alias.
Provider registration and browser acceptance are separate checks.

Project-aware `config validate` and `config plan` return `routing_resolution` with
the selected domain and provenance, project/alias origins, branch namespace, open
choice and selected routes. The CLI cross-checks the report against authored
declarations and request context. Routing changes affect the local resolution hash;
local policy never rewrites the authored semantic hash. This is offline planning:
it does not configure DNS, trust certificates, run hooks, bind ports or admit a
runtime. Execution remains a later integration step.

## Endpoint references and host bindings

Environment destinations can reference a route, service or logical host binding:

```json
{
  "API": { "endpoint": { "kind": "service", "name": "api", "port": 3000, "protocol": "http" } },
  "APP_ORIGIN": { "endpoint": { "kind": "route", "name": "web" } },
  "SEARCH": { "endpoint": { "kind": "host_binding", "name": "search" } }
}
```

Service references require a declared service, a port from 1 to 65,535 and an
explicit `http`, `https` or `tcp` protocol. Jobs cannot be service targets. Route
references name an entry in `routes.http`. Unknown references and active consumers
of inactive service targets refuse; disabled declarations still receive static
validation. A route endpoint uses the selected origin from `routing_resolution`.
The port and protocol of a direct service endpoint remain typed rather than being
turned into a guessed URL or credentials-bearing connection string.

Optional project `host_bindings` declares targets in a separate logical namespace:

```json
{
  "host_bindings": {
    "search": { "kind": "host", "port": 9200, "protocol": "http" },
    "remote": { "kind": "external", "hostname": "search.example.com", "port": 443, "protocol": "https" }
  }
}
```

`host` identifies an endpoint on the machine running the project. Its report
retains `context:"host"` or `context:"workload"`; an execution backend must choose
the appropriate loopback or guest-to-host address. `external` preserves a validated
hostname, port and protocol. Neither definition starts a tunnel, grants ownership
of a process, probes connectivity or configures DNS. Commands, credentials,
resource IDs and source paths are not binding targets. External hostnames cannot
contain credentials, schemes, ports, paths, queries or fragments.

Local `host_bindings` merges by logical name: project, inherited verified primary,
then checkout. A local `null` removes that binding; a later target restores it.
There is no recursive patch or command injection. Actual resolution reports
`host_binding_resolution:{bindings:{NAME:{target,origin}},removed:{NAME:origin}}`,
where `origin` is `project`, `primary_local` or `checkout_local`.
Context-free `--file` validation keeps local-only binding references symbolic.
Project-aware validation rejects missing or removed referenced bindings before
reading managed environment documents. CI, slim and inheritance opt-out rules
apply to binding inheritance just as they do to other local settings.

`config plan` returns endpoint bindings as
`{kind:"endpoint",reference:{...},target:{...}}`. An existing managed key at the
destination produces `env_endpoint_collision`, keeps the managed binding intact,
and makes the plan incomplete with exit 1. Endpoint and unset tags cannot share
an entry. A direct service endpoint in a host invocation produces
`unsupported_endpoint_context` rather than assuming guest DNS works on the host.
This is a planning refusal, not a failure to launch a process.

Endpoint support requires the sidecar's `endpoint_plan_version:1` capability.
Consumers validate report targets against their authored references and existing
routing/binding reports. Authored identity includes project binding declarations;
local binding selection affects only resolution identity. The shared output budget
covers expanded binding reports and endpoint entries. No managed values, ciphertext,
keys or host paths enter these reports. Late hook-produced bindings and runtime
address delivery still require separate execution and generation-fence work.

## Host declarations

The optional `host` namespace declares ordered lifecycle hooks and named processes:

```json
{
  "schema_version": 1,
  "name": "example",
  "services": { "web": { "image": "example/web:1" } },
  "host": {
    "up": {
      "before": [{
        "name": "prepare",
        "command": { "exec": ["./scripts/prepare"] },
        "cwd": "."
      }]
    },
    "processes": {
      "tunnel": {
        "command": { "shell": "./scripts/tunnel" },
        "env_target": { "kind": "workload", "name": "web" },
        "environment": { "TOKEN": { "env_ref": "TOKEN" } }
      }
    }
  }
}
```

`host.up` and `host.down` accept `before`/`after` arrays. Each hook requires a
canonical `name` and explicit `command`; array order is preserved. `host.processes`
is a map of canonical names to process declarations with required commands. Names
must be unique across all hooks and processes, in a namespace separate from
services/jobs. Commands use the same explicit exec/shell forms as workloads.
`cwd` defaults to `.` and is lexically normalized relative to the project checkout,
not `source.root`, `.hack` or the caller's working directory. No filesystem lookup
or process execution occurs.

A process's `startup` defaults to `up` and `exit` to `stop_on_down`; these are the
only supported values in this slice. They preserve lifecycle intent in the plan,
without enabling a controller. Optional process `singleton` requires nonempty,
unique ports in 1–65,535, normalized as a sorted set, and `on_conflict` of `fail`
(default) or `adopt`. Adoption still requires the existing lifecycle owner's
ownership proof at execution. Hook singleton settings, restart/readiness policies
and additional startup/exit policies currently refuse.

Each hook/process has `env_target` of `{kind:"host"}` (the omitted default) or
`{kind:"workload",name:"declared-service-or-job"}`. An explicit workload target may
name an inactive declaration; it selects env ownership and does not enable that
workload. Matching host and workload names confers no implicit env scope. Unknown
targets and per-reference scope overrides refuse. Each entry's `environment`
accepts the same literal/default/env_ref/unset directives as workloads. There is
no per-process managed store scope. Local settings cannot inject host commands.

The compiler omits an empty host namespace from the normalized plan; hostless
plans keep their existing serialized identity. Validation preserves symbolic refs
without reading managed files. Explicit planning checks each host entry against
its selected owner's immutable baseline. Generic host selection uses global plus
host overrides; a workload target uses global plus that workload plus host
overrides, with the existing layer-first precedence. If any declared workload is
named `host`, including an inactive service/job, that scope belongs to the workload:
generic selection then uses global only and other workload targets receive no
generic host override. All target maps share the bounded metadata budget.

The environment report adds `host:{NAME:{env_target,bindings}}`, separate from its
`workloads` map. Required refs and remapping collisions report the original host
declaration pointer. No managed values or ciphertext enter the report or either
portable identity. This is offline planning; execution, post-hook generation
checks, secret delivery and locked adoption remain later integration work.

## Protocol and diagnostics

The CLI supports project-aware and explicit-document validation:

```sh
hack config validate --json
hack config validate --path /path/to/native-project --env base --json
hack config validate --domain hack.gy --json
hack config validate --file .hack/hack.project.json
hack config validate --file .hack/hack.project.json --profile dev,test --json
```

Without `--file`, discovery selects a native project without touching the registry.
Legacy or absent projects refuse; mixed active inputs refuse with
`E_NATIVE_PROJECT_CONFLICT`. `--path` changes the discovery start. `--env base`
explicitly selects base; another canonical name selects that overlay. This selects
a name only: overlay existence, managed metadata, keys and required references are
not inspected, and no env values are read. Runtime/adoption commands remain fenced.

`--file` validates only that document, ignores local/global policy files and performs
no project discovery or origin resolution. It cannot be combined with `--path`,
`--env` or `--domain`.
`--json` returns the authored normalized plan, including
authored public literals and commands. Those values are intentionally visible;
diagnostic redaction does not turn the plan into a secret-safe storage format.

- `hack-config-compiler --protocol` emits
  `{"transport_version":1,"authored_version":1,"plan_version":1,"resolve_version":1,"local_version":1,"env_plan_version":1,"host_env_plan_version":1,"routing_plan_version":1}`.
  Project-aware validation requires local resolution capabilities; explicit
  metadata planning additionally requires `env_plan_version:1`. Older matching
  compilers can still serve their supported validation modes.
  Host planning requires `host_env_plan_version:1` before acquiring host metadata;
  hostless env-plan-v1 compilers remain supported.
  Typed routing and policy resolution require `routing_plan_version:1`; unchanged
  non-routing calls remain compatible with older matching compilers.
- `hack-config-compiler compile [--profile NAME]...` reads one UTF-8 JSON document
  from stdin through EOF. Input is limited to 1 MiB and 64 nested containers. These
  are parser safety bounds, not container resource or workload-count limits.
- Success exits 0 and emits `{transport_version:1,ok:true,plan,semantic_hash,declared_workloads}`.
  The plan declares `plan_version:1`. Failure exits 1 and emits
  `{transport_version:1,ok:false,diagnostics:[...]}`. One deterministic first
  diagnostic contains a stable code, fixed redacted message, JSON pointer and
  one-based line/byte-column. Semantic errors use the nearest authored value's
  location; errors for a missing property or CLI-selected profile may point to its
  containing object. Input contents and parser excerpts never appear in messages.
  Host declarations additionally produce `host_env_targets:{include_default,
  workloads:[...]}`, a names-only owner selection derived in Rust. It is separate
  from the authored identity and includes explicit targets from inactive workloads.
- Invalid invocation exits 2 with fixed usage on stderr and no JSON on stdout.
- `hack-config-compiler resolve [--profile NAME]...` reads a versioned request:
  `{request_version:1,project:"original JSON text",primary_local?:"original JSON text",checkout_local?:"original JSON text",explicit_overlay?:null|string,global_domain?:string,explicit_domain?:string,branch?:string}`.
  JSON texts retain duplicate keys until Rust checks each document. Each document
  is limited to 1 MiB, their combined text to 3 MiB, and the encoded request to
  20 MiB to allow JSON escaping. Diagnostics add `document` identifying `project`,
  `primary_local`, `checkout_local` or `request`.
  A routing-v1 compiler also accepts `routing_probe:true` on `resolve` only.
  This validates authored/local policy and returns `routing_inputs_required:true`
  when routing context is needed, without deriving provisional origins. The CLI
  then acquires verified global/branch inputs and sends an ordinary resolve.
  The probe is not part of the resolution hash and is never a final plan. Old
  non-routing compilers receive no probe flag.
- `hack-config-compiler generate DIR` writes deterministic
  `hack.project.schema.json`, `hack.local.schema.json` (2020-12) and
  `native-config.ts` projections.

## Explicit managed-env metadata planning

```sh
hack config plan --json
hack config plan --path /path/to/native-project --env qa --profile dev --json
hack config plan --env base
hack config plan --domain hack.gy --json
```

This project-aware command uses the same validated local selection as `config
validate`, then asks the existing managed-env owner for effective key names,
winning scopes and secret flags. It parses selected managed YAML files internally;
it does not read the secret key, decrypt values, run hooks, touch the registry or
start workloads. `config validate` continues to perform no managed-document reads.
`config plan` has no `--file` mode.

The owner merges tracked base/overlay, verified primary local base/overlay and
current checkout local base/overlay in that order. Later layers win before scope
precedence is applied. Null tombstones remove a key; an empty string is present.
CI, slim mode and `inherit_local:false` exclude primary inheritance. Unreadable,
redirected or invalid selected files refuse with fixed redacted errors. Missing
optional files are allowed. A missing selected named overlay keeps base/local
fallback and produces `missing_overlay`; unknown stored scopes produce
`inactive_env_scope` and grant no target authority. Services and jobs, including
inactive declarations, share one namespace. A workload named `host` owns that
scope; generic host overrides are otherwise excluded from guest bindings.

The Rust planner binds `env_ref` against each workload's immutable managed baseline,
before authored directives. Literals replace bindings, defaults apply only when
the destination is absent, and unset removes it. Remapping into a different
already-bound managed destination refuses with `env_reference_collision`.
Unresolved required refs produce `missing_env_reference`. These failures yield
`ok:true`, `environment_plan.complete:false` and exit 1; a complete report exits 0.
Malformed inputs yield `ok:false` and exit 1.

The report contains symbolic managed bindings and authored public literal/default
text, never managed values, ciphertext, key material or private file paths. It
leaves the authored `semantic_hash` and local `resolution_hash` unchanged. This is
binding completeness, not runtime admission, secret delivery or an atomic snapshot.

The internal native-selected value API shares the managed-env owner's layer
selection and declared-workload/requested-host scope rules. It supplies private
values through the existing key and decryption owner, never creates keys on reads,
and bounds file acquisition and returned values. These values must stay out of
compiler metadata, plans, reports and diagnostics. This API does not provide an
atomic admission or freshness fence, and its tests do not establish execution
acceptance.

Private execution acquisition can bind metadata and later value delivery to the
same acquired layer bytes. Its non-enumerable methods retain a private revision
and recheck exact selection, selected roots, raw bytes and missing-file presence
before and after decryption. Callers must recheck again immediately before each
effect with the current validated selection. No revision or secret-derived hash
enters compiler reports or public plans. Rechecking does not freeze external
editors or establish runtime execution acceptance.

The sidecar `plan` operation accepts the original `resolve` request fields plus
`env_metadata:{metadata_version:1,overlay:null|string,overlay_exists:boolean,
workloads:{NAME:{KEY:{scope:string,secret:boolean}}},inactive_scopes:string[]}`.
Every declared workload must appear, including inactive ones. Unknown fields,
target names, invalid scopes and mismatched selections refuse. Serialized metadata
is limited to 1 MiB in addition to the existing document and encoded-request bounds.
For host declarations, metadata additionally includes
`host:{default?:{KEY:{scope,secret}},workloads:{TARGET:{KEY:{scope,secret}}}}`.
The default map is present exactly when requested, and workload maps exactly match
`host_env_targets.workloads`, including empty maps. Extra target authority refuses.
The compiler shares an 8 MiB output safety budget across the complete planning
envelope. It charges symbolic baselines before cloning them for each invocation,
plus authored directives and diagnostics before report growth. Accounting is
conservative and does not refund overwritten or removed entries. Oversized
expansion refuses with a fixed `plan_too_large` diagnostic at the original project
pointer. This bounds report memory; it does not cap project resources or workload
counts.

## Local settings and worktrees

The optional `.hack/hack.local.json` is a separate versioned document:

```json
{"schema_version":1,"environment":{"default_overlay":null}}
```

Local settings permit `environment.default_overlay`, `routes.domain`,
`open.prefer` and `host_bindings`. Omission inherits; overlay null selects base,
binding null removes a logical target, while domain/open null
refuses. A canonical overlay name selects that overlay. Other fields, workload
definitions, unversioned documents, duplicate keys and unknown versions refuse.
The effective selection is project default/base, then verified primary local,
current checkout local, then explicit `--env`. Each later present value wins.

Primary inheritance requires a verified linked Git worktree in the same repository
family and a primary checkout with native inputs. Different input families refuse;
redirected/nonregular input files refuse. `inherit_local:false`, CI and slim mode
exclude primary reads. Current checkout local settings remain available. Files are
read in place; no primary files, secrets, keys or generated state are copied.
Native projects nested below a Git checkout root currently use only their own
local settings; primary inheritance requires the project root to be the Git root.

Success adds `local_resolution` with selected `overlay` (null means base), `origin`,
worktree policy and `resolution_hash`. Local settings do not rewrite the authored
plan or its `semantic_hash`. The separate hash binds normalized supplied local
documents, supplied routing context and explicit selection, including missing
versus null. Neither hash
proves an atomic multi-file snapshot or provides an admission/freshness fence.
Future apply must recheck private input generations. Adding defaulted worktree
policy changes hashes relative to the earlier experimental compiler; do not reuse
historical compiler hashes as resource identities.

Duplicate keys, including escaped-equivalent keys in nested objects and arrays,
are rejected before map insertion. Graph cycle checking is iterative. Serialization
orders object keys, profile sets and dependency sets deterministically, materializes
defaults, normalizes portable paths and durations, and preserves semantic command
and mount order. `semantic_hash` is lowercase SHA-256 of the serialized normalized
plan; it contains no managed secret values, ciphertext or host admission metadata.
It is not a freshness fence, artifact signature or resource identity.

The JSON Schema and DTOs describe wire shape. Rust additionally enforces names,
paths, dependencies, cycles, profiles and other contextual rules. The shared shape
corpus is `packages/config-compiler/tests/fixtures/schema-corpus.json`; semantic
negative cases live in Rust tests. TypeScript types cannot enforce runtime limits
or reject extra properties supplied through untyped inputs.

## Development checks

```sh
bun run build:config-compiler
bun run build:release --skip-tests
bun scripts/check-release-config-compiler.ts dist/release
cargo +1.97.1 fmt --manifest-path packages/config-compiler/Cargo.toml --check
cargo +1.97.1 clippy --locked --manifest-path packages/config-compiler/Cargo.toml --all-targets -- -D warnings
cargo +1.97.1 test --locked --manifest-path packages/config-compiler/Cargo.toml
```

Release assembly requires pinned Rust at build time and verifies projections against
a fresh `generate` run before packaging. The release acceptance script verifies
checksums with the host SHA-256 tool, runs the generated normal/slim download and
install scripts against local archives, and exercises the installed and relocated
compiled executables with no Bun/Rust/VM tools on the CLI's PATH. macOS uses a network
sandbox; Linux requires noninteractive sudo for an isolated network namespace and
drops back to the invoking user before running the fixture. A live loopback canary
checks network denial. Validation, metadata planning, missing/mismatch refusal,
ignored PATH compilers and legacy config reads are separate assertions. CI runs
this gate on all four release host architectures. Hosted CI and published artifact
results still need their own evidence; unit tests alone do not establish them.
