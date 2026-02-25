import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __testOnlyMutagenSync,
  ensureMutagenLocalToRemoteSync,
} from "../src/lib/mutagen-sync.ts";

let tempDir: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-mutagen-sync-"));
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("parseSshSource parses user, host, and port", () => {
  expect(
    __testOnlyMutagenSync.parseSshSource({
      source: "remote-user@198.51.100.42:2222",
    })
  ).toEqual({
    user: "remote-user",
    host: "198.51.100.42",
    port: 2222,
  });
  expect(
    __testOnlyMutagenSync.parseSshSource({
      source: "node-a.tailnet.ts.net",
    })
  ).toEqual({
    host: "node-a.tailnet.ts.net",
  });
});

test("buildMutagenSessionName is deterministic and normalized", () => {
  const first = __testOnlyMutagenSync.buildMutagenSessionName({
    projectName: "Live Nation App",
    nodeId: "db5d885f-1647-4229-add9-2a5e5833e7a4",
    branch: "feat/remote-sync",
    localProjectRoot: "/Users/hack/dev/hack",
    remoteProjectRoot: "/Users/remote-user/.hack/projects/hack",
  });
  const second = __testOnlyMutagenSync.buildMutagenSessionName({
    projectName: "Live Nation App",
    nodeId: "db5d885f-1647-4229-add9-2a5e5833e7a4",
    branch: "feat/remote-sync",
    localProjectRoot: "/Users/hack/dev/hack",
    remoteProjectRoot: "/Users/remote-user/.hack/projects/hack",
  });

  expect(first).toBe(second);
  expect(first.startsWith("hack-live-nation-app-db5d885f-")).toBe(true);
  expect(/-[a-f0-9]{8}$/.test(first)).toBe(true);
  expect(first.length).toBeLessThanOrEqual(72);
});

test("ensureMutagenLocalToRemoteSync creates and flushes session", async () => {
  const calls: string[][] = [];
  const result = await ensureMutagenLocalToRemoteSync({
    projectName: "event-agent",
    nodeId: "node-1",
    branch: "feat/e2e",
    nodeSource: "remote-user@198.51.100.42:2222",
    localProjectRoot: tempDir!,
    remoteProjectRoot: "/Users/remote-user/.hack/projects/event-agent",
    exclude: ["node_modules", "dist", ".git"],
    resolveBinary: () => "/opt/homebrew/bin/mutagen",
    execCommand: async ({ cmd }) => {
      calls.push([...cmd]);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.created).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.slice(0, 7)).toEqual([
    "/opt/homebrew/bin/mutagen",
    "sync",
    "create",
    "--name",
    result.sessionName,
    "--sync-mode",
    "one-way-safe",
  ]);
  expect(calls[0]).toContain("--ignore");
  expect(calls[0]).toContain(".git");
  expect(calls[0]).toContain("node_modules");
  expect(calls[1]).toEqual([
    "/opt/homebrew/bin/mutagen",
    "sync",
    "flush",
    result.sessionName,
  ]);
});

test("ensureMutagenLocalToRemoteSync tolerates existing session and still flushes", async () => {
  const calls: string[][] = [];
  const result = await ensureMutagenLocalToRemoteSync({
    projectName: "event-agent",
    nodeId: "node-1",
    nodeSource: "remote-user@198.51.100.42",
    localProjectRoot: tempDir!,
    remoteProjectRoot: "/Users/remote-user/.hack/projects/event-agent",
    resolveBinary: () => "/opt/homebrew/bin/mutagen",
    execCommand: async ({ cmd }) => {
      calls.push([...cmd]);
      if (calls.length === 1) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "session named hack-event-agent-node-1-default already exists",
        };
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    return;
  }
  expect(result.created).toBe(false);
  expect(calls).toHaveLength(2);
});

test("ensureMutagenLocalToRemoteSync fails when binary is unavailable", async () => {
  const result = await ensureMutagenLocalToRemoteSync({
    projectName: "event-agent",
    nodeId: "node-1",
    nodeSource: "remote-user@198.51.100.42",
    localProjectRoot: tempDir!,
    remoteProjectRoot: "/Users/remote-user/.hack/projects/event-agent",
    resolveBinary: () => null,
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.code).toBe("missing_binary");
});

test("ensureMutagenLocalToRemoteSync fails when node source is missing", async () => {
  const result = await ensureMutagenLocalToRemoteSync({
    projectName: "event-agent",
    nodeId: "node-1",
    nodeSource: " ",
    localProjectRoot: tempDir!,
    remoteProjectRoot: "/Users/remote-user/.hack/projects/event-agent",
    resolveBinary: () => "/opt/homebrew/bin/mutagen",
    execCommand: async () => {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.code).toBe("missing_source");
});
