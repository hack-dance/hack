# Machine-readable output

New `--json` outputs added for HACK-2218 use one success envelope:

```json
{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"}}
```

The stable schema identifier belongs inside `data`. A payload schema changes
when its incompatible contract changes. Consumers unwrap `data` and validate
its schema before using it. Human diagnostics go to stderr.

Failures use a stable error code and a nonzero exit status:

```json
{"ok":false,"error":{"code":"E_USAGE","message":"Use a supported option combination."}}
```

Errors may carry `error.detail`. A refused administrator plan uses
`E_PLAN_REFUSED` (exit 1); an incomplete plan uses `E_PLAN_INCOMPLETE` (exit 3).
Both retain the partial plan, including its schema, at `error.detail.plan`.
Unknown/offline state in an observation is still a successful observation;
it is not a claim that the runtime is healthy.

The previously unpublished version, observe-only project/status and admin-plan
outputs now follow this rule. Plain `projects --json` and other published legacy
outputs keep their shapes. A consumer must not use the new observe-only parser
for a plain projects result. Streaming interfaces remain NDJSON and have their
own event contracts. No published payload is silently wrapped by this change.

![JSON command boundary](./machine-readable-output.svg)

## Command inventory

This inventory includes every canonical command exposing `--json`, including
retained unsupported command groups. Aliases have the same contract as their
canonical command. “Legacy” records the existing output; it does not recommend
that shape for a new interface. Backend-dependent entries need their existing
command-specific parser. Do not infer a success shape from an error envelope.

Regenerate with `bun scripts/generate-machine-output-reference.ts`. Tests compare
the inventory to the command definitions and exercise every command's shared
usage-error boundary without entering its handler. The migrated success variants
also have real CLI-boundary contract tests; existing legacy success behavior
remains covered by its command-specific suites.

<!-- json-inventory:start -->
| Canonical command / variant | Success shape |
|---|---|
| `hack activity --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack commands cancel --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack commands read --json` | NDJSON events / terminal event, not a single envelope |
| `hack commands show --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack config adopt --json` | Legacy bare object (no `data` envelope) |
| `hack config import --json` | Legacy bare object (no `data` envelope) |
| `hack config plan --json` | Native compiler protocol object (`transport_version`, `ok`, result / diagnostics) |
| `hack config validate --json` | Native compiler protocol object (`transport_version`, `ok`, result / diagnostics) |
| `hack daemon status --json` | Legacy bare object (no `data` envelope) |
| `hack dispatch logs --json` | Legacy bare object (no `data` envelope) |
| `hack dispatch run --json` | Legacy bare object (no `data` envelope) |
| `hack dispatch status --json` | Legacy bare object (no `data` envelope) |
| `hack doctor --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack down --json` | Backend-dependent: envelope or legacy bare object |
| `hack env apply --json` | Legacy bare object (no `data` envelope) |
| `hack env backend status --json` | Legacy bare object (no `data` envelope) |
| `hack env backend use --json` | Legacy bare object (no `data` envelope) |
| `hack env explain --json` | Legacy bare object (no `data` envelope) |
| `hack env hydrate --json` | Legacy bare object (no `data` envelope) |
| `hack env list --json` | Legacy bare object (no `data` envelope) |
| `hack env protect --json` | Legacy bare object (no `data` envelope) |
| `hack exec --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack exec-sessions --json` | Legacy bare object (no `data` envelope) |
| `hack global dns preview --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack global install --plan --json` | Envelope; versioned `data.schema`: `hack.global-admin-plan.v1` |
| `hack global status --json` | Legacy bare object (no `data` envelope) |
| `hack global trust --plan --json` | Envelope; versioned `data.schema`: `hack.global-admin-plan.v1` |
| `hack host ps --json` | Legacy bare object (no `data` envelope) |
| `hack logs --json` | NDJSON logs; finite native modes may return a legacy snapshot object |
| `hack node add --json` | Legacy bare object (no `data` envelope) |
| `hack node devcontainer attach --json` | Legacy bare object (no `data` envelope) |
| `hack node devcontainer down --json` | Legacy bare object (no `data` envelope) |
| `hack node devcontainer up --json` | Legacy bare object (no `data` envelope) |
| `hack node init --json` | Legacy bare object (no `data` envelope) |
| `hack node list --json` | Legacy bare object (no `data` envelope) |
| `hack node pair --json` | Legacy bare object (no `data` envelope) |
| `hack node pair approve --json` | Legacy bare object (no `data` envelope) |
| `hack node pair cancel --json` | Legacy bare object (no `data` envelope) |
| `hack node pair complete --json` | Legacy bare object (no `data` envelope) |
| `hack node pair fulfill --json` | Legacy bare object (no `data` envelope) |
| `hack node pair list --json` | Legacy bare object (no `data` envelope) |
| `hack node pair request --json` | Legacy bare object (no `data` envelope) |
| `hack node pair start --json` | Legacy bare object (no `data` envelope) |
| `hack node pair walkthrough --json` | Legacy bare object (no `data` envelope) |
| `hack node provider railway bootstrap --json` | Legacy bare object (no `data` envelope) |
| `hack node remove --json` | Legacy bare object (no `data` envelope) |
| `hack node routes repair --json` | Legacy bare object (no `data` envelope) |
| `hack node routes status --json` | Legacy bare object (no `data` envelope) |
| `hack node ssh setup --json` | Legacy bare object (no `data` envelope) |
| `hack node status --json` | Legacy bare object (no `data` envelope) |
| `hack node use --json` | Legacy bare object (no `data` envelope) |
| `hack node workspace attach --json` | Legacy bare object (no `data` envelope) |
| `hack node workspace list --json` | Legacy bare object (no `data` envelope) |
| `hack node workspace remove --json` | Legacy bare object (no `data` envelope) |
| `hack node workspace resolve --json` | Legacy bare object (no `data` envelope) |
| `hack open --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack project owner show --json` | Legacy bare object (no `data` envelope) |
| `hack project target --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack project task inspect --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack project task list --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack projects --json` | Legacy bare object (no `data` envelope) |
| `hack projects prune --json` | Legacy bare object (no `data` envelope) |
| `hack ps --json` | Backend-dependent: envelope or legacy bare object |
| `hack restart --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack run --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack session capture --json` | NDJSON events / terminal event, not a single envelope |
| `hack session panes --json` | NDJSON events / terminal event, not a single envelope |
| `hack session tail --json` | NDJSON events / terminal event, not a single envelope |
| `hack setup migrate --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack setup sync --json` | Retired: usage-error envelope, no success payload |
| `hack status --json` | Backend-dependent: envelope or legacy bare object |
| `hack up --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack update --json` | Legacy result (`ok` plus fields, no `data`; error may be a string) |
| `hack upgrade apply --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack upgrade check --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack upgrade review --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack upgrade rollback --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack upgrade snapshot --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack usage --json` | Legacy bare object (no `data` envelope) |
| `hack version --json` | Envelope; versioned `data.schema`: `hack.version.v1` |
| `hack projects --json --observe` | Envelope; `data.schema: hack.projects.observe.v1` |
| `hack global status --json --observe` | Envelope; `data.schema: hack.global-status.observe.v1` |
<!-- json-inventory:end -->
