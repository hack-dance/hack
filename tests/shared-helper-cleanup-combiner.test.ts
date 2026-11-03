import { afterEach, expect, test } from "bun:test";

import {
  type LifecycleSharedHelpers,
  withSharedHelperCleanup,
} from "../src/commands/project.ts";
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

function combined(outcome: ProcessCleanupOutcome) {
  const events: string[] = [];
  const sharedHelpers: LifecycleSharedHelpers = {
    configured: true,
    rollback: () => {
      events.push("rollback");
      return Promise.resolve();
    },
    assertCurrent: () => Promise.resolve(),
    runUnlessNewerStart: async (cleanup) => {
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
      return Promise.resolve();
    },
    signalCleanup: null,
    sharedHelpers,
  });
  return { events, cleanup: result.cleanup };
}

test("an undecidable process cleanup keeps the helper holders too", async () => {
  const { events, cleanup } = combined("undecidable");
  await cleanup?.();
  expect(events).toEqual(["processes:undecidable"]);
});

test("a decided process cleanup is followed by the helper rollback", async () => {
  for (const outcome of ["ran", "newer-start"] as const) {
    const { events, cleanup } = combined(outcome);
    await cleanup?.();
    expect(events).toEqual([
      ...(outcome === "ran" ? ["kill-session"] : []),
      `processes:${outcome}`,
      "rollback",
    ]);
  }
});
