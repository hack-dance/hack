# Project inventory and environment reports

Public report shapes at `91b14bf0abb17602142425de0d02628a3e8a2615`. This page describes CLI projections, not private daemon/compiler/guest protocols. See [Command and output contracts](command-contracts.md) for envelope and exit semantics.
v4 has no MCP env.keys/env.explain registrations. Use the version-specific CLI inspection contract rather than assuming v5 tools exist.

## Project inventory

`hack projects --json` and status inventory emit a bare report. `--summary` selects the summary projection; `--meta` adds optional metadata. Missing or null observations mean unavailable/unknown, not proof that resources or processes do not exist. Runtime health in report data is separate from exit status.

| Selection | Report effect |
| --- | --- |
| Default full listing | projects[] contains serialized project views, runtime observations, sessions, worktrees and lifecycle descriptions |
| --summary | detail_level is summary; rows contain identity/status and counts instead of full nested runtime views |
| --meta | meta is present on each row; it may be null |

### Project metadata types

The following declarations are copied from the pinned public metadata producers. Optional properties may be omitted. Nullable properties are present but may be null. Raw metadata contains repository paths and command descriptions; it is not a redacted sharing format. Ownership shared/broker names are retained compatibility metadata, not hosted team management or an access-control API.

[Pinned src/lib/project-meta.ts](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/lib/project-meta.ts).

```ts
export type GitWorktreeMeta = {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
};

export type GitMeta = {
  readonly isRepo: boolean;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean | null;
  readonly dirty: boolean | null;
  readonly localBranchCount: number | null;
  readonly worktrees: readonly GitWorktreeMeta[] | null;
  readonly error: string | null;
};

export type HackBranchesMeta = {
  readonly path: string;
  readonly parseError: string | null;
  readonly branches: readonly BranchEntry[];
};

export type EnvVarMeta = {
  readonly key: string;
  readonly required: boolean;
  readonly source: HackEnvSource;
  readonly services: readonly string[] | null;
  readonly description?: string;
  readonly resolvedFrom:
    | "dotenv"
    | "process"
    | "keychain"
    | "portable_backend"
    | null;
  readonly hasValue: boolean;
};

export type EnvMeta = {
  readonly contractPath: string;
  readonly contractExists: boolean;
  readonly contractParseError: string | null;
  readonly vars: readonly EnvVarMeta[];
  readonly missingRequired: readonly string[];
};

export type SessionsMeta = {
  readonly sessions: readonly MuxSession[];
};

export type ComposeBuildServiceMeta = {
  readonly service: string;
  readonly build: boolean;
  readonly context: string | null;
  readonly dockerfile: string | null;
  readonly dockerfilePath: string | null;
  readonly dockerfileExists: boolean | null;
};

export type ComposeBuildMeta = {
  readonly services: readonly ComposeBuildServiceMeta[];
};

export type ProjectMeta = {
  readonly ownership: ProjectOwnershipConfig | null;
  readonly configError: string | null;
  readonly git: GitMeta;
  readonly hackBranches: HackBranchesMeta;
  readonly env: EnvMeta;
  readonly sessions: SessionsMeta;
  readonly composeBuild: ComposeBuildMeta;
};

```

[Pinned src/lib/branches.ts](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/lib/branches.ts).

```ts
export type BranchEntry = {
  readonly name: string;
  readonly slug: string;
  readonly note?: string;
  readonly created_at?: string;
  readonly last_used_at?: string;
};

```

[Pinned src/mux/mux-backend.ts](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mux/mux-backend.ts).

```ts
export type MuxBackendName = "tmux" | "zellij";

export type MuxSession = {
  readonly backend: MuxBackendName;
  readonly name: string;
  readonly attached: boolean | null;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: string | null;
};

```

[Pinned src/lib/hack-env.ts](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/lib/hack-env.ts).

```ts
export type HackEnvSource = "plain_env" | "keychain";

```

[Pinned src/lib/project.ts](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/lib/project.ts).

```ts
export type ProjectOwnershipMode = "local" | "shared";

export type ProjectOwnershipOwnerType = "user" | "team" | "organization";

export type ProjectOwnershipManager = "local" | "broker";

export interface ProjectOwnershipConfig {
  readonly mode: ProjectOwnershipMode;
  readonly ownerType: ProjectOwnershipOwnerType;
  readonly ownerId: string | null;
  readonly managedBy: ProjectOwnershipManager;
}

```

### Serialized runtime observations

The public runtime projection uses snake_case names and arrays, not the internal Map representation. It contains project:string, working_dir:string|null and services[]. Each service has service:string and containers[]. Container fields: id/state/status/name/ports:string; working_dir/image:string|null; labels:string-map|null; mounts[] and networks[]. Mount fields: type/source/destination/mode:string, name:string|null, rw:boolean|null. Network fields: name:string, ip_address/gateway:string|null, aliases:string[]. Labels and engine state strings remain open values.

The raw ps items[] engine report is a different surface from this normalized projects[].runtime projection. Do not infer that an open engine report makes Hack-owned wrapper fields unknowable.

### Sessions and lifecycle in full project rows

Full-row sessions[] uses name:string, backend:tmux|zellij, source:hack|external, attached:boolean, path:string|null, windows:number|null and created_at:number|null. This numeric creation observation is distinct from the metadata MuxSession.createdAt string|null above; do not silently convert one contract into the other.

worktrees is null or an array of path:string, branch:string|null and last_seen_at:string. lifecycle is null or an object with up_before/up_after/down_before/down_after arrays and processes[]. Hook rows carry name:string|null, command:string, cwd:string|null and service:string; persistent:true is emitted only when true. Process rows require name/command/service:string and cwd:string|null.

## Environment list reports

Raw CLI env reports can contain values. Default secret masking does not make an entire report value-free: plaintext values still appear. Use a value-free inspection interface for agent metadata, and avoid copying raw env reports into logs or messages. These examples describe shapes only and contain no real values.

The legacy contract and managed YAML contract are separate variants. Both use vars[] in raw CLI output. MCP env.keys, where available, returns a narrower keys[] projection and withholds raw stdout/stderr.

| Field | Legacy contract | Managed YAML |
| --- | --- | --- |
| project | string | string |
| env_selection | requested/default/effective/overlay_path:string or null; overlay_exists:boolean | same public field names |
| format | omitted in legacy list | project_env_config_v1 |
| status | classification plus summary/detail strings | YAML classification plus summary/detail strings |
| storage | legacy contract/local/portable compatibility report | canonical YAML/project-key report; contract member is not added by this builder |
| warnings | array of warning records | not emitted by modern list builder |
| vars | array of resolved variable records | array of selected-scope records |
| missing_required | string[] | empty array in modern list builder |
| files/scopes/unknown_scopes/selected_scope | omitted | string[]/string[]/string[]/string |
| materialized_keys | omitted | sorted string[] unless values were explicitly requested |
| materialized | omitted | string map only on explicit value-output path |

### Variable records

| Field | Legacy | Managed YAML |
| --- | --- | --- |
| key | string | string |
| required | boolean from contract | false |
| source | plain_env or keychain | plain_env or keychain (secret marker) |
| services | string[] or null | winning non-global scope as one-element array, otherwise null |
| resolved_from | dotenv/process/keychain/portable_backend or null | project_env_config |
| storage | HackEnvValueStorageJson | kind/plaintext-or-secret, backend/project_env_config, location:string, mode/yaml, trust_model:string, classification |
| value | string or null; secret default mask is *** | string; secret default mask is *** |

The source field is a compatibility label: keychain on a managed YAML record marks a secret; it does not mean that YAML ciphertext moved to OS keychain storage. Files and scopes are selected by the matching version parser. v4 rejects YAML null; v5 uses it as a removal marker.

### Legacy storage and classification types

These type names describe serialized report metadata. A retained backend/classification value is not qualification of every backend or hosted shared-state feature. Modern YAML storage has its own concrete projection described above.

```ts
export type HackEnvSharedState =
  | "local_only"
  | "plaintext_compatible"
  | "portable_bundle"
  | "broker_managed";
```

```ts
export type HackEnvJsonClassification = {
  readonly trust_model: string;
  readonly custody: string;
  readonly portability: string;
  readonly shared_state: HackEnvSharedState;
};
```

```ts
export type HackEnvValueStorageJson = {
  readonly kind: "plaintext" | "secret";
  readonly backend: string;
  readonly location: string;
  readonly mode: string;
  readonly trust_model: string;
  readonly classification: HackEnvJsonClassification;
};
```

```ts
export type HackEnvStorageJson = {
  readonly contract: {
    readonly path: string;
    readonly trust_model: string;
    readonly classification: HackEnvJsonClassification;
  };
  readonly local_plaintext: {
    readonly path: string;
    readonly exists: boolean;
    readonly trust_model: string;
    readonly mirrored_to_backend: boolean;
    readonly fallback: {
      readonly enabled: boolean;
      readonly source: string;
      readonly trust_model: string;
      readonly classification: HackEnvJsonClassification;
    };
    readonly classification: HackEnvJsonClassification;
  };
  readonly local_secrets: {
    readonly backend: string;
    readonly location: string;
    readonly mode: string;
    readonly provider: string | null;
    readonly trust_model: string;
    readonly classification: HackEnvJsonClassification;
  };
  readonly portable_state: {
    readonly status: string;
    readonly trust_model: string;
    readonly message: string;
    readonly classification: HackEnvJsonClassification;
  };
  readonly compatibility_mode: {
    readonly plaintext_target: string;
    readonly secret_backend: string;
    readonly plaintext_mirrored_to_backend: boolean;
    readonly summary: string;
  };
};
```

```ts
export type HackEnvAggregateStatusJson = HackEnvJsonClassification & {
  readonly summary: string;
  readonly detail: string;
};
```

### Legacy warnings

Warnings contain kind:overlay_plaintext_ignored_for_secret_contract, key:string, overlay_path:string, services:string[]|null and message:string. This is a report of contract/source mismatch; it is not a secret value. Missing-required names are reported separately.

## Scope and provenance

[Project view serializer](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/lib/project-views.ts), [runtime serializer](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/lib/runtime-projects.ts), [env output builders](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/commands/env.ts), and [env storage serializers](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/lib/hack-env-status.ts) are the authority for these projections. This documents public fields from source, not successful runtime, cloud or client qualification. Unknown application map keys and external engine values are intentionally open; owned report fields above are not treated as open merely because the JSON emitter returns Record<string, unknown>.

## Applying environment changes

`hack env apply` is a service restart wrapper. It does not return the env-list report above: it forwards restart, a concrete service, --path and selected env/JSON arguments, then returns the child exit code/output. Service/JSON forms remain subject to that version and backend admission. This is not an atomic multi-service env transaction.

v4 trims the service and refuses an empty name or global; it forwards a truthy env option. next.5 uses stricter service/selection parsers rather than widening this contract.

## Listing field types

--summary and --timings require --json. --summary cannot be combined with --meta or --details. Timings are a separate numeric diagnostic record on stderr; they do not change stdout into a timing envelope.

| Top-level field | Type / presence |
| --- | --- |
| generated_at | string timestamp |
| filter | string or null |
| include_global/include_unregistered/include_meta | boolean |
| detail_level | summary when summary selected; otherwise omitted |
| runtime_ok | boolean |
| runtime_error/runtime_checked_at/runtime_last_ok_at/runtime_reset_at/runtime_reset_summary/runtime_last_repair_at/runtime_repair_action/runtime_next_step | string or null |
| runtime_reset_count | number |
| runtime_reset_changes | string[] |
| runtime_repair_outcome | stabilized, manual_action_required or null |
| projects | project row array |

Summary rows contain project_id:string|null; name:string; repo_root/dev_host:string|null; status:running/stopped/missing/unregistered/unknown; runtime_status below; defined_service_count:number|null; host_process_count/container_count/running_container_count/branch_count/session_count:number. Counts describe the gathered snapshot, not ongoing ownership or liveness.

runtime_status is running/stopped/missing/unknown/not_configured in v4.

Full rows additionally contain project_dir:string|null; ownership:compatibility object|null with mode/owner_type/owner_id/managed_by; defined_services/extensions_enabled/features:string[]|null; service_hosts:string-to-string-array map|null; runtime_configured:boolean|null; normalized runtime|null; branch_runtime array of branch:string plus runtime; sessions/worktrees/lifecycle as described above; kind:registered/unregistered. The ownership data is descriptive, not authorization for hosted features.

## Managed YAML classification values

Managed YAML does not use the legacy classification enum above. The exact classification groups emitted by the modern builder are:

| Group | trust_model | custody | portability | shared_state |
| --- | --- | --- | --- | --- |
| YAML aggregate/portable state | repo_managed_env_config | repo_tracked_env_config | portable_with_out_of_band_key | repo_managed_overlay |
| Compatibility plaintext | compatibility_output | local_plaintext_file | local_only | compatibility_only |
| Local project key | local_secret_key | local_secret_key | local_only | local_only |

