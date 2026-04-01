import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  collectDescendantProcessGroupIds,
  parseProcessSnapshotOutput,
  resolveLifecycleProcessGroupIdsForTmuxState,
  wrapLifecyclePersistentCommand,
} from "../src/commands/project.ts";
import { readLifecycleState } from "../src/lib/lifecycle-runtime.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

test("readLifecycleState preserves lifecycle pane and process group metadata", async () => {
  const projectDir = await createLifecycleProjectDir();
  const statePath = resolve(projectDir, ".internal", "lifecycle", "state.json");

  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        entries: [
          {
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
                panePid: "12345",
                processGroupId: 67_890,
              },
            ],
          },
        ],
      },
      null,
      2
    )}\n`
  );

  const entries = await readLifecycleState({ projectDir });

  expect(entries).toHaveLength(1);
  expect(entries[0]?.processes).toEqual([
    {
      name: "proxy",
      windowName: "proxy",
      logPath: "/tmp/event-agent.log",
      panePid: 12_345,
      processGroupId: 67_890,
    },
  ]);
});

test("parseProcessSnapshotOutput ignores malformed rows", () => {
  expect(
    parseProcessSnapshotOutput(
      ["101 1 101", "bad row", "202 x 202", "303 101 303 extra", ""].join("\n")
    )
  ).toEqual([
    { pid: 101, ppid: 1, processGroupId: 101 },
    { pid: 303, ppid: 101, processGroupId: 303 },
  ]);
});

test("collectDescendantProcessGroupIds returns root and descendant groups once", () => {
  const groups = collectDescendantProcessGroupIds({
    snapshot: [
      { pid: 100, ppid: 1, processGroupId: 100 },
      { pid: 101, ppid: 100, processGroupId: 101 },
      { pid: 102, ppid: 100, processGroupId: 101 },
      { pid: 103, ppid: 101, processGroupId: 103 },
      { pid: 200, ppid: 1, processGroupId: 200 },
    ],
    rootPids: [100, 999, 100],
  });

  expect(groups).toEqual([100, 101, 103]);
});

test("resolveLifecycleProcessGroupIdsForTmuxState ignores stale persisted ids", () => {
  const groups = resolveLifecycleProcessGroupIdsForTmuxState({
    lifecycleEntry: {
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
          panePid: 99_999,
          processGroupId: 99_999,
        },
      ],
    },
    panePidsByWindow: new Map([["proxy", [100]]]),
    snapshot: [
      { pid: 100, ppid: 1, processGroupId: 100 },
      { pid: 101, ppid: 100, processGroupId: 101 },
      { pid: 99_999, ppid: 1, processGroupId: 99_999 },
    ],
  });

  expect(groups).toEqual([100, 101]);
});

test("wrapLifecyclePersistentCommand uses external kill for process-group cleanup", () => {
  const script = wrapLifecyclePersistentCommand({
    command: "bun run proxy",
    logPath: "/tmp/event-agent.log",
    serviceName: "proxy",
  });

  expect(script).toContain('/bin/kill -TERM -- "-$cmd_pid"');
  expect(script).toContain('/usr/bin/kill -TERM -- "-$cmd_pid"');
  expect(script).not.toContain(
    'kill -TERM -- "-$cmd_pid" 2>/dev/null || kill "$cmd_pid" 2>/dev/null || true'
  );
});

async function createLifecycleProjectDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-lifecycle-processes-"));
  tempDirs.add(root);
  const projectDir = resolve(root, ".hack");

  await mkdir(resolve(projectDir, ".internal", "lifecycle"), {
    recursive: true,
  });

  return projectDir;
}
