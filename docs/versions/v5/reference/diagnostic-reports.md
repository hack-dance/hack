# Diagnostic and setup reports

Pinned source: `28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc`. Consumer-visible JSON projections only. R = required; optional means omitted, never implicitly null. A listed null union is emitted as null. Arrays may be empty unless stated otherwise. Source admission is not runtime/provider qualification. All examples are synthetic; paths and values are placeholders.

## Report and exit rules

Doctor emits the shared `{ok:true,data:DoctorJsonData}` envelope even when a completed check has status error; those checks make the command exit 1. Warnings alone do not. Top-level thrown failures can instead use the shared failure envelope. A diagnostic report is not repair or deletion authority.

Update JSON is its own UpdateOutput union. Handled ok:false has a string error and exits 1; ok:true exits 0. The optional mutagen report appears after a successful update installation. An already-available dependency yields available:true/installed:false/path:string; successful provisioning yields available:true and the actual installation result. Provisioning failure can still leave top-level ok:true/installed:true; inspect mutagen.warning/available. Path null means no dependency found. Omitted warning is distinct from an empty string.  A synthetic provisioning fragment is `{"available":false,"installed":false,"path":null,"warning":"<provisioning diagnostic>"}`.

Host ps emits a bare HostPsReport and returns 0 after gathering observations, including when the process snapshot is unavailable. It does not return an envelope. snapshotAvailable:false and nullable live metrics mean unknown observation, not proof of stopped processes. Command records carry no argv, environment or output. Record parsing strips unrecognized properties. All current serializer fields are documented below despite its broad inferred/Record return types.

Next.5 setup sync emits `{ok:true,data:SetupSyncData}` for a completed report; exit is computed separately. check exits 1 on refreshed/installed/removed/preserved/error; missing and unchanged do not fail. sync/remove exit 1 only on error. Counts contain only encountered status keys; absent keys are omitted, not null or guaranteed zero. dryRun is action===check. Check reports what would change, never proves a write occurred. Missing targets are left missing unless install-missing requests creation/planning. A preserved result keeps customized/unrecognized content unchanged; reason/message are optional in the record type, not nullable. Successful sync is not proof that an agent loaded the integration.

Next.5 update refuses the explicitly selected native candidate with its handled ok:false/error:string result. No broader native self-update capability is implied.

## Doctor diagnostic meaning

supersededRoots appears only on the superseded Caddy roots check and only when inventory succeeded. The exact check id is superseded caddy roots. Absence is not count 0; unavailable inventory is a warning. count counts unique superseded DER fingerprints; expired and notYetValid are subsets. sha256 contains sorted uppercase public SHA-256 fingerprints, capped at 32, so its length can be less than count. The current root is excluded; this report neither establishes trust nor selects certificates for removal.

hackLocalRoute appears on the native hack.local route check. current maps to doctor ok; repairable/refused map to warn. The serializer emits the three precise variants below: paths are descriptive strings, receiptState is nullable, and oldLine/newLine are validated managed-form lines, not arbitrary file contents. The exact check id is native hack.local route; failed dependency inspection can produce a warning check with hackLocalRoute omitted. This is not a private receipt contract.

envKey appears only on the env key check (id: env key), and remains omitted if inspection cannot produce that projection. findings are ordered most severe first; aggregate status is their highest severity. A clean result has one env-key-ok or env-key-absent finding. subject is a fixed label or project-relative subject; remedy is a string suggestion or null. env-key-ok and env-key-absent have status ok and remedy null. Symlink/not-regular/unreadable/tracked/public-path findings are error; weak-permissions/wrong-owner/wrong-length/low-entropy are warn. Neither bytes nor absolute key paths are exposed; doctor never runs the remedy. EnvKeyCandidate/inspection inputs are private and omitted here.

## Setup status variants

| Status | Meaning | check exit contribution | sync/remove exit contribution |
| --- | --- | --- | --- |
| refreshed | existing owned content changed / would change | 1 | 0 |
| unchanged | already current | 0 | 0 |
| installed | missing content created / would be created with install-missing | 1 | 0 |
| preserved | customized, unknown, unreadable or non-regular content retained | 1 | 0 |
| missing | no integration present; not created | 0 | 0 |
| removed | owned/retired content removed / would remove | 1 | 0 |
| error | target could not be checked/updated | 1 | 1 |

Targets are finite named integrations, not a map of arbitrary files. Project scope includes agent docs; global scope additionally includes the shared CLI skill. scope-root is an error target when a scope root cannot be resolved; its path is an empty string. retired-artifact results are emitted only when present (absent artifacts are filtered); a reported removed status during check is prospective. MCP helper present maps to unchanged; removed maps to removed; missing/noop map to missing; invalid/unreadable maps to error. A user-owned doc with no Hack section is missing, whereas malformed markers are preserved/customized-content. The current producer includes reason/message on preserved rows; reason is otherwise omitted. Message also appears on error and selected removal outcomes. These emission rules are stronger than the optional properties in SetupSyncTargetResult; consumers should retain the optional record contract. The target list enum does not promise every target occurs in every scope/report.

## Host telemetry interpretation

All HostCommandObservation fields are emitted, including explicit nulls. Stored status is running/exited/cancelled/timed_out; the observer preserves completed statuses and can replace running with unknown/orphaned/interrupted. unknown means snapshot or wrapper birth identity unavailable. running requires the original wrapper identity; orphaned means wrapper absent but original child identified; interrupted means neither identified while an unfinished record remains.

Identity is PID plus birth/start time, not PID alone. observedPids includes the observed child tree and proven owned-group members. unverifiedGroupPids is populated only when child identity is unavailable but matching numeric group members exist; it confers no signaling authority. Group-members attention takes precedence over wrapper-loss attention. Persistent orphaned commands use persistent_wrapper_lost; other orphaned commands use wrapper_lost; interrupted uses completion_unknown.

elapsedMs on command rows is wall time from stored start to finish/now, clamped at zero. cpuTimeMs/maxRssBytes are stored child-completion metrics; liveCpuTimeMs/liveRssBytes sum current proven members or are null without child identity. cpuAccounting labels stored-finish versus live-snapshot mode; it does not make absent metrics non-null.

Lifecycle rows come from registered projects/worktrees with persisted sessions. owned-healthy/owned-stale/legacy-owned allow proven group selection; absent/foreign/unknown do not. Unknown can mean missing backend or failed inspection. With owned state and an available snapshot, an empty member set gives live CPU/RSS 0, while elapsedMs is null. Without owned state/snapshot, live CPU/RSS are null. Absent sessions add session_absent_review_state; foreign adds ownership_unverified; other attention is null. Definition source is persisted, not proof current definitions were compared successfully. No private state-file/ownership-token schema is published. Millisecond metrics are durations/CPU time; RSS fields are bytes.

## Candidate CLI reports

These leaves exist only at next.5 and remain experimental. validate --file prints ValidateFileSuccess or a diagnostic failure; discovery validation prints ValidateResolvedSuccess. Each exits 0 for ok:true and 1 for ok:false. Validate does not read managed env values or start workloads. plan prints PlanSuccess, but exits 0 only when ok:true AND environment_plan.complete AND file_plan.complete is not false. Therefore ok:true with incomplete bindings is an exit-1 report, not successful execution or runtime admission. Transport/request exceptions print CandidateTransportFailure and exit 1. Argument errors can use the top-level shared E_USAGE failure instead.

The CLI prints only its returned result. The helper-only envelope is stripped before serialization. routing_inputs_required is an intermediate probe signal: project preparation consumes it and resolves routing again; it is not added to these final report tables. Compiler request/handshake, raw authored input, private candidates, environment metadata input envelopes, guest/provider DTOs and journals are not public CLI report objects.

The CLI wrapper exposes plan as an opaque compiler-owned `Record<string, unknown>`. Its internal producer Plan DTO is not a stable public API here. Authored document shapes are documented separately in [Authored schema fields](authored-schema-fields.md); the explicit CLI wrapper fields below remain separate report contracts.

NativeConfigDiagnostic.code is a nonempty string; ImportField.code is declared string. Neither is a declared closed enum. NativeConfigDiagnostic line/column are positive safe integers, pointer is a JSON pointer (empty for document root); compile diagnostics may omit document, while resolved and environment/file planning diagnostics require a recognized document role. Messages are strings, never permission to run suggested actions.

EnvironmentPlan maps workload and destination names to typed bindings. Managed bindings expose names/scope/secret metadata, never resolved secret values. Literal/default bindings can contain authored plaintext; runtime bindings contain generated public metadata. Host bindings reject runtime kind. Host report keys identify declared hooks/process targets, not arbitrary backend objects. FilePlan reports bindings without reading file material; uid/gid are omitted unless supplied, never implicitly null. Plan/environment/file complete flags describe offline completeness only. Current file-plan diagnostics are specifically missing_env_reference at project pointers; they are not application errors. File target paths are normalized; mode is a four-character octal string matching 0[0-7]{3} (fallback 0444). File uid/gid are integers 0–4294967295 when supplied. Resolved endpoint/route ports are integers 1–65535. These are report shape constraints, not proof of runtime admission.

RoutingResolution is a URL/domain preview: aliases/routes are caller-named maps with closed value types. No DNS, trust, OAuth or application acceptance is established. Optional branch is omitted when absent; oauth_alias is explicitly null when unavailable. HostBindingResolution bindings and removed maps have finite origin choices, and removed records overridden/deleted authored bindings rather than authorizing host mutations.

Import requires dry-run and prints only NativeImportReport, never candidate. report_version is 1; complete is a preview result, adoption always not_performed. Fields are sorted by document then pointer by nativeImportResult. target is optional, typically present on mapped exact/normalized rows; a refused row may retain a target from an earlier mapping, so it is not mutually exclusive with refused. Code is a string namespace, not arbitrary source values. Refusals use fixed root coordinates when no specific location can be exposed. Complete false exits 1; true exits 0. The preview neither exports inputs nor adopts resources.

Adopt preview differs from import: it has no report_version and adds containers/volumes/stop only when complete:true. A refused preview omits all three. Requested stop in dry-run is prospective, not proof any container stopped. Apply/recover/rollback success is AdoptionApplied; original_data is always retained. A nonzero stop can return before any success JSON is emitted. Other handled adoption errors become E_CONFIG_INVALID in the shared error envelope. Optional error.detail.legacy_adoption_publication_refusal is exactly LegacyComposePublicationRefusal; absence is omitted. These closed stage/reason labels convey a last reached boundary, not recovery authority or a private journal schema.

The generated model keeps Workload image/build optional at the TypeScript representation level. Valid authored input requires exactly one image/build variant; schemas constrain pull_policy accordingly. This model table documents report types and does not loosen authored schema validation or claim all normalized capabilities are executable.

## Synthetic examples

Doctor warning fragment (a completed warning is not an error exit):

~~~json
{"id":"env key","status":"warn","detail":"<fixed diagnostic>","durationMs":1,"envKey":{"status":"warn","findings":[{"code":"env-key-weak-permissions","status":"warn","subject":"<relative-subject>","remedy":"<suggested action>"}]}}
~~~

Setup check can report a prospective install while returning exit 1:

~~~json
{"ok":true,"data":{"action":"check","dryRun":true,"installMissing":true,"counts":{"installed":1},"targets":[{"scope":"project","target":"cursor-rules","path":"<integration-path>","status":"installed"}]}}
~~~

Refused import report (exit 1, no candidate material):

~~~json
{"report_version":1,"complete":false,"adoption":"not_performed","fields":[{"document":"config","pointer":"","line":1,"column":1,"status":"refused","code":"unsafe_changed_or_unavailable_input"}]}
~~~

## Typed payload records

Each numbered variant below is a distinct object alternative; nested named records are listed separately. Field counts count table rows, including repeated fields in distinct alternatives. Alias definitions and their literal choices are counted separately.

### DoctorResult

Source: `src/commands/doctor.ts:1388 (finishDoctorJson)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `true` | required |
| `data` | `DoctorJsonData` | required |


### DoctorJsonData.counts

Source: `src/commands/doctor.ts:1345 (DoctorJsonData)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `number` | required |
| `warn` | `number` | required |
| `error` | `number` | required |


### DoctorJsonData

Source: `src/commands/doctor.ts:1345 (DoctorJsonData)`.

| Field | Type | Presence |
| --- | --- | --- |
| `checks` | `DoctorJsonCheck[]` | required |
| `summary` | `string[]` | required |
| `counts` | `DoctorJsonData.counts` | required |


### DoctorJsonCheck

Source: `src/commands/doctor.ts:1332 (DoctorJsonCheck)`.

| Field | Type | Presence |
| --- | --- | --- |
| `id` | `string` | required |
| `status` | `CheckStatus` | required |
| `detail` | `string` | required |
| `durationMs` | `number` | required |
| `supersededRoots` | `SupersededRootInventory` | optional; omitted when absent |
| `hackLocalRoute` | `HackLocalRouteReport` | optional; omitted when absent |
| `envKey` | `EnvKeyInspection` | optional; omitted when absent |


### SupersededRootInventory

Source: `src/lib/mac-ca-trust.ts:23 (SupersededRootInventory)`.

| Field | Type | Presence |
| --- | --- | --- |
| `count` | `number` | required |
| `expired` | `number` | required |
| `notYetValid` | `number` | required |
| `sha256` | `string[]` | required |


### HackLocalRouteReport.current

Source: `src/lib/native-hack-local-route.ts:711 (reportHackLocalRoute)`.

| Field | Type | Presence |
| --- | --- | --- |
| `status` | `"current"` | required |
| `dnsmasqPath` | `string` | required |
| `resolverPath` | `string` | required |
| `receiptPath` | `string` | required |
| `receiptState` | `"pending" \| "applied" \| "rolled-back" \| "released" \| null` | required |
| `relayPort` | `number` | required |
| `command` | `string` | optional; only applied receipt emits rollback command |


### HackLocalRouteReport.repairable

Source: `src/lib/native-hack-local-route.ts:711 (reportHackLocalRoute)`.

| Field | Type | Presence |
| --- | --- | --- |
| `status` | `"repairable"` | required |
| `dnsmasqPath` | `string` | required |
| `resolverPath` | `string` | required |
| `receiptPath` | `string` | required |
| `receiptState` | `"pending" \| "applied" \| "rolled-back" \| "released" \| null` | required |
| `oldLine` | `string` | required |
| `newLine` | `string` | required |
| `resolverAction` | `"keep" \| "create"` | required |
| `relayPort` | `number` | required |
| `command` | `string` | required |


### HackLocalRouteReport.refused

Source: `src/lib/native-hack-local-route.ts:711 (reportHackLocalRoute)`.

| Field | Type | Presence |
| --- | --- | --- |
| `status` | `"refused"` | required |
| `dnsmasqPath` | `string` | required |
| `resolverPath` | `string` | required |
| `receiptPath` | `string` | required |
| `receiptState` | `"pending" \| "applied" \| "rolled-back" \| "released" \| null` | required |
| `reason` | `HackLocalRouteRefusal` | required |
| `detail` | `string` | required |
| `command` | `string` | optional; only pending-receipt adds rollback command |


### EnvKeyInspection

Source: `src/lib/doctor-env-key.ts:52 (EnvKeyInspection)`.

| Field | Type | Presence |
| --- | --- | --- |
| `status` | `EnvKeyFindingStatus` | required |
| `findings` | `EnvKeyFinding[]` | required |


### EnvKeyFinding

Source: `src/lib/doctor-env-key.ts:43 (EnvKeyFinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `code` | `EnvKeyDiagnosticCode` | required |
| `status` | `EnvKeyFindingStatus` | required |
| `subject` | `string` | required |
| `remedy` | `string \| null` | required |


### SetupSyncResult

Source: `src/commands/setup.ts:900 (buildSetupSyncJsonData)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `true` | required |
| `data` | `SetupSyncData` | required |


### SetupSyncData

Source: `src/commands/setup.ts:900 (buildSetupSyncJsonData)`.

| Field | Type | Presence |
| --- | --- | --- |
| `action` | `SetupSyncAction` | required |
| `dryRun` | `boolean` | required |
| `installMissing` | `boolean` | required |
| `counts` | `Partial<Record<SetupSyncStatus, number>>` | required |
| `targets` | `SetupSyncTargetResult[]` | required |


### SetupSyncTargetResult

Source: `src/agents/setup-sync.ts:99 (SetupSyncTargetResult)`.

| Field | Type | Presence |
| --- | --- | --- |
| `scope` | `SetupSyncScope` | required |
| `target` | `SetupSyncTarget` | required |
| `path` | `string` | required |
| `status` | `SetupSyncStatus` | required |
| `reason` | `IntegrationPreservedReason` | optional; omitted when absent |
| `message` | `string` | optional; omitted when absent |


### UpdateOutput — variant 1.target

Source: `src/commands/update.ts:418 (UpdateOutput)`.

| Field | Type | Presence |
| --- | --- | --- |
| `platform` | `string` | required |
| `arch` | `string` | required |


### UpdateOutput — variant 1

Source: `src/commands/update.ts:418 (UpdateOutput)`.

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

Source: `src/commands/update.ts:418 (UpdateOutput)`.

| Field | Type | Presence |
| --- | --- | --- |
| `ok` | `false` | required |
| `error` | `string` | required |


### MutagenProvisionResult

Source: `src/commands/update.ts:295 (MutagenProvisionResult)`.

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


### ValidateFileSuccess

Source: `src/lib/native-config-compiler.ts:108 (NativeConfigCompileResult)`.

| Field | Type | Presence |
| --- | --- | --- |
| `transport_version` | `1` | required |
| `ok` | `true` | required |
| `plan` | `Readonly<Record<string, unknown>>` | required |
| `semantic_hash` | `string (64 lowercase hex)` | required |
| `declared_workloads` | `Record<string, WorkloadKind>` | optional at CLI boundary; current generated producer emits it |
| `host_env_targets` | `HostEnvTargets` | optional; omitted when absent |


### ValidateResolvedSuccess

Source: `src/lib/native-config-compiler.ts:91 (NativeConfigResolveResult)`.

| Field | Type | Presence |
| --- | --- | --- |
| `transport_version` | `1` | required |
| `ok` | `true` | required |
| `plan` | `Readonly<Record<string, unknown>>` | required |
| `semantic_hash` | `string (64 lowercase hex)` | required |
| `declared_workloads` | `Record<string, WorkloadKind>` | optional at CLI boundary; current generated producer emits it |
| `host_env_targets` | `HostEnvTargets` | optional; omitted when absent |
| `local_resolution` | `NativeLocalResolution` | required |
| `routing_resolution` | `RoutingResolution` | optional; omitted when not selected |
| `host_binding_resolution` | `HostBindingResolution` | optional; omitted when absent |


### PlanSuccess

Source: `src/lib/native-config-compiler.ts:100 (NativeConfigPlanResult)`.

| Field | Type | Presence |
| --- | --- | --- |
| `transport_version` | `1` | required |
| `ok` | `true` | required |
| `plan` | `Readonly<Record<string, unknown>>` | required |
| `semantic_hash` | `string (64 lowercase hex)` | required |
| `declared_workloads` | `Record<string, WorkloadKind>` | required |
| `host_env_targets` | `HostEnvTargets` | optional; omitted when absent |
| `local_resolution` | `NativeLocalResolution` | required |
| `routing_resolution` | `RoutingResolution` | optional; omitted when not selected |
| `host_binding_resolution` | `HostBindingResolution` | optional; omitted when absent |
| `environment_plan` | `EnvironmentPlan` | required |
| `file_plan` | `FilePlan` | optional; omitted when no file report |


### CandidateDiagnosticFailure

Source: `src/lib/native-config-compiler.ts:108 (NativeConfigCompileResult)`.

| Field | Type | Presence |
| --- | --- | --- |
| `transport_version` | `1` | required |
| `ok` | `false` | required |
| `diagnostics` | `NativeConfigDiagnostic[] (nonempty)` | required |


### CandidateTransportFailure

Constructed by the CLI handler catch path; config plan has the same failure shape.

Source: `src/commands/config-validate.ts:58 (configValidateCommand)`.

| Field | Type | Presence |
| --- | --- | --- |
| `transport_version` | `1` | required |
| `ok` | `false` | required |
| `error` | `CandidateError` | required |


### CandidateError

Source: `src/lib/native-config-compiler.ts:124 (NativeConfigCompilerError)`.

| Field | Type | Presence |
| --- | --- | --- |
| `code` | `string` | required |
| `message` | `string` | required |


### NativeConfigDiagnostic

Source: `src/lib/native-config-compiler.ts:68 (NativeConfigDiagnostic)`.

| Field | Type | Presence |
| --- | --- | --- |
| `code` | `string` | required |
| `pointer` | `string` | required |
| `message` | `string` | required |
| `line` | `number` | required |
| `column` | `number` | required |
| `document` | `NativeConfigDocumentRole` | optional; omitted when absent |


### NativeLocalResolution

Source: `src/lib/native-config-compiler.ts:83 (NativeLocalResolution)`.

| Field | Type | Presence |
| --- | --- | --- |
| `overlay` | `string \| null` | required |
| `origin` | `"project" \| "primary_local" \| "checkout_local" \| "explicit"` | required |
| `auto_branch` | `boolean` | required |
| `inherit_local` | `boolean` | required |
| `resolution_hash` | `string` | required |


### NativeImportReport

Source: `src/lib/native-config-import-plan.ts:44 (NativeImportReport)`.

| Field | Type | Presence |
| --- | --- | --- |
| `report_version` | `1` | required |
| `complete` | `boolean` | required |
| `adoption` | `"not_performed"` | required |
| `fields` | `ImportField[]` | required |


### ImportField

Source: `src/lib/native-config-import-parser.ts:18 (ImportField)`.

| Field | Type | Presence |
| --- | --- | --- |
| `document` | `ImportDocument` | required |
| `pointer` | `string` | required |
| `line` | `number` | required |
| `column` | `number` | required |
| `status` | `"exact" \| "normalized" \| "refused"` | required |
| `code` | `string` | required |
| `target` | `string` | optional; omitted when absent |


### AdoptionPreview.refused

Source: `src/lib/native-compose-adoption-preview.ts:37 (previewLegacyComposeAdoption)`.

| Field | Type | Presence |
| --- | --- | --- |
| `complete` | `false` | required |
| `adoption` | `"not_performed"` | required |
| `fields` | `ImportField[]` | required |


### AdoptionPreview.complete

Source: `src/lib/native-compose-adoption-preview.ts:37 (previewLegacyComposeAdoption)`.

| Field | Type | Presence |
| --- | --- | --- |
| `complete` | `true` | required |
| `adoption` | `"not_performed"` | required |
| `containers` | `number` | required |
| `volumes` | `number` | required |
| `stop` | `"requested" \| "not_requested"` | required |
| `fields` | `ImportField[]` | required |


### AdoptionApplied

Source: `src/commands/config-adopt.ts:168 (apply)`.

| Field | Type | Presence |
| --- | --- | --- |
| `adoption_version` | `1` | required |
| `owner` | `"legacy-compose"` | required |
| `status` | `"active" \| "rolled-back"` | required |
| `original_data` | `"retained"` | required |


### LegacyComposePublicationRefusal

Source: `src/lib/native-compose-adoption-publication-diagnostics.ts:4 (LegacyComposePublicationRefusal)`.

| Field | Type | Presence |
| --- | --- | --- |
| `stage` | `\| "publication-state" \| "publication-inputs" \| "publication-layout" \| "publication-compiler" \| "publication-stopped" \| "publication-routing" \| "publication-originals-directory" \| "publication-hold-original" \| "publication-install-native" \| "publication-sync" \| "publication-save-native" \| "publication-finish-native" \| "publication-active-candidate" \| "publication-final-inputs" \| "publication-final-stopped" \| "publication-final-directories" \| "publication-save-active" \| "publication-save-active-context" \| "publication-save-active-previous" \| "publication-save-active-staging" \| "publication-save-active-staged-context" \| "publication-save-active-latest" \| "publication-save-active-routing" \| "publication-save-active-receipt" \| "publication-save-active-rename" \| "publication-save-active-sync" \| "publication-save-active-published" \| "publication-save-active-final-context" \| "publication-save-active-decode" \| "publication-close-originals"` | required |
| `reason` | `\| "legacy-state" \| "legacy-busy" \| "legacy-changed" \| "legacy-unsupported" \| "legacy-cancelled" \| "private-state" \| "private-busy" \| "private-uncertain" \| "private-stale" \| "compiler-transport" \| "proof-deadline" \| "unclassified"` | required |


### EndpointReference — variant 1

Source: `packages/config-compiler/generated/native-config.ts:15 (EndpointReference)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"route"` | required |
| `name` | `string` | required |


### EndpointReference — variant 2

Source: `packages/config-compiler/generated/native-config.ts:15 (EndpointReference)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"service"` | required |
| `name` | `string` | required |
| `port` | `number` | required |
| `protocol` | `EndpointProtocol` | required |


### EndpointReference — variant 3

Source: `packages/config-compiler/generated/native-config.ts:15 (EndpointReference)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"host_binding"` | required |
| `name` | `string` | required |


### HostEnvTarget — variant 1

Source: `packages/config-compiler/generated/native-config.ts:28 (HostEnvTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"host"` | required |


### HostEnvTarget — variant 2

Source: `packages/config-compiler/generated/native-config.ts:28 (HostEnvTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"workload"` | required |
| `name` | `string` | required |


### HostBindingTarget — variant 1

Source: `packages/config-compiler/generated/native-config.ts:16 (HostBindingTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"host"` | required |
| `port` | `number` | required |
| `protocol` | `EndpointProtocol` | required |


### HostBindingTarget — variant 2

Source: `packages/config-compiler/generated/native-config.ts:16 (HostBindingTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"external"` | required |
| `hostname` | `string` | required |
| `port` | `number` | required |
| `protocol` | `EndpointProtocol` | required |


### EnvironmentPlan

Source: `packages/config-compiler/generated/native-config.ts:22 (EnvironmentPlan)`.

| Field | Type | Presence |
| --- | --- | --- |
| `plan_version` | `1` | required |
| `overlay` | `string \| null` | required |
| `overlay_exists` | `boolean` | required |
| `complete` | `boolean` | required |
| `workloads` | `{ [key in string]: { [key in string]: EnvironmentBinding } }` | required |
| `host` | `{ [key in string]: HostEnvironmentPlan }` | optional; omitted when absent |
| `warnings` | `Array<ResolveDiagnostic>` | required |
| `diagnostics` | `Array<ResolveDiagnostic>` | required |


### EnvironmentBinding — variant 1

Source: `packages/config-compiler/generated/native-config.ts:7 (EnvironmentBinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"managed"` | required |
| `key` | `string` | required |
| `scope` | `string` | required |
| `secret` | `boolean` | required |


### EnvironmentBinding — variant 2

Source: `packages/config-compiler/generated/native-config.ts:7 (EnvironmentBinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"literal"` | required |
| `value` | `string` | required |


### EnvironmentBinding — variant 3

Source: `packages/config-compiler/generated/native-config.ts:7 (EnvironmentBinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"default"` | required |
| `value` | `string` | required |


### EnvironmentBinding — variant 4

Source: `packages/config-compiler/generated/native-config.ts:7 (EnvironmentBinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"endpoint"` | required |
| `reference` | `EndpointReference` | required |
| `target` | `EndpointTarget` | required |


### EnvironmentBinding — variant 5

Source: `packages/config-compiler/generated/native-config.ts:7 (EnvironmentBinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"runtime"` | required |
| `value` | `string` | required |


### EndpointTarget — variant 1

Source: `packages/config-compiler/generated/native-config.ts:21 (EndpointTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"route"` | required |
| `origin` | `string` | required |


### EndpointTarget — variant 2

Source: `packages/config-compiler/generated/native-config.ts:21 (EndpointTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"service"` | required |
| `name` | `string` | required |
| `port` | `number` | required |
| `protocol` | `EndpointProtocol` | required |


### EndpointTarget — variant 3

Source: `packages/config-compiler/generated/native-config.ts:21 (EndpointTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"host"` | required |
| `context` | `EndpointContext` | required |
| `port` | `number` | required |
| `protocol` | `EndpointProtocol` | required |


### EndpointTarget — variant 4

Source: `packages/config-compiler/generated/native-config.ts:21 (EndpointTarget)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"external"` | required |
| `hostname` | `string` | required |
| `port` | `number` | required |
| `protocol` | `EndpointProtocol` | required |


### HostEnvironmentPlan

Source: `packages/config-compiler/generated/native-config.ts:5 (HostEnvironmentPlan)`.

| Field | Type | Presence |
| --- | --- | --- |
| `env_target` | `HostEnvTarget` | required |
| `bindings` | `{ [key in string]: EnvironmentBinding }` | required |


### ResolveDiagnostic

Source: `packages/config-compiler/generated/native-config.ts:80 (ResolveDiagnostic)`.

| Field | Type | Presence |
| --- | --- | --- |
| `document` | `DocumentRole` | required |
| `code` | `string` | required |
| `message` | `string` | required |
| `pointer` | `string` | required |
| `line` | `number` | required |
| `column` | `number` | required |


### FilePlan

Source: `packages/config-compiler/generated/native-config.ts:13 (FilePlan)`.

| Field | Type | Presence |
| --- | --- | --- |
| `plan_version` | `1` | required |
| `complete` | `boolean` | required |
| `workloads` | `{ [key in string]: Array<FileBinding> }` | required |
| `diagnostics` | `Array<ResolveDiagnostic>` | required |


### FileBinding

Source: `packages/config-compiler/generated/native-config.ts:12 (FileBinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `FileKind` | required |
| `name` | `string` | required |
| `source` | `FileBindingSource` | required |
| `target` | `string` | required |
| `access` | `Access` | required |
| `mode` | `string` | required |
| `uid` | `number` | optional; omitted when absent |
| `gid` | `number` | optional; omitted when absent |


### FileBindingSource — variant 1

Source: `packages/config-compiler/generated/native-config.ts:11 (FileBindingSource)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"file"` | required |
| `file` | `string` | required |


### FileBindingSource — variant 2

Source: `packages/config-compiler/generated/native-config.ts:11 (FileBindingSource)`.

| Field | Type | Presence |
| --- | --- | --- |
| `kind` | `"managed"` | required |
| `key` | `string` | required |
| `scope` | `string` | required |
| `secret` | `boolean` | required |


### HostBindingResolution

Source: `packages/config-compiler/generated/native-config.ts:19 (HostBindingResolution)`.

| Field | Type | Presence |
| --- | --- | --- |
| `bindings` | `{ [key in string]: ResolvedHostBinding }` | required |
| `removed` | `{ [key in string]: HostBindingOrigin }` | required |


### ResolvedHostBinding

Source: `packages/config-compiler/generated/native-config.ts:18 (ResolvedHostBinding)`.

| Field | Type | Presence |
| --- | --- | --- |
| `target` | `HostBindingTarget` | required |
| `origin` | `HostBindingOrigin` | required |


### RoutingResolution

Source: `packages/config-compiler/generated/native-config.ts:45 (RoutingResolution)`.

| Field | Type | Presence |
| --- | --- | --- |
| `domain` | `string` | required |
| `domain_origin` | `DomainOrigin` | required |
| `project_origin` | `string` | required |
| `aliases` | `{ [key in string]: string }` | required |
| `oauth_alias` | `string \| null` | required |
| `open_preference` | `OpenPreference` | required |
| `open_preference_origin` | `OpenPreferenceOrigin` | required |
| `open_origin` | `string` | required |
| `branch` | `string` | optional; omitted when absent |
| `routes` | `{ [key in string]: ResolvedHttpRoute }` | required |


### ResolvedHttpRoute

Source: `packages/config-compiler/generated/native-config.ts:44 (ResolvedHttpRoute)`.

| Field | Type | Presence |
| --- | --- | --- |
| `service` | `string` | required |
| `port` | `number` | required |
| `protocol` | `HttpProtocol` | required |
| `origin` | `string` | required |
| `aliases` | `{ [key in string]: string }` | required |


### HostEnvTargets

Source: `packages/config-compiler/generated/native-config.ts:33 (HostEnvTargets)`.

| Field | Type | Presence |
| --- | --- | --- |
| `include_default` | `boolean` | required |
| `workloads` | `Array<string>` | required |

## Scalar, enum and collection aliases

| Name | Exact type / choices | Pinned source |
| --- | --- | --- |
| `CheckStatus` | `"ok" \| "warn" \| "error"` | `src/commands/doctor.ts:190 (CheckStatus)` |
| `HackLocalRouteReport` | `HackLocalRouteReport.current \| HackLocalRouteReport.repairable \| HackLocalRouteReport.refused (serializer variants)` | `src/lib/native-hack-local-route.ts:711 (reportHackLocalRoute)` |
| `HackLocalRouteRefusal` | `\| "invalid-receipt" \| "pending-receipt" \| "relay-not-verified" \| "dnsmasq-config-missing" \| "unreadable-config" \| "uninspected-config-source" \| "no-managed-line" \| "unmanaged-line" \| "foreign-target" \| "foreign-resolver" \| "old-target-live" \| "non-interactive" \| "declined" \| "authorization-failed" \| "busy" \| "restart-unavailable" \| "inputs-changed" \| "no-receipt"` | `src/lib/native-hack-local-route.ts:71 (HackLocalRouteRefusal)` |
| `EnvKeyDiagnosticCode` | `\| "env-key-ok" \| "env-key-absent" \| "env-key-symlink" \| "env-key-not-regular" \| "env-key-unreadable" \| "env-key-weak-permissions" \| "env-key-wrong-owner" \| "env-key-tracked" \| "env-key-public-path" \| "env-key-wrong-length" \| "env-key-low-entropy"` | `src/lib/doctor-env-key.ts:28 (EnvKeyDiagnosticCode)` |
| `EnvKeyFindingStatus` | `"ok" \| "warn" \| "error"` | `src/lib/doctor-env-key.ts:41 (EnvKeyFindingStatus)` |
| `SetupSyncAction` | `"sync" \| "check" \| "remove"` | `src/agents/setup-sync.ts:67 (SetupSyncAction)` |
| `SetupSyncScope` | `"project" \| "global"` | `src/agents/setup-sync.ts:69 (SetupSyncScope)` |
| `SetupSyncTarget` | `\| "cursor-rules" \| "claude-hooks" \| "claude-hack-init-skill" \| "codex-hack-cli-skill" \| "codex-hack-init-skill" \| "shared-hack-cli-skill" \| "cursor-mcp" \| "claude-mcp" \| "codex-mcp" \| "agents-md" \| "claude-md" \| "retired-artifact" \| "scope-root"` | `src/agents/setup-sync.ts:71 (SetupSyncTarget)` |
| `SetupSyncStatus` | `\| "refreshed" \| "unchanged" \| "installed" \| "preserved" \| "missing" \| "removed" \| "error"` | `src/agents/setup-sync.ts:90 (SetupSyncStatus)` |
| `IntegrationPreservedReason` | `\| "customized-content" \| "missing-ownership-marker" \| "not-a-regular-file" \| "unreadable"` | `src/agents/integration-ownership.ts:32 (IntegrationPreservedReason)` |
| `NativeConfigDocumentRole` | `\| "project" \| "primary_local" \| "checkout_local" \| "request"` | `src/lib/native-config-compiler.ts:77 (NativeConfigDocumentRole)` |
| `ImportDocument` | `\| "config" \| "compose" \| "primary_local" \| "checkout_local"` | `src/lib/native-config-import-parser.ts:13 (ImportDocument)` |
| `EndpointProtocol` | `"http" \| "https" \| "tcp"` | `packages/config-compiler/generated/native-config.ts:14 (EndpointProtocol)` |
| `HttpProtocol` | `"http" \| "https"` | `packages/config-compiler/generated/native-config.ts:37 (HttpProtocol)` |
| `OpenPreference` | `"auto" \| "alias" \| "dev"` | `packages/config-compiler/generated/native-config.ts:39 (OpenPreference)` |
| `Access` | `"read-only" \| "read-write"` | `packages/config-compiler/generated/native-config.ts:64 (Access)` |
| `EndpointContext` | `"workload" \| "host"` | `packages/config-compiler/generated/native-config.ts:20 (EndpointContext)` |
| `DocumentRole` | `"project" \| "primary_local" \| "checkout_local" \| "request"` | `packages/config-compiler/generated/native-config.ts:79 (DocumentRole)` |
| `FileKind` | `"config" \| "secret"` | `packages/config-compiler/generated/native-config.ts:10 (FileKind)` |
| `HostBindingOrigin` | `"project" \| "primary_local" \| "checkout_local"` | `packages/config-compiler/generated/native-config.ts:17 (HostBindingOrigin)` |
| `DomainOrigin` | `"default" \| "global" \| "project" \| "primary_local" \| "checkout_local" \| "explicit"` | `packages/config-compiler/generated/native-config.ts:42 (DomainOrigin)` |
| `OpenPreferenceOrigin` | `"default" \| "project" \| "primary_local" \| "checkout_local"` | `packages/config-compiler/generated/native-config.ts:43 (OpenPreferenceOrigin)` |

## Contract boundaries

The CLI wrapper exposes plan as an opaque compiler-owned record, not a stable public Plan DTO. Its matching private producer model is intentionally excluded. Other named CLI projection records above have documented fields and typed dynamic map values. Shared error.detail remains unknown by its public contract. A report shape is not runtime/provider/client qualification.
