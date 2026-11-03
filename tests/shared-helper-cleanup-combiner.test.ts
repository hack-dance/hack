import { afterEach, expect, test } from "bun:test";

import {
  type LifecycleSharedHelpers,
  releaseAfterFailedProcessStart,
  withSharedHelperCleanup,
} from "../src/commands/project.ts";
import {
  LIFECYCLE_SESSION_RETAINED,
  LifecycleSessionRetainedError,
} from "../src/lib/project-lifecycle-controller.ts";
import type { ProcessCleanupOutcome } from "../src/lib/project-shared-helpers.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";

/**
 * The combined lifecycle cleanup keeps the session and the helper holders
 * together: when process cleanup is undecidable (the shared helper instance
 * lock was busy), the helper rollback is skipped as well, so a kept session is
 * never left without its helpers.
 */

afterEach(() => {
  setLoggerBackendOverride({ backend: null });
});

function combined(
  outcome: ProcessCleanupOutcome,
  processResult: undefined | "session-retained" = undefined
) {
  const events: string[] = [];
  const sharedHelpers: LifecycleSharedHelpers = {
    configured: true,
    rollback: () => {
      events.push("rollback");
      return Promise.resolve();
    },
    assertCurrent: () => Promise.resolve(),
  };
  const sessionOwnership = {
    runIfOwned: async (cleanup: () => Promise<void>) => {
      if (outcome === "ran") {
        await cleanup();
      }
      events.push(`processes:${outcome}`);
      return outcome;
    },
  };
  const result = withSharedHelperCleanup({
    cleanup: () => {
      events.push("kill-session");
      return Promise.resolve(processResult);
    },
    signalCleanup: null,
    sharedHelpers,
    sessionOwnership,
  });
  return { events, cleanup: result.cleanup };
}

test("an undecidable process cleanup keeps the helper holders too", async () => {
  const { events, cleanup } = combined("undecidable");
  await cleanup?.();
  expect(events).toEqual(["processes:undecidable"]);
});

test("a decided process cleanup is followed by the helper rollback", async () => {
  for (const outcome of ["ran", "adopted"] as const) {
    const { events, cleanup } = combined(outcome);
    await cleanup?.();
    expect(events).toEqual([
      ...(outcome === "ran" ? ["kill-session"] : []),
      `processes:${outcome}`,
      "rollback",
    ]);
  }
});

test("a session kept because its stop was unconfirmed keeps the helper holders too", async () => {
  const { events, cleanup } = combined("ran", "session-retained");
  await cleanup?.();
  expect(events).toEqual(["kill-session", "processes:ran"]);
});

test("a failed process start keeps the helper holders when its session was retained", async () => {
  const cases = [
    {
      name: "abort reports the retained session",
      error: new Error("second process failed"),
      aborted: LIFECYCLE_SESSION_RETAINED,
      rolledBack: false,
    },
    {
      name: "the start already aborted and retained it",
      error: new LifecycleSessionRetainedError(new Error("process failed")),
      aborted: undefined,
      rolledBack: false,
    },
    {
      name: "the session was stopped",
      error: new Error("second process failed"),
      aborted: undefined,
      rolledBack: true,
    },
  ] as const;
  for (const entry of cases) {
    let rolledBack = false;
    await releaseAfterFailedProcessStart({
      error: entry.error,
      abortProcesses: () => Promise.resolve(entry.aborted),
      rollbackHelpers: () => {
        rolledBack = true;
        return Promise.resolve();
      },
    });
    expect({ name: entry.name, rolledBack }).toEqual({
      name: entry.name,
      rolledBack: entry.rolledBack,
    });
  }
});
