import { afterEach, expect, test } from "bun:test";
import { errorResult, okResult } from "../src/lib/cli-result.ts";
import {
  armLifecycleProgress,
  beginLifecycleProgress,
  closeLifecycleProgress,
  finalServiceEvents,
  LIFECYCLE_PROGRESS_SCHEMA,
  LifecycleProgressStream,
  prepareLifecycleProgress,
  reportLifecycleProgress,
  resetLifecycleProgress,
} from "../src/lib/lifecycle-progress.ts";

const FIXED = new Date("2026-01-02T03:04:05.000Z");
const TS = FIXED.toISOString();

function capture(): {
  readonly lines: string[];
  readonly write: (line: string) => void;
} {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

afterEach(() => {
  resetLifecycleProgress();
});

test("a stream writes start, progress and a compact envelope, one line each", () => {
  const out = capture();
  const stream = new LifecycleProgressStream({
    action: "up",
    write: out.write,
    now: () => FIXED,
  });
  stream.begin({ project: "shop" });
  stream.progress({ service: null, phase: "images" });
  stream.progress({ service: "api", phase: "installing" });
  const services = {
    started: ["api"],
    completed: ["migrate"],
    stopped: [],
    failed: [],
  };
  expect(stream.close({ result: okResult({ data: { services } }) })).toBe(true);
  // Each write is exactly one newline-terminated line.
  expect(out.lines.every((line) => line.split("\n").length === 2)).toBe(true);
  expect(out.lines.every((line) => line.endsWith("\n"))).toBe(true);
  const parsed = out.lines.map((line) => JSON.parse(line));
  expect(parsed).toEqual([
    {
      schema: LIFECYCLE_PROGRESS_SCHEMA,
      type: "start",
      ts: TS,
      action: "up",
      project: "shop",
    },
    { type: "progress", ts: TS, service: null, phase: "images" },
    { type: "progress", ts: TS, service: "api", phase: "installing" },
    { type: "progress", ts: TS, service: "api", phase: "running" },
    { type: "progress", ts: TS, service: "migrate", phase: "completed" },
    { ok: true, data: { services } },
  ]);
  expect(parsed.slice(1).some((line) => "schema" in line)).toBe(false);
  expect(out.lines.at(-1)?.startsWith('{"ok":true,')).toBe(true);
});

test("nothing is written before begin or after close", () => {
  const out = capture();
  const stream = new LifecycleProgressStream({
    action: "down",
    write: out.write,
  });
  const failure = errorResult({ code: "E_USAGE", message: "x" });
  stream.progress({ service: null, phase: "stopping" });
  expect(stream.close({ result: failure })).toBe(false);
  expect(out.lines).toEqual([]);
  stream.begin({});
  stream.begin({ project: "again" });
  expect(stream.close({ result: failure })).toBe(true);
  stream.progress({ service: null, phase: "stopped" });
  expect(stream.close({ result: failure })).toBe(false);
  const parsed = out.lines.map((line) => JSON.parse(line));
  expect(parsed).toEqual([
    expect.objectContaining({ type: "start", action: "down" }),
    { ok: false, error: { code: "E_USAGE", message: "x" } },
  ]);
  expect(parsed[0]).not.toHaveProperty("project");
});

test("final service events come from the envelope only", () => {
  expect(
    finalServiceEvents(
      errorResult({
        code: "E_STARTUP_INCOMPLETE",
        message: "m",
        detail: { running: ["api"], completed: [], failed: ["worker"] },
      })
    )
  ).toEqual([
    { service: "api", phase: "running" },
    { service: "worker", phase: "failed" },
  ]);
  expect(
    finalServiceEvents(
      errorResult({
        code: "E_COMPOSE_FAILED",
        message: "m",
        detail: { exitCode: 3 },
      })
    )
  ).toEqual([]);
  expect(
    finalServiceEvents(
      okResult({ data: { services: { stopped: ["api", 4] } } })
    )
  ).toEqual([{ service: "api", phase: "stopped" }]);
});

test("the process-wide stream is a no-op until armed and begun", () => {
  const empty = okResult({ data: {} });
  reportLifecycleProgress({ service: null, phase: "images" });
  expect(closeLifecycleProgress({ result: empty })).toBe(false);
  const out = capture();
  armLifecycleProgress({ action: "restart", write: out.write });
  reportLifecycleProgress({ service: null, phase: "stopping" });
  expect(out.lines).toEqual([]);
  beginLifecycleProgress({ project: "shop" });
  reportLifecycleProgress({ service: null, phase: "stopping" });
  expect(closeLifecycleProgress({ result: empty })).toBe(true);
  expect(out.lines).toHaveLength(3);
});

test("prepare refuses --progress without --json and on the native backend", () => {
  expect(() =>
    prepareLifecycleProgress({
      action: "up",
      progress: true,
      json: false,
      backend: undefined,
    })
  ).toThrow("--progress requires --json.");
  expect(() =>
    prepareLifecycleProgress({
      action: "down",
      progress: true,
      json: true,
      backend: "native",
    })
  ).toThrow("Native lifecycle commands do not support --progress yet.");
  // Without --progress nothing is validated or armed.
  prepareLifecycleProgress({
    action: "up",
    progress: false,
    json: false,
    backend: "native",
  });
  expect(closeLifecycleProgress({ result: okResult({ data: {} }) })).toBe(
    false
  );
});
