import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directReplacementPath } from "../src/commands/daemon-replace.ts";
import { detachedDaemonEnvironment } from "../src/daemon/spawn.ts";

// A replacement hackd started outside its service must not inherit the
// caller's PATH (HACK-2216): it gets the service's PATH, checked the same way.

let root = "";
let home = "";
let system = "";
let program = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-replace-path-")));
  home = join(root, "home");
  system = join(root, "system-bin");
  await mkdir(join(root, "install"), { mode: 0o755 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(system, { mode: 0o755 });
  program = join(root, "install", "hack");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the detached environment replaces PATH only when a path is given", () => {
  const caller = {
    PATH: "/caller/writable:/usr/bin",
    HACK_DAEMON_RECONCILE_ONLY: "1",
    KEEP: "value",
  };
  expect(detachedDaemonEnvironment(caller)).toEqual({
    PATH: "/caller/writable:/usr/bin",
    KEEP: "value",
  });
  expect(detachedDaemonEnvironment(caller, { path: "/a:/b" })).toEqual({
    PATH: "/a:/b",
    KEEP: "value",
  });
});

test("a direct replacement gets the systemd unit's PATH on Linux and the plist's on macOS", async () => {
  expect(
    await directReplacementPath({
      argv: [program, "daemon", "start", "--foreground"],
      home,
      platform: "linux",
      systemDirectories: [system],
    })
  ).toEqual({
    path: [
      join(root, "install"),
      system,
      join(home, ".local/bin"),
      join(home, ".bun/bin"),
      join(home, ".hack/bin"),
    ].join(":"),
  });
  expect(
    await directReplacementPath({
      argv: [program, "daemon", "start", "--foreground"],
      home,
      platform: "darwin",
      systemDirectories: [system],
    })
  ).toEqual({
    path: [system, join(home, ".bun/bin"), join(home, ".hack/bin")].join(":"),
  });
});

test("a service PATH directory others can add programs to refuses the direct start", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const bun = join(home, ".bun/bin");
    await mkdir(bun, { recursive: true, mode: 0o700 });
    await chmod(bun, 0o777);
    const result = await directReplacementPath({
      argv: [program],
      home,
      platform,
      systemDirectories: [system],
    });
    expect(result).toMatchObject({
      refused: expect.stringContaining("the service PATH"),
    });
    await chmod(bun, 0o700);
    expect(
      await directReplacementPath({
        argv: [program],
        home,
        platform,
        systemDirectories: [system],
      })
    ).toHaveProperty("path");
  }
  // On Linux the program's own directory is on the unit's PATH too.
  await chmod(join(root, "install"), 0o777);
  expect(
    await directReplacementPath({
      argv: [program],
      home,
      platform: "linux",
      systemDirectories: [system],
    })
  ).toHaveProperty("refused");
});
