import { expect, test } from "bun:test";
import {
  assertNativeLogFlags,
  nativeLogFollowOptions,
  nativeLogLineDecoder,
  nativeLogWireLines,
} from "../src/backends/native-log-follow.ts";

const container = "a".repeat(64);
function envelope(
  data: Uint8Array | string,
  stream = "stdout",
  id = container
) {
  return JSON.stringify({
    version: 1,
    kind: "native-log-chunk",
    service: "web",
    container: id,
    stream,
    data: Buffer.from(data).toString("base64"),
  });
}

test("decodes UTF-8 across envelopes with independent stdout and stderr line state", async () => {
  const lines: string[] = [];
  const decoder = nativeLogLineDecoder({
    service: "web",
    container,
    onLine: async (stream, text) => {
      lines.push(`${stream}:${text}`);
    },
  });
  const bytes = Buffer.from("hello 🌍\nlast");
  await decoder.accept(envelope(bytes.subarray(0, 8)));
  await decoder.accept(envelope("error\n", "stderr"));
  await decoder.accept(envelope(bytes.subarray(8)));
  await decoder.finish();
  expect(lines).toEqual([
    "stderr:error",
    "stdout:hello 🌍",
    "stdout:last [partial]",
  ]);
});

test("refuses changed container, invalid framing and oversized payloads by name", async () => {
  const decoder = nativeLogLineDecoder({
    service: "web",
    container,
    onLine: async () => {},
  });
  for (const line of [
    "not json",
    envelope("x", "stdout", "b".repeat(64)),
    envelope("x", "unknown"),
    envelope("x").replace("eA==", "eB=="),
  ]) {
    await expect(decoder.accept(line)).rejects.toThrow(
      "native_log_wire_invalid"
    );
  }
  await expect(decoder.accept(envelope("x".repeat(4097)))).rejects.toThrow(
    "native_log_wire_limit"
  );
});

test("oversized lines retain one bounded prefix, mark truncation and continue", async () => {
  const lines: { text: string; truncated: boolean; partial: boolean }[] = [];
  const decoder = nativeLogLineDecoder({
    service: "web",
    onLine: async (_stream, text, completeness) => {
      lines.push({ text, ...completeness });
    },
  });
  for (let i = 0; i < 64; i++) {
    await decoder.accept(envelope("x".repeat(4096)));
  }
  expect(lines).toEqual([]);
  await decoder.accept(envelope("\nafter\npartial"));
  await decoder.finish();
  expect(lines).toEqual([
    {
      text: `${"x".repeat(64 * 1024)} [truncated]`,
      truncated: true,
      partial: false,
    },
    { text: "after", truncated: false, partial: false },
    { text: "partial [partial]", truncated: false, partial: true },
  ]);
});

test("exact-bound lines stay complete and oversized trailing fragments mark both flags", async () => {
  const lines: { text: string; truncated: boolean; partial: boolean }[] = [];
  const decoder = nativeLogLineDecoder({
    service: "web",
    onLine: async (_stream, text, completeness) => {
      lines.push({ text, ...completeness });
    },
  });
  for (let i = 0; i < 16; i++) {
    await decoder.accept(envelope("x".repeat(4096)));
  }
  await decoder.accept(envelope("\n"));
  for (let i = 0; i < 16; i++) {
    await decoder.accept(envelope("y".repeat(4096)));
  }
  await decoder.accept(envelope("more"));
  await decoder.finish();
  expect(lines[0]).toEqual({
    text: "x".repeat(65_536),
    truncated: false,
    partial: false,
  });
  expect(lines[1]).toEqual({
    text: `${"y".repeat(65_536)} [truncated] [partial]`,
    truncated: true,
    partial: true,
  });
});

test("consumer backpressure stops line delivery until the current write finishes", async () => {
  const gate = Promise.withResolvers<void>();
  const lines: string[] = [];
  const decoder = nativeLogLineDecoder({
    service: "web",
    onLine: async (_stream, line) => {
      lines.push(line);
      await gate.promise;
    },
  });
  const accepted = decoder.accept(envelope("one\ntwo\n"));
  await Promise.resolve();
  expect(lines).toEqual(["one"]);
  gate.resolve();
  await accepted;
  expect(lines).toEqual(["one", "two"]);
});

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(Buffer.from(chunk));
      }
      controller.close();
    },
  });
}
async function lines(chunks: string[]) {
  const result: string[] = [];
  for await (const line of nativeLogWireLines(
    stream(chunks),
    new AbortController().signal
  )) {
    result.push(line);
  }
  return result;
}
test("wire lines survive fragmentation and reject truncation or unbounded lines", async () => {
  expect(await lines(["a", "bc\nd", "ef\n"])).toEqual(["abc", "def"]);
  await expect(lines(["unfinished"])).rejects.toThrow(
    "native_log_wire_truncated"
  );
  await expect(lines(["x".repeat(8193)])).rejects.toThrow(
    "native_log_wire_limit"
  );
  await expect(lines([`${"x".repeat(8193)}\n`])).rejects.toThrow(
    "native_log_wire_limit"
  );
});

test("abort cancels an idle read", async () => {
  let canceled = false;
  const controller = new AbortController();
  const idle = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  const iter = nativeLogWireLines(idle, controller.signal);
  const read = iter.next();
  controller.abort();
  expect((await read).done).toBe(true);
  expect(canceled).toBe(true);
});

test("unsupported flags and bounds are refused explicitly", () => {
  for (const key of ["profile", "services", "query", "until"]) {
    expect(() => assertNativeLogFlags({ [key]: "value" })).toThrow(`--${key}`);
  }
  for (const key of ["compose", "loki", "pretty"]) {
    expect(() => assertNativeLogFlags({ [key]: true })).toThrow(`--${key}`);
  }
  expect(() => assertNativeLogFlags({ follow: true, noFollow: true })).toThrow(
    "--no-follow"
  );
  expect(() => nativeLogFollowOptions({})).toThrow("service");
  expect(() => nativeLogFollowOptions({ service: "web", tail: 1001 })).toThrow(
    "--tail"
  );
  expect(nativeLogFollowOptions({ service: "web", tail: 0 })).toEqual({
    service: "web",
    tail: 0,
  });
  expect(() => nativeLogFollowOptions({ service: "web", tail: -1 })).toThrow(
    "--tail"
  );
  expect(() =>
    nativeLogFollowOptions({ service: "web", since: "invalid" })
  ).toThrow("--since");
  expect(
    nativeLogFollowOptions({
      service: "web",
      tail: 20,
      since: "2026-01-01T00:00:00Z",
    })
  ).toEqual({ service: "web", tail: 20, since: 1_767_225_600 });
});

test("Engine timestamp metadata does not consume the payload line limit", async () => {
  const lines: { text: string; timestamp?: string; truncated: boolean }[] = [];
  const decoder = nativeLogLineDecoder({
    service: "web",
    onLine: async (_stream, text, flags) => {
      lines.push({ text, ...flags });
    },
  });
  const chunk = (text: string) =>
    JSON.stringify({
      version: 2,
      kind: "native-log-chunk",
      service: "web",
      container,
      stream: "stdout",
      timestamp: "2026-01-01T00:00:00.123456789Z",
      data: Buffer.from(text).toString("base64"),
    });
  for (let i = 0; i < 16; i++) {
    await decoder.accept(chunk("x".repeat(4096)));
  }
  await decoder.accept(chunk("\n"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    text: "x".repeat(65_536),
    timestamp: "2026-01-01T00:00:00.123456789Z",
    truncated: false,
  });
});
