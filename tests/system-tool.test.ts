import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  defaultDaemonProcessProbe,
  findOrphanDaemonProcesses,
} from "../src/daemon/process.ts";
import { readObservedProcesses } from "../src/lib/host-command-observation.ts";
import { resolveSystemTool } from "../src/lib/system-tool.ts";

/*
 * HACK-2216: the daemon's process proofs (the orphan sweep and the
 * ownership proof an automatic replacement runs) never look `ps` or `lsof`
 * up on PATH. They run a fixed, trusted path, or treat the observation as
 * unknown.
 */

let root: string;
let planted: string;
let savedPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-system-tool-"));
  planted = join(root, "planted-bin");
  await mkdir(planted);
  // Stand-ins that leave a marker if they ever run.
  for (const tool of ["ps", "lsof"]) {
    const path = join(planted, tool);
    await writeFile(
      path,
      `#!/bin/sh\n: > "${join(root, `${tool}-ran`)}"\nexit 0\n`
    );
    await chmod(path, 0o755);
  }
  savedPath = process.env.PATH;
  process.env.PATH = `${planted}:${savedPath ?? "/usr/bin:/bin"}`;
});

afterEach(async () => {
  if (savedPath === undefined) {
    Reflect.deleteProperty(process.env, "PATH");
  } else {
    process.env.PATH = savedPath;
  }
  await rm(root, { recursive: true, force: true });
});

async function plantedRan(tool: string): Promise<boolean> {
  return await Bun.file(join(root, `${tool}-ran`)).exists();
}

test("an automatic replacement's sweep and ownership proof never run a ps or lsof from PATH", async () => {
  const spawned: string[] = [];
  const spawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((
    ...args: Parameters<typeof Bun.spawn>
  ) => {
    const first = args[0] as
      | readonly string[]
      | { readonly cmd: readonly string[] };
    const argv = "cmd" in first ? first.cmd : first;
    spawned.push(String(argv[0]));
    return spawn(...args);
  }) as typeof Bun.spawn);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    // The orphan sweep (process table) and a snapshot read.
    await findOrphanDaemonProcesses({ trackedPid: null, daemonRoot: root });
    await readObservedProcesses([process.pid]);
    // The ownership proof as macOS runs it: births through `ps`, socket
    // owners through `lsof`.
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    await defaultDaemonProcessProbe.birth(process.pid);
    await defaultDaemonProcessProbe.socketOwners({
      daemonRoot: root,
      pids: [process.pid],
    });
  } finally {
    if (platform) {
      Object.defineProperty(process, "platform", platform);
    }
    spy.mockRestore();
  }
  // Every tool these ran was an absolute path outside the planted dir.
  for (const program of spawned) {
    expect(isAbsolute(program)).toBe(true);
    expect(program.startsWith(planted)).toBe(false);
  }
  expect(await plantedRan("ps")).toBe(false);
  expect(await plantedRan("lsof")).toBe(false);
});

test("resolveSystemTool returns a fixed, trusted path or null, never PATH", () => {
  const exists = (paths: readonly string[]) => (path: string) =>
    paths.includes(path);
  const trusted = () => true;
  expect(
    resolveSystemTool("ps", {
      platform: "darwin",
      exists: exists(["/bin/ps"]),
      isTrusted: trusted,
    })
  ).toBe("/bin/ps");
  expect(
    resolveSystemTool("lsof", {
      platform: "darwin",
      exists: exists(["/usr/sbin/lsof"]),
      isTrusted: trusted,
    })
  ).toBe("/usr/sbin/lsof");
  // Linux: the first existing candidate.
  expect(
    resolveSystemTool("ps", {
      platform: "linux",
      exists: exists(["/usr/bin/ps"]),
      isTrusted: trusted,
    })
  ).toBe("/usr/bin/ps");
  expect(
    resolveSystemTool("lsof", {
      platform: "linux",
      exists: exists(["/usr/sbin/lsof"]),
      isTrusted: trusted,
    })
  ).toBe("/usr/sbin/lsof");
  // An untrusted candidate is skipped; none left is null (unknown).
  expect(
    resolveSystemTool("ps", {
      platform: "linux",
      exists: exists(["/bin/ps", "/usr/bin/ps"]),
      isTrusted: (path) => path !== "/bin/ps",
    })
  ).toBe("/usr/bin/ps");
  expect(
    resolveSystemTool("ps", {
      platform: "linux",
      exists: exists(["/bin/ps"]),
      isTrusted: () => false,
    })
  ).toBeNull();
  expect(
    resolveSystemTool("lsof", {
      platform: "linux",
      exists: exists([]),
      isTrusted: trusted,
    })
  ).toBeNull();
  expect(
    resolveSystemTool("ps", { platform: "win32", isTrusted: trusted })
  ).toBeNull();
});

test("the orphan sweep reports an unknown process table when no trusted ps exists", async () => {
  // A platform with no fixed `ps` candidate: resolveSystemTool finds none,
  // and the planted `ps` on PATH is never used instead.
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let scan: Awaited<ReturnType<typeof findOrphanDaemonProcesses>>;
  try {
    Object.defineProperty(process, "platform", {
      value: "freebsd",
      configurable: true,
    });
    scan = await findOrphanDaemonProcesses({
      trackedPid: null,
      daemonRoot: root,
    });
  } finally {
    if (platform) {
      Object.defineProperty(process, "platform", platform);
    }
  }
  // Unknown, never "no orphans".
  expect(scan.unknown).toBe(true);
  expect(scan.orphans).toEqual([]);
  expect(await plantedRan("ps")).toBe(false);
});
