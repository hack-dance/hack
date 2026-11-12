import { expect, test } from "bun:test";

import { startDockerEventWatcher } from "../src/daemon/docker-events.ts";

/**
 * hackd starts the Docker event watcher at boot. On a host without
 * `docker` on PATH (macOS CI, a service with a narrow PATH) Bun.spawn
 * throws synchronously; the watcher must report that and keep retrying,
 * not reject its loop and crash hackd (HACK-2052).
 */

test("a missing docker is reported, not thrown, and the watcher stops cleanly", async () => {
  const errors: string[] = [];
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const watcher = startDockerEventWatcher({
      onEvent: () => undefined,
      onError: (message) => {
        errors.push(message);
      },
      onExit: () => undefined,
      dockerCommand: "hack-test-no-such-docker",
    });
    await Bun.sleep(100);
    watcher.stop();
    await Bun.sleep(50);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(unhandled).toBeNull();
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]).toContain("docker events could not start");
});
