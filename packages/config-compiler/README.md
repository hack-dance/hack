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

A local document permits `schema_version: 1` and optional `environment`,
`routes`, `open`, and `host_bindings`. Environment permits only `default_overlay`. Omission inherits, `null` selects base,
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

## Typed host intent and environment targets

Optional project `host` contains `up` and `down` hooks and named `processes`.
Each hook phase has ordered `before` and `after` arrays. Hooks require a canonical
`name` and explicit `command: {exec: [...]}` or `{shell: "..."}`. Processes use
the map key as their name and require the same command forms. Names must be unique
across all host stages and processes, but occupy a separate namespace from services
and jobs. Hook order is preserved in the plan and semantic hash.

Every hook/process has optional `cwd` (default `.`), `environment` (the existing
tagged directives) and `env_target` (default `{kind: "host"}`). Cwd is relative to
the checkout root, normalized, and cannot escape through `..` or absolute paths.
Explicit `{kind: "workload", name: "declared-service-or-job"}` selects an existing
workload's host environment, including inactive profile declarations. Matching a
host process name to a workload gives no implicit environment scope. Names such as
`global` and `host` remain ordinary identities in the host entry namespace.

Processes support `startup: "up"` and `exit: "stop_on_down"` only, both defaulted.
An optional process `singleton` declares a nonempty unique set of ports 1–65535
and `on_conflict: "fail" | "adopt"` (default `fail`). Port order is normalized.
These declarations are intent only: no process is run, port checked, or process
adopted. A later runtime owner must prove adoption eligibility. Hook singletons,
restart policies, readiness and other unsupported fields refuse.

Normalized host plans materialize defaults. Empty host declarations normalize to
omission and preserve the previous hostless plan and semantic hash. A nonempty host
adds `host_env_targets: {include_default, workloads}` to compile, resolve and plan
success envelopes. This Rust-derived projection has sorted unique workload targets;
it is omitted for hostless projects. Protocol capability `host_env_plan_version: 1`
must be present before requesting host owner metadata.

Environment metadata gains optional `host: {default?, workloads}`. `default` is
required exactly when generic host targeting is requested; `workloads` must contain
exactly the projected target names, with no extra targets. Every map contains only
key names and winning `{scope, secret}` metadata. Generic host accepts global and
generic host scopes; an explicit workload target accepts global, its owning workload
scope, and generic host scope. When a workload named `host` is declared, generic
host override disappears: default accepts only global, and each workload target
accepts only global and its owning name. Inactive workload declarations participate
in this rule. Unknown fields, null objects, arrays and malformed metadata refuse.

`environment_plan.host` maps unique hook/process names to `{env_target, bindings}`
and is omitted when there are no host entries. Host binding shares the immutable
baseline and literal/default/reference/unset rules used for workloads. A generic
host reference cannot read another workload's metadata. Missing-reference and
collision diagnostics retain original project pointers, including ordered hook
indices. Host metadata never enters semantic or resolution hashes. A complete
metadata plan still does not qualify secret delivery, process supervision, singleton
ownership, shutdown, runtime execution or application readiness.

Environment planning enforces a shared 8 MiB serialized-response safety budget.
It reserves portable plan, namespace, local-resolution and envelope space first,
then counts symbolic baseline bytes once per metadata target and charges each
workload/host copy before allocating its binding map. New directives and diagnostics
are charged before insertion. Counting does not allocate a serialized expanded
report. Charges are conservative and are not refunded for overwritten/unset
bindings. This may refuse near-limit reports before their final encoding reaches
8 MiB; refusal is the fixed redacted `plan_too_large` diagnostic at the original
project location. The bound prevents input-to-output amplification and is shared
across workload and host reporting; it is not a process-count or runtime-resource
limit. No metadata-derived hash or managed value is exposed by the budget.


## Typed routing and domain planning

The protocol advertises `routing_plan_version: 1`. Optional project `routes`
contains `domain`, `origin`, named `aliases`, `oauth_alias`, and an `http` map
(default empty). Each HTTP entry requires a declared service, a port from 1–65535,
and `hostname`; `protocol` defaults to `http` and also accepts `https`. Hostname
`project` uses the project origin; other canonical relative DNS labels prefix its
hostname. Jobs cannot receive HTTP routes. All declarations, including inactive
services, are validated before profile filtering. The portable plan retains every
route; the resolved routing report contains only selected services.

An alias has exactly one of `{domain: "example.test"}` or
`{origin: "http://localhost:3000"}`. `oauth_alias` explicitly selects a declared
alias. Optional project `open.prefer` is `auto` (default), `alias`, or `dev`.
`auto` uses the explicitly selected OAuth alias when present, otherwise the project
origin. `alias` without that selection refuses during resolution; `dev` uses the
project origin. This describes navigation intent, not OAuth-provider acceptance.

Local `routes` permits only optional `domain`; local `open` permits only optional
`prefer`. Null is invalid and empty objects inherit. Resolve and plan requests add
optional `global_domain`, `explicit_domain`, and `branch`. Domain precedence is
explicit request, checkout local, inherited primary local, project, global, then
`hack.local`. Open preference precedence is checkout local, inherited primary local,
project, then `auto`. Every supplied document is validated, including shadowed or
opted-out primary settings. Generated project and domain-alias origins are
`https://[branch.]project.domain`; explicit origins are never rewritten. Branch
must be one canonical DNS label. Project names need that DNS grammar only when
used in generated origins.

Domain suffixes use lowercase ASCII DNS labels and require two or more labels,
except the supported `hack` suffix. Decimal or hexadecimal numeric final labels,
underscores, wildcard labels and trailing dots refuse. Relative route hostnames
have their own DNS-label grammar. Explicit origins accept only HTTP or HTTPS,
normalize hostname case and default ports, and permit localhost, strict IPv4 and
bracketed IPv6. Credentials, paths (including `/`), query, fragment, whitespace,
control characters and legacy numeric-IP forms refuse. IPv6 is normalized to
compressed hexadecimal form. A relative route cannot prefix an IP origin.
Duplicate normalized project/alias origins and route expansions refuse, even for
inactive services or projects with no HTTP entries.

Routing becomes active when authored or effective local routing/open settings,
or any domain/branch request input, is present. Successful resolve and plan then
add `routing_resolution`: effective domain and its source, project origin, alias
origins, selected OAuth alias or null, open preference and its source, open origin,
optional branch, and selected route origins with alias expansions. Supplied domain
and branch choices enter the separate resolution hash, not the authored semantic
hash. Existing calls without routing inputs preserve their previous output and
hashes. Empty authored routing/open objects explicitly enable routing defaults.

Resolve alone supports `routing_probe: true` for an acquisition pass. It validates
original documents and static routing references but defers origin expansion and
context-dependent collisions until the caller acquires the global domain and
verified branch. Active routing returns `routing_inputs_required: true` instead
of `routing_resolution`; inactive routing returns neither field. The probe flag
never enters a hash. Plan refuses the probe field, including `false`; a probe is
not a completed routing plan. Consumers must perform the final normal resolution.

Routing expansion counts output space before allocating repeated route/alias
entries, using the same conservative 8 MiB response safety budget as environment
planning. Environment planning reserves the routing report before copying symbolic
bindings. Oversized expansion returns fixed redacted `plan_too_large`; this is an
input-amplification bound, not a runtime route or workload capacity limit. This
package does not register DNS, acquire certificates, bind ports, configure proxies,
open browsers or claim that an origin is reachable.

## Structured endpoints and local host bindings

`endpoint_plan_version: 1` adds one exclusive authored environment form:
`{endpoint: {kind, ...}}`. References are `{kind: "route", name}`, a declared
service `{kind: "service", name, port, protocol}`, or a logical binding
`{kind: "host_binding", name}`. Ports are explicit integers from 1–65535 and
protocol is `http`, `https`, or `tcp`. References accept no credentials, path,
query, command, or arbitrary scope. A route selects its centrally derived project
origin, not its OAuth alias. Services and routes must exist in the authored
namespace and cannot target jobs. Every reference is validated before profile
filtering; an active invocation cannot reference an inactive service or route.

Project `host_bindings` is an optional map from canonical logical names (lowercase
letters/digits, single separating hyphens, at most 63 bytes) to either
`{kind: "host", port, protocol}` or
`{kind: "external", hostname, port, protocol}`. External hostname is literal,
canonical lowercase DNS (including a single label), strict dotted IPv4, or
compressed hexadecimal IPv6 in brackets. It has no authority port, credentials,
path, wildcard, query, fragment, or normalization. Explicit external loopback
addresses retain their meaning in the calling context; they do not imply host
gateway access. Use the typed `host` intent for that purpose.

Local maps merge by logical name: project, verified primary when inheritance is
enabled, then current checkout. Local `null` removes that binding, including an
inherited binding; a later target readds it. Null is not a project target and the
whole map cannot be null. Binding definitions contain no process command, resource
ID, source replacement, or credential. Empty maps explicitly enable binding
reporting. Ignored primary maps are still validated and enter resolution identity.

Context-free compile keeps logical host-binding references symbolic, allowing
local provisioning without tracked host addresses. Actual resolve requires every
referenced binding, including those in inactive invocations, to exist after local
merging. Missing references refuse with `unknown_host_binding`; tombstoned
references refuse with `removed_host_binding` at the removing local document's
original location. The authored plan retains only project definitions. Optional
`host_binding_resolution: {bindings, removed}` reports effective typed targets and
each winning/removing `project`, `primary_local`, or `checkout_local` source.
The probe performs this merge/reference check while deferring routing expansion.

Metadata planning produces `{kind: "endpoint", reference, target}` without a
string `value`. Route targets contain a centrally derived `origin`; direct service
targets remain symbolic `{kind: "service", name, port, protocol}`. Typed host
targets add `context: "host" | "workload"`; they require backend-qualified loopback
or gateway translation during execution. External targets retain the canonical
hostname, port and protocol. Direct service references in host invocations produce
an incomplete `unsupported_endpoint_context` diagnostic and omit the destination,
because guest service names are not host addresses.

Endpoints cannot replace a same-key managed baseline entry: the plan preserves
that managed entry, reports `env_endpoint_collision`, and remains incomplete.
Combining endpoint and unset forms refuses; unsetting another key grants no
replacement permission. Existing remapped managed-reference collision rules stay
unchanged. The shared 8 MiB report budget counts binding reports and every expanded
endpoint before insertion. No new fields alter old hashes or replies when absent.
This compiler does not resolve DNS, execute hooks, start services, or prove endpoint
reachability; native execution and backend translation remain separate work.

## Workload process policy

`process_plan_version: 1` adds optional service/job `entrypoint`, `init`,
`shutdown`, and `restart` fields. Each field preserves omission; the compiler
does not supply a new default or rewrite image behavior. Explicit `init: false`
and explicit no-restart intent remain distinct from omission in the plan and
semantic identity. Every declaration is validated before profile filtering.

`entrypoint` has exactly one form: `{exec: ["program", "argument"]}` or
`{shell: "explicit shell text"}`. The distinct entrypoint type also permits
`{exec: []}` to clear an inherited image entrypoint. A nonempty exec list requires
a nonempty first argument; later arguments can be empty strings. Shell text must
be nonempty. No argument or shell text can contain NUL bytes. Normal commands,
readiness commands, and host commands still reject empty exec lists. Entrypoint
intent is retained independently of the normal workload command.

`shutdown` contains optional `signal` and `grace`, with at least one field required.
Signal is a canonical named Linux signal from the generated `ShutdownSignal`
enum, including the 31 ordinary names from `SIGHUP` through `SIGSYS`. Numeric
signals, prefixless names, aliases (`SIGIOT`, `SIGCLD`, `SIGPOLL`, `SIGUNUSED`),
and realtime syntax refuse. Grace uses the existing positive integer duration
parser for `ms`, `s`, `m`, or `h`, normalized to milliseconds within the supported
u32 millisecond range. Authored grace is not capped by a backend's execution
timeout; a backend must preserve or explicitly refuse unsupported intent during
admission. The plan does not prove that a signal can be delivered by a runtime.

`restart` is a tagged object with `kind: "no"`, `"always"`, `"unless-stopped"`,
or `"on-failure"`. Only `on-failure` may include `max_retries`, a positive u32
integer; omission is retained as symbolic intent. Jobs reject perpetual `always`
and `unless-stopped` policies even when inactive. Jobs permit `no` and
`on-failure` as authored intent, without claiming that a backend executes job
retries. The generated schema includes this job restriction and entrypoint
clearing distinction. Null, unknown fields, tuple forms, ambiguous tags, and
invalid scalar types refuse with redacted diagnostics. Compilation performs no
entrypoint execution, init launch, signal delivery, or restart supervision.
