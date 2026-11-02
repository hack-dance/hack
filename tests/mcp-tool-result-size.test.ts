import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_OUTPUT_LIMIT_BYTES } from "../src/mcp/output-budget.ts";
import {
  boundMcpToolResult,
  MCP_TOOL_RESULT_CUT_NOTE,
  MCP_TOOL_RESULT_LIMIT_BYTES,
  MCP_TOOL_RESULT_TEXT_LIMIT_BYTES,
} from "../src/mcp/result-budget.ts";

/** `STDIO_DEFAULT_MAX_BUFFER_SIZE` in MCP SDK 1.32. Older SDKs have no limit, so
 * these tests also measure the bytes on the wire. */
const SDK_CLIENT_READ_LIMIT_BYTES = 10 * 1024 * 1024;
/** Everything JSON-RPC adds around `result`: `{"jsonrpc":"2.0","id":N,"result":}`. */
const ENVELOPE_ALLOWANCE_BYTES = 64;
const REPLACEMENT_CHAR = "�";
const CALL_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

/** Emoji cost four bytes as UTF-8; the rest expand when JSON escapes them again. */
const LOG_BODY = `${"😀".repeat(1024)}${'"\\\n\u0001'.repeat(256)}`;
const BULK_LINES = 1500;

/**
 * Stands in for `hack`. The scenario picks the output, and each one is sized so
 * the unbounded message passes the client's 10 MiB limit.
 */
const STUB_SOURCE = `
const body = ${JSON.stringify(LOG_BODY)};
const write = (text) => Bun.write(Bun.stdout, text);
const logEvent = (n) => JSON.stringify({ type: "log", n, entry: { raw: "BULK " + n + " " + body } }) + "\\n";
switch (process.env.HACK_TEST_RESULT_SCENARIO) {
  case "logs-over-capture":
    for (let n = 1; n <= ${BULK_LINES}; n += 1) await write(logEvent(n));
    break;
  case "logs-expanding": {
    // Canonical JSON cannot grow when reparsed, except for spellings like 1e20,
    // which is what forces events, not just their duplicates, over the limit.
    const numbers = Array.from({ length: 4096 }, () => "1e20").join(",");
    for (let n = 1; n <= 200; n += 1) {
      await write('{"type":"log","n":' + n + ',"values":[' + numbers + "]}\\n");
    }
    break;
  }
  case "plain-over-capture":
    await write("😀\\u0001".repeat(2 * 1024 * 1024));
    break;
  case "plain-escaped":
    await write("\\u0001".repeat(5 * 1024 * 1024));
    break;
  case "json-structured-fits":
    await write(JSON.stringify({ items: "😀".repeat(1024 * 1024) }));
    break;
  case "small":
    await write(JSON.stringify({ items: ["one"] }));
    break;
  default:
    process.exit(2);
}
`;

type Payload = {
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated?: boolean;
  readonly data?: {
    readonly events?: readonly {
      readonly n?: number;
      readonly entry?: { readonly raw?: string };
    }[];
    readonly count?: number;
    readonly cutoff?: { bound: string; limit: number } | null;
    readonly stop_reason?: string;
    readonly items?: unknown;
  };
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/**
 * Drive the real server over stdio with a real SDK client on default limits. A
 * `tee` records the exact bytes the client reads, which keeps the size assertion
 * meaningful on an SDK version without a read limit.
 */
async function startSession(scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "hack-mcp-result-size-"));
  const project = join(root, "repo");
  const projectDir = join(project, ".hack");
  const registryDir = join(root, "registry");
  await mkdir(projectDir, { recursive: true });
  await mkdir(registryDir);
  await writeFile(join(projectDir, "docker-compose.yml"), "services: {}\n");
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "demo" })
  );
  await writeFile(
    join(registryDir, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "demo",
          createdAt: "2026-01-01T00:00:00Z",
          name: "demo",
          repoRoot: project,
          projectDirName: ".hack",
          projectDir,
        },
      ],
    })
  );
  const stub = join(root, "hack-stub");
  await writeFile(stub, `#!${process.execPath}\n${STUB_SOURCE}`);
  await chmod(stub, 0o755);
  const wire = join(root, "wire.jsonl");

  const transport = new StdioClientTransport({
    command: "/bin/sh",
    args: ["-c", '"$TEST_BUN" "$TEST_ENTRY" mcp serve | tee "$TEST_WIRE"'],
    cwd: project,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      HACK_HOME: join(root, "state"),
      HACK_GLOBAL_CONFIG_PATH: join(registryDir, "config.json"),
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_MCP_COMMAND: stub,
      HACK_TEST_RESULT_SCENARIO: scenario,
      TEST_BUN: process.execPath,
      TEST_ENTRY: resolve(import.meta.dir, "..", "index.ts"),
      TEST_WIRE: wire,
    },
    stderr: "ignore",
  });
  let closed = false;
  const client = new Client({ name: "hack-mcp-result-size", version: "1" });
  await client.connect(transport);
  const onclose = transport.onclose;
  transport.onclose = () => {
    closed = true;
    onclose?.();
  };
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  // Listing tools makes the SDK validate each result against its outputSchema.
  await client.listTools();

  const call = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    readonly result: CallToolResult;
    readonly payload: Payload;
    readonly text: Payload;
    readonly wireBytes: number;
  }> => {
    const result = (await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    )) as CallToolResult;
    const block = result.content[0];
    return {
      result,
      payload: result.structuredContent as Payload,
      text: JSON.parse(block?.type === "text" ? block.text : "null") as Payload,
      wireBytes: await largestWireLine(wire),
    };
  };
  /** The session must survive the large result. */
  const expectAlive = async (): Promise<void> => {
    await client.listTools();
    expect(closed).toBe(false);
  };
  return { call, expectAlive };
}

/** Bytes of the largest message sent. Each line must also be whole JSON. */
async function largestWireLine(path: string): Promise<number> {
  const bytes = await readFile(path);
  let largest = 0;
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0x0a, start);
    expect(end).not.toBe(-1);
    largest = Math.max(largest, end - start);
    JSON.parse(bytes.toString("utf8", start, end));
    start = end + 1;
  }
  return largest;
}

function expectWithinLimits(wireBytes: number): void {
  expect(wireBytes).toBeLessThanOrEqual(
    MCP_TOOL_RESULT_LIMIT_BYTES + ENVELOPE_ALLOWANCE_BYTES
  );
  expect(wireBytes).toBeLessThan(SDK_CLIENT_READ_LIMIT_BYTES);
}

function expectNoSplitCodePoint(payload: Payload): void {
  expect(JSON.stringify(payload)).not.toContain(REPLACEMENT_CHAR);
  expect(JSON.stringify(payload)).not.toMatch(/\\ud[89ab]/i);
}

/** A complete, ordered prefix of whole events, starting at the first. */
function expectEventPrefix(payload: Payload): number {
  const events = payload.data?.events ?? [];
  expect(payload.data?.count).toBe(events.length);
  for (const [index, event] of events.entries()) {
    expect(event.n).toBe(index + 1);
  }
  return events.length;
}

function expectWholeBulkEvents(payload: Payload): void {
  for (const event of payload.data?.events ?? []) {
    expect(event.entry?.raw).toBe(`BULK ${event.n} ${LOG_BODY}`);
  }
}

/** The shortened `content` view: valid JSON that admits it was cut. */
function expectTruthfulTextView(opts: {
  readonly text: Payload;
  readonly payload: Payload;
}): void {
  const { text, payload } = opts;
  expect(text.ok).toBe(payload.ok);
  expect(text.exitCode).toBe(payload.exitCode);
  expect(text.outputTruncated).toBe(true);
  expect(text.stderr).toContain(MCP_TOOL_RESULT_CUT_NOTE);
  expectNoSplitCodePoint(text);
}

for (const tool of [
  "hack.project.logs.snapshot",
  "hack.project.logs.tail",
] as const) {
  test(
    `${tool} over the capture limit keeps whole events within the client limit`,
    async () => {
      const session = await startSession("logs-over-capture");
      const { result, payload, text, wireBytes } = await session.call(tool, {
        projectName: "demo",
        tail: 10_000,
        ...(tool === "hack.project.logs.tail"
          ? { maxEvents: 10_000, maxMs: 60_000 }
          : {}),
      });
      expectWithinLimits(wireBytes);
      await session.expectAlive();

      expect(result.isError).toBeUndefined();
      expect(payload.ok).toBe(true);
      expect(payload.outputTruncated).toBe(true);
      // The capture limit cut these events, and it is the limit that is reported.
      expect(payload.data?.cutoff).toEqual({
        bound: "bytes",
        limit: MCP_OUTPUT_LIMIT_BYTES,
      });
      const kept = expectEventPrefix(payload);
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(BULK_LINES);
      expectWholeBulkEvents(payload);
      expectNoSplitCodePoint(payload);
      if (tool === "hack.project.logs.tail") {
        expect(payload.data?.stop_reason).toBe("output_limit");
      }

      expectTruthfulTextView({ text, payload });
      const preview = expectEventPrefix(text);
      expect(preview).toBeGreaterThan(0);
      expect(preview).toBeLessThan(kept);
      expectWholeBulkEvents(text);
      expect(text.data?.cutoff).toEqual({
        bound: "bytes",
        limit: MCP_TOOL_RESULT_TEXT_LIMIT_BYTES,
      });
    },
    TEST_TIMEOUT_MS
  );
}

test(
  "a complete log stream over the message limit reports the result byte limit",
  async () => {
    const session = await startSession("logs-expanding");
    const { result, payload, text, wireBytes } = await session.call(
      "hack.project.logs.tail",
      { projectName: "demo", maxEvents: 10_000, maxMs: 60_000 }
    );
    expectWithinLimits(wireBytes);
    await session.expectAlive();

    expect(result.isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(payload.outputTruncated).toBe(true);
    expect(payload.stderr).toContain(MCP_TOOL_RESULT_CUT_NOTE);
    // Collection reached end of stream; the result is what was cut.
    expect(payload.data?.stop_reason).toBe("eof");
    expect(payload.data?.cutoff).toEqual({
      bound: "bytes",
      limit: MCP_TOOL_RESULT_LIMIT_BYTES,
    });
    const kept = expectEventPrefix(payload);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(200);
    expectTruthfulTextView({ text, payload });
  },
  TEST_TIMEOUT_MS
);

test(
  "a non-log tool over the capture limit stays an error within the client limit",
  async () => {
    const session = await startSession("plain-over-capture");
    const { result, payload, text, wireBytes } = await session.call(
      "hack.projects.list",
      {}
    );
    expectWithinLimits(wireBytes);
    await session.expectAlive();

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.exitCode).toBe(1);
    expect(payload.outputTruncated).toBe(true);
    expect(payload.data).toBeUndefined();
    expect(payload.stdout.length).toBeGreaterThan(0);
    expect(payload.stderr).toContain(MCP_TOOL_RESULT_CUT_NOTE);
    expectNoSplitCodePoint(payload);
    expectTruthfulTextView({ text, payload });
  },
  TEST_TIMEOUT_MS
);

test(
  "a successful non-log command under the capture limit keeps its status when cut",
  async () => {
    const session = await startSession("plain-escaped");
    const { result, payload, text, wireBytes } = await session.call(
      "hack.projects.list",
      {}
    );
    expectWithinLimits(wireBytes);
    await session.expectAlive();

    // 5 MiB of control characters is under the capture limit, but 30 MiB once
    // JSON-escaped. Nothing went wrong with the command.
    expect(result.isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(payload.outputTruncated).toBe(true);
    expect(payload.stdout.length).toBeGreaterThan(1024 * 1024);
    expect(payload.stdout).toBe("\u0001".repeat(payload.stdout.length));
    expect(payload.stderr).toBe(`${MCP_TOOL_RESULT_CUT_NOTE}\n`);
    expectTruthfulTextView({ text, payload });
  },
  TEST_TIMEOUT_MS
);

test(
  "shedding only the text keeps structured content complete and unflagged",
  async () => {
    const session = await startSession("json-structured-fits");
    const { result, payload, text, wireBytes } = await session.call(
      "hack.projects.list",
      {}
    );
    expectWithinLimits(wireBytes);
    await session.expectAlive();

    expect(result.isError).toBeUndefined();
    expect(payload.outputTruncated).toBeUndefined();
    expect(payload.stderr).toBe("");
    expect(payload.data?.items).toBe("😀".repeat(1024 * 1024));
    expect(JSON.parse(payload.stdout)).toEqual(payload.data);
    expectTruthfulTextView({ text, payload });
    expect(text.data).toBeUndefined();
  },
  TEST_TIMEOUT_MS
);

test(
  "a result within the limit is unchanged",
  async () => {
    const session = await startSession("small");
    const { result, payload } = await session.call("hack.projects.list", {});
    await session.expectAlive();
    expect(payload.outputTruncated).toBeUndefined();
    expect(payload.data).toEqual({ items: ["one"] });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ]);
  },
  TEST_TIMEOUT_MS
);

function toolResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

const basePayload = { ok: true, command: "hack", exitCode: 0, stderr: "" };

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

test("a cut never splits a surrogate pair, at any budget", () => {
  const stdout = "😀".repeat(4096);
  for (let limitBytes = 3000; limitBytes < 3040; limitBytes += 1) {
    const bounded = boundMcpToolResult(toolResult({ ...basePayload, stdout }), {
      limitBytes,
      textLimitBytes: 1024,
    });
    const payload = bounded.structuredContent as Payload;
    expect(serializedBytes(bounded)).toBeLessThanOrEqual(limitBytes);
    expect(payload.stdout.length).toBeGreaterThan(0);
    expect(payload.stdout).toBe("😀".repeat(payload.stdout.length / 2));
  }
});

test("a first event too large to fit leaves an empty, flagged event list", () => {
  const bounded = boundMcpToolResult(
    toolResult({
      ...basePayload,
      stdout: "",
      data: {
        events: [{ n: 1, raw: "x".repeat(64 * 1024) }],
        count: 1,
        cutoff: null,
      },
    }),
    { limitBytes: 16 * 1024, textLimitBytes: 4096 }
  );
  const payload = bounded.structuredContent as Payload;
  expect(serializedBytes(bounded)).toBeLessThanOrEqual(16 * 1024);
  expect(payload.ok).toBe(true);
  expect(payload.outputTruncated).toBe(true);
  expect(payload.data?.events).toEqual([]);
  expect(payload.data?.count).toBe(0);
  expect(payload.data?.cutoff).toEqual({ bound: "bytes", limit: 16 * 1024 });
});

test("a backend failure stays a failure with a null cutoff when events are cut", () => {
  const error = { code: "E_UNEXPECTED", reason: "backend_error", message: "x" };
  const bounded = boundMcpToolResult(
    {
      ...toolResult({
        ...basePayload,
        ok: false,
        exitCode: 1,
        stdout: "",
        error,
        data: {
          events: Array.from({ length: 64 }, (_, index) => ({
            n: index + 1,
            raw: "x".repeat(1024),
          })),
          count: 64,
          cutoff: null,
        },
      }),
      isError: true,
    },
    { limitBytes: 16 * 1024, textLimitBytes: 4096 }
  );
  const payload = bounded.structuredContent as Payload & { error: unknown };
  expect(bounded.isError).toBe(true);
  expect(payload.ok).toBe(false);
  expect(payload.error).toEqual(error);
  expect(payload.outputTruncated).toBe(true);
  expect(payload.data?.cutoff).toBeNull();
  expect(expectEventPrefix(payload)).toBeLessThan(64);
});

test("stderr keeps a floor beside oversized stdout and the rest when stdout is small", () => {
  const limits = { limitBytes: 256 * 1024, textLimitBytes: 4096 };
  const crowded = boundMcpToolResult(
    toolResult({
      ...basePayload,
      stdout: "o".repeat(1024 * 1024),
      stderr: "e".repeat(1024 * 1024),
    }),
    limits
  ).structuredContent as Payload;
  expect(crowded.stderr.length).toBeGreaterThanOrEqual(16 * 1024);
  expect(crowded.stdout.length).toBeGreaterThan(200 * 1024);

  const stderrOnly = boundMcpToolResult(
    toolResult({ ...basePayload, stdout: "", stderr: "e".repeat(1024 * 1024) }),
    limits
  ).structuredContent as Payload;
  expect(stderrOnly.stderr.length).toBeGreaterThan(200 * 1024);
});

test("a result without a typed payload is cut to bounded text", () => {
  const bounded = boundMcpToolResult(
    {
      content: [{ type: "text", text: `${"😀".repeat(4096)}\u0001`.repeat(8) }],
      isError: true,
    },
    { limitBytes: 16 * 1024 }
  );
  expect(serializedBytes(bounded)).toBeLessThanOrEqual(16 * 1024);
  expect(bounded.isError).toBe(true);
  expect(JSON.stringify(bounded)).not.toMatch(/\\ud[89ab]/i);
  expect(JSON.stringify(bounded)).toContain(MCP_TOOL_RESULT_CUT_NOTE);
});

test("an unexpected oversized field still cannot pass the limit", () => {
  const bounded = boundMcpToolResult(
    {
      ...toolResult({
        ...basePayload,
        ok: false,
        exitCode: 3,
        stdout: "",
        data: {
          events: [],
          count: 0,
          cutoff: null,
          unexpected: "x".repeat(64 * 1024),
        },
      }),
      isError: true,
    },
    { limitBytes: 16 * 1024, textLimitBytes: 4096 }
  );
  const payload = bounded.structuredContent as Payload;
  expect(serializedBytes(bounded)).toBeLessThanOrEqual(16 * 1024);
  expect(bounded.isError).toBe(true);
  expect(payload.ok).toBe(false);
  expect(payload.exitCode).toBe(3);
  expect(payload.outputTruncated).toBe(true);
});
