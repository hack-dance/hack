import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const statusQueue: Array<{
  readonly running: boolean;
  readonly pid: number | null;
  readonly socketExists: boolean;
  readonly logExists: boolean;
}> = [];
const execCalls: string[][] = [];

mock.module("../src/control-plane/sdk/config.ts", () => ({
  readControlPlaneConfig: async () => ({
    config: {
      tickets: {
        git: {
          enabled: true,
          branch: "hack/tickets",
          remote: "origin",
          forceBareClone: false,
          refMode: "hidden",
        },
      },
      daemon: {
        autoStart: true,
        launchd: {
          runAtLoad: true,
          guiSessionOnly: true,
        },
      },
    },
  }),
}));

mock.module("../src/lib/hack-cli.ts", () => ({
  resolveHackInvocation: async () => ({
    bin: "hack",
    args: [],
  }),
}));

mock.module("../src/lib/shell.ts", () => ({
  exec: async (cmd: readonly string[]) => {
    execCalls.push([...cmd]);
    return { exitCode: 0, stdout: "", stderr: "" };
  },
}));

mock.module("../src/daemon/launchd.ts", () => ({
  getLaunchdServiceStatus: async () => ({
    installed: false,
    loaded: false,
    running: false,
    pid: null,
    exitStatus: null,
  }),
  installLaunchdService: async () => ({ ok: true, alreadyInstalled: false }),
  kickstartLaunchdService: async () => ({ ok: true }),
}));

mock.module("../src/daemon/paths.ts", () => ({
  resolveDaemonPaths: () => ({
    root: "/tmp/hackd",
    socketPath: "/tmp/hackd.sock",
    pidPath: "/tmp/hackd.pid",
    logPath: "/tmp/hackd.log",
    launchdPlistPath: "/tmp/hackd.plist",
  }),
}));

mock.module("../src/daemon/status.ts", () => ({
  readDaemonStatus: async () =>
    statusQueue.shift() ?? {
      running: true,
      pid: 456,
      socketExists: true,
      logExists: true,
    },
}));

const originalFetch = globalThis.fetch;

import { requestDaemonJson } from "../src/daemon/client.ts";

beforeEach(() => {
  statusQueue.length = 0;
  execCalls.length = 0;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

test("requestDaemonJson auto-repairs stale daemon state before retrying", async () => {
  statusQueue.push(
    {
      running: false,
      pid: 123,
      socketExists: true,
      logExists: false,
    },
    {
      running: true,
      pid: 456,
      socketExists: true,
      logExists: true,
    }
  );

  const responses = [
    new Response(JSON.stringify({ status: "ok", version: "1.17.1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(JSON.stringify({ status: "ok", projects: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];

  globalThis.fetch = (async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("unexpected fetch");
    }
    return next;
  }) as unknown as typeof globalThis.fetch;

  const response = await requestDaemonJson({
    path: "/v1/projects",
  });

  expect(execCalls).toEqual(
    process.platform === "darwin" ? [] : [["hack", "daemon", "start"]]
  );
  expect(response).not.toBeNull();
  expect(response?.ok).toBe(true);
  expect(response?.json).toEqual({ status: "ok", projects: [] });
});
