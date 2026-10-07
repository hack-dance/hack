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
