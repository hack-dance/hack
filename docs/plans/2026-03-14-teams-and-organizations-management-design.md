# Teams and Organizations Management Design

## Context

Hack already has partial team and organization signals in broker-backed auth and integration state, but the administrative contract is still implicit. That is acceptable for single-user local workflows and unacceptable for shared ownership, project transfer, or environment sharing.

The missing piece is not only storage. The product needs an explicit command model, explicit trust boundaries, and explicit privilege escalation rules so users can answer three questions without guessing:

- who owns this resource?
- who can act on it?
- is this operation local-only or broker-mediated?

## Goals

- Define a command model for organizations, teams, projects, and shared envs.
- Make privileges explicit and secure by default.
- Tie team/org administration directly to project ownership and env sharing.
- Preserve Hack's local-first workflow while making shared admin operations clearly remote.
- Break the work into child issues that cover lifecycle, permissions, and admin boundaries.

## Non-Goals

- Do not make local `hack up`, `hack down`, `hack logs`, `hack session`, or local tickets require sign-in.
- Do not introduce hidden auto-sharing of local secrets or project state.
- Do not collapse provider identity into Hack org/team identity.
- Do not design billing, quotas, or enterprise SSO in this slice.

## Approaches Considered

### 1. Broker-first administration everywhere

Treat all team, org, project ownership, and env management as broker-owned from day one.

Why reject it:
- It conflicts with the repo's existing local-first behavior.
- It would turn previously local project/admin actions into authenticated cloud operations.
- It creates a larger migration and failure surface than the milestone requires.

### 2. Local-first with explicit broker escalation

Keep local workflows local. Introduce org/team lifecycle, shared project ownership, and shared env operations as broker-mediated features with explicit commands and explicit auth requirements.

Why recommend it:
- It matches current `hack auth`, env contract, and gateway boundary patterns.
- It preserves offline and single-user workflows.
- It gives shared collaboration a trustworthy model without hidden trust assumptions.

### 3. Team-only model with organizations deferred

Support teams as the top-level shared scope now and postpone orgs.

Why reject it:
- The current broker auth responses already expose organization and team context.
- Project transfer, team creation, and future policy inheritance are cleaner with an explicit org container.
- Deferring orgs would force a second administrative migration later.

## Approved Direction

Adopt approach 2: local-first with explicit broker escalation.

Core rule:

- local-only resources stay local and unauthenticated
- shared resources require Hack auth and broker mediation

There is no silent promotion from local to shared.

## Resource Model

Hack administration needs four resource layers:

### User

- The local operator on a machine.
- May also be an authenticated Hack account principal.
- Owns local-only projects and local-only env values by default.

### Organization

- Top-level shared administrative boundary.
- Owns teams.
- Can own projects directly when the project is meant to be org-wide rather than team-scoped.

### Team

- Collaboration boundary inside an organization.
- Primary shared owner for most projects.
- Membership alone does not grant env write access.

### Project

- Runtime and collaboration unit for a repo/workspace.
- Has an explicit owner scope:
  - `user`
  - `team`
  - `organization`
- Ownership determines who can administer access, but does not automatically expose secret values.

### Environment Bundle

- Named set of declared env keys and optionally broker-portable secret material.
- Has its own access policy and lifecycle.
- Can be attached to a project, but attachment is not the same as disclosure.

## Ownership and Scope Rules

### Project ownership

Every project must resolve to one of two modes:

- `local`
  - owned by the current user/device context
  - no broker dependency
- `shared`
  - owned by a Hack team or organization
  - broker-backed metadata and access grants

Default is `local`.

Projects are only promoted to `shared` through an explicit transfer/share command.

### Env ownership

Every env bundle must resolve to one of three policies:

- `local_only`
  - values remain in `.hack/.env`, local keychain, or configured local secret backend
- `shared_metadata_only`
  - contract, descriptions, and required keys are shared; values remain local
- `shared_values`
  - encrypted values are broker-mediated and access-controlled

Default is `local_only`.

The default shared policy for newly shared projects is still `local_only`. Sharing a project must not silently share secrets.

## Role Model

Roles are intentionally minimal and explicit.

### Organization roles

- `org_owner`
  - delete org
  - transfer org ownership
  - manage org admins
  - create/delete teams
  - override project ownership within the org
- `org_admin`
  - invite/remove members
  - create/archive teams
  - manage shared projects and grants
  - cannot delete org or transfer org ownership
- `org_member`
  - can view org/team membership they belong to
  - no admin rights by default

### Team roles

- `team_admin`
  - manage team membership
  - administer team-owned projects
  - administer team env grants
- `team_member`
  - use team resources only where separately granted

### Project roles

- `project_owner`
  - transfer project ownership
  - grant/revoke project access
  - manage project-level policies
- `project_maintainer`
  - manage project runtime/admin settings
  - cannot transfer ownership
- `project_operator`
  - run approved project actions
  - cannot change access policy
- `project_viewer`
  - inspect metadata and status only

### Env roles

- `env_admin`
  - rotate values
  - grant/revoke env access
  - change env sharing mode
- `env_consumer`
  - resolve values for permitted runs
- `env_metadata_viewer`
  - inspect contract and state without value access

## Secure-by-Default Rules

- Local projects start as `local` and private.
- Shared projects do not automatically disclose env values.
- Team membership does not automatically grant project admin.
- Project access does not automatically grant env value access.
- Broker writes require authenticated Hack account context.
- Destructive admin actions require explicit target scope and fail closed when scope is ambiguous.
- CLI defaults to read-only inspection when ownership or auth state is unresolved.

## Command Model

The command model should reflect the trust boundary instead of hiding it.

### `hack auth`

Purpose:
- authenticate the Hack account used for broker-mediated operations

Rules:
- remains separate from provider auth
- required for org/team/shared-project/shared-env admin
- not required for local-only runtime commands

### `hack org`

Broker-mediated only.

Primary surface:
- `hack org list`
- `hack org show <org>`
- `hack org create`
- `hack org invite`
- `hack org members list`
- `hack org members remove`
- `hack org teams list`

Rule:
- no local-only `org` mode; organizations are shared constructs

### `hack team`

Broker-mediated only.

Primary surface:
- `hack team list`
- `hack team show <team>`
- `hack team create`
- `hack team archive <team>`
- `hack team members list`
- `hack team members add`
- `hack team members remove`

Rule:
- teams only exist inside an organization
- team lifecycle must always be explicit and authenticated

### `hack project owner`

Hybrid surface.

Primary surface:
- `hack project owner show`
- `hack project owner set --user self`
- `hack project owner transfer --team <team>`
- `hack project owner transfer --org <org>`

Rules:
- `show` works for local and shared projects
- setting local user ownership remains local-only
- transfer to team/org is broker-mediated and explicit
- transfer must not succeed unless the caller holds the required admin role in the target scope

### `hack project access`

Hybrid surface with a sharp boundary.

Primary surface:
- `hack project access list`
- `hack project access grant`
- `hack project access revoke`

Rules:
- local projects may expose only local access metadata if any
- team/org grants are only valid for shared projects
- commands fail with a clear error if the project is still local

### `hack env`

Split into local env management and shared env management.

Local surfaces remain:
- `hack env list`
- `hack env set`
- `hack env unset`
- `hack env backend ...`

New shared surfaces:
- `hack env share enable`
- `hack env share disable`
- `hack env access list`
- `hack env access grant`
- `hack env access revoke`
- `hack env rotate`

Rules:
- plain `hack env set` stays local by default
- sharing env metadata or values is a separate command
- secret value disclosure requires both project context and env grant context

## Local vs Broker Boundary

This boundary must be product-visible and documentation-visible.

### Local-only operations

- local project/runtime management
- local sessions
- local tickets
- local `.hack/.env` editing
- local secret backend configuration
- local project owner inspection
- local user ownership assignment

### Broker-mediated operations

- organization lifecycle
- team lifecycle
- org/team membership changes
- project transfer to team/org ownership
- shared project access grants
- shared env metadata/value grants
- shared env rotation
- audit logging for shared admin actions

### Boundary rule

If the operation changes shared identity, shared membership, shared project access, or shared secret custody, it is broker-mediated.

If the operation only changes device-local runtime state, it is local-only.

## Project Ownership Contract

Projects need explicit ownership metadata, not inference from git remotes, provider accounts, or current user.

Required project fields:

- `ownership.mode`: `local` | `shared`
- `ownership.ownerType`: `user` | `team` | `organization`
- `ownership.ownerId`
- `ownership.managedBy`: `local` | `broker`

Semantics:

- `local` implies `managedBy=local`
- `shared` implies `managedBy=broker`
- a project cannot be both local and shared
- access grants are ignored for purely local projects

## Env Sharing Contract

Env sharing must be explicit at both the bundle and grant levels.

Required env policy fields:

- `sharing.mode`: `local_only` | `shared_metadata_only` | `shared_values`
- `sharing.ownerType`
- `sharing.ownerId`
- `sharing.managedBy`

Rules:

- project ownership does not override env policy
- a shared project may still use local-only env values
- `shared_values` requires encrypted broker custody and audit events
- value resolution for remote/shared operations must check env grants separately from project grants

## Lifecycle Coverage

The child work needs to cover the full lifecycle:

### Organization lifecycle

- create
- invite members
- promote/demote admins
- create/archive teams
- transfer or dissolve shared ownership safely

### Team lifecycle

- create
- add/remove members
- grant/revoke admin
- archive team without orphaning projects or env bundles

### Project lifecycle

- local project creation
- explicit promotion to shared ownership
- access grant management
- transfer between team and org scopes
- archive/delete behavior for shared projects

### Env lifecycle

- local contract declaration
- enable sharing
- grant consumer/admin access
- rotate or revoke values
- downgrade back to metadata-only or local-only when allowed

## Audit and Enforcement Direction

Shared admin operations need durable audit events with:

- acting Hack user
- target resource type and id
- previous and new role/policy state
- project/env scope
- timestamp

Enforcement must happen in two places:

- broker-side authorization for shared operations
- client-side refusal to pretend a local command can mutate shared state

The CLI should never imply success for a shared admin mutation that the broker did not authorize.

## Child Workstreams

The program should split into the following child issues:

1. Org and team lifecycle primitives
2. Org/team membership and RBAC enforcement
3. Project ownership metadata and transfer flow
4. Project access grants and permission checks
5. Shared env policy, grants, and encrypted value custody
6. CLI command/help/docs updates for local vs broker boundaries
7. Audit events and operator-facing diagnostics

## Proposed Child Tickets

The queue for this program is:

1. `T-00001` Org and Team Lifecycle Primitives
2. `T-00002` Org/Team Membership and RBAC Enforcement
3. `T-00003` Project Ownership Metadata and Transfer Flow
4. `T-00004` Project Access Grants and Permission Checks
5. `T-00005` Shared Env Policy, Grants, and Encrypted Value Custody
6. `T-00006` CLI Help and Docs for Local vs Broker Admin Boundaries
7. `T-00007` Audit Events and Diagnostics for Shared Admin Operations

Recommended dependency order:

- Ticket 2 depends on Ticket 1
- Ticket 3 depends on Ticket 1
- Ticket 4 depends on Tickets 2 and 3
- Ticket 5 depends on Tickets 2 and 3
- Ticket 6 depends on Tickets 1, 3, 4, and 5
- Ticket 7 depends on Tickets 2, 4, and 5

Coverage rule:

- Tickets 1 and 2 own lifecycle and authorization primitives
- Tickets 3 and 4 own project ownership and access semantics
- Ticket 5 owns env sharing and secret custody semantics
- Tickets 6 and 7 own the operator-visible trust boundary, help text, and audit trail

## Acceptance Mapping

### Understandable operations without hidden trust assumptions

Covered by:
- explicit resource model
- explicit command namespaces
- explicit local vs broker rule

### Roles and privileges explicit and safe by default

Covered by:
- minimal role model
- separate project and env grants
- no silent sharing or privilege inheritance

### Child issues cover lifecycle, permissions, and admin boundaries

Covered by:
- lifecycle sections for org/team/project/env
- seven child workstreams above

## Open Questions

- Whether org-owned projects should be common or reserved for a small set of shared infrastructure projects.
- Whether shared env value access should support approval workflows later, or remain direct grant-based access for now.
- Whether the first implementation surface should be CLI-only or should include macOS admin views in the same milestone.
