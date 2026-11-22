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
    problem: "sign-in\nexpired\nfor\nprofile",
    which: "example-dev",
    needs: "db needs it",
    command: "aws sso login --profile example-dev",
    prompt: "press enter to continue",
  });
  output.hint({ text: "nothing running. try:", command: "hack up" });
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

test("a detail supplied at completion is rendered before the duration", () => {
  const lines: string[] = [];
  const output = createTextOutput({
    tty: false,
    write: (line) => lines.push(line),
  });
  output.stepRows([{ name: "db" }])({
    name: "db",
    status: "error",
    detail: "port in use",
    result: "0.3s",
  });
  expect(lines).toEqual(["× db  port in use  0.3s\n"]);
});

test("text fields stay on one line and commands are validated before writing", () => {
  const lines: string[] = [];
  const output = createTextOutput({
    tty: false,
    write: (line) => lines.push(line),
  });
  output.stepRows([{ name: "one\ntwo", detail: "host\nport" }])({
    name: "one\ntwo",
    detail: "host\nport",
    result: "up\r\n0.3s",
    status: "ok",
  });
  output.table({
    columns: ["service\nname"],
    rows: [["db\nprimary"]],
    count: "1\nservice",
  });
  output.hint({ text: "nothing running.\ntry:", command: "hack up" });
  expect(lines.join("")).toBe(
    "✓ one two  host port  up 0.3s\nSERVICE NAME\ndb primary\n\n1 service\nnothing running. try: hack up\n"
  );

  lines.length = 0;
  expect(() => output.hint({ text: "try:", command: "" })).toThrow(
    "single-line command"
  );
  expect(() =>
    output.blocker({
      thing: "db",
      problem: "down",
      needs: "api needs it",
      command: "hack up\nhack down",
    })
  ).toThrow("single-line command");
  expect(lines).toEqual([]);
});
