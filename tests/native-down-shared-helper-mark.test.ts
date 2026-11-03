import { expect, test } from "bun:test";

import { markSharedHelpersStoppingAfter } from "../src/commands/project.ts";

/**
 * Native `hack down` marks shared helpers as stopping only after its
 * `lifecycle.down.before` step succeeds, like the Compose path. A refused down
 * must not supersede a concurrent up of the same instance.
 */

test("a failing down.before step writes no stopping mark", async () => {
  const events: string[] = [];
  const before = markSharedHelpersStoppingAfter({
    before: () => {
      events.push("before");
      return Promise.reject(new Error("down.before hook failed"));
    },
    mark: () => {
      events.push("mark");
      return Promise.resolve();
    },
  });
  await expect(before("run")).rejects.toThrow("down.before hook failed");
  expect(events).toEqual(["before"]);
});

test("a successful down.before step is followed by the stopping mark", async () => {
  const events: string[] = [];
  const before = markSharedHelpersStoppingAfter({
    before: (run: string) => {
      events.push(`before:${run}`);
      return Promise.resolve();
    },
    mark: () => {
      events.push("mark");
      return Promise.resolve();
    },
  });
  await before("run-1");
  expect(events).toEqual(["before:run-1", "mark"]);
});
