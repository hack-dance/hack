import { expect, test } from "bun:test";

import {
  checkNativeAgentPlugin,
  checkNativeAgentPluginCutover,
  mergeLegacyCleanupResults,
  prepareNativeAgentPlugin,
  resolveAgentPluginInstallOutcome,
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

test("native plugin checks report a missing client executable without inspection", async () => {
  let parsed = false;
  const result = await checkNativeAgentPlugin({
    scope: "project",
    pluginId: "hack@example",
    runCommand: null,
    missingExecutableMessage: "client executable is missing",
    inspectErrorMessage: "inspection failed",
    missingPluginMessage: "missing plugin",
    disabledPluginMessage: "disabled plugin",
    parseState: () => {
      parsed = true;
      return { ok: true, installed: true, enabled: true };
    },
  });

  expect(result.status).toBe("missing");
  expect(result.message).toBe("client executable is missing");
  expect(parsed).toBe(false);
});

test("native plugin preparation skips cleanup until the plugin is ready", async () => {
  let cleanupCalled = false;
  const result = await prepareNativeAgentPlugin({
    cleanup: async () => {
      cleanupCalled = true;
      return {
        scope: "project",
        status: "removed" as const,
        path: "/legacy",
      };
    },
    check: async () => ({
      scope: "project",
      status: "missing",
      path: "hack@example",
      message: "install plugin",
    }),
  });

  expect(result.status).toBe("missing");
  expect(result.cleanupStatus).toBeUndefined();
  expect(result.message).toContain("install plugin");
  expect(cleanupCalled).toBe(false);
});

test("cutover checks report readiness before inspecting legacy artifacts", async () => {
  let legacyChecked = false;
  const result = await checkNativeAgentPluginCutover({
    check: async () => ({
      scope: "user",
      status: "stale",
      path: "hack@example",
    }),
    checkLegacy: async () => {
      legacyChecked = true;
      return {
        scope: "user",
        status: "deprecated" as const,
        path: "/legacy",
      };
    },
  });

  expect(result.status).toBe("stale");
  expect(legacyChecked).toBe(false);
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

test("legacy cleanup aggregation gives preserved content precedence over removals", () => {
  const result = mergeLegacyCleanupResults({
    scope: "project",
    fallbackPath: "/fallback",
    results: [
      { status: "removed", path: "/generated" },
      {
        status: "preserved",
        path: "/customized",
        message: "Preserved customized content.",
      },
    ],
  });

  expect(result).toEqual({
    scope: "project",
    status: "preserved",
    path: "/customized",
    message: "Preserved customized content.",
  });
});

test("unavailable plugins are warning outcomes instead of successful installs", () => {
  for (const status of ["missing", "stale", "deprecated"] as const) {
    expect(resolveAgentPluginInstallOutcome({ status })).toBe("warning");
  }
  expect(resolveAgentPluginInstallOutcome({ status: "noop" })).toBe(
    "unchanged"
  );
  expect(resolveAgentPluginInstallOutcome({ status: "removed" })).toBe(
    "updated"
  );
  expect(
    resolveAgentPluginInstallOutcome({
      status: "noop",
      cleanupStatus: "preserved",
    })
  ).toBe("warning");
  expect(
    resolveAgentPluginInstallOutcome({
      status: "noop",
      cleanupStatus: "removed",
    })
  ).toBe("updated");
});
