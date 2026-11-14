import { expect, test } from "bun:test";
import {
  bothForegroundContainersRunning,
  bothForegroundServicesLogged,
  waitForForegroundContainers,
} from "./e2e/foreground-readiness.ts";

const app = "app-1 | foreground-ready:app\n";
const worker = "worker-1 | foreground-ready:worker\n";
const listing = (stdout: string, exitCode = 0) => ({
  stdout,
  exitCode,
  stderr: "",
});

test("foreground readiness rejects replayed app logs and echoed marker text", () => {
  expect(bothForegroundServicesLogged(app + app)).toBe(false);
  expect(
    bothForegroundServicesLogged(
      "echo foreground-ready:app; echo foreground-ready:worker\n"
    )
  ).toBe(false);
  expect(bothForegroundServicesLogged(app + worker)).toBe(true);
  expect(bothForegroundServicesLogged(worker)).toBe(false);
});

test("foreground container readiness requires each named service in a successful listing", () => {
  expect(bothForegroundContainersRunning(listing("a\tapp\nb\tapp\n"))).toBe(
    false
  );
  expect(
    bothForegroundContainersRunning(listing("a\tapp\nb\tworker\n", 1))
  ).toBe(false);
  expect(bothForegroundContainersRunning(listing("a\tapp\nb\tworker\n"))).toBe(
    true
  );
});

test("foreground readiness waits through an incomplete running-container listing", async () => {
  let now = 0;
  let reads = 0;
  const result = await waitForForegroundContainers({
    alive: () => true,
    read: async () => {
      reads += 1;
      return listing(reads === 1 ? "a\tapp\n" : "a\tapp\nb\tworker\n");
    },
    runtime: {
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    },
  });
  expect(reads).toBe(2);
  expect(now).toBeGreaterThan(0);
  expect(bothForegroundContainersRunning(result)).toBe(true);
});

test("foreground readiness is bounded and reports the last container listing", async () => {
  let now = 0;
  await expect(
    waitForForegroundContainers({
      timeoutMs: 250,
      alive: () => true,
      read: async () => listing("only-app\tapp\n"),
      runtime: {
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      },
    })
  ).rejects.toThrow("only-app\tapp");
  expect(now).toBe(250);
});
