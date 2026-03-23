import { expect, test } from "bun:test";

import { __testOnlyProjectsCommand } from "../src/commands/projects.ts";

test("buildRuntimeRecoveryNotice reports manual action guidance", () => {
  const notice = __testOnlyProjectsCommand.buildRuntimeRecoveryNotice({
    runtimeMeta: {
      resetCount: 2,
      lastResetSummary: "engine id changed",
      lastRepairAction: "refresh_runtime_snapshot",
      lastRepairOutcome: "manual_action_required",
      nextStep: "Restart affected projects with `hack up`.",
    },
  });

  expect(notice).toEqual({
    title: "Runtime reset detected",
    tone: "warn",
    lines: [
      "Detected reset #2: engine id changed",
      "hackd repair: refresh_runtime_snapshot -> manual_action_required",
      "Next step: Restart affected projects with `hack up`.",
    ],
  });
});

test("buildRuntimeRecoveryNotice reports stabilized repairs", () => {
  const notice = __testOnlyProjectsCommand.buildRuntimeRecoveryNotice({
    runtimeMeta: {
      resetCount: 1,
      lastResetSummary: "socket inode changed",
      lastRepairAction: "refresh_runtime_snapshot",
      lastRepairOutcome: "stabilized",
      nextStep: null,
    },
  });

  expect(notice).toEqual({
    title: "Runtime reset detected",
    tone: "info",
    lines: [
      "Detected reset #1: socket inode changed",
      "hackd repair: refresh_runtime_snapshot -> stabilized",
    ],
  });
});

test("buildRuntimeRecoveryNotice returns null without recovery metadata", () => {
  const notice = __testOnlyProjectsCommand.buildRuntimeRecoveryNotice({
    runtimeMeta: {
      resetCount: 0,
      lastResetSummary: null,
      lastRepairAction: null,
      lastRepairOutcome: null,
      nextStep: null,
    },
  });

  expect(notice).toBeNull();
});
