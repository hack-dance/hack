import { expect, test } from "bun:test";

import type { LifecycleStateEntry } from "../src/lib/lifecycle-runtime.ts";
import { inspectLifecycleStateEntries } from "../src/lib/project-lifecycle-hygiene.ts";

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
    ],
  });

  expect(inspection.staleEntries).toEqual([]);
  expect(inspection.orphanedProcessGroups).toEqual([500]);
});
