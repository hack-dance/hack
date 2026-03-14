import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  parseLinearProjectArtifactFile,
  planLinearProjectArtifactChanges,
  resolveLinearProjectArtifactsRoot,
  serializeLinearProjectArtifactFile,
} from "../src/control-plane/extensions/linear/project-artifacts.ts";

test("parseLinearProjectArtifactFile parses a project document frontmatter block", () => {
  const artifact = parseLinearProjectArtifactFile({
    filePath: "/repo/.hack/linear/projects/proj_123/documents/launch-plan.md",
    text: `---
kind: linear-project-document
linearProjectId: proj_123
title: Launch plan
linearId: doc_123
slug: launch-plan
sortOrder: 1
icon: rocket
archived: false
updatedAt: 2026-03-14T10:00:00.000Z
---
# Launch plan
`,
  });

  expect(artifact).toMatchObject({
    kind: "linear-project-document",
    linearProjectId: "proj_123",
    title: "Launch plan",
    linearId: "doc_123",
    slug: "launch-plan",
    sortOrder: 1,
    icon: "rocket",
    archived: false,
    updatedAt: "2026-03-14T10:00:00.000Z",
    body: "# Launch plan\n",
  });
});

test("parseLinearProjectArtifactFile parses a milestone with notes", () => {
  const artifact = parseLinearProjectArtifactFile({
    filePath: "/repo/.hack/linear/projects/proj_123/milestones/private-beta.md",
    text: `---
kind: linear-project-milestone
linearProjectId: proj_123
title: Private beta
linearId: milestone_123
slug: private-beta
targetDate: 2026-04-01
state: pending
sortOrder: 7
---
Ship the beta cohort.
`,
  });

  expect(artifact).toMatchObject({
    kind: "linear-project-milestone",
    linearProjectId: "proj_123",
    title: "Private beta",
    linearId: "milestone_123",
    slug: "private-beta",
    targetDate: "2026-04-01",
    state: "pending",
    sortOrder: 7,
    body: "Ship the beta cohort.\n",
  });
});

test("parseLinearProjectArtifactFile parses a status update draft with linked milestones", () => {
  const artifact = parseLinearProjectArtifactFile({
    filePath:
      "/repo/.hack/linear/projects/proj_123/status-updates/drafts/2026-03-14-weekly.md",
    text: `---
kind: linear-project-status-update
linearProjectId: proj_123
title: Weekly update
slug: weekly
date: 2026-03-14
health: onTrack
linkedMilestoneIds:
  - milestone_123
  - milestone_456
---
Still on track for dogfooding.
`,
  });

  expect(artifact).toMatchObject({
    kind: "linear-project-status-update",
    linearProjectId: "proj_123",
    title: "Weekly update",
    slug: "weekly",
    date: "2026-03-14",
    health: "onTrack",
    linkedMilestoneIds: ["milestone_123", "milestone_456"],
    body: "Still on track for dogfooding.\n",
  });
});

test("resolveLinearProjectArtifactsRoot uses the bound project id", () => {
  const root = resolveLinearProjectArtifactsRoot({
    projectDir: "/repo",
    linearProjectId: "proj_123",
  });

  expect(root).toBe(join("/repo", ".hack/linear/projects/proj_123"));
});

test("planLinearProjectArtifactChanges reports duplicate local mappings", () => {
  const plan = planLinearProjectArtifactChanges({
    localArtifacts: [
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Launch plan",
        linearId: "doc_123",
        slug: "launch-plan",
        body: "# Launch plan\n",
        path: "/repo/.hack/linear/projects/proj_123/documents/launch-plan.md",
        archived: false,
      },
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Launch plan duplicate",
        linearId: "doc_123",
        slug: "launch-plan-duplicate",
        body: "# Launch plan duplicate\n",
        path: "/repo/.hack/linear/projects/proj_123/documents/launch-plan-duplicate.md",
        archived: false,
      },
    ],
    remoteArtifacts: [],
  });

  expect(plan.errors).toEqual([
    'Duplicate local linearId "doc_123" in /repo/.hack/linear/projects/proj_123/documents/launch-plan.md and /repo/.hack/linear/projects/proj_123/documents/launch-plan-duplicate.md',
  ]);
});

test("planLinearProjectArtifactChanges distinguishes create update noop and remote-only", () => {
  const plan = planLinearProjectArtifactChanges({
    localArtifacts: [
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Create me",
        slug: "create-me",
        body: "# Create me\n",
        path: "/repo/.hack/linear/projects/proj_123/documents/create-me.md",
        archived: false,
      },
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Update me",
        linearId: "doc_update",
        slug: "update-me",
        body: "# Updated body\n",
        path: "/repo/.hack/linear/projects/proj_123/documents/update-me.md",
        archived: false,
      },
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "No-op me",
        linearId: "doc_noop",
        slug: "noop-me",
        body: "# No changes\n",
        path: "/repo/.hack/linear/projects/proj_123/documents/noop-me.md",
        archived: false,
      },
    ],
    remoteArtifacts: [
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Update me",
        linearId: "doc_update",
        slug: "update-me",
        body: "# Old body\n",
        archived: false,
      },
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "No-op me",
        linearId: "doc_noop",
        slug: "noop-me",
        body: "# No changes\n",
        archived: false,
      },
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Remote only",
        linearId: "doc_remote",
        slug: "remote-only",
        body: "# Remote only\n",
        archived: false,
      },
    ],
  });

  expect(plan.errors).toEqual([]);
  expect(plan.create.map((item) => item.title)).toEqual(["Create me"]);
  expect(plan.update.map((item) => item.local.title)).toEqual(["Update me"]);
  expect(plan.noop.map((item) => item.local.title)).toEqual(["No-op me"]);
  expect(plan.remoteOnly.map((item) => item.title)).toEqual(["Remote only"]);
});

test("planLinearProjectArtifactChanges flags slug-matched remotes when local linearId is missing", () => {
  const plan = planLinearProjectArtifactChanges({
    localArtifacts: [
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Launch plan",
        slug: "launch-plan",
        body: "# Launch plan\n",
        path: "/repo/.hack/linear/projects/proj_123/documents/launch-plan.md",
        archived: false,
      },
    ],
    remoteArtifacts: [
      {
        kind: "linear-project-document",
        linearProjectId: "proj_123",
        title: "Launch plan",
        linearId: "doc_123",
        slug: "launch-plan",
        body: "# Remote launch plan\n",
        archived: false,
      },
    ],
  });

  expect(plan.errors).toEqual([
    'Local artifact /repo/.hack/linear/projects/proj_123/documents/launch-plan.md matches remote linearId "doc_123" by slug/title. Pull first or add the remote linearId before apply.',
  ]);
  expect(plan.create).toEqual([]);
  expect(plan.update).toEqual([]);
  expect(plan.noop).toEqual([]);
  expect(plan.remoteOnly).toEqual([]);
});

test("serializeLinearProjectArtifactFile writes stable frontmatter", () => {
  const text = serializeLinearProjectArtifactFile({
    artifact: {
      kind: "linear-project-status-update",
      linearProjectId: "proj_123",
      title: "Weekly update",
      linearId: "update_123",
      slug: "weekly",
      date: "2026-03-14",
      health: "onTrack",
      linkedMilestoneIds: ["milestone_123"],
      body: "Still on track for dogfooding.\n",
      archived: false,
      path: "/repo/.hack/linear/projects/proj_123/status-updates/published/2026-03-14-weekly.md",
    },
  });

  expect(text).toBe(`---
kind: linear-project-status-update
linearProjectId: proj_123
title: Weekly update
linearId: update_123
slug: weekly
archived: false
date: 2026-03-14
health: onTrack
linkedMilestoneIds:
  - milestone_123
---
Still on track for dogfooding.
`);
});

test("serializeLinearProjectArtifactFile round-trips YAML-sensitive string fields", () => {
  const text = serializeLinearProjectArtifactFile({
    artifact: {
      kind: "linear-project-document",
      linearProjectId: "proj_123",
      title: "API: Launch #1",
      linearId: "doc_123",
      slug: "api-launch",
      body: "# API launch\n",
      archived: false,
      path: "/repo/.hack/linear/projects/proj_123/documents/api-launch.md",
    },
  });

  const reparsed = parseLinearProjectArtifactFile({
    filePath: "/repo/.hack/linear/projects/proj_123/documents/api-launch.md",
    text,
  });

  expect(reparsed.title).toBe("API: Launch #1");
  expect(reparsed.slug).toBe("api-launch");
});
