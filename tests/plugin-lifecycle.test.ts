import { expect, test } from "bun:test";

import {
  checkNativeAgentPlugin,
  mergeLegacyCleanupResults,
  prepareNativeAgentPlugin,
} from "../src/agents/plugin-lifecycle.ts";

test("native plugin checks map client state to lifecycle results", async () => {
  const result = await checkNativeAgentPlugin({
    scope: "user",
    pluginId: "hack@example",
    runCommand: async () => ({
      exitCode: 0,
      stdout: "client output",
      stderr: "",
    }),
    missingExecutableMessage: "missing executable",
    inspectErrorMessage: "inspection failed",
    missingPluginMessage: "missing plugin",
    disabledPluginMessage: "disabled plugin",
    parseState: ({ json }) => ({
      ok: true,
      installed: json === "client output",
      enabled: false,
    }),
  });

  expect(result).toEqual({
    scope: "user",
    status: "stale",
    path: "hack@example",
    message: "disabled plugin",
  });
});

test("native plugin preparation preserves cleanup as a secondary outcome", async () => {
  const result = await prepareNativeAgentPlugin({
    cleanup: async () => ({
      scope: "project",
      status: "removed",
      path: "/legacy",
    }),
    check: async () => ({
      scope: "project",
      status: "missing",
      path: "hack@example",
      message: "install plugin",
    }),
  });

  expect(result.status).toBe("missing");
  expect(result.cleanupStatus).toBe("removed");
  expect(result.message).toContain(
    "Removed deprecated standalone integration artifacts."
  );
  expect(result.message).toContain("install plugin");
});

test("legacy cleanup aggregation gives errors precedence over mutations", () => {
  const result = mergeLegacyCleanupResults({
    scope: "project",
    fallbackPath: "/fallback",
    results: [
      { status: "removed", path: "/removed" },
      { status: "error", path: "/failed", message: "cleanup failed" },
    ],
  });

  expect(result).toEqual({
    scope: "project",
    status: "error",
    path: "/failed",
    message: "cleanup failed",
  });
});
