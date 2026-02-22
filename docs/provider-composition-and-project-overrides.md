# Provider Composition + Project Overrides Spec

Date: 2026-02-22
Status: Phase 1 implemented, Phase 2 in progress
Owners: multi-node / desktop / provider integrations

Follow-on:
1. GitHub SCM profile composition and project-level profile selection tracked in:
   - `T-00141`
   - `T-00142`
   - `T-00143`
   - Status update (2026-02-22): profile composition and project override wiring landed in CLI + dispatch + desktop project settings.

## Implemented in this repo

1. `controlPlane.providers` and `controlPlane.routing` schema support in config parsing/merging.
2. Deterministic route resolver with explicit precedence and typed diagnostics:
   - missing profile
   - disabled profile/provider
   - private Railway auth-source validation
3. Dispatch route wiring:
   - new `hack dispatch run --provider/--profile/--bootstrap-if-needed` flags
   - provider-aware node selection preference
   - guarded Railway bootstrap handoff when no node is reachable
   - persisted route metadata in run events/manifest/summary
4. macOS project-level execution target controls:
   - inherited global default
   - fixed node
   - provider profile
   - reset-to-inherited action
5. GitHub profile composition + precedence:
   - extension profile catalog under `controlPlane.extensions["dance.hack.github"].config.profiles`
   - global default profile via `controlPlane.extensions["dance.hack.github"].config.defaultProfile`
   - project override via `controlPlane.routing.overrides.github.profile`
   - command override via `--profile` (`hack x github ...`) and `--github-profile` (`hack dispatch run --pr`)

## Problem Statement

We currently have provider-level bootstrap flows (for example Railway) and node-level routing (`controlPlane.nodeId`), but we do not yet have a clean composition model for:

1. Global provider defaults and profiles.
2. Project-level provider/account/profile overrides.
3. Deterministic precedence between command flags, project config, and global defaults.
4. A simple macOS UX that hides advanced provider knobs by default.

This makes advanced scenarios harder than necessary (for example: one project pinned to AWS account A, another project using Railway private tailscale mode).

## Goals

1. Keep simple flows simple: global defaults + one-click bootstrap.
2. Support project-specific provider/account/profile requirements without copying large configs.
3. Preserve backward compatibility with existing `controlPlane.nodeId` behavior.
4. Ensure all sensitive values are auth refs or env refs, not plaintext config.
5. Make precedence explicit and testable.

## Non-Goals

1. Replace per-provider bootstrap commands in this phase.
2. Build all provider adapters at once (AWS first, then parity).
3. Introduce implicit trust from network presence (for example Tailscale membership alone).

## Design Principles

1. Progressive disclosure: only require provider project/profile at first; hide advanced flags under an advanced section.
2. Composition over duplication: projects reference global profiles and override only needed fields.
3. Explicit precedence: command > project > global > provider hard defaults.
4. Secure by reference: secret material stored in configured secret backend, referenced by auth refs.

## Terminology

1. Provider: bootstrap/control integration (railway, aws, gcp, hetzner).
2. Profile: named provider configuration unit (account/project/environment/auth refs/default networking mode).
3. Project override: project-local selection of provider/profile and optional field overrides.
4. Route target: resolved execution destination for dispatch/bootstrap.

## Config Model (Proposed)

### Global config (`~/.hack/hack.config.json`)

```json
{
  "controlPlane": {
    "providers": {
      "defaultProvider": "railway",
      "defaultProfile": "default",
      "profiles": {
        "railway/default": {
          "provider": "railway",
          "project": "hack-node-runtime",
          "environment": "production",
          "privateNetworking": true,
          "labelsCsv": "railway,linux,container",
          "createService": true,
          "auth": {
            "tailscaleAuthKey": "tskey-auth-..."
          }
        },
        "aws/prod-account-a": {
          "provider": "aws",
          "region": "us-east-1",
          "accountId": "123456789012",
          "ssmAuthRef": "aws-prod-a",
          "privateNetworking": true
        }
      }
    }
  }
}
```

Notes:
1. Profile key format is `<provider>/<name>` for uniqueness.
2. Provider-specific fields are validated by provider adapter schema.
3. For private Railway routing, set `auth.tailscaleAuthKey` (or use `HACK_TAILSCALE_AUTH_KEY` at runtime).

### Project config (`.hack/hack.config.json`)

```json
{
  "controlPlane": {
    "nodeId": "",
    "routing": {
      "provider": "aws",
      "profile": "aws/prod-account-a",
      "mode": "prefer_existing_then_bootstrap",
      "bootstrap": {
        "enabled": true,
        "setAsProjectNode": true
      },
      "overrides": {
        "region": "us-west-2",
        "labelsCsv": "aws,project-x"
      }
    }
  }
}
```

Notes:
1. `controlPlane.nodeId` remains highest-priority project pin for compatibility.
2. `routing.*` is used when `nodeId` is unset or invalid.
3. `overrides` is a shallow provider-field overlay on top of selected profile.

## Resolution Precedence (Authoritative)

For both dispatch and provider-driven bootstrap:

1. Command flags (`--node`, `--provider`, `--profile`, explicit provider flags).
2. Project `controlPlane.nodeId` (if valid and reachable).
3. Project `controlPlane.routing` (`provider` + `profile` + overrides).
4. Global `controlPlane.providers.defaultProvider/defaultProfile`.
5. Provider adapter hard defaults.

If resolution fails at any stage, return a typed error with actionable remediation (missing profile/auth ref/provider disabled).

## Runtime Behavior

### Dispatch selection

1. If node resolves directly, use existing node path.
2. If no node resolves and routing mode allows bootstrap, invoke provider adapter bootstrap.
3. Register resulting node and optionally set project-level affinity (`setAsProjectNode`).
4. Continue with workspace ensure + job launch.

### Bootstrap behavior

1. Build effective provider input from profile + overrides + command flags.
2. Validate required fields for the selected provider.
3. Resolve auth refs through configured secrets backend.
4. Run provider bootstrap command/adapter and register node.

## macOS UX Composition

### Global Extensions / Provider defaults

1. Keep existing provider settings pages as global defaults/profile editors.
2. Expose profile list with "Default" marker.
3. Keep advanced provider fields collapsed.

### Topology

1. "Add remote node" starts from provider + profile picker.
2. Inherit defaults automatically and show only required fields first.
3. Offer advanced overrides inline before bootstrap.

### Project settings

1. Add "Execution target" section:
   - Fixed node
   - Provider profile
   - Auto (default provider/profile)
2. Show effective source chips per field:
   - command
   - project override
   - profile/global
3. Allow "Reset to inherited" per override field.

## Provider Adapter Contract (Unified)

Each adapter implements:

1. `validateProfile(profile)`
2. `validateOverrides(overrides)`
3. `resolveEffectiveInput({ profile, overrides, flags })`
4. `bootstrapNode(effectiveInput)`
5. `describeRequirements()` for CLI/UI diagnostics

This keeps dispatch/bootstrap flow generic while provider internals stay isolated.

## Security + Secrets

1. Provider credentials reference secret backend entries (`authRef`) or approved env refs.
2. Resolution path respects `controlPlane.secrets.backend` contract.
3. No raw secrets persisted in profile/project config.
4. Audit each bootstrap and dispatch decision with resolved provider/profile identity (redacted).

## Migration Plan

### Phase 1

1. Add `controlPlane.providers` + `controlPlane.routing` schema.
2. Implement precedence resolver used by `hack dispatch run` and provider bootstrap entrypoints.
3. Keep legacy `controlPlane.nodeId` unchanged.

### Phase 2

1. Add project-level provider/profile override commands.
2. Add desktop project-level routing UI.
3. Add adapter skeletons for AWS/GCP/Hetzner using the same contract.

### Phase 3

1. Add optional auto-bootstrap mode in dispatch when no node exists.
2. Persist deterministic route selection metadata in run artifacts.

## CLI Additions (Proposed)

1. `hack provider profile list`
2. `hack provider profile show <id>`
3. `hack provider profile save --provider <name> --profile <id> ...`
4. `hack project routing set --provider <name> --profile <id> [--mode <...>]`
5. `hack project routing clear`
6. `hack dispatch plan --project <name|id> [--json]` (preview effective route decision)

## Test Plan

### Unit

1. Precedence resolver matrix.
2. Profile + override merge semantics.
3. Secret/auth ref resolution behavior across backends.
4. Validation errors for missing provider/profile/auth fields.

### Integration

1. Dispatch with project override to provider profile.
2. Bootstrap register + route reuse with `setAsProjectNode` enabled.
3. Failure behavior when provider auth is missing/expired.

### E2E

1. Railway profile defaults + project override to dedicated service.
2. AWS profile switch per project (account/region) with isolated routing.
3. Desktop flow: set project override, run dispatch, verify target node/provider used.

## Open Questions

1. Should project routing override live in `controlPlane.routing` or under `controlPlane.cluster.projects[projectId]` for multi-project global control?
2. Should provider profiles support inheritance (for example `aws/base` + project deltas) or remain flat for simplicity?
3. Should successful auto-bootstrap always pin `controlPlane.nodeId`, or only when explicitly requested?

## Immediate Implementation Slice

1. Completed: schema + resolver + dispatch route metadata.
2. Completed: desktop project-level execution target controls.
3. In progress: provider profile authoring/list commands and profile-focused UX cleanup on provider settings pages.
