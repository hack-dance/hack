import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const readControlPlaneConfigMock = mock(async () => {
  throw new Error("should not attempt daemon autostart");
});

mock.module("../src/control-plane/sdk/config.ts", () => ({
  readControlPlaneConfig: readControlPlaneConfigMock,
}));

mock.module("../src/lib/hack-cli.ts", () => ({
  resolveHackInvocation: async () => ({
    bin: "hack",
    args: [],
  }),
}));

mock.module("../src/lib/shell.ts", () => ({
  exec: async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }),
}));

mock.module("../src/daemon/launchd.ts", () => ({
  getLaunchdServiceStatus: async () => ({
    installed: false,
    loaded: false,
    running: false,
    pid: null,
    exitStatus: null,
  }),
  installLaunchdService: async () => ({ ok: true }),
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

const readDaemonStatusMock = mock(async () => ({
  running: false,
  pid: null,
  socketExists: false,
  logExists: false,
}));

mock.module("../src/daemon/status.ts", () => ({
  readDaemonStatus: readDaemonStatusMock,
}));

import { requestDaemonJson } from "../src/daemon/client.ts";

beforeEach(() => {
  readControlPlaneConfigMock.mockClear();
  readDaemonStatusMock.mockClear();
});

afterAll(() => {
  mock.restore();
});

test("requestDaemonJson skips daemon autostart when autoStart is false", async () => {
  const response = await requestDaemonJson({
    path: "/v1/metrics",
    autoStart: false,
  });

  expect(response).toBeNull();
  expect(readControlPlaneConfigMock).not.toHaveBeenCalled();
});
