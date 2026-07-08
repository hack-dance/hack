import { expect, test } from "bun:test";

import { findOrphanDaemonProcesses } from "../src/daemon/process.ts";

const PS_LINES = [
  "  123 /Users/x/.hack/bin/hack daemon start --foreground",
  "  456 /opt/homebrew/bin/hack daemon start --foreground",
  "  789 vim src/commands/daemon.ts",
  "  999 hack daemon status",
];

test("finds daemon processes not tracked by the pid file", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: 123,
    psLines: PS_LINES,
  });
  expect(orphans).toEqual([456]);
});

test("all daemon processes are orphans when no pid is tracked", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: null,
    psLines: PS_LINES,
  });
  expect(orphans).toEqual([123, 456]);
});

test("ignores its own pid and requires the exact daemon marker", async () => {
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: null,
    psLines: [
      `  ${process.pid} hack daemon start --foreground`,
      "  789 tail -f daemon-start-foreground.log",
      "  790 node something daemon start --foreground",
    ],
  });
  expect(orphans).toEqual([790]);
});

import {
  extractLaunchdProgramPath,
  isVirtualExecutablePath,
} from "../src/daemon/launchd.ts";

test("virtual bunfs executable paths are rejected", () => {
  expect(isVirtualExecutablePath("/$bunfs/root/hack")).toBe(true);
  expect(isVirtualExecutablePath("/Users/x/.hack/bin/hack")).toBe(false);
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
