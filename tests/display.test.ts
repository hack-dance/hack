import { expect, test } from "bun:test";

import { buildPanelLines, renderStatusList } from "../src/ui/display.ts";
import { createTextOutput } from "../src/ui/text-output.ts";

test("status list aligns rows and wraps diagnostic detail", () => {
  const lines: string[] = [];
  renderStatusList({
    output: createTextOutput({
      tty: false,
      write: (text) => lines.push(text.slice(0, -1)),
    }),
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
    "",
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

test("colored Doctor status list matches the golden", async () => {
  let text = "";
  renderStatusList({
    title: "Doctor summary",
    items: [
      { label: "Runtime", status: "ok", meta: "12 checks" },
      {
        label: "Routing",
        status: "error",
        meta: "1 error",
        detail: "Proxy is unreachable",
      },
    ],
    width: 80,
    output: createTextOutput({
      color: true,
      tty: true,
      write: (line) => {
        text += line;
      },
    }),
  });
  expect(text).toBe(
    await Bun.file(
      new URL("./fixtures/text-output/status-list-color.txt", import.meta.url)
    ).text()
  );
});
