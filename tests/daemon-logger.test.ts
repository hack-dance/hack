import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDaemonLogger,
  DAEMON_LOG_MAX_BYTES,
} from "../src/daemon/logger.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-daemon-log-"));
  roots.push(root);
  const logPath = join(root, "hackd.log");
  return {
    logPath,
    logger: createDaemonLogger({ logPath, foreground: false }),
  };
}

test("repeated warning bursts stay capped and retain the newest diagnostics", async () => {
  const { logPath, logger } = await fixture();
  const diagnostic = "x".repeat(64 * 1024);
  for (let burst = 0; burst < 3; burst++) {
    for (let index = 0; index < 100; index++) {
      logger.warn({ message: diagnostic });
      logger.warn({ message: "docker events exited (1)" });
    }
    logger.info({ message: `burst ${burst} complete` });
    await logger.flush();
    expect((await stat(logPath)).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(await Bun.file(logPath).text()).toEndWith(
      `burst ${burst} complete\n`
    );
  }
});

test("caps an oversized legacy log on the next write", async () => {
  const { logPath, logger } = await fixture();
  await writeFile(logPath, Buffer.alloc(DAEMON_LOG_MAX_BYTES + 100));
  logger.error({ message: "new diagnostic" });
  await logger.flush();
  expect((await stat(logPath)).size).toBeLessThan(1024);
  expect(await Bun.file(logPath).text()).toEndWith("new diagnostic\n");
});

test("a single oversized multibyte record cannot exceed the byte cap", async () => {
  const { logPath, logger } = await fixture();
  logger.warn({ message: `${"é".repeat(DAEMON_LOG_MAX_BYTES)} end` });
  await logger.flush();
  expect((await stat(logPath)).size).toBe(5 * 1024 * 1024);
  expect(await Bun.file(logPath).text()).toEndWith(" end\n");
});

test("a write failure does not prevent later diagnostics", async () => {
  const { logPath, logger } = await fixture();
  await rm(dirname(logPath), { recursive: true });
  logger.warn({ message: "unavailable" });
  await logger.flush();
  await mkdir(dirname(logPath));
  logger.info({ message: "recovered" });
  await logger.flush();
  expect(await Bun.file(logPath).text()).toEndWith("recovered\n");
});
