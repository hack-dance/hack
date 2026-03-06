# Hack Account Auth and Provider UX Design

## Context

Hack now has real broker-backed remote capabilities:

- Better Auth session/org/team ownership in `auth-broker`
- broker-owned Linear connections, subscriptions, and deliveries
- desktop and CLI provider connection flows
- growing need for shared remote state beyond local keychain-only auth

The current user experience is still provider-first rather than account-first.
That creates two problems:

1. The product does not clearly distinguish `Hack account/session` from `connected provider account`.
2. The desktop/project settings forms still use raw system controls and duplicated labels, which makes the configuration surfaces feel unfinished and harder to use.

This design introduces a first-class, optional Hack account layer while keeping local-only Hack usage available without sign-in.

## Goals

- Keep Hack usable without authentication for local-only workflows.
- Add a first-class Hack account/session model in web, CLI, and macOS app.
- Make broker-owned/shared remote features clearly require Hack sign-in.
- Separate Hack login methods from provider integrations.
- Improve macOS configuration UX so forms are compact, styled, and easier to scan.
- Establish the next design boundary for remote encrypted project/env portability.

## Non-Goals

- Do not make local project/runtime/ticket usage require sign-in.
- Do not build a full account web product or admin console.
- Do not implement remote secret portability in this slice.
- Do not collapse provider integration identity into Hack login identity.

## Product Boundary

### Local-only features remain unauthenticated

No Hack account sign-in should be required for:

- local project/runtime management
- local sessions
- local git/system identity
- local git-backed tickets
- provider tokens already stored locally and used purely locally

### Shared remote features require Hack auth

Hack sign-in should be required for:

- listing and managing broker-owned Linear connections
- broker-owned autosync subscriptions and deliveries
- future shared provider management by org/team
- future remote encrypted project/env storage
- any state that is stored remotely and owned by a Hack user/org/team

This gives the product a clear rule:

- local-only = no login required
- shared/remote = login required

## Identity Model

There are three different concepts and the UI must keep them separate.

### 1. Hack account

A Hack account is the primary identity used by Better Auth.
It has:

- a user record
- optional active organization
- optional active team
- one or more linked login methods

### 2. Login methods

Login methods are how a user signs into Hack itself.
Examples:

- GitHub social login
- Google social login
- email/password if we keep it enabled

These should link into the same Hack user when they represent the same person.

### 3. Provider integrations

Provider integrations are separate owned resources under the Hack account.
Examples:

- Linear profiles
- GitHub integration profiles / app installations

A user may sign into Hack with GitHub and also connect one or more GitHub integration profiles. Those are not the same thing and must not be presented as the same thing.

## Account Linking Rules

Hack login methods should link under a strict verified-email policy.

### Automatic account merge

Allow automatic linking only when:

- the provider returns an email
- the provider marks that email as verified
- the normalized email matches an existing Hack user

### Do not auto-link when

- the provider email is missing
- the provider email is unverified
- the emails differ

### Safety rule

Do not enable permissive same-user linking across mismatched or unverified emails.
This is an auth boundary, not a convenience feature.

## Auth Providers

### Current state

Current broker code already supports:

- Better Auth with email/password
- GitHub social login in Better Auth
- organization/team plugin

Current broker code does not yet support:

- Google social login in Better Auth

### Design decision

The auth shell should render whichever Better Auth social providers are configured.

That means:

- if only GitHub is configured, show GitHub sign-in
- if Google is added, show Google sign-in too
- do not hardcode a product promise around Google before the broker exposes it

## Web Surface

We need a minimal hosted auth shell, not a full web application.

### Required pages

#### `/auth`

Landing page for Hack account sign-in.

It should show:

- current signed-in state if present
- available sign-in methods
- short explanation that Hack account unlocks shared remote features

#### `/auth/account`

Profile/session page.

It should show:

- name
- email
- active org
- active team
- linked login methods
- sign out action

#### org/team selection UI

Only if needed.

If a user belongs to multiple orgs or teams, the account page should allow choosing the active context used by broker-owned resources.

### Scope constraints

This web shell is intentionally small.
It is not a dashboard, not a billing panel, and not a management console.

## CLI Surface

Add a first-class `hack auth` command group.

### Commands

- `hack auth status`
- `hack auth login`
- `hack auth logout`
- `hack auth whoami`

### Behavior

#### `hack auth login`

- opens the auth shell in browser
- completes local session/bootstrap
- stores enough local state to identify the signed-in Hack user/session for broker-backed workflows

#### `hack auth status`

Returns:

- signed-in vs signed-out
- user identity
- active org
- active team
- whether shared remote features are available

#### `hack auth logout`

- clears local Hack auth session/bootstrap state
- does not delete local provider profiles by default

#### `hack auth whoami`

- compact output for scripts and troubleshooting

### Broker-required command behavior

When a command requires broker-owned access and the user is not signed in:

- fail clearly
- explain why auth is required
- tell the user the next step: `hack auth login`
- where possible, resume the original flow after login

## macOS Surface

### Settings structure

Add a top-level `Hack account` section above provider settings.

It should show:

- signed-in state
- display name/email
- active org
- active team
- linked login methods
- actions:
  - `Sign in`
  - `Manage account`
  - `Sign out`

### Provider settings

Keep provider settings, but subordinate them to Hack account state.

#### Linear integration

Should say clearly:

- connected under current Hack account
- or local-only/provider token exists but shared broker features require Hack sign-in

#### GitHub integration

Should clearly separate:

- `Sign in to Hack with GitHub`
- `Connect GitHub integration`

### Project/settings UX cleanup

Project settings should stop using duplicated labels and raw row-based menus.

#### Form style

Use stacked field groups:

- small label above control
- styled select/input below
- helper text only when needed

Apply the same field style to:

- project settings
- Linear routing sheet
- assignee mapping form

#### Routing and operations split

- project settings remain configuration-only
- operational sync actions stay in `Tickets`

## Provider Flow Model

Provider flows should work differently depending on Hack auth state.

### Signed in to Hack

- provider connect flow runs under the Hack session
- broker-owned resources are visible and manageable
- connected provider accounts are clearly attributed to the signed-in Hack account/org/team

### Not signed in to Hack

- local-only flows can still proceed when safe
- broker-owned/shared features should prompt sign-in first
- desktop UI should explain the distinction instead of silently failing or looking disconnected

## Broker and Session Model

The broker already has the right ownership enforcement direction:

- Better Auth sessions own broker-managed resources
- Linear routes are access-controlled by user/org/team ownership
- CLI already persists a management token for protected broker routes after provider OAuth

The missing product layer is session visibility and a clean login path in CLI/macOS.

## Remote Secret Portability Direction

This is not part of the immediate implementation, but the auth model should leave room for it.

### Future direction

We should explore remote encrypted project/env storage with:

- per-project encryption context or project keys
- remote portability across macOS/Linux/nodes
- less dependence on single-machine keychain custody
- clear ownership under Hack account/org/team

### Constraint

Do not fold this into the immediate auth/UX slice.
Track it as follow-on architecture work.

## Implementation Priorities

### Immediate

1. First-class Hack account/session surface in web/CLI/macOS
2. Project settings and provider UX cleanup in macOS
3. Better command gating and messaging for auth-required broker features
4. Verified-email login method linking rules

### Follow-on

1. Add Google social login to Better Auth if env and callback setup exist
2. Shared linked-login management UI
3. Remote encrypted project/env storage and portability design

## Success Criteria

- Users can understand the difference between Hack sign-in and provider connections.
- Local-only Hack workflows remain available without auth.
- Broker-backed features fail clearly and guide the user into sign-in.
- macOS settings/project forms feel compact, styled, and consistent.
- GitHub and Google can both act as Hack login methods without fragmenting a user into duplicate accounts when verified email matches.
