import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requestDaemonJson } from "../src/daemon/client.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  tempDir = await mkdtemp(join(tmpdir(), "hack-daemon-client-"));
  process.env.HOME = tempDir;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
});

test("requestDaemonJson skips daemon autostart when autoStart is false", async () => {
  const response = await requestDaemonJson({
    path: "/v1/metrics",
    autoStart: false,
  });

  expect(response).toBeNull();
});
