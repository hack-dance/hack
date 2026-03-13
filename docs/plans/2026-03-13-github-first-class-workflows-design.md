# GitHub First-Class Workflows Design

## Context

Hack already has a GitHub extension, but its current surface is mostly auth/profile plumbing plus a narrow `pr-upsert` write path. That is enough to prove connectivity, but not enough to define what "GitHub support" means as a product capability. Without an explicit workflow set, future work risks growing as disconnected commands and one-off UI affordances.

This ticket defines the first-class GitHub workflow boundary for the current milestone so implementation can sequence intentionally around user outcomes instead of command accumulation.

## Goals

- Define a prioritized, bounded initial GitHub workflow set.
- Make the supported user outcomes explicit for reviews, PR updates, comments, and adjacent repo actions.
- Separate the initial release scope from later expansion so product and engineering can say no clearly.
- Provide enough sequencing guidance that implementation can proceed in phases.

## Non-Goals

- Defining every future GitHub action Hack may ever support.
- Matching the full GitHub web UI.
- Covering GitHub Issues, Projects, Discussions, releases, or repo administration in the initial set.
- Designing the final CLI verbs or macOS UI in detail.

## Approaches Considered

### 1. Command-inventory definition

Define scope around concrete commands such as `pr-upsert`, `review-submit`, and `comment-create`.

Pros:

- Easy to tie directly to implementation
- Low ambiguity for CLI work

Cons:

- Locks product language to current transport details
- Makes cross-surface planning harder for macOS, CLI, and agents

### 2. Workflow-class definition (recommended)

Define scope around user jobs such as "review a PR" or "update my PR", then map commands and UI to those jobs.

Pros:

- Keeps the capability user-outcome focused
- Gives implementation freedom across CLI, desktop, and agents
- Makes later expansion easier to reason about

Cons:

- Requires a little more up-front definition work

### 3. Broad GitHub workbench

Treat GitHub as a general remote workbench and include most adjacent actions now.

Pros:

- Ambitious and flexible

Cons:

- Too large for the current milestone
- Makes "first-class" indistinguishable from "everything"
- Weakens implementation sequencing

## Recommendation

Adopt the workflow-class model. The first-class GitHub surface should be defined by a small number of high-value jobs that users can complete end-to-end inside Hack. Commands, desktop affordances, and agent tools should then map onto those workflows.

## Proposed First-Class Workflow Set

### Priority 1: Review Intake and Review Decision

**User outcome:** A user can see which PR needs their attention, inspect the decision context, and submit a review outcome without falling back to GitHub web for the common case.

**Initial support**

- List relevant PRs for the current user or current repo context.
- Open a PR summary with:
  - title, author, branch/base
  - review state
  - mergeability/check status summary
  - changed file summary
  - unresolved conversation/thread counts
- Submit a review decision:
  - `approve`
  - `comment`
  - `request_changes`
- Include one summary review body with the decision.

**Explicitly out of initial scope**

- Inline diff comment authoring
- Multi-comment review drafts
- Thread resolution management
- Batch review across many repositories

**Success criteria**

- A reviewer can identify a PR requiring action in one entry flow.
- A reviewer can make an approve/comment/request-changes decision from Hack.
- The review action returns the resulting GitHub review state and PR URL/id so downstream tooling can continue.

### Priority 2: PR Update and Readiness Management

**User outcome:** An author can create or keep a PR accurate and move it between draft and ready states without using the GitHub web UI.

**Initial support**

- Create or update a PR for the current branch/repo context.
- Update title, body, and base branch.
- Transition draft <-> ready for review.
- Read current PR metadata before mutating it.
- Optionally add a single top-level comment when performing a PR update.

**Explicitly out of initial scope**

- Label, assignee, milestone, or project edits
- Auto-generated release notes
- Merge queue controls
- Auto-rebase, auto-merge, or branch protection bypass

**Success criteria**

- A branch with an existing or missing PR can be brought to a correct GitHub PR state from Hack.
- An author can mark a PR ready or return it to draft.
- The update flow is idempotent enough to support agent-driven use.

### Priority 3: Conversation Comments

**User outcome:** A user can leave PR-level discussion comments when they do not need a full review submission.

**Initial support**

- Create a top-level PR comment.
- Reply to an existing discussion target only if GitHub exposes a clear non-inline comment target already represented in Hack state.
- Show enough surrounding PR metadata so comments are not sent blind.

**Explicitly out of initial scope**

- Full threaded review comment authoring on diffs
- Comment editing and deletion
- Emoji reactions
- Issue-wide/general GitHub social surface

**Success criteria**

- A user can post a contextual PR comment without switching tools.
- Comment creation can be attached to either standalone discussion or a PR update flow.
- The result includes a durable remote identifier for later correlation.

### Priority 4: Adjacent Repo Actions

**User outcome:** A user can move cleanly between GitHub PR context and local repo work without re-entering context manually.

**Initial support**

- Resolve the current branch to its PR, or a PR to its repo/branch refs.
- Open or hand off to the local repo/branch context:
  - checkout or branch/worktree handoff target
  - canonical PR URL
  - head/base refs
  - changed file list summary
- Show CI/check status summary as read-only context when acting on a PR.

**Explicitly out of initial scope**

- Merging a PR
- Rebasing or updating branches on GitHub
- Rerunning GitHub Actions jobs
- Repo settings, secrets, releases, tags, or admin actions

**Success criteria**

- A user can pivot from PR context to local repo context with no manual copy-paste of branch/ref data.
- Review and PR update workflows can reuse the same repo-context resolution primitives.
- Repo actions remain supportive, not a second unbounded GitHub product surface.

## Initial Supported Set

The initial GitHub capability set is explicitly limited to:

1. Review intake for a relevant PR
2. Review decision submission with a summary body
3. PR creation/update plus draft-ready state changes
4. Top-level PR comments
5. Read-only repo-context handoff actions tied to a PR

Everything else is out unless it is necessary to make one of those five workflows function end-to-end.

## Later Expansion

Later GitHub phases may add:

- Inline diff comments and thread resolution
- PR metadata enrichment such as labels, assignees, milestones, and linked issues
- Merge and queue actions
- CI control actions such as rerun/retry
- Issue-centric workflows
- Repo maintenance/admin workflows
- Multi-repo inbox and batch review surfaces

These should remain separate expansion decisions, not implicit additions to the initial milestone.

## Sequencing Guidance

Implementation should land in this order:

1. Shared PR/review read models
2. Review decision submission
3. PR metadata update and draft/ready transitions
4. Standalone comment creation
5. Repo-context handoff affordances

That order keeps the highest-value workflows intact while forcing a shared read layer before write surfaces multiply.

## Product Boundary Rules

- Every new GitHub action must map to one of the workflow classes above or be deferred.
- If an action does not complete a clear user outcome, it is not first-class.
- Repo actions stay subordinate to PR/review workflows unless a separate milestone expands them.
- Initial support favors summary-level actions over fine-grained GitHub UI parity.

## Acceptance Mapping

### The initial GitHub capability set is explicit and bounded

Yes. The initial set is limited to review intake/decision, PR updates, PR comments, and PR-adjacent repo handoff actions.

### Each workflow has a clear user outcome

Yes. Each workflow class above includes a single primary outcome and explicit success criteria.

### The scope is concrete enough to drive implementation sequencing

Yes. The workflow set is prioritized, split into initial vs later, and ordered for phased implementation.
