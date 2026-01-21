import { expect, test } from "bun:test";
import type { LogJsonEntry } from "../src/ui/log-json.ts";
import {
  buildLogStreamEndEvent,
  buildLogStreamLogEvent,
  buildLogStreamStartEvent,
  writeLogStreamEvent,
} from "../src/ui/log-stream.ts";

const baseContext = {
  backend: "compose" as const,
  project: "my-app",
  branch: "feature-x",
  services: ["api", "www"],
  follow: true,
  since: "15m",
};

function isIso(value: string): boolean {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(value);
}

test("buildLogStreamStartEvent includes context", () => {
  const event = buildLogStreamStartEvent({ context: baseContext });
  expect(event.type).toBe("start");
  expect(event.backend).toBe("compose");
  expect(event.project).toBe("my-app");
  expect(event.branch).toBe("feature-x");
  expect(event.services).toEqual(["api", "www"]);
  expect(event.follow).toBe(true);
  expect(event.since).toBe("15m");
  expect(event.until).toBeUndefined();
  expect(isIso(event.ts)).toBe(true);
});

test("buildLogStreamLogEvent uses entry timestamp", () => {
  const entry: LogJsonEntry = {
    source: "compose",
    message: "hello",
    raw: "api-1 | hello",
    timestamp: "2025-01-01T00:00:01.000Z",
    service: "api",
  };
  const event = buildLogStreamLogEvent({ context: baseContext, entry });
  expect(event.type).toBe("log");
  expect(event.ts).toBe("2025-01-01T00:00:01.000Z");
  expect(event.entry).toEqual(entry);
});

test("writeLogStreamEvent emits NDJSON", () => {
  const event = buildLogStreamEndEvent({ context: baseContext, reason: "eof" });
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    writeLogStreamEvent({ event });
  } finally {
    process.stdout.write = originalWrite;
  }

  expect(output.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(output.trim()) as { type: string; reason?: string };
  expect(parsed.type).toBe("end");
  expect(parsed.reason).toBe("eof");
});
