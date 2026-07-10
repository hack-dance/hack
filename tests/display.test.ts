import { expect, test } from "bun:test";

import { buildPanelLines, buildStatusListLines } from "../src/ui/display.ts";

test("status list aligns rows and wraps diagnostic detail", () => {
  const lines = buildStatusListLines({
    width: 44,
    items: [
      { label: "Runtime", status: "ok", meta: "12 checks" },
      {
        label: "Project & env",
        status: "warn",
        meta: "2 warnings",
        detail:
          "Three projects have services stuck in Created and need a targeted restart.",
      },
    ],
  });

  expect(lines).toEqual([
    "✓  Runtime        12 checks",
    "!  Project & env  2 warnings",
    "   Three projects have services stuck in",
    "   Created and need a targeted restart.",
  ]);
});

test("panel lines keep bullet indentation when wrapping", () => {
  const lines = buildPanelLines({
    width: 36,
    lines: [
      "   - daemon: hackd is running but incompatible (run: hack daemon restart)",
    ],
  });

  expect(lines).toEqual([
    "   - daemon: hackd is running but",
    "     incompatible (run: hack daemon",
    "     restart)",
  ]);
});
