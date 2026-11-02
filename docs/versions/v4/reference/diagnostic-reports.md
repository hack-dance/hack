# Diagnostic and setup reports

Pinned source: `91b14bf0abb17602142425de0d02628a3e8a2615`. Consumer-visible JSON projections only. R = required; optional means omitted, never implicitly null. A listed null union is emitted as null. Arrays may be empty unless stated otherwise. Source admission is not runtime/provider qualification. All examples are synthetic; paths and values are placeholders.

## Report and exit rules

Doctor emits the shared `{ok:true,data:DoctorJsonData}` envelope even when a completed check has status error; those checks make the command exit 1. Warnings alone do not. Top-level thrown failures can instead use the shared failure envelope. A diagnostic report is not repair or deletion authority.

Update JSON is its own UpdateOutput union. Handled ok:false has a string error and exits 1; ok:true exits 0. The optional mutagen report appears after a successful update installation. An already-available dependency yields available:true/installed:false/path:string; successful provisioning yields available:true and the actual installation result. Provisioning failure can still leave top-level ok:true/installed:true; inspect mutagen.warning/available. Path null means no dependency found. Omitted warning is distinct from an empty string.  A synthetic provisioning fragment is `{"available":false,"installed":false,"path":null,"warning":"<provisioning diagnostic>"}`.

Host ps emits a bare HostPsReport and returns 0 after gathering observations, including when the process snapshot is unavailable. It does not return an envelope. snapshotAvailable:false and nullable live metrics mean unknown observation, not proof of stopped processes. Command records carry no argv, environment or output. Record parsing strips unrecognized properties. All current serializer fields are documented below despite its broad inferred/Record return types.

V4 setup sync has **no JSON flag and no targets[] payload**. It renders a status list. Its check exits 1 for missing/stale/deprecated/error entries; install/remove fail on error. Do not backport next.5 refresh-only statuses or installMissing/targets fields. V4 doctor has no supersededRoots/hackLocalRoute/envKey fields, and candidate validate/plan/import/adopt leaves are absent.

## Host telemetry interpretation

All HostCommandObservation fields are emitted, including explicit nulls. Stored status is running/exited/cancelled/timed_out; the observer preserves completed statuses and can replace running with unknown/orphaned/interrupted. unknown means snapshot or wrapper birth identity unavailable. running requires the original wrapper identity; orphaned means wrapper absent but original child identified; interrupted means neither identified while an unfinished record remains.

Identity is PID plus birth/start time, not PID alone. observedPids includes the observed child tree and proven owned-group members. unverifiedGroupPids is populated only when child identity is unavailable but matching numeric group members exist; it confers no signaling authority. Group-members attention takes precedence over wrapper-loss attention. Persistent orphaned commands use persistent_wrapper_lost; other orphaned commands use wrapper_lost; interrupted uses completion_unknown.

elapsedMs on command rows is wall time from stored start to finish/now, clamped at zero. cpuTimeMs/maxRssBytes are stored child-completion metrics; liveCpuTimeMs/liveRssBytes sum current proven members or are null without child identity. cpuAccounting labels stored-finish versus live-snapshot mode; it does not make absent metrics non-null.

Lifecycle rows come from registered projects/worktrees with persisted sessions. owned-healthy/owned-stale/legacy-owned allow proven group selection; absent/foreign/unknown do not. Unknown can mean missing backend or failed inspection. With owned state and an available snapshot, an empty member set gives live CPU/RSS 0, while elapsedMs is null. Without owned state/snapshot, live CPU/RSS are null. Absent sessions add session_absent_review_state; foreign adds ownership_unverified; other attention is null. Definition source is persisted, not proof current definitions were compared successfully. No private state-file/ownership-token schema is published. Millisecond metrics are durations/CPU time; RSS fields are bytes.

## Typed payload records

Each numbered variant below is a distinct object alternative; nested named records are listed separately. Field counts count table rows, including repeated fields in distinct alternatives. Alias definitions and their literal choices are counted separately.

### DoctorResult

Source: `src/commands/doctor.ts:680 (finishDoctorJson)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `true` | required |
| `data` | `DoctorJsonData` | required |

### DoctorJsonData.counts

Source: `src/commands/doctor.ts:644 (DoctorJsonData)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `number` | required |
| `warn` | `number` | required |
| `error` | `number` | required |

### DoctorJsonData

Source: `src/commands/doctor.ts:644 (DoctorJsonData)`.

| Field | Type | Presence |
| --- | --- | --- |
| `checks` | `DoctorJsonCheck[]` | required |
| `summary` | `string[]` | required |
| `counts` | `DoctorJsonData.counts` | required |

### DoctorJsonCheck

Source: `src/commands/doctor.ts:637 (DoctorJsonCheck)`.

| Field | Type | Presence |
| --- | --- | --- |
| `id` | `string` | required |
| `status` | `CheckStatus` | required |
| `detail` | `string` | required |
| `durationMs` | `number` | required |

### UpdateOutput — variant 1.target

Source: `src/commands/update.ts:406 (UpdateOutput)`.

| Field | Type | Presence |
| --- | --- | --- |
| `platform` | `string` | required |
| `arch` | `string` | required |

### UpdateOutput — variant 1

Source: `src/commands/update.ts:406 (UpdateOutput)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `true` | required |
| `current` | `string` | required |
| `latest` | `string` | required |
| `updateAvailable` | `boolean` | required |
| `installed` | `boolean` | required |
| `target` | `UpdateOutput — variant 1.target` | required |
| `binaryPath` | `string` | required |
| `assetsDir` | `string` | required |
| `mutagen` | `MutagenProvisionResult` | optional; omitted when absent |

### UpdateOutput — variant 2

Source: `src/commands/update.ts:406 (UpdateOutput)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `false` | required |
| `error` | `string` | required |

### MutagenProvisionResult

Source: `src/commands/update.ts:283 (MutagenProvisionResult)`.

| Field | Type | Presence |
| --- | --- | --- |
| `available` | `boolean` | required |
| `installed` | `boolean` | required |
| `path` | `string \| null` | required |
| `warning` | `string` | optional; omitted when absent |

### HostPsReport

Source: `src/commands/host-ps.ts:33 (hostPsCommand)`.

| Field | Type | Presence |
| --- | --- | --- |
| `generatedAt` | `string (ISO timestamp)` | required |
| `snapshotAvailable` | `boolean` | required |
| `commands` | `HostCommandObservation[]` | required |
| `lifecycle` | `LifecycleObservation[]` | required |

### HostCommandObservation

Source: `src/lib/host-command-observation.ts:242 (observeHostCommand)`.

| Field | Type | Presence |
| --- | --- | --- |
| `version` | `1` | required |
| `id` | `string (UUID)` | required |
| `project` | `string` | required |
| `projectRoot` | `string` | required |
| `executable` | `string (basename only)` | required |
| `wrapper` | `ProcessIdentity` | required |
| `child` | `ProcessIdentity` | required |
| `ownsProcessGroup` | `boolean` | required |
| `processGroupId` | `positive integer \| null` | required |
| `lifetime` | `"command" \| "persistent" \| "bounded"` | required |
| `timeoutMs` | `positive number \| null` | required |
| `startedAt` | `string (ISO timestamp)` | required |
| `finishedAt` | `string (ISO timestamp) \| null` | required |
| `status` | `"running" \| "exited" \| "cancelled" \| "timed_out" \| "unknown" \| "orphaned" \| "interrupted"` | required |
| `exitCode` | `integer \| null` | required |
| `cpuTimeMs` | `nonnegative number \| null` | required |
| `maxRssBytes` | `nonnegative number \| null` | required |
| `elapsedMs` | `nonnegative number` | required |
| `observedPids` | `number[]` | required |
| `unverifiedGroupPids` | `number[]` | required |
| `liveCpuTimeMs` | `number \| null` | required |
| `liveRssBytes` | `number \| null` | required |
| `cpuAccounting` | `"reaped_child" \| "live_tree_snapshot"` | required |
| `ownership` | `"pid_and_start_time" \| "unverified"` | required |
| `attention` | `"group_members_require_review" \| "persistent_wrapper_lost" \| "wrapper_lost" \| "completion_unknown" \| null` | required |

### ProcessIdentity

Source: `src/lib/host-command-observation.ts:13 (identitySchema)`.

| Field | Type | Presence |
| --- | --- | --- |
| `pid` | `positive integer` | required |
| `birth` | `string \| null` | required |

### LifecycleObservation

Source: `src/commands/host-ps.ts:121 (observeLifecycleEntry)`.

| Field | Type | Presence |
| --- | --- | --- |
| `project` | `string` | required |
| `projectRoot` | `string` | required |
| `branch` | `string \| null` | required |
| `session` | `string` | required |
| `backend` | `"tmux" \| "zellij"` | required |
| `lifetime` | `"persistent"` | required |
| `ownership` | `"absent" \| "owned-healthy" \| "owned-stale" \| "legacy-owned" \| "foreign" \| "unknown"` | required |
| `definitionSource` | `"persisted"` | required |
| `processGroupIds` | `number[]` | required |
| `observedPids` | `number[]` | required |
| `liveCpuTimeMs` | `number \| null` | required |
| `liveRssBytes` | `number \| null` | required |
| `elapsedMs` | `number \| null` | required |
| `attention` | `"session_absent_review_state" \| "ownership_unverified" \| null` | required |

## Scalar, enum and collection aliases

| Name | Exact type / choices | Pinned source |
| --- | --- | --- |
| `CheckStatus` | `"ok" \| "warn" \| "error"` | `src/commands/doctor.ts:134 (CheckStatus)` |

## Contract boundaries

These are the v4 CLI report records only. The newer v5 diagnostic attachments, setup-sync JSON and candidate config report leaves are absent. Shared error.detail remains unknown by its public contract. A report shape is not runtime/provider/client qualification.
