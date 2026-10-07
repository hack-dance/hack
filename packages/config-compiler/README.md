# Pure native configuration compiler

This standalone package validates an experimental subset of native Hack project
configuration. It performs no discovery, file acquisition, runtime admission,
decryption, process execution, or host-path resolution. The CLI owns acquisition
of verified document bytes. See the public
[compiler reference](../../docs/reference/native-config-compiler.md) for the
supported project grammar and remaining execution boundaries.

## Local resolution protocol

`hack-config-compiler --protocol` advertises `transport_version`,
`authored_version`, `plan_version`, `resolve_version`, and `local_version`, all `1`.
Existing `compile [--profile NAME]...` remains context-free. The new
`resolve [--profile NAME]...` operation accepts one UTF-8 JSON request on stdin:

```json
{
  "request_version": 1,
  "project": "{\"schema_version\":1,\"name\":\"example\"}",
  "primary_local": "{\"schema_version\":1}",
  "checkout_local": "{\"schema_version\":1,\"environment\":{\"default_overlay\":\"qa\"}}",
  "explicit_overlay": null
}
```

`project` is required; the remaining document fields and `explicit_overlay` are
optional. Embedded documents are original JSON text, not pre-parsed objects.
Recursive duplicate keys, unknown fields, unsupported versions, and invalid shapes
are rejected. Each document is limited to 1 MiB, their combined decoded size to
3 MiB, and the encoded request to 20 MiB. All JSON parsing has a depth budget of 64.
These are parser resource bounds, not runtime workload limits.

A local document permits only `schema_version: 1` and optional `environment`,
which permits only `default_overlay`. Omission inherits, `null` selects base,
and a string selects a canonical overlay matching `[a-z0-9]+(?:-[a-z0-9]+)*`.
No normalization silently changes names.

The project supports optional `worktree` with strict boolean `auto_branch` and
`inherit_local`, each defaulting to `true`. Resolution applies the project overlay,
then primary local when inheritance is enabled, then checkout local, then an
explicit selection. Every supplied local document is validated, even a primary
ignored by `inherit_local: false`. The compiler reports policy; it does not create
branches or read Git metadata.

Successful output contains `transport_version: 1`, `ok: true`, the authored `plan`
and `semantic_hash`, plus `local_resolution` with `overlay`, `origin`,
`auto_branch`, `inherit_local`, and `resolution_hash`. Origin is `project`,
`primary_local`, `checkout_local`, or `explicit`. Locals never alter the authored
plan or its semantic hash. The resolution hash binds the authored hash, normalized
supplied locals (including shadowed or opted-out primary input), and explicit
selection presence/value. Formatting and key order do not affect either hash;
changing a permitted local selection affects the resolution hash even when another
layer shadows it. Host acquisition paths and decrypted secrets never enter this resolver. Authored
literal environment values remain explicit public plan data, just as in compile.

The normalized plan now materializes defaulted `worktree` policy, so authored
hashes from the earlier experimental compiler change. `plan_version: 1` remains
experimental; this package does not promise compatibility with cached plans from
the earlier prototype.

Failures exit `1` and return `ok: false` with diagnostics containing `document`
(`project`, `primary_local`, `checkout_local`, or `request`) and fixed `code`,
`message`, JSON `pointer`, `line`, and `column`. Values and parser error text are
not echoed. Pointers necessarily include authored key names; consumers must quote
or escape them for terminal display. Unsupported command arguments exit `2` with
fixed usage text on stderr. Success exits `0`.

## Generated contracts and checks

`generate <dir>` emits deterministic `hack.project.schema.json`,
`hack.local.schema.json`, and `native-config.ts` from Rust types. The schemas use
JSON Schema 2020-12. The shared project/local shape corpora are consumed by Rust
acceptance tests and the independent schema validator; graph semantic validation
remains separate from structural schema acceptance.

Use Rust 1.97.1 with the locked dependencies. From the repository root:

```sh
cargo +1.97.1 fmt --manifest-path packages/config-compiler/Cargo.toml --check
cargo +1.97.1 clippy --locked --manifest-path packages/config-compiler/Cargo.toml --all-targets -- -D warnings
cargo +1.97.1 test --locked --manifest-path packages/config-compiler/Cargo.toml
```

## Metadata-only environment planning

`compile` and `resolve` return a separate `declared_workloads` map from every
validated service/job name to `service` or `job`, including inactive profiles.
This projection does not change the authored plan or semantic hash. Consumers use
it to ask the existing environment owner for effective metadata without parsing
authored project JSON themselves.

The protocol advertises `env_plan_version: 1`. `plan [--profile NAME]...` accepts
the resolve request fields plus required `env_metadata`:

```json
{
  "metadata_version": 1,
  "overlay": null,
  "overlay_exists": false,
  "workloads": {
    "web": { "TOKEN": { "scope": "global", "secret": true } }
  },
  "inactive_scopes": []
}
```

`overlay` is required and nullable. It must equal the resolved selection; base
uses `overlay_exists: false`. Metadata must include exactly the complete declared
workload namespace. Each winning scope must be `global` or that owning workload;
managed key names use `[A-Z_][A-Z0-9_]*`. A workload named `host` owns its own
metadata; it does not grant generic host scope to other workloads. Inactive scopes
must be distinct valid stored scope names outside the declared namespace, excluding
reserved `global` and `host`. All supplied metadata is validated, including inactive
workloads. Unknown fields, arrays used as objects, and duplicates refuse. The JSON
serialization of metadata is limited to 1 MiB, in addition to the existing document
and encoded-request bounds. Managed values, ciphertext and paths are unsupported.

Successful parsing returns `ok: true` and the unchanged plan, semantic hash, local
resolution and declared namespace, plus `environment_plan`. That object contains
`plan_version: 1`, selection metadata, `complete`, selected `workloads`, `warnings`
and `diagnostics`. Bindings have one of three forms:

- `managed`: symbolic `key`, winning `scope`, and `secret` flag;
- `literal`: the explicit public authored `value`;
- `default`: the explicit public fallback `value` used when no baseline key exists.

Managed baseline presence includes an empty managed value. `unset` removes a
binding. References always read the immutable owning baseline before authored
changes; a literal cannot create a reference source, nor can unset remove one.
Same-key references are allowed. A reference remapped onto a different existing
managed destination produces `env_reference_collision`; a missing source produces
`missing_env_reference`. Both make `complete: false`. Only selected workloads
contribute binding diagnostics. Missing selected overlays and inactive scopes emit
visible fixed warnings without authorizing new targets or suppressing missing refs.
Binding diagnostics use original project pointers and positions, without managed
values. Missing-overlay warnings identify the document that supplied the winning
selection: project, primary local, checkout local, or explicit request, preserving
that document’s pointer and line/column.

The process exits `1` for incomplete bindings even when `ok: true`, and `0` only
for a complete metadata plan. Completeness is not runtime admission: this operation
cannot decrypt, verify secret availability, apply config, run hooks, or start a
workload. No metadata-derived or secret-derived hash is added to the portable plan.
