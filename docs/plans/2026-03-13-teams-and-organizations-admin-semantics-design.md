# Teams And Organizations Admin Semantics Design

## Context

Hack already has a real Hack-account model in flight:

- `hack auth` establishes the local Hack session
- broker-owned resources can already be scoped to `userId`, `organizationId`, and `teamId`
- the auth broker already exposes active org/team metadata to CLI consumers

What is still missing is the user-facing admin contract for:

- creating organizations and teams
- inviting or directly adding members
- accepting, declining, and removing membership
- explaining what happens when org and team access overlap

Without that contract, implementation work will drift into hidden admin behavior, especially around team onboarding and org removal cascades.

## Goals

- Define a command surface that is explicit enough to implement directly.
- Make pending, active, and removed membership states predictable.
- Remove hidden privilege escalation and hidden access inheritance.
- Keep the common onboarding path concise without making team access implicit.
- Define UX rules for confirmations, audit visibility, and safe defaults.

## Non-Goals

- Full role and permission matrix design beyond minimal creator/admin defaults.
- Billing, seat management, or SCIM-style bulk provisioning.
- Team rename/archive or organization deletion flows.
- Browser UI design for an admin console.

## Approaches Considered

### 1. Put everything under `hack auth`

Examples:

- `hack auth org create`
- `hack auth team create`
- `hack auth member invite`

Pros:

- Keeps account and admin flows under one top-level area.
- Matches the fact that org/team data is tied to Hack auth.

Cons:

- Makes durable resources look like session subcommands.
- Hurts discoverability for day-to-day admin work.
- Becomes awkward once `org` and `team` have multiple sub-areas.

### 2. Top-level `hack org` and `hack team` commands with invite acceptance under `hack auth` (recommended)

Examples:

- `hack org create`
- `hack org member invite`
- `hack team member remove`
- `hack auth invite accept`

Pros:

- Keeps durable resources discoverable at the top level.
- Keeps personal invitation acceptance under the existing identity/session area.
- Maps cleanly to resource-local help and future growth.

Cons:

- Adds two new top-level command groups.
- Requires clear docs for where invite acceptance lives.

### 3. One generic `hack membership` surface

Examples:

- `hack membership invite --scope org:hack`
- `hack membership remove --scope team:hack/cli`

Pros:

- Uniform implementation surface.
- Easy to script mechanically.

Cons:

- Harder for humans to learn.
- Pushes core semantics into flags instead of verbs.
- Makes `hack help` less readable.

## Recommended Design

Adopt approach 2:

- `hack org` owns organization resource management and org-scoped membership
- `hack team` owns team resource management and team-scoped membership
- `hack auth invite ...` owns recipient-side invite acceptance and decline

This keeps resource management explicit while preserving a clear boundary:

- admins act on orgs and teams
- invited users act on their own invitations through `auth`

## Resource Model

### Organization

An organization is the parent scope for one or more teams.

Creating an organization:

- creates the org record
- makes the creator the initial active org owner/admin
- does not create any teams implicitly

### Team

A team always belongs to exactly one organization.

Creating a team:

- requires an explicit `--org <org>`
- creates the team record inside that organization
- makes the creator an active team admin/manager for that team
- does not invite or add any other members implicitly

### Membership

Membership is always scoped to exactly one resource:

- organization membership
- team membership

Team membership depends on organization membership.

That dependency is explicit:

- an active team member must also be an active org member
- a pending team invite for a non-org member must be created together with an org invite
- removing org membership removes access to all teams in that org

## Command Surface

### Organization commands

- `hack org create <slug> --name <display-name>`
- `hack org list`
- `hack org show <org>`
- `hack org member list <org> [--state pending|active|removed|all]`
- `hack org member invite <org> <email> [--team <team>...]`
- `hack org member add <org> <user>`
- `hack org member remove <org> <member>`

### Team commands

- `hack team create <slug> --org <org> --name <display-name>`
- `hack team list --org <org>`
- `hack team show <team> --org <org>`
- `hack team member list <team> --org <org> [--state pending|active|removed|all]`
- `hack team member invite <team> --org <org> <email>`
- `hack team member add <team> --org <org> <user>`
- `hack team member remove <team> --org <org> <member>`

### Invite-recipient commands

- `hack auth invites`
- `hack auth invite accept <invite-id>`
- `hack auth invite decline <invite-id>`

## Command Semantics

### `invite` means pending access

`invite` is for an email-address target that may or may not already have a Hack account.

Effects:

- creates a membership in `pending`
- does not grant access yet
- sends or reissues an invitation link

Safe default:

- inviting an already-active member fails with an explicit `already_active` result
- inviting an already-pending member fails with `already_pending` unless the user runs a future dedicated resend/reinvite command

### `add` means immediate active access

`add` is for a target that already resolves to an existing Hack user.

Effects:

- creates or reactivates the membership in `active`
- grants access immediately
- does not send an invite email

Safe default:

- `add` fails if the target cannot be resolved to an existing Hack user
- the fallback guidance is to use `invite`

### `remove` means access revoked or invite canceled

`remove` is the admin-side verb for both pending and active memberships.

Effects:

- `pending -> removed`: cancels the invite before acceptance
- `active -> removed`: revokes access immediately

The CLI should say which path happened in plain language:

- `Invite revoked`
- `Access removed`

### Recipient acceptance is explicit

Only the invited user can move their own invite from `pending` to `active` through:

- `hack auth invite accept <invite-id>`

Decline is also explicit:

- `hack auth invite decline <invite-id>`

That transition results in:

- `pending -> active` on accept
- `pending -> removed` on decline

## Membership Lifecycle Model

### States

- `pending`: membership has been proposed but does not grant access
- `active`: membership grants access to the scope
- `removed`: membership no longer grants access and remains visible in audit history

### State transitions

- `invite` creates `pending`
- `add` creates `active`
- `accept` moves `pending -> active`
- `decline` moves `pending -> removed`
- `remove` moves `pending -> removed`
- `remove` moves `active -> removed`
- `invite` on a previously removed membership creates a new pending invite attempt
- `add` on a previously removed membership reactivates access immediately

### Org and team coupling

The rules for parent and child scopes are:

- org membership is the parent grant
- team membership is invalid without org membership
- removing org membership cascades all pending and active team memberships in that org to `removed`
- removing a team membership does not affect org membership

### Recommended onboarding path

The common case should be:

- use `hack org member invite <org> <email> --team <team>...` for a new person
- use `hack team member add <team> --org <org> <user>` only when the user is already an active org member

That gives one explicit onboarding command for new people without requiring team commands to invent implicit org access.

## Output And Audit Contract

Every membership mutation should return the same core fields in human and JSON output:

- `scopeType`: `organization` or `team`
- `scopeId`
- `memberUserId` when known
- `memberEmail`
- `state`
- `previousState`
- `changedBy`
- `changedAt`
- `reason`
- `cascade` details when other memberships were affected

### Audit visibility rules

- default member lists show `pending` and `active`
- `--state removed` or `--state all` exposes removed membership history
- org member removal must show the team memberships removed by cascade
- member detail views should show when a membership was invited, accepted, declined, or removed and by whom

## Confirmation And Safety Rules

### Confirmation

Interactive destructive commands must show a preview before execution.

Required confirmation cases:

- removing an active org member
- removing any org member when team memberships will cascade
- removing multiple members in a future bulk flow

Non-interactive automation must require `--yes` for destructive operations.

### Safe defaults

- no command may silently grant org access as a side effect of a team command
- no command may silently delete audit history
- no duplicate invite should be silently resent
- no active member should be silently downgraded or re-added as part of another operation

### Error guidance

Errors should explain the next correct command, for example:

- `user_not_found`: "Use \`hack org member invite\` for new users."
- `org_membership_required`: "Add the user to the organization first, or use \`hack org member invite --team ...\`."
- `already_pending`: "Use a future resend command or remove the pending invite first."

## Minimal JSON Contract

The machine-readable mutation payload should include:

```json
{
  "ok": true,
  "action": "invite",
  "scopeType": "organization",
  "scopeId": "hack",
  "member": {
    "userId": "user_123",
    "email": "dev@example.com"
  },
  "membership": {
    "state": "pending",
    "previousState": null,
    "changedAt": "2026-03-13T12:00:00.000Z",
    "changedBy": "user_admin"
  },
  "cascade": {
    "removedTeamMemberships": []
  }
}
```

The exact payload can grow, but these fields should remain stable enough for CLI, desktop, and MCP consumers.

## Follow-On Work

The next implementation slices should cover:

1. broker persistence and APIs for org/team membership lifecycle
2. CLI command registration and JSON output for `org`, `team`, and invite flows
3. desktop/admin UX that uses the same lifecycle terms and confirmation rules
