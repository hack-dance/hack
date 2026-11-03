import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repairFailedRestart } from "../src/commands/project.ts";
import {
  DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS,
  DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
} from "../src/lib/compose-startup-budget.ts";
import { SharedHelperSupersededError } from "../src/lib/project-shared-helpers.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";

/**
 * The restart repair attempt launches containers too, so it runs behind the
 * same shared helper guard as the first attempt: a concurrent down that
 * released the helpers stops the repair before any container starts.
 */

const roots: string[] = [];

afterEach(async () => {
  setLoggerBackendOverride({ backend: null });
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const budgets = {
  startupTimeoutMs: DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
  imageTimeoutMs: DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS,
};

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-restart-repair-"));
  roots.push(root);
  return root;
}

test("a superseded restart repair cleans up and starts no container", async () => {
  const projectDir = await scratch();
  const events: string[] = [];
  const result = await repairFailedRestart({
    budgets,
    upCode: 1,
    composePhase: "start",
    assertCurrent: () => Promise.reject(new SharedHelperSupersededError()),
    cleanup: () => {
      events.push("cleanup");
      return Promise.resolve();
    },
    projectDir,
    lifecycleComposeProject: "demo--branch-a",
    up: async (beforeStart) => {
      events.push(beforeStart ? "up-guarded" : "up-unguarded");
      // The backend awaits beforeStart right before containers start.
      await beforeStart?.();
      events.push("containers-started");
      return 0;
    },
  });
  expect(result).toEqual({ code: 1, phase: "lifecycle" });
  expect(events).toEqual(["up-guarded", "cleanup"]);
});

test("a current restart repair runs guarded and reports the original failure", async () => {
  const projectDir = await scratch();
  const checks: unknown[] = [];
  const result = await repairFailedRestart({
    budgets,
    upCode: 3,
    composePhase: "start",
    assertCurrent: (check) => {
      checks.push(check ?? "before-start");
      return Promise.resolve();
    },
    cleanup: () => Promise.reject(new Error("must not clean up a repair")),
    projectDir,
    lifecycleComposeProject: "demo--branch-a",
    up: async (beforeStart) => {
      await beforeStart?.();
      return 0;
    },
  });
  expect(result).toEqual({ code: 3, phase: "compose", composePhase: "start" });
  expect(checks).toEqual(["before-start", { servicesStarted: true }]);
});

test("a failed repair keeps the shared helpers when containers may run, before cleanup", async () => {
  const projectDir = await scratch();
  const events: string[] = [];
  const result = await repairFailedRestart({
    budgets,
    upCode: 1,
    composePhase: "start",
    assertCurrent: () => Promise.resolve(),
    cleanup: () => {
      events.push("cleanup");
      return Promise.resolve();
    },
    retainHelpersIfContainersMayRun: () => {
      events.push("retain-check");
      return Promise.resolve();
    },
    projectDir,
    lifecycleComposeProject: "demo--branch-a",
    up: () => Promise.resolve(124),
  });
  expect(result.code).toBe(1);
  expect(events).toEqual(["retain-check", "cleanup"]);
});
