# Linear Project Management UX Design

## Context

The current `hack linear` setup surface exposes auth and extension internals more than project-management meaning. Users can connect a profile and bind a project, but the default CLI responses make it harder than necessary to answer three practical questions:

- What Linear account/profile is active here?
- Which Linear team/project will this repo route to?
- What commands are valid next, and how do I repair missing or invalid bindings?

The issue scope is limited to the existing `setup`, `project-bind`, and `status` commands. Command names remain stable to avoid churn in scripts, docs, and user muscle memory.

## Goals

- Reframe `setup`, `project-bind`, and `status` around active profile, project routing, and capabilities.
- Make human-facing output answer what is connected, what is bound, and what to do next.
- Explicitly describe which project/team a command will affect.
- Point every broken state at the correct repair command.
- Keep `--json` useful for automation without leaking unnecessary auth machinery into normal terminal output.

## Non-Goals

- Renaming the command surface.
- Reworking OAuth/token plumbing.
- Changing sync behavior or autosync semantics.
- Migrating config storage away from existing routing/auth fields.

## Approaches Considered

### 1. Stable verbs, new summaries and repair-centric output (recommended)

Keep `setup`, `project-bind`, and `status` but redesign their human-facing responses around project-management meaning. Add shared helpers that compute:

- active profile and its connection state
- bound default project/team and linked projects
- user-facing capabilities and next steps
- repair commands for missing token/profile/project binding states

Pros:

- Lowest migration risk.
- Preserves docs and scripts.
- Directly addresses the acceptance criteria.

Cons:

- Old verbs still reflect the legacy mental model somewhat.

### 2. Add friendlier aliases on top of the existing verbs

Keep the existing commands but add alternative entry points such as `bind` or `whoami`.

Pros:

- Slightly clearer discovery.

Cons:

- Broader command-surface work.
- Raises documentation and help complexity without being required by the issue.

### 3. Full command rename

Replace the current verbs with a new primary surface.

Pros:

- Could optimize the language more aggressively.

Cons:

- High compatibility and documentation churn.
- Out of scope for the acceptance criteria.

## Recommended Design

Adopt approach 1.

### Shared status model

Introduce a shared project-management summary helper in the Linear extension that resolves:

- `activeProfile`
- `connected`
- `connectionLabel`
- `boundProject`
- `linkedProjects`
- `capabilities`
- `repairCommand`
- `routingSummary`
- `nextSteps`

This model is used by `status` directly and by `setup` / `project-bind` success states.

### `hack linear status`

`status` becomes the default “what is connected here?” command.

Human output should include:

- active Linear profile
- whether that profile is connected locally
- which Hack project routing override is active
- default Linear project/team routing for this repo
- any additional linked projects
- capabilities that are currently unlocked
- next actions or repair actions

Examples of capability language:

- `sync tickets for the bound Linear project`
- `pull issues from linked Linear projects`
- `repair local access from the connected Hack account`

Examples of repair language:

- missing profile: `Run hack linear connect --profile <id> or hack linear oauth-connect --profile <id>.`
- missing token for selected profile: `Run hack linear connect --profile <id>.`
- missing project binding: `Run hack linear project-bind --profile <id> --project-id <linear-project-id>.`
- selected profile override points to a missing profile: call that out and point at `hack linear setup --profile <valid-profile>` or `hack linear project-bind --profile <valid-profile> ...`

### `hack linear setup`

`setup` remains the fastest “make this repo ready for Linear” command, but its output changes from raw config fields to an outcome summary:

- active profile after setup
- default project/team route now bound for this repo, if provided
- what commands will use that route
- next recommended command if setup is partial

If setup only sets a profile and not a project binding, it should say the repo is connected but not yet routed for project sync, then point to `project-bind`.

### `hack linear project-bind`

`project-bind` becomes the explicit routing command.

Human output should answer:

- which repo is now routed
- which active profile owns that route
- which default team/project sync commands target
- which linked projects remain in scope
- what to run next

Error states should use routing language rather than raw config language. For example:

- `Missing --project-id` becomes guidance that the repo has no default Linear project route and should either pass `--project-id` or clear the route.
- unresolved project/team should say the selected profile cannot verify the target and suggest reconnecting that profile if access is stale.

### JSON compatibility

Keep existing fields where practical, but add user-facing fields so callers can consume the clearer model:

- `connected`
- `connectionLabel`
- `routing`
- `capabilities`
- `repair`
- `nextSteps`

### Help and docs

Update top-level `hack linear` examples and docs so the first mental model is:

1. connect a profile
2. bind this repo to a Linear project
3. use `hack linear status` to confirm what this repo can do

## Testing

- Add parser/helper tests for the new status/setup/bind summary payloads and repair decisions.
- Preserve existing parser coverage for command flags.
- Verify command docs/help reflect the new routing language.

## Risks

- Human-facing text can drift from the actual command behavior if the shared summary helper is not used consistently.
- JSON shape changes could surprise external callers if existing fields are removed. Avoid removal in this pass.
