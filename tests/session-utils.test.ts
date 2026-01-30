import { expect, test } from "bun:test";

import {
  buildSessionStreamEndEvent,
  buildSessionStreamErrorEvent,
  buildSessionStreamLogEvent,
  buildSessionStreamStartEvent,
  diffNewLines,
  parseTmuxPanesOutput,
  splitLines,
} from "../src/commands/session-utils.ts";

test("diffNewLines returns suffix when output grows", () => {
  const previous = "line 1\nline 2\n";
  const next = "line 1\nline 2\nline 3\n";
  expect(diffNewLines({ previous, next })).toBe("line 3\n");
});

test("diffNewLines falls back to line diff when prefix mismatches", () => {
  const previous = "old 1\nold 2\n";
  const next = "old 1\nnew 2\nnew 3\n";
  expect(diffNewLines({ previous, next })).toBe("new 2\nnew 3\n");
});

test("splitLines trims trailing newline", () => {
  expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  expect(splitLines("solo")).toEqual(["solo"]);
});

test("buildSessionStreamStartEvent includes context", () => {
  const event = buildSessionStreamStartEvent({
    context: {
      session: "demo",
      target: "demo:0.0",
      lines: 200,
      follow: false,
    },
  });
  expect(event.type).toBe("start");
  expect(event.session).toBe("demo");
  expect(event.target).toBe("demo:0.0");
  expect(event.lines).toBe(200);
  expect(event.follow).toBe(false);
});

test("buildSessionStreamLogEvent carries line + timing options", () => {
  const event = buildSessionStreamLogEvent({
    context: {
      session: "demo",
      target: "demo:0.1",
      lines: 50,
      follow: true,
      intervalMs: 250,
      maxMs: 1000,
    },
    line: "hello",
  });
  expect(event.type).toBe("log");
  expect(event.line).toBe("hello");
  expect(event.follow).toBe(true);
  expect(event.intervalMs).toBe(250);
  expect(event.maxMs).toBe(1000);
});

test("buildSessionStreamErrorEvent includes message", () => {
  const event = buildSessionStreamErrorEvent({
    context: {
      session: "demo",
      target: "demo:0.0",
      lines: 200,
      follow: false,
    },
    message: "boom",
  });
  expect(event.type).toBe("error");
  expect(event.message).toBe("boom");
});

test("buildSessionStreamEndEvent includes reason when provided", () => {
  const event = buildSessionStreamEndEvent({
    context: {
      session: "demo",
      target: "demo:0.0",
      lines: 200,
      follow: true,
      intervalMs: 500,
      maxMs: 5000,
    },
    reason: "timeout",
  });
  expect(event.type).toBe("end");
  expect(event.reason).toBe("timeout");
  expect(event.intervalMs).toBe(500);
});

test("parseTmuxPanesOutput parses tab-delimited pane fields", () => {
  const output = [
    "demo:1.0\t1\t1\teditor\t0\tnvim\t/Users/demo/project",
    "demo:1.1\t0\t1\teditor\t1\tbash\t/Users/demo/project",
  ].join("\n");

  const panes = parseTmuxPanesOutput(output);
  expect(panes).toHaveLength(2);
  const firstPane = panes.at(0);
  const secondPane = panes.at(1);
  expect(firstPane).toBeDefined();
  expect(secondPane).toBeDefined();
  if (!firstPane || !secondPane) {
    throw new Error("Missing pane data");
  }
  expect(firstPane).toEqual({
    target: "demo:1.0",
    active: true,
    windowIndex: 1,
    windowName: "editor",
    paneIndex: 0,
    command: "nvim",
    path: "/Users/demo/project",
  });
  expect(secondPane.active).toBe(false);
});
