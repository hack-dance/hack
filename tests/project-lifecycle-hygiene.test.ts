import { expect, test } from "bun:test";

import type { LifecycleStateEntry } from "../src/lib/lifecycle-runtime.ts";
import {
  classifyLifecycleSessionHygiene,
  inspectLifecycleStateEntries,
} from "../src/lib/project-lifecycle-hygiene.ts";
import { classifyLifecycleSession } from "../src/lib/project-lifecycle-sessions.ts";

const staleEntry: LifecycleStateEntry = {
  composeProject: "event-agent",
  projectName: "event-agent",
  branch: "feature-cleanup",
  sessionName: "event-agent--lifecycle-feature-cleanup",
  backend: "tmux",
  updatedAt: "2026-04-01T14:00:00.000Z",
  processes: [
    {
      name: "proxy",
      windowName: "proxy",
      logPath: "/tmp/event-agent.log",
      panePid: 500,
      processGroupId: 500,
    },
  ],
};

test("inspectLifecycleStateEntries ignores lifecycle entries with a live mux session", () => {
  const inspection = inspectLifecycleStateEntries({
    entries: [staleEntry],
    sessionsByBackend: new Map([["tmux", new Set([staleEntry.sessionName])]]),
    snapshot: [{ pid: 500, ppid: 1, processGroupId: 500 }],
  });

  expect(inspection.staleEntries).toEqual([]);
  expect(inspection.orphanedProcessGroups).toEqual([]);
});

test("inspectLifecycleStateEntries reports stale lifecycle entries and orphaned groups", () => {
  const inspection = inspectLifecycleStateEntries({
    entries: [staleEntry],
    sessionsByBackend: new Map([["tmux", new Set<string>()]]),
    snapshot: [
      { pid: 500, ppid: 1, processGroupId: 500 },
      { pid: 501, ppid: 500, processGroupId: 501 },
    ],
  });

  expect(inspection.staleEntries).toEqual([
    {
      entry: staleEntry,
      liveProcessGroups: [500, 501],
    },
  ]);
  expect(inspection.orphanedProcessGroups).toEqual([]);
});

test("inspectLifecycleStateEntries reports leaderless groups behind a live mux session", () => {
  const inspection = inspectLifecycleStateEntries({
    entries: [staleEntry],
    sessionsByBackend: new Map([["tmux", new Set([staleEntry.sessionName])]]),
    snapshot: [
      { pid: 501, ppid: 1, processGroupId: 500 },
      { pid: 502, ppid: 501, processGroupId: 500 },
      { pid: 503, ppid: 502, processGroupId: 503 },
    ],
  });

  expect(inspection.staleEntries).toEqual([]);
  expect(inspection.orphanedProcessGroups).toEqual([500, 503]);
});

test("classifyLifecycleSessionHygiene reports an owned session without a running instance", () => {
  const ownedEntry: LifecycleStateEntry = {
    ...staleEntry,
    ownershipToken: "owner-token",
    definitionHash: "definition-hash",
  };
  const sessionInspection = classifyLifecycleSession({
    session: {
      backend: "tmux",
      name: ownedEntry.sessionName,
      attached: false,
      path: "/tmp/event-agent",
      windows: 2,
      createdAt: "2026-04-01T13:59:59.000Z",
    },
    entry: ownedEntry,
    observedOwnershipToken: "owner-token",
    expectedBackend: "tmux",
    expectedSessionName: ownedEntry.sessionName,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: "definition-hash",
    liveWindowNames: new Set(["shell", "proxy"]),
  });

  const inspection = classifyLifecycleSessionHygiene({
    entries: [ownedEntry],
    sessionInspections: new Map([
      [ownedEntry.composeProject, sessionInspection],
    ]),
    activeComposeProjects: new Set(),
    now: new Date("2026-04-01T14:10:00.000Z"),
  });

  expect(inspection.orphanedSessions).toEqual([
    { entry: ownedEntry, classification: "owned-healthy" },
  ]);
  expect(inspection.unverifiedSessions).toEqual([]);
});

test("classifyLifecycleSessionHygiene preserves a recent owned session during startup", () => {
  const ownedEntry: LifecycleStateEntry = {
    ...staleEntry,
    ownershipToken: "owner-token",
    definitionHash: "definition-hash",
  };
  const sessionInspection = classifyLifecycleSession({
    session: {
      backend: "tmux",
      name: ownedEntry.sessionName,
      attached: false,
      path: "/tmp/event-agent",
      windows: 2,
      createdAt: "2026-04-01T13:59:59.000Z",
    },
    entry: ownedEntry,
    observedOwnershipToken: "owner-token",
    expectedBackend: "tmux",
    expectedSessionName: ownedEntry.sessionName,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: "definition-hash",
    liveWindowNames: new Set(["shell", "proxy"]),
  });

  const inspection = classifyLifecycleSessionHygiene({
    entries: [ownedEntry],
    sessionInspections: new Map([
      [ownedEntry.composeProject, sessionInspection],
    ]),
    activeComposeProjects: new Set(),
    now: new Date("2026-04-01T14:01:00.000Z"),
  });

  expect(inspection.orphanedSessions).toEqual([]);
  expect(inspection.unverifiedSessions).toEqual([
    {
      entry: ownedEntry,
      reason:
        'Lifecycle session "event-agent--lifecycle-feature-cleanup" is recent enough to belong to an in-flight startup.',
    },
  ]);
});

test("classifyLifecycleSessionHygiene preserves foreign collisions for manual review", () => {
  const foreignInspection = classifyLifecycleSession({
    session: {
      backend: "tmux",
      name: staleEntry.sessionName,
      attached: false,
      path: "/tmp/unrelated",
      windows: 1,
      createdAt: "2026-04-01T13:59:59.000Z",
    },
    entry: staleEntry,
    observedOwnershipToken: null,
    expectedBackend: "tmux",
    expectedSessionName: staleEntry.sessionName,
    expectedProjectRoot: "/tmp/event-agent",
    expectedDefinitionHash: "",
    liveWindowNames: new Set(["shell"]),
  });

  const inspection = classifyLifecycleSessionHygiene({
    entries: [staleEntry],
    sessionInspections: new Map([
      [staleEntry.composeProject, foreignInspection],
    ]),
    activeComposeProjects: new Set(),
    now: new Date("2026-04-01T14:10:00.000Z"),
  });

  expect(inspection.orphanedSessions).toEqual([]);
  expect(inspection.unverifiedSessions).toHaveLength(1);
  expect(inspection.unverifiedSessions[0]?.reason).toContain(
    "cannot be proven"
  );
});
