import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MuxCommandTimeoutError } from "../src/mux/mux-backend.ts";
import { createTmuxBackend } from "../src/mux/tmux-backend.ts";

/**
 * A timed-out tmux command is killed and reported as an unknown outcome,
 * never as an empty or absent result: a hung `tmux list-sessions` must not
 * read as "no sessions", or up/down would overwrite or retire a healthy
 * owned session's state.
 */

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalTimeout = process.env.HACK_MUX_COMMAND_TIMEOUT_MS;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalTimeout === undefined) {
    Reflect.deleteProperty(process.env, "HACK_MUX_COMMAND_TIMEOUT_MS");
  } else {
    process.env.HACK_MUX_COMMAND_TIMEOUT_MS = originalTimeout;
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function hangingTmux(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hack-mux-timeout-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  // Every query hangs, like a wedged tmux server.
  await writeFile(join(bin, "tmux"), "#!/bin/sh\nsleep 30\n", {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  process.env.HACK_MUX_COMMAND_TIMEOUT_MS = "200";
}

test("a timed-out tmux session listing throws instead of returning no sessions", async () => {
  await hangingTmux();
  const backend = createTmuxBackend();
  const started = performance.now();
  await expect(backend.listSessions()).rejects.toBeInstanceOf(
    MuxCommandTimeoutError
  );
  expect(performance.now() - started).toBeLessThan(5000);
});

test("a timed-out tmux presence query is unknown, and an ownership-token read throws", async () => {
  await hangingTmux();
  const backend = createTmuxBackend();
  expect(await backend.readSessionPresence?.({ name: "demo" })).toBe("unknown");
  await expect(
    backend.readLifecycleOwnerToken?.({ name: "demo" })
  ).rejects.toBeInstanceOf(MuxCommandTimeoutError);
});
