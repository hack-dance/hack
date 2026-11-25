# Machine-readable output

New `--json` outputs added for HACK-2218 use one success envelope:

```json
{"ok":true,"data":{"schema":"hack.version.v1","version":"5.0.0"}}
```

The stable schema identifier belongs inside `data`. A payload schema changes
when its incompatible contract changes. Consumers unwrap `data` and validate
its schema before using it. Human diagnostics go to stderr.
The envelope has exactly two top-level keys; additional metadata belongs inside
the schema-tagged payload, not alongside `ok` and `data`.

Failures use a stable error code and a nonzero exit status:

```json
{"ok":false,"error":{"code":"E_USAGE","message":"Use a supported option combination."}}
```

Errors may carry `error.detail`. A refused administrator plan uses
`E_PLAN_REFUSED` (exit 1); an incomplete plan uses `E_PLAN_INCOMPLETE` (exit 3).
Both retain the partial plan, including its schema, at `error.detail.plan`.
If `hack down --service <name> --json` fails after Docker confirms some replica
stops, `E_COMPOSE_FAILED` includes their IDs in `error.detail.stoppedContainerIds`
and the receipt time in `error.detail.stoppedAt`. When inspect identified the
execution before Stop, `error.detail.stoppedContainers` pairs the confirmed ID
with its `startedAt`. Successful service stops include those fields in `data`.
Unknown/offline state in an observation is still a successful observation;
it is not a claim that the runtime is healthy.

The version, Activity, observe-only project/status and admin-plan outputs
follow this rule from next.18. They first shipped in 5.0.0-next.17 with other
shapes; the [next.18 release notes](../guides/v5-release-notes.md) say how to
migrate. Plain `projects --json` and other older legacy outputs keep their
shapes. A consumer must not use the new observe-only parser for a plain projects
result. Streaming interfaces remain NDJSON and have their own event contracts.

![JSON command boundary](./machine-readable-output.svg)

## Output from what Hack runs

With Hack's own `--json`, stdout carries only Hack's result: one JSON value,
or, with `--progress`, only NDJSON lines ending in the envelope. Everything
Hack runs for the command writes to stderr instead, on both backends:
lifecycle hooks (`before`, `after` and down phases, both their stdout and their
stderr), host commands, the Compose client's own output, and the unsupported
remote lifecycle dispatch (`--target remote`). This holds for every command in the inventory
below, including `up`, `restart`, `down` and `run --detach`. Read stderr for
that output; never parse it from stdout. One exception: `run --detach` captures
the Compose client's output for its own result, so that output appears on
neither stream.

A `--json` that belongs to a child command, as in `hack run web tool --json`,
is the child's: Hack passes its output through unchanged.

For Compose-file projects, `hack up <service> --json` uses `data.action`,
`project`, `branch`, `composeProject`, `services`, and `durationMs` on both
backends. `services` contains the `started`, `completed`, `stopped`, and
`failed` arrays. Native returns this result after its selected services meet
their startup goals.

## Command inventory

This inventory includes every canonical command exposing `--json`, including
retained unsupported command groups. Aliases have the same contract as their
canonical command. “Legacy” records the existing output; it does not recommend
that shape for a new interface. Backend-dependent entries need their existing
command-specific parser. Do not infer a success shape from an error envelope.

Regenerate with `bun scripts/generate-machine-output-reference.ts`. Tests compare
the inventory to the command definitions and exercise every command's shared
usage-error boundary without entering its handler. Every listed command that can
succeed without a runtime, engine or project is also run for real and checked
against its row; legacy objects there pin their top-level keys. The remaining
success behavior stays covered by command-specific suites.

<!-- json-inventory:start -->
| Canonical command / variant | Success shape |
|---|---|
| `hack activity --json` | Envelope; versioned `data.schema`: `hack.activity.v1` |
| `hack autostart add --json` | Envelope; versioned `data.schema`: `hack.autostart.v1` |
| `hack autostart list --json` | Envelope; versioned `data.schema`: `hack.autostart.v1` |
| `hack autostart pause --json` | Envelope; versioned `data.schema`: `hack.autostart.v1` |
| `hack autostart remove --json` | Envelope; versioned `data.schema`: `hack.autostart.v1` |
| `hack autostart resume --json` | Envelope; versioned `data.schema`: `hack.autostart.v1` |
| `hack autostart run --json` | Envelope; versioned `data.schema`: `hack.autostart.v1` |
| `hack commands cancel --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack commands read --json` | NDJSON events / terminal event, not a single envelope |
| `hack commands show --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack config adopt --json` | Legacy bare object (no `data` envelope) |
| `hack config import --json` | Legacy bare object (no `data` envelope) |
| `hack config plan --json` | Native compiler protocol object (`transport_version`, `ok`, result / diagnostics) |
| `hack config validate --json` | Native compiler protocol object (`transport_version`, `ok`, result / diagnostics) |
| `hack daemon install --json` | Envelope; versioned `data.schema`: `hack.daemon-install.v1` |
| `hack daemon restart --json` | Envelope; versioned `data.schema`: `hack.daemon-restart.v1` |
| `hack daemon start --json` | Envelope; versioned `data.schema`: `hack.daemon-start.v1` |
| `hack daemon status --json` | Legacy bare object (no `data` envelope) |
| `hack daemon stop --json` | Envelope; versioned `data.schema`: `hack.daemon-stop.v1` |
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
| `hack env migrate --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack env overlay add --json` | Envelope; versioned `data.schema`: `hack.env-overlays.v1` |
| `hack env overlay list --json` | Envelope; versioned `data.schema`: `hack.env-overlays.v1` |
| `hack env protect --json` | Legacy bare object (no `data` envelope) |
| `hack exec --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack exec-sessions --json` | Legacy bare object (no `data` envelope) |
| `hack files cat --json` | Envelope; versioned `data.schema`: `hack.files.v1` |
| `hack files ls --json` | Envelope; versioned `data.schema`: `hack.files.v1` |
| `hack global dns preview --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack global install --plan --json` | Envelope; versioned `data.schema`: `hack.global-admin-plan.v1` |
| `hack global status --json` | Legacy bare object (no `data` envelope) |
| `hack global trust --plan --json` | Envelope; versioned `data.schema`: `hack.global-admin-plan.v1` |
| `hack global up --json` | Envelope; versioned `data.schema`: `hack.global-up.v1` |
| `hack host ps --json` | Legacy bare object (no `data` envelope) |
| `hack logs --json` | NDJSON logs; finite native modes may return a legacy snapshot object |
| `hack native disk-usage --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack native recover --json` | Native runtime result passed through unchanged, with no `data` envelope (setup: `status`, `builder`, `files`, `probe`; recover: the runtime status, such as `phase`) |
| `hack native setup --json` | Native runtime result passed through unchanged, with no `data` envelope (setup: `status`, `builder`, `files`, `probe`; recover: the runtime status, such as `phase`) |
| `hack native temp-aliases --json` | Legacy bare object (no `data` envelope) |
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
| `hack open --json` | Legacy bare object (no `data` envelope) |
| `hack project owner show --json` | Legacy bare object (no `data` envelope) |
| `hack project target --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack project task inspect --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack project task list --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack projects --json` | Legacy bare object (no `data` envelope) |
| `hack projects prune --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack ps --json` | Backend-dependent: envelope or legacy bare object |
| `hack pull --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack resources list --json` | Envelope; versioned `data.schema`: `hack.resources.v1` |
| `hack resources remove --json` | Envelope; versioned `data.schema`: `hack.resource-remove.v1` |
| `hack restart --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack run --json` | Envelope (`ok`, `data` / `error`); legacy payload has no required schema |
| `hack service add --json` | Envelope; versioned `data.schema`: `hack.service-add.v1` |
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
| `hack usage --json --by-service` | Envelope; `data.schema: hack.usage.by-service.v1` |
| `hack update --json --check --observe` | Envelope; `data.schema: hack.update-check.v1` |
| `hack doctor --json --machine` | Envelope; `data.schema: hack.doctor.machine.v1` |
<!-- json-inventory:end -->

### Resource removal refusals

`hack resources remove --json` reports a machine-readable `error.detail.reason`
for safety refusals. `confirmation_required` accompanies `E_INTERACTIVE_REQUIRED`.
The remaining reasons below accompany `E_PLAN_REFUSED`. Invalid selectors and
combining `--dry-run` with `--confirm` return `E_USAGE`.

| Reason | Meaning |
| --- | --- |
| `engine_context_unknown`, `engine_unknown`, `engine_changed` | Docker context or engine identity could not be pinned, verified, or stayed inconsistent. |
| `receipt_mismatch` | The resource is absent or does not match a Hack launch receipt on this engine. |
| `container_active`, `project_not_down` | The container or its Compose project has an active or unverified container state. |
| `volume_references_unknown`, `volume_referenced` | Container references could not be checked, or a container references the volume. |
| `checkout_present`, `checkout_unknown` | A launch checkout exists or its absence cannot be verified. |
| `registry_reference`, `run_reference` | A registered checkout or a runtime or lifecycle entry still refers to the Compose project. |
| `registry_unknown`, `state_unknown`, `history_unknown` | The registry, checkout state, or launch history could not be verified. |
| `confirmation_stale`, `resource_changed` | The preview token or final identity check no longer matches. |
| `engine_refused` | Docker declined the non-forced removal. |


## Additive fields

Additive fields keep a command's row and shape above; consumers ignore keys they do not know.

- Compose `hack ps --json`: each `items[]` entry is a Compose `ps` object. An entry whose image
  architecture differs from the engine's adds `emulated: true`; the key is absent when the
  architectures match or Docker could not report them (HACK-2323).
- `hack doctor --json`: the `emulated services`, `polling watchers`, `shared volume
  architectures` and `dev image tags` checks add a `devPerformance` object with a `kind`, the
  services, project-relative files and lines, and architectures. `hack doctor --fix --only
  'polling watchers' --json` adds `data.fix` with `id`, `applied`, `changed`, `confirmed`,
  `removed` and `diff`.
- Compose `hack down --json`: when the overall down cap ends `docker compose down`
  (exit `124`), `error.message` explains the cap and `error.detail` adds `timedOut: true`
  and `capMs`.
