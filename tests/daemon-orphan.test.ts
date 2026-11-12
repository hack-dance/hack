import { expect, test } from "bun:test";
import {
  type DaemonProcessProbe,
  findOrphanDaemonProcesses,
  parseLsofDaemonSocketOwners,
} from "../src/daemon/process.ts";
import type { ProcessImage } from "../src/daemon/process-image.ts";

/**
 * HACK-2052: `ps` text only nominates candidates. Every orphan passed the
 * full proof (exact argv and resolved executable from the probe, a socket in
 * this daemon root, start time); anything else is reported, never returned
 * for signalling.
 */

const DAEMON_ROOT = "/tmp/hack-home/.hack/daemon";
const ENTRY = "/src/hack/index.ts";
const DAEMON_ARGS = ["daemon", "start", "--foreground"];

function hackImage(executable: string): ProcessImage {
  return { executable, argv: [executable, ...DAEMON_ARGS] };
}

/** A probe over a fixed process table; pids must be live for the proof. */
function tableProbe(
  table: ReadonlyMap<number, ProcessImage>,
  socketOwners: ReadonlySet<number>
): DaemonProcessProbe {
  return {
    birth: () => Promise.resolve("birth"),
    image: (pid) => Promise.resolve(table.get(pid) ?? null),
    socketOwners: ({ pids }) =>
      Promise.resolve(new Set(pids.filter((pid) => socketOwners.has(pid)))),
  };
}

// The proof requires live pids: use this test runner's own children.
const sleepers: ReturnType<typeof Bun.spawn>[] = [];
function livePid(): number {
  const child = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  sleepers.push(child);
  return child.pid;
}

import { afterAll } from "bun:test";

afterAll(async () => {
  for (const child of sleepers.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("only processes that pass the proof are orphans; text matches are reported", async () => {
  const tracked = livePid();
  const untracked = livePid();
  const python = livePid();
  const otherCheckout = livePid();
  const foreign = livePid();
  const unknown = livePid();
  const dev = livePid();
  const table = new Map<number, ProcessImage>([
    [tracked, hackImage("/usr/local/bin/hack")],
    [untracked, hackImage("/opt/homebrew/bin/hack")],
    // Review r2 #1: `ps` shows a daemon start, but the program is Python.
    [
      python,
      {
        executable: "/usr/bin/python3",
        argv: ["/usr/bin/python3", "/tmp/hack-fixture", ...DAEMON_ARGS],
      },
    ],
    [
      otherCheckout,
      {
        executable: "/usr/bin/bun",
        argv: ["bun", "/other/index.ts", ...DAEMON_ARGS],
      },
    ],
    [foreign, hackImage("/usr/local/bin/hack")],
    [dev, { executable: "/usr/bin/bun", argv: ["bun", ENTRY, ...DAEMON_ARGS] }],
  ]);
  const scan = await findOrphanDaemonProcesses({
    trackedPid: tracked,
    daemonRoot: DAEMON_ROOT,
    psLines: [
      `  ${tracked} /usr/local/bin/hack daemon start --foreground`,
      `  ${untracked} /opt/homebrew/bin/hack daemon start --foreground`,
      `  ${python} /usr/bin/python3 /tmp/hack-fixture daemon start --foreground`,
      `  ${otherCheckout} bun /other/index.ts daemon start --foreground`,
      `  ${foreign} /usr/local/bin/hack daemon start --foreground`,
      `  ${unknown} /usr/local/bin/hack daemon start --foreground`,
      `  ${dev} bun ${ENTRY} daemon start --foreground`,
      `  ${process.pid} hack daemon start --foreground`,
      "  789 vim src/commands/daemon.ts",
      "  999 hack daemon status",
    ],
    probe: tableProbe(
      table,
      new Set([tracked, untracked, python, otherCheckout, unknown, dev])
    ),
    expectation: { entryFiles: new Set([ENTRY]) },
  });
  expect(scan.orphans.map((orphan) => orphan.pid)).toEqual([untracked, dev]);
  expect(scan.refused).toEqual([
    { pid: python, reason: "not-hackd" },
    { pid: otherCheckout, reason: "not-hackd" },
    { pid: foreign, reason: "foreign-socket" },
    { pid: unknown, reason: "identity-unknown" },
  ]);
});

test("a dead candidate is neither an orphan nor reported", async () => {
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  const scan = await findOrphanDaemonProcesses({
    trackedPid: null,
    daemonRoot: DAEMON_ROOT,
    psLines: [`  ${gone.pid} /usr/local/bin/hack daemon start --foreground`],
    probe: tableProbe(new Map(), new Set()),
    expectation: { entryFiles: new Set() },
  });
  expect(scan).toEqual({ orphans: [], refused: [] });
});

test("lsof parsing accepts this root's sockets and Linux stream names only", async () => {
  const owners = await parseLsofDaemonSocketOwners({
    daemonRoot: DAEMON_ROOT,
    lines: [
      "p123",
      `n${DAEMON_ROOT}/hackd.sock`,
      "p456",
      `n${DAEMON_ROOT}/hackd.internal.sock type=STREAM`,
      "p457",
      `n${DAEMON_ROOT}/hackd.sock.backup type=STREAM`,
      "p458",
      "n/tmp/other-home/daemon/hackd.sock",
      "p459",
      `n${DAEMON_ROOT}/hackd.sock type=STREAM extra`,
    ],
  });
  expect(owners).toEqual(new Set([123, 456]));
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
