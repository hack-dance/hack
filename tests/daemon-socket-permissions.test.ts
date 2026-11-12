import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  restrictSocketMode,
  secureDaemonDirectory,
} from "../src/daemon/socket-permissions.ts";

/**
 * HACK-2052 (Codex security review): hackd's unauthenticated sockets stay
 * private to their owner even under a shared-group umask.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-socket-mode-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the daemon directory is made owner-only before sockets are bound", async () => {
  const daemonRoot = join(root, "daemon");
  await mkdir(daemonRoot);
  // What `mkdir -p` gives under umask 0002.
  await chmod(daemonRoot, 0o775);
  await secureDaemonDirectory({ root: daemonRoot });
  expect((await stat(daemonRoot)).mode & 0o777).toBe(0o700);
});

test("a bound socket is made owner-only", async () => {
  const daemonRoot = join(root, "daemon");
  await mkdir(daemonRoot);
  const socket = join(daemonRoot, "hackd.sock");
  const previous = process.umask(0o002);
  let server: ReturnType<typeof Bun.listen> | null = null;
  try {
    server = Bun.listen({ unix: socket, socket: { data() {} } });
  } finally {
    process.umask(previous);
  }
  try {
    expect((await stat(socket)).mode & 0o077).not.toBe(0);
    await restrictSocketMode({ path: socket });
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
  } finally {
    server?.stop(true);
  }
});

test("the daemon directory's parents must not be replaceable by other users", async () => {
  // Codex security review: a group-writable ~/.hack let another account
  // rename daemon/ and bind its own socket in its place.
  const home = join(root, "home");
  const hackHome = join(home, ".hack");
  const daemonRoot = join(hackHome, "daemon");
  await mkdir(daemonRoot, { recursive: true });
  await chmod(home, 0o755);
  // Inside the Hack home (umask 0002 leftovers): repaired.
  await chmod(hackHome, 0o775);
  await secureDaemonDirectory({ root: daemonRoot });
  expect((await stat(hackHome)).mode & 0o777).toBe(0o755);
  // Above it (the user's home): refused, left as it is.
  await chmod(home, 0o777);
  try {
    await expect(secureDaemonDirectory({ root: daemonRoot })).rejects.toThrow(
      "not safe from other users"
    );
    expect((await stat(home)).mode & 0o777).toBe(0o777);
  } finally {
    await chmod(home, 0o755);
  }
});

test("a daemon link to another directory is refused before any mode change", async () => {
  // Second-family review: chmod(root) followed a planted `daemon` link and
  // changed an unrelated directory before the trust check refused it.
  const hackHome = join(root, "home", ".hack");
  const unrelated = join(root, "unrelated");
  await mkdir(hackHome, { recursive: true });
  await chmod(join(root, "home"), 0o755);
  await chmod(hackHome, 0o755);
  await mkdir(unrelated);
  await chmod(unrelated, 0o755);
  const daemonRoot = join(hackHome, "daemon");
  await symlink(unrelated, daemonRoot);
  await expect(secureDaemonDirectory({ root: daemonRoot })).rejects.toThrow(
    "not a directory of its own"
  );
  expect((await stat(unrelated)).mode & 0o777).toBe(0o755);
});

test("an unreadable daemon directory of this user's gets the chmod to run", async () => {
  const hackHome = join(root, "home", ".hack");
  const daemonRoot = join(hackHome, "daemon");
  await mkdir(daemonRoot, { recursive: true });
  await chmod(join(root, "home"), 0o755);
  await chmod(hackHome, 0o755);
  await chmod(daemonRoot, 0o300);
  try {
    await expect(secureDaemonDirectory({ root: daemonRoot })).rejects.toThrow(
      "chmod 700"
    );
  } finally {
    await chmod(daemonRoot, 0o700);
  }
});

test("a Hack home under a linked path is still repaired (HACK-2142)", async () => {
  // macOS temp and home paths sit under /var -> /private/var: the chain is
  // walked physically, so an unresolved Hack home matched nothing and a
  // group-writable directory inside it was refused instead of repaired.
  const real = join(root, "real");
  const linked = join(root, "linked");
  await mkdir(join(real, "home", ".hack", "daemon"), { recursive: true });
  await chmod(real, 0o755);
  await chmod(join(real, "home"), 0o755);
  await symlink(real, linked);
  const hackHome = join(linked, "home", ".hack");
  const daemonRoot = join(hackHome, "daemon");
  // What `mkdir -p` gives under umask 0002.
  await chmod(hackHome, 0o775);
  await chmod(daemonRoot, 0o775);
  await secureDaemonDirectory({ root: daemonRoot });
  expect((await stat(hackHome)).mode & 0o777).toBe(0o755);
  expect((await stat(daemonRoot)).mode & 0o777).toBe(0o700);
});
