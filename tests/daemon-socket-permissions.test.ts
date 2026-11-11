import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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
