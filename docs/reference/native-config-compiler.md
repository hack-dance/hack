# Native config compiler foundation

This is an experimental, pure compiler for a bounded subset of the planned
`.hack/hack.project.json` format. It does not discover projects, execute workloads,
import Compose, migrate data, decrypt environment values, perform host admission,
or change how existing projects run. A successful compile is syntax and semantic
validation, not backend capability or application acceptance.

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
  environment. Required references stay symbolic; managed-layer selection, missing
  keys, remapping collisions and secret delivery remain later owner/admission checks.
- Project `environment.default_overlay` may select a canonical named overlay;
  omission selects base. Names must already match `[a-z0-9]+(?:-[a-z0-9]+)*`;
  noncanonical spellings refuse rather than selecting a normalized different name.
  Local override files are not accepted by this compiler.
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
and local/worktree policy are not yet implemented. They refuse rather than being
silently dropped. This foundation does not replace the full native contract or
qualify a migrated advanced project.

## Protocol and diagnostics

The current CLI exposes explicit validation only:

```sh
hack config validate --file .hack/hack.project.json
hack config validate --file .hack/hack.project.json --profile dev,test --json
```

`--file` is required; this command does not switch project discovery or runtime
execution to the native format. `--json` returns the normalized plan, including
authored public literals and commands. Those values are intentionally visible;
diagnostic redaction does not turn the plan into a secret-safe storage format.

- `hack-config-compiler --protocol` emits
  `{"transport_version":1,"authored_version":1,"plan_version":1}`.
- `hack-config-compiler compile [--profile NAME]...` reads one UTF-8 JSON document
  from stdin through EOF. Input is limited to 1 MiB and 64 nested containers. These
  are parser safety bounds, not container resource or workload-count limits.
- Success exits 0 and emits `{transport_version:1,ok:true,plan,semantic_hash}`.
  The plan declares `plan_version:1`. Failure exits 1 and emits
  `{transport_version:1,ok:false,diagnostics:[...]}`. One deterministic first
  diagnostic contains a stable code, fixed redacted message, JSON pointer and
  one-based line/byte-column. Semantic errors use the nearest authored value's
  location; errors for a missing property or CLI-selected profile may point to its
  containing object. Input contents and parser excerpts never appear in messages.
- Invalid invocation exits 2 with fixed usage on stderr and no JSON on stdout.
- `hack-config-compiler generate DIR` writes deterministic
  `hack.project.schema.json` (2020-12) and `native-config.ts` projections.

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
