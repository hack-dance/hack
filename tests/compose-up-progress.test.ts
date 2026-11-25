import { afterEach, beforeEach, expect, test } from "bun:test";
import { createComposeUpProgress } from "../src/commands/compose-up-progress.ts";

/*
 * HACK-2542: a detached phase's transient wait is an unterminated stdout
 * line on a terminal. Hack's own stderr lines during the phase (dependency
 * cache progress, startup notices, beforeCreate warnings) must clear it
 * first and show it again after, or they land on the wait's line and the
 * later erase clears the wrong one.
 */

const erase = "\r\x1b[2K";
// Colour codes (SGR) dropped; the erase sequence is what this pins.
const SGR = /\x1b\[[\d;]*m/g;
let raw = "";
let written = "";
const saved = {
  isTTY: process.stdout.isTTY,
  term: process.env.TERM,
  stdout: process.stdout.write,
  stderr: process.stderr.write,
};

beforeEach(() => {
  raw = "";
  written = "";
  process.stdout.isTTY = true;
  process.env.TERM = "xterm";
  const record = (chunk: string | Uint8Array) => {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk);
    written = raw.replace(SGR, "");
    return true;
  };
  process.stdout.write = record as typeof process.stdout.write;
  process.stderr.write = record as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.isTTY = saved.isTTY;
  if (saved.term === undefined) {
    Reflect.deleteProperty(process.env, "TERM");
  } else {
    process.env.TERM = saved.term;
  }
  process.stdout.write = saved.stdout;
  process.stderr.write = saved.stderr;
});

function progress() {
  return createComposeUpProgress({
    before: undefined,
    after: undefined,
    services: ["api"],
  });
}

test("a notice during a phase clears the wait first and shows it again after", () => {
  const rows = progress();
  rows.phase("images");
  rows.notice("Dependency cache api: installing");
  rows.settle();
  expect(written).toContain(
    `images ...${erase}Dependency cache api: installing\n${erase}images ...`
  );
  expect(written).not.toContain("images ...Dependency");
  expect(written.endsWith(erase)).toBe(true);
});

test("quiet work runs with the wait hidden, and the wait returns after it", async () => {
  const rows = progress();
  rows.phase("images");
  const result = await rows.quiet(async () => {
    process.stderr.write("warning from beforeCreate\n");
    return 7;
  });
  expect(result).toBe(7);
  expect(written).toContain(
    `images ...${erase}warning from beforeCreate\n${erase}images ...`
  );
});

test("a notice after the phases settle writes only the line", () => {
  const rows = progress();
  rows.phase("images");
  rows.phase("start");
  rows.settle();
  const before = written;
  rows.notice("Dependency cache api: ready");
  expect(written.slice(before.length)).toBe("Dependency cache api: ready\n");
});
