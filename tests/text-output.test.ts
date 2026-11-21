import { expect, test } from "bun:test";

import { createTextOutput, formatDuration } from "../src/ui/text-output.ts";

function render(color: boolean, tty: boolean): string {
  let text = "";
  const output = createTextOutput({
    color,
    tty,
    write: (line) => {
      text += line;
    },
  });
  const services = { name: "services", detail: "db よ" };
  const after = { name: "after", detail: "migrate" };
  const step = output.stepRows([services, after]);
  expect(text).toBe("");
  step({ ...services, status: "ok", result: `up · ${formatDuration(2130)}` });
  step({ ...after, status: "error", result: "failed" });
  output.table({
    columns: ["service", "address", "state"],
    rows: [
      ["web", { text: "https://app.hack.local", role: "identity" }, "healthy"],
      ["jobs", { text: "no address", role: "faint" }, null],
    ],
    count: "2 services · 1 up",
  });
  output.blocker({
    thing: "cloud",
    problem: "sign-in expired",
    which: "example-dev",
    needs: "db needs it",
    command: "aws sso login --profile example-dev",
    prompt: "press enter to continue",
  });
  output.hint("nothing running. try: hack up");
  return text;
}

test.each([
  { color: false, tty: false, golden: "plain" },
  { color: true, tty: false, golden: "plain" },
  { color: true, tty: true, golden: "color" },
  { color: false, tty: true, golden: "tty" },
])("text output matches the $golden golden", async ({ color, tty, golden }) => {
  expect(render(color, tty)).toBe(
    await Bun.file(
      new URL(`./fixtures/text-output/${golden}.txt`, import.meta.url)
    ).text()
  );
});
