# Linear Project Artifacts Design

## Goal
Add a Hack-managed model for Linear project documents, milestones, and status updates so project planning can live in the repo with explicit pull, plan, and apply flows instead of staying manual in Linear.

## Existing State
- Hack already supports Linear auth profiles, project binding, issue sync, webhook deliveries, and autosync subscriptions.
- The current Linear CLI surface is centered on account setup, issue/project sync, and delivery review.
- There is no repo-managed representation for Linear project documents, milestones, or status updates.
- This project still creates those planning artifacts directly in Linear, which breaks the "Hack manages project state" story.

## Requirements
- Documents, milestones, and status updates must be manageable as repo artifacts.
- The CLI shape must fit the existing `hack linear` surface instead of introducing a separate product.
- The model must stay manual-first for outbound writes: no background mutation of Linear project planning data.
- The design must be specific enough to drive CLI and client implementation work.

## Approaches Considered

### 1. Direct pass-through commands only
Examples:
- `hack linear documents create --title ... --body-stdin`
- `hack linear milestones update --id ...`
- `hack linear status-updates create --stdin`

Pros:
- Smallest implementation surface.
- No new local file model.

Cons:
- Not actually Hack-managed state.
- No diffable planning artifacts in git.
- Hard to review or batch changes.
- Poor fit for long-form project docs.

### 2. Config-only project artifact metadata
Examples:
- Store documents/milestones/status updates inside `hack.config.json` or extension config blobs.

Pros:
- Reuses existing config write paths.
- Easy to resolve target profile/project defaults.

Cons:
- Bad fit for Markdown bodies and multi-document projects.
- Encourages giant config blobs.
- Awkward review experience.
- Weak separation between routing config and content artifacts.

### 3. Repo-managed artifact files with explicit pull/plan/apply commands
Examples:
- Local Markdown/frontmatter artifacts under `.hack/linear/projects/<project-id>/...`
- `hack linear documents list|pull|plan|apply`
- `hack linear milestones list|pull|plan|apply`
- `hack linear status-updates list|pull|publish`

Pros:
- Git-visible planning artifacts.
- Works for long-form docs.
- Matches Hack’s “managed local state with explicit sync” model.
- Supports safe previews before mutating Linear.

Cons:
- Requires new file parsing and reconciliation code.
- Needs a clear local artifact contract.

## Recommendation
Adopt approach 3.

Documents, milestones, and status updates should become repo-managed artifacts with explicit lifecycle commands. Routing stays in `hack.config.json`, but artifact content lives in dedicated files under `.hack/linear/projects/<project-id>/`. This keeps the current project-binding model intact while adding a planning surface that can be reviewed, committed, synced, and reapplied from the repo.

## Artifact Model

### Repository layout
Use one canonical directory per bound Linear project:

```text
.hack/linear/projects/<project-id>/
  documents/
    <slug>.md
  milestones/
    <slug>.md
  status-updates/
    drafts/
      <yyyy-mm-dd>-<slug>.md
    published/
      <yyyy-mm-dd>-<slug>.md
```

Rules:
- `<project-id>` is the stable key, not project name, so project renames do not churn paths.
- All artifact files are user-editable source-of-truth files, not generated state.
- Remote IDs are persisted in frontmatter after first pull or apply so future updates remain idempotent.
- Routing defaults continue to come from `controlPlane.routing.overrides.linear.*`.

### Shared file contract
Every artifact file uses Markdown with YAML frontmatter.

Required frontmatter fields:
- `kind`
- `linearProjectId`
- `title`

Optional common fields:
- `linearProfile`
- `linearProjectName`
- `linearId`
- `slug`
- `archived`
- `updatedAt`

The Markdown body is the artifact content. Milestones can use the body for notes/context even if Linear only exposes structured milestone fields.

### Document files
Path:
- `.hack/linear/projects/<project-id>/documents/<slug>.md`

Frontmatter:
- `kind: linear-project-document`
- `title`
- `linearId`
- `slug`
- `sortOrder`
- `icon`
- `archived`

Behavior:
- Multiple documents per project are supported.
- Removing a local file does not delete the remote document implicitly.
- Remote archive/delete requires an explicit command or `--prune`.

### Milestone files
Path:
- `.hack/linear/projects/<project-id>/milestones/<slug>.md`

Frontmatter:
- `kind: linear-project-milestone`
- `title`
- `linearId`
- `slug`
- `targetDate`
- `sortOrder`
- `state`
- `archived`

Behavior:
- Milestones are treated as upsertable structured artifacts.
- The body is optional notes/context, kept locally even if not all fields round-trip to Linear.

### Status update files
Draft path:
- `.hack/linear/projects/<project-id>/status-updates/drafts/<yyyy-mm-dd>-<slug>.md`

Published path:
- `.hack/linear/projects/<project-id>/status-updates/published/<yyyy-mm-dd>-<slug>.md`

Frontmatter:
- `kind: linear-project-status-update`
- `title`
- `linearId`
- `slug`
- `health`
- `date`
- `linkedMilestoneIds`

Behavior:
- Status updates are append-only snapshots, not mutable upserts.
- `publish` creates a new remote update from a draft file.
- After publish, Hack updates the file with the remote ID and moves it into `published/`.
- Pulling status updates imports remote history into `published/`; it does not recreate drafts.

## CLI Shape

### Command families
Add three new `hack linear` command families:
- `hack linear documents <verb>`
- `hack linear milestones <verb>`
- `hack linear status-updates <verb>`

This is the cleanest fit with the existing top-level `hack linear` namespace:
- existing nouns already group related workflows (`projects`, `subscriptions`, `deliveries`)
- documents/milestones/status-updates are recognizable Linear concepts
- each family can parse its own verbs without exploding the extension command count

### Standard verbs
Documents:
- `list`
- `pull`
- `plan`
- `apply`
- `archive`

Milestones:
- `list`
- `pull`
- `plan`
- `apply`
- `archive`

Status updates:
- `list`
- `pull`
- `plan`
- `publish`

Reasoning:
- `plan` is the non-mutating diff/preflight verb across all families.
- `apply` is correct for upsertable artifacts.
- `publish` is clearer than `apply` for append-only status updates.

### Shared targeting flags
All three families should accept the same routing flags:
- `--profile <id>`
- `--project-id <linear-project-id>`
- `--project-name <name>`
- `--team-id <linear-team-id>`
- `--path <artifact-file-or-dir>`
- `--json`

Resolution order:
1. explicit CLI flags
2. current project’s bound Linear routing
3. selected/default Linear profile

### UX rules
1. No remote writes on plain `list` or `pull`.
2. `plan` is required for safe review and should show create/update/archive counts before `apply` or `publish`.
3. `apply` and `publish` must be explicit; no autosync for planning artifacts in this slice.
4. Missing project binding should fail with the same pattern as existing project-bound commands and suggest `hack linear project-bind`.
5. `--json` output must be stable and structured so desktop/MCP clients can adopt the same surface later.
6. Human output should prefer table or kv layouts consistent with current Linear commands.
7. Removing a file locally must not archive/delete remote state unless the user passes an explicit destructive flag.
8. Remote IDs and last-sync metadata should be written back only after successful remote mutation.

## Sync Semantics

### Pull
- Fetch remote artifacts for the selected project.
- Create local files when missing.
- Update frontmatter/body for files that are already Hack-managed.
- Never overwrite untracked local drafts without `--force`.

### Plan
- Compare local files and remote artifacts.
- Categorize results as `create`, `update`, `archive`, `noop`, `conflict`.
- Exit non-zero only for hard resolution failures, not for pending work.

### Apply
- Documents and milestones: upsert remote artifacts from local files.
- Status updates: only publish draft files that have no remote ID yet, unless a future `republish` mode is added.

### Conflict rules
- Same remote ID mapped from multiple local files is a hard error.
- Same local slug mapping to different remote IDs is a hard error.
- Local file missing remote ID but matching remote slug/title is review-needed, not silent overwrite.
- Status updates with an existing remote ID are treated as immutable unless an explicit repair command is added later.

## Data Boundary
- Repo-managed:
  - artifact files under `.hack/linear/projects/<project-id>/...`
  - remote IDs in frontmatter
  - local draft/published distinction for status updates
- Broker-managed:
  - OAuth connections
  - webhook deliveries
  - autosync subscriptions
  - assignee mappings

Project planning artifacts belong in the repo because they are collaborative project state, not secret integration state.

## MCP / Desktop Implications
- MCP should eventually expose the same noun/verb families instead of inventing separate project-planning tools.
- Desktop can build on the same structured `--json` responses for listing, planning, and publishing.
- The CLI remains the source of truth for artifact mutation rules.

## Non-Goals
- No background autosync for project documents, milestones, or status updates.
- No implicit remote deletion from file removal.
- No migration of issue sync or ticket storage.
- No replacement of existing `project-bind`, `sync-project`, or delivery workflows.

## Rollout
1. Add Linear client support for project documents, milestones, and status updates.
2. Add local artifact parsing/materialization for the `.hack/linear/projects/<project-id>/` tree.
3. Add the three CLI command families with `list/pull/plan/apply|publish`.
4. Expose structured JSON outputs for MCP/desktop reuse.
5. Add destructive/archive flows only after the base upsert/publish path is stable.

## Risks
- Linear’s GraphQL shape for project documents/status updates may not line up cleanly with the local Markdown contract and may need lossy field selection.
- File/path churn can become noisy if slug and title normalization are unstable.
- Status updates are more timeline-like than documents; over-generalizing them as editable artifacts would cause accidental rewrites.
- If `plan` output is weak, users will not trust `apply` for project planning state.
