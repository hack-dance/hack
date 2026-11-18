import { expect, test } from "bun:test";

import {
  countJsonValues,
  groupWritableAncestors,
  parseCheckArgs,
  pathWithoutHack,
  renderStepTable,
} from "../scripts/linux-first-run-check.ts";

test("counts one document, line-delimited values, and refuses garbage", () => {
  expect(countJsonValues('{\n  "ok": true\n}\n')).toBe(1);
  expect(
    countJsonValues('{"type":"start"}\n{"type":"log"}\n{"type":"end"}\n')
  ).toBe(3);
  expect(countJsonValues("")).toBe(0);
  expect(countJsonValues('{"ok":true}\nSTEP: noise\n')).toBeNull();
});

test("requires absolute --hack and --scratch and a bounded one-shot", () => {
  expect(parseCheckArgs(["--hack", "/x/hack", "--scratch", "/tmp/s"])).toEqual({
    hack: "/x/hack",
    scratch: "/tmp/s",
    oneShotSeconds: 150,
    reuseGlobalStack: false,
    keep: false,
  });
  expect(() =>
    parseCheckArgs(["--hack", "hack", "--scratch", "/tmp/s"])
  ).toThrow("absolute");
  expect(() =>
    parseCheckArgs([
      "--hack",
      "/x",
      "--scratch",
      "/s",
      "--one-shot-seconds",
      "0",
    ])
  ).toThrow("1..1800");
  expect(() => parseCheckArgs(["--sudo"])).toThrow("Unknown argument");
});

test("renders one Markdown row per step with pipes escaped", () => {
  const table = renderStepTable([
    {
      step: "3 ps --json",
      command: "hack ps --json",
      exit: 0,
      seconds: 0.42,
      result: "pass",
      note: "a | b",
    },
    {
      step: "0 preflight",
      command: "docker info",
      exit: null,
      seconds: 0,
      result: "fail",
      note: "refused",
    },
  ]);
  expect(table.split("\n")).toEqual([
    "| Step | Command | Exit | Seconds | Result | Note |",
    "| --- | --- | --- | --- | --- | --- |",
    "| 3 ps --json | `hack ps --json` | 0 | 0.4 | pass | a \\| b |",
    "| 0 preflight | `docker info` | - | 0.0 | fail | refused |",
  ]);
});

test("drops PATH entries that hold a hack so the CLI under test is the one re-invoked", () => {
  expect(
    pathWithoutHack(
      "/opt/hack/bin:/usr/bin::/home/u/.hack/bin",
      (file) =>
        file.endsWith("/opt/hack/bin/hack") || file.endsWith("/.hack/bin/hack")
    )
  ).toEqual({
    path: "/usr/bin:",
    dropped: ["/opt/hack/bin", "/home/u/.hack/bin"],
  });
});

test("reports scratch ancestors other users can write, ignoring sticky ones", async () => {
  const { mkdtemp, mkdir, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "hack-frc-"));
  try {
    const shared = join(root, "shared");
    await mkdir(join(shared, "scratch"), { recursive: true });
    await chmod(root, 0o700);
    await chmod(shared, 0o775);
    const found = groupWritableAncestors(join(shared, "scratch", "new"));
    expect(found).toContain(shared);
    // /tmp is sticky and world-writable: not reported.
    expect(found).not.toContain(tmpdir());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
