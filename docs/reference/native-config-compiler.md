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
      "command": { "exec": ["web", "--port", "3000"] },
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
- Omitted command preserves image defaults. `{ "exec": ["program", "argument"] }`
  and `{ "shell": "explicit shell source" }` are distinct. Empty commands and NUL
  bytes refuse. Argument order is preserved.
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
  command uses inheritance policy; it does not create branch instances or execute
  `auto_branch` behavior.
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

Routes, shutdown/restart policies, host hooks/processes, endpoint references,
network/security/resources, cache protocols, backend options, arbitrary extensions,
and local settings other than environment selection are not yet implemented. They refuse rather than being
silently dropped. This foundation does not replace the full native contract or
qualify a migrated advanced project.

## Protocol and diagnostics

The CLI supports project-aware and explicit-document validation:

```sh
hack config validate --json
hack config validate --path /path/to/native-project --env base --json
hack config validate --file .hack/hack.project.json
hack config validate --file .hack/hack.project.json --profile dev,test --json
```

Without `--file`, discovery selects a native project without touching the registry.
Legacy or absent projects refuse; mixed active inputs refuse with
`E_NATIVE_PROJECT_CONFLICT`. `--path` changes the discovery start. `--env base`
explicitly selects base; another canonical name selects that overlay. This selects
a name only: overlay existence, managed metadata, keys and required references are
not inspected, and no env values are read. Runtime/adoption commands remain fenced.

`--file` validates only that document, ignores all local files and performs no
project discovery. It cannot be combined with `--path` or `--env`.
`--json` returns the authored normalized plan, including
authored public literals and commands. Those values are intentionally visible;
diagnostic redaction does not turn the plan into a secret-safe storage format.

- `hack-config-compiler --protocol` emits
  `{"transport_version":1,"authored_version":1,"plan_version":1,"resolve_version":1,"local_version":1,"env_plan_version":1}`.
  Project-aware validation requires local resolution capabilities; explicit
  metadata planning additionally requires `env_plan_version:1`. Older matching
  compilers can still serve their supported validation modes.
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
- Invalid invocation exits 2 with fixed usage on stderr and no JSON on stdout.
- `hack-config-compiler resolve [--profile NAME]...` reads a versioned request:
  `{request_version:1,project:"original JSON text",primary_local?:"original JSON text",checkout_local?:"original JSON text",explicit_overlay?:null|string}`.
  JSON texts retain duplicate keys until Rust checks each document. Each document
  is limited to 1 MiB, their combined text to 3 MiB, and the encoded request to
  20 MiB to allow JSON escaping. Diagnostics add `document` identifying `project`,
  `primary_local`, `checkout_local` or `request`.
- `hack-config-compiler generate DIR` writes deterministic
  `hack.project.schema.json`, `hack.local.schema.json` (2020-12) and
  `native-config.ts` projections.

## Explicit managed-env metadata planning

```sh
hack config plan --json
hack config plan --path /path/to/native-project --env qa --profile dev --json
hack config plan --env base
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

The sidecar `plan` operation accepts the original `resolve` request fields plus
`env_metadata:{metadata_version:1,overlay:null|string,overlay_exists:boolean,
workloads:{NAME:{KEY:{scope:string,secret:boolean}}},inactive_scopes:string[]}`.
Every declared workload must appear, including inactive ones. Unknown fields,
target names, invalid scopes and mismatched selections refuse. Serialized metadata
is limited to 1 MiB in addition to the existing document and encoded-request bounds.

## Local settings and worktrees

The optional `.hack/hack.local.json` is a separate versioned document:

```json
{"schema_version":1,"environment":{"default_overlay":null}}
```

Only `environment.default_overlay` is supported in this slice. Omission inherits;
null selects base; a canonical name selects that overlay. Other fields, workload
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
documents and explicit selection, including missing versus null. Neither hash
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
cargo +1.97.1 fmt --manifest-path packages/config-compiler/Cargo.toml --check
cargo +1.97.1 clippy --locked --manifest-path packages/config-compiler/Cargo.toml --all-targets -- -D warnings
cargo +1.97.1 test --locked --manifest-path packages/config-compiler/Cargo.toml
```

Generated projections must match a fresh `generate` run. Cross-platform packaging,
CLI transport, installed-sidecar checks and schema-validator qualification are
separate integration gates; unit tests alone do not establish them.
