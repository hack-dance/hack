import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeClientWarnings,
  openComposeClientCapture,
  sanitizeComposeClientLines,
  tryOpenComposeClientCapture,
  writeComposeClientTail,
  writeComposeClientWarnings,
} from "../src/lib/compose-client-output.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hack-compose-client-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the capture file is unlinked as soon as it opens", async () => {
  const capture = openComposeClientCapture(dir);
  try {
    expect(await readdir(dir)).toEqual([]);
    writeSync(capture.fd, "one\ntwo\n");
    expect(capture.tail()).toEqual(["one", "two"]);
  } finally {
    capture.close();
  }
  // A second close and a read after close are harmless.
  capture.close();
  expect(capture.tail()).toEqual([]);
  expect(capture.warnings()).toEqual([]);
});

test("an unusable temporary directory leaves the client's lines uncaptured", () => {
  expect(tryOpenComposeClientCapture(join(dir, "missing"))).toBeUndefined();
});

test("the tail keeps only the last lines and drops a partial first line", () => {
  const capture = openComposeClientCapture(dir);
  try {
    // One line longer than the 64 KiB window, so the window starts inside it.
    writeSync(capture.fd, `${"x".repeat(70_000)}\n`);
    for (let index = 1; index <= 30; index += 1) {
      writeSync(capture.fd, `line ${index}\n`);
    }
    const tail = capture.tail({ lines: 5 });
    expect(tail).toEqual([
      "line 26",
      "line 27",
      "line 28",
      "line 29",
      "line 30",
    ]);
    // The cut line is dropped rather than quoted in part.
    const all = capture.tail({ lines: 10_000 });
    expect(all[0]).toBe("line 1");
    expect(all).toHaveLength(30);
  } finally {
    capture.close();
  }
});

test("quoted lines lose escapes and control characters and are redacted", () => {
  const previous = process.env.SAMPLE_API_TOKEN;
  process.env.SAMPLE_API_TOKEN = "inherited-secret";
  try {
    const lines = sanitizeComposeClientLines({
      text: "\x1b[1;31mfailed\x1b[0m\r\n\tpulling https://user:pw@registry.invalid/x\r progress 10%\rvalue added-secret inherited-secret\n\n\x07bell\n",
      redactValues: ["added-secret", "abc"],
    });
    expect(lines).toEqual([
      "failed",
      "pulling https://[REDACTED]@registry.invalid/x",
      "progress 10%",
      "value [REDACTED] [REDACTED]",
      "bell",
    ]);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "SAMPLE_API_TOKEN");
    } else {
      process.env.SAMPLE_API_TOKEN = previous;
    }
  }
  const long = sanitizeComposeClientLines({ text: "y".repeat(1000) });
  expect(long[0]).toHaveLength(240);
  expect(long[0]?.endsWith("…")).toBe(true);
});

test("warnings come once each, without their log prefix, up to the limit", () => {
  const text = [
    'WARN[0000] The "A" variable is not set. Defaulting to a blank string.',
    " Container shop-api-1  Created",
    'time="2026-01-01T00:00:00Z" level=warning msg="The \\"A\\" variable is not set. Defaulting to a blank string."',
    "warning: something else",
    "WARN[0001] third",
    "WARN[0001] fourth",
  ].join("\n");
  expect(composeClientWarnings({ text, limit: 5 })).toEqual([
    'The "A" variable is not set. Defaulting to a blank string.',
    "something else",
    "third",
    "fourth",
  ]);
  expect(composeClientWarnings({ text, limit: 2 })).toHaveLength(2);
});

test("the tail and warnings render as plain lines", () => {
  let tail = "";
  writeComposeClientTail(["a", "b"], (text) => {
    tail += text;
  });
  expect(tail).toBe("docker compose output (last 2 lines):\n  a\n  b\n");
  let none = "";
  writeComposeClientTail([], (text) => {
    none += text;
  });
  expect(none).toBe("");
  let warnings = "";
  writeComposeClientWarnings(["unset variable"], (text) => {
    warnings += text;
  });
  expect(warnings).toBe("! compose  unset variable\n");
});
