import { expect, test } from "bun:test";

import { findOrphanDaemonProcesses } from "../src/daemon/process.ts";

const PS_LINES = [
  "  123 /tmp/hack-home/.hack/bin/hack daemon start --foreground",
  "  456 /opt/homebrew/bin/hack daemon start --foreground",
  "  789 vim src/commands/daemon.ts",
  "  999 hack daemon status",
];
const DAEMON_ROOT = "/tmp/hack-home/.hack/daemon";
const LSOF_LINES = [
  "p123",
  `n${DAEMON_ROOT}/hackd.sock`,
  "p456",
  `n${DAEMON_ROOT}/hackd.internal.sock`,
];

test("finds daemon processes not tracked by the pid file", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: 123,
    daemonRoot: DAEMON_ROOT,
    psLines: PS_LINES,
    lsofLines: LSOF_LINES,
  });
  expect(orphans).toEqual([456]);
});

test("only socket-owned daemon processes are orphans when no pid is tracked", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: null,
    daemonRoot: DAEMON_ROOT,
    psLines: PS_LINES,
    lsofLines: LSOF_LINES,
  });
  expect(orphans).toEqual([123, 456]);
});

test("ignores its own pid, non-hack executables, and near-miss commands", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: null,
    daemonRoot: DAEMON_ROOT,
    psLines: [
      `  ${process.pid} hack daemon start --foreground`,
      "  789 tail -f daemon-start-foreground.log",
      "  790 node something daemon start --foreground",
      "  791 /tmp/hack-repo/bin/hack-dev daemon start --foreground",
      "  792 bun /tmp/hack-repo/index.ts daemon start --foreground",
    ],
    lsofLines: [
      "p791",
      `n${DAEMON_ROOT}/hackd.sock`,
      "p792",
      `n${DAEMON_ROOT}/hackd.internal.sock`,
    ],
  });
  expect(orphans).toEqual([791, 792]);
});

test("preserves daemons belonging to another state directory", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: null,
    daemonRoot: DAEMON_ROOT,
    psLines: PS_LINES,
    lsofLines: [
      "p123",
      "n/tmp/other-home/daemon/hackd.sock",
      "p456",
      `n${DAEMON_ROOT}/hackd.sock.backup`,
    ],
  });
  expect(orphans).toEqual([]);
});

test("does not authorize cleanup without socket ownership evidence", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: null,
    daemonRoot: DAEMON_ROOT,
    psLines: PS_LINES,
    lsofLines: [],
  });
  expect(orphans).toEqual([]);
});

import {
  extractLaunchdProgramPath,
  isVirtualExecutablePath,
} from "../src/daemon/launchd.ts";

test("virtual bunfs executable paths are rejected", () => {
  expect(isVirtualExecutablePath("/$bunfs/root/hack")).toBe(true);
  expect(isVirtualExecutablePath("/tmp/hack-home/.hack/bin/hack")).toBe(false);
});

test("extracts the launchd program path from plist text", () => {
  const plist = [
    "<key>Label</key>",
    "<string>dance.hack.hackd</string>",
    "<key>ProgramArguments</key>",
    "<array>",
    "  <string>/$bunfs/root/hack</string>",
    "  <string>daemon</string>",
    "</array>",
  ].join("\n");
  expect(extractLaunchdProgramPath({ plistText: plist })).toBe(
    "/$bunfs/root/hack"
  );
  expect(extractLaunchdProgramPath({ plistText: "<plist/>" })).toBeNull();
});
