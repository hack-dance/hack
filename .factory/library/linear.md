# Linear

Repo-bound Linear project and artifact guidance for this mission.

**What belongs here:** project binding, artifact roots, issue-scope rules, and worker expectations for Linear sync/status work.

---

## Bound Project

- Project: `Hack`
- Project ID: `7a3c8adf-ede5-4d3a-8779-9c32695c76bf`
- Team ID: `e0aedec9-5273-446f-b975-aa4cd1525900`
- Active profile: `default`

## Canonical Artifact Root

- Use `.hack/linear/projects/<project-id>/...` as the only authoritative repo path.
- Treat `.hack/.hack/linear/**` as legacy bug fallout that must be neutralized by mission work.
- In command code, resolve that artifact tree from the repo root (`project.projectRoot`), not from `project.projectDir` (`.hack`), or audit/status reads will drift back into the wrong path.

## Tracking Expectations

- Keep repo-bound Linear project state current while working, especially for features that touch project sync, status updates, or closeout.
- Prefer repo-bound `./dist/hack linear ...` commands over manual remote edits when verifying project/status behavior.
- Broker-backed inspection commands such as `./dist/hack linear connections --json` or `./dist/hack linear subscriptions --json` can still require a fresh `./dist/hack auth login` even when `./dist/hack linear status --json` already works from local token-backed access.
- Preserve an auditable frozen closeout scope: all Hack-project Linear issues open at mission start plus mission-created optional-web-control-plane work.

## Frozen Closeout Inventory

- Canonical mission snapshot file: `missionDir/linear-closeout-scope.json`
- `linear-tracking-foundation-and-freeze-set` must populate `openedAtStart` before status-changing mission work proceeds and append any mission-created optional-web-control-plane issue IDs under `missionCreated`.
- Final closeout work must reconcile exactly this inventory to zero unresolved items.
