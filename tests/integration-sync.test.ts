import { expect, test } from "bun:test";

import { syncLegacyScopesWhenPluginReady } from "../src/cli/integration-sync.ts";

test("automatic integration sync leaves both scopes untouched until plugin readiness", async () => {
  let cleanupCalls = 0;
  const statuses = await syncLegacyScopesWhenPluginReady({
    check: async () => ({ status: "stale" }),
    cleanups: [
      async () => {
        cleanupCalls += 1;
        return { status: "removed" };
      },
      async () => {
        cleanupCalls += 1;
        return { status: "removed" };
      },
    ],
  });

  expect(statuses).toEqual(["stale"]);
  expect(cleanupCalls).toBe(0);
});

test("automatic integration sync cleans both scopes after plugin readiness", async () => {
  let cleanupCalls = 0;
  const statuses = await syncLegacyScopesWhenPluginReady({
    check: async () => ({ status: "noop" }),
    cleanups: [
      async () => {
        cleanupCalls += 1;
        return { status: "removed" };
      },
      async () => {
        cleanupCalls += 1;
        return { status: "absent" };
      },
    ],
  });

  expect(statuses).toEqual(["removed", "absent"]);
  expect(cleanupCalls).toBe(2);
});
