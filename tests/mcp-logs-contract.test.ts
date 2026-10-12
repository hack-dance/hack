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
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  classifyLogCollection,
  MCP_LOG_BACKEND_ERROR,
  type McpLogStopReason,
  observeLogStreamEvent,
} from "../src/mcp/logs-contract.ts";
import {
  createMcpOutputBudget,
  incompleteUtf8TailLength,
  MCP_OUTPUT_LIMIT_BYTES,
} from "../src/mcp/output-budget.ts";
import { createMcpServer } from "../src/mcp/server.ts";

// ---------------------------------------------------------------------------
// HACK-1134: logs.tail / logs.snapshot separate a cutoff (success, data.cutoff)
// from a backend failure (closed backend_error), cut output on a UTF-8 code
// point boundary, and never replay events across calls or reconnects.
//
// Every fixture is a temp root with its own HOME, HACK_HOME and registry; the
// hack binary is a stub selected by HACK_MCP_COMMAND, so no Docker/OrbStack
// socket, agent client config or real home directory is touched.
// ---------------------------------------------------------------------------

const LIMITS = { maxEvents: 2, timeMs: 1000, bytes: 64 } as const;

test("only type:log events count toward maxEvents; error and failing end events are failures", () => {
  expect(observeLogStreamEvent({ type: "log", entry: {} })).toEqual({
    isLog: true,
    backendFailure: false,
  });
  for (const type of ["start", "heartbeat", undefined]) {
    expect(observeLogStreamEvent({ type })).toEqual({
      isLog: false,
      backendFailure: false,
    });
  }
  expect(observeLogStreamEvent({ type: "error", message: "x" })).toEqual({
    isLog: false,
    backendFailure: true,
  });
  for (const reason of ["eof", "closed", undefined]) {
    expect(observeLogStreamEvent({ type: "end", reason }).backendFailure).toBe(
      false
    );
  }
  for (const reason of ["error", "exit:1", "exit:125"]) {
    expect(observeLogStreamEvent({ type: "end", reason }).backendFailure).toBe(
      true
    );
  }
});

test("each stop reason maps to exactly one outcome and failure evidence wins", () => {
  const classify = (
    stopReason: McpLogStopReason,
    exitCode: number,
    backendFailureObserved = false
  ) =>
    classifyLogCollection({
      stopReason,
      exitCode,
      backendFailureObserved,
      limits: LIMITS,
    });
  expect(classify("eof", 0)).toEqual({ kind: "complete" });
  expect(classify("eof", 1)).toEqual({ kind: "backend_error" });
  // A server-initiated stop is a cutoff even though the child exits non-zero.
  expect(classify("max_events", 143)).toEqual({
    kind: "cutoff",
    cutoff: { bound: "events", limit: 2 },
  });
  expect(classify("timeout", 137)).toEqual({
    kind: "cutoff",
    cutoff: { bound: "time", limit: 1000 },
  });
  expect(classify("output_limit", 143)).toEqual({
    kind: "cutoff",
    cutoff: { bound: "bytes", limit: 64 },
  });
  expect(classify("cancelled", 143)).toEqual({ kind: "cancelled" });
  expect(classify("interrupted", 143)).toEqual({ kind: "cancelled" });
  for (const stopReason of [
    "eof",
    "max_events",
    "timeout",
    "output_limit",
  ] as const) {
    expect(classify(stopReason, 0, true)).toEqual({ kind: "backend_error" });
  }
  expect(Object.isFrozen(MCP_LOG_BACKEND_ERROR)).toBe(true);
});

test("incomplete UTF-8 tails are measured for 2-, 3- and 4-byte sequences", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  expect(incompleteUtf8TailLength(bytes(""))).toBe(0);
  expect(incompleteUtf8TailLength(bytes("ab"))).toBe(0);
  for (const char of ["é", "€", "😀"]) {
    const encoded = bytes(`a${char}`);
    expect(incompleteUtf8TailLength(encoded)).toBe(0);
    for (let drop = 1; drop < encoded.byteLength - 1; drop += 1) {
      expect(
        incompleteUtf8TailLength(encoded.subarray(0, encoded.byteLength - drop))
      ).toBe(encoded.byteLength - 1 - drop);
    }
  }
  // Malformed input is never held back: stray continuations, bad leads.
  expect(incompleteUtf8TailLength(new Uint8Array([0x80, 0x80, 0x80]))).toBe(0);
  expect(incompleteUtf8TailLength(new Uint8Array([0x61, 0xff]))).toBe(0);
});

function chunkedStream(chunks: readonly Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("code-point-safe capture never ends on a split code point at the byte limit", async () => {
  const text = "a😀😀😀";
  const encoded = new TextEncoder().encode(text);
  for (let maxBytes = 1; maxBytes < encoded.byteLength; maxBytes += 1) {
    const safe = createMcpOutputBudget({
      maxBytes,
      codePointSafe: true,
      onLimit: () => undefined,
    });
    const kept = await readAll(safe.wrap(chunkedStream([encoded])));
    expect(safe.exceeded()).toBe(true);
    expect(kept.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(kept)).toBe(
      text.slice(0, 1 + 2 * Math.floor((maxBytes - 1) / 4))
    );
  }
});

test("negative control: the byte-exact default capture does split a code point", async () => {
  const encoded = new TextEncoder().encode("a😀");
  const exact = createMcpOutputBudget({
    maxBytes: 3,
    onLimit: () => undefined,
  });
  const kept = await readAll(exact.wrap(chunkedStream([encoded])));
  expect(kept.byteLength).toBe(3);
  expect(new TextDecoder().decode(kept)).toContain("�");
});

test("code-point-safe capture joins sequences split across chunks and keeps exact-limit output", async () => {
  const encoded = new TextEncoder().encode("é€😀");
  const chunks = [...encoded].map((byte) => new Uint8Array([byte]));
  let stops = 0;
  const budget = createMcpOutputBudget({
    maxBytes: encoded.byteLength,
    codePointSafe: true,
    onLimit: () => {
      stops += 1;
    },
  });
  const kept = await readAll(budget.wrap(chunkedStream(chunks)));
  expect(new TextDecoder("utf-8", { fatal: true }).decode(kept)).toBe("é€😀");
  expect(budget.exceeded()).toBe(false);
  expect(stops).toBe(0);
});

test("code-point-safe capture shares one budget and drops a held partial sequence once cut", async () => {
  const budget = createMcpOutputBudget({
    maxBytes: 4,
    codePointSafe: true,
    onLimit: () => undefined,
  });
  const euro = new TextEncoder().encode("€");
  // First stream ends after two of the euro's three bytes, consuming 3 bytes.
  const first = await readAll(
    budget.wrap(chunkedStream([new Uint8Array([0x61]), euro.subarray(0, 2)]))
  );
  // Source bytes that are themselves incomplete pass through at stream end.
  expect([...first]).toEqual([0x61, ...euro.subarray(0, 2)]);
  const second = await readAll(budget.wrap(chunkedStream([euro])));
  expect(second.byteLength).toBe(0);
  expect(budget.exceeded()).toBe(true);
});

// ---------------------------------------------------------------------------
// In-process MCP sessions against a scripted log backend.
// ---------------------------------------------------------------------------

type Scenario =
  | "clean"
  | "heartbeats"
  | "follow"
  | "backend-error"
  | "exit-end"
  | "nonzero-exit"
  | "error-after-stop"
  | "bytes-utf8"
  | "sequenced";

type LogsFixture = {
  readonly root: string;
  readonly stubDir: string;
  readonly connect: () => Promise<Client>;
};

const CANARY = "LOGS-CANARY-QUERY-ECHO";
const fixtureRoots: string[] = [];
const fixtureClients: Client[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureClients.splice(0).map(async (mcp) => {
      try {
        await mcp.close();
      } catch {
        /* already closed */
      }
    })
  );
  for (const root of fixtureRoots.splice(0)) {
    for (const pid of await readStubPids(join(root, "stub"))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already stopped */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

const STUB_SOURCE = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const dir = process.env.HACK_TEST_STUB_DIR;
const scenario = process.env.HACK_TEST_LOG_SCENARIO;
const counter = dir + "/invocations";
const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(n));
appendFileSync(dir + "/pids", process.pid + "\n");
const line = (event) =>
  JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", backend: "compose", ...event }) + "\n";
const emit = (event) => process.stdout.write(line(event));
const log = (message) => emit({ type: "log", entry: { message } });
const hang = () => setInterval(() => {}, 1000);
emit({ type: "start", follow: true });
switch (scenario) {
  case "clean":
    log("one");
    log("two");
    emit({ type: "end", reason: "eof" });
    break;
  case "heartbeats":
    emit({ type: "heartbeat" });
    log("one");
    emit({ type: "heartbeat" });
    emit({ type: "heartbeat" });
    log("two");
    log("three");
    hang();
    break;
  case "follow":
    log("one");
    hang();
    break;
  case "backend-error":
    log("one");
    emit({ type: "error", message: "Loki error: " + process.env.HACK_TEST_CANARY });
    emit({ type: "end", reason: "error" });
    process.stderr.write("Loki error: " + process.env.HACK_TEST_CANARY + "\n");
    process.exitCode = 1;
    break;
  case "exit-end":
    log("one");
    emit({ type: "end", reason: "exit:1" });
    break;
  case "nonzero-exit":
    process.stderr.write("compose failed\n");
    process.exitCode = 1;
    break;
  case "error-after-stop": {
    log("one");
    const timer = hang();
    process.on("SIGTERM", () => {
      clearInterval(timer);
      emit({ type: "error", message: "terminated" });
      emit({ type: "end", reason: "error" });
      process.exitCode = 1;
    });
    break;
  }
  case "bytes-utf8": {
    log("one");
    log("two");
    const written = Buffer.byteLength(line({ type: "start", follow: true })) +
      Buffer.byteLength(line({ type: "log", entry: { message: "one" } })) +
      Buffer.byteLength(line({ type: "log", entry: { message: "two" } }));
    // Pad so the 8 MiB cut lands three bytes into a four-byte code point.
    const pad = (5 - (written % 4)) % 4;
    process.stdout.write("a".repeat(pad) + "😀".repeat(2_400_000));
    hang();
    break;
  }
  case "sequenced": {
    let seq = 0;
    setInterval(() => {
      log("inv-" + n + "-seq-" + seq);
      appendFileSync(dir + "/emitted-" + n, seq + "\n");
      seq += 1;
    }, 10);
    break;
  }
  default:
    process.exitCode = 2;
}
`;

async function startLogsFixture(scenario: Scenario): Promise<LogsFixture> {
  const root = await mkdtemp(join(tmpdir(), "hack-mcp-logs-"));
  fixtureRoots.push(root);
  const project = join(root, "repo");
  const projectDir = join(project, ".hack");
  const registryDir = join(root, "registry");
  const stubDir = join(root, "stub");
  await mkdir(projectDir, { recursive: true });
  await mkdir(registryDir);
  await mkdir(stubDir);
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
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: root,
    HACK_HOME: join(root, "state"),
    HACK_GLOBAL_CONFIG_PATH: join(registryDir, "config.json"),
    HACK_MCP_COMMAND: stub,
    HACK_TEST_STUB_DIR: stubDir,
    HACK_TEST_LOG_SCENARIO: scenario,
    HACK_TEST_CANARY: CANARY,
  };
  // Each connect is a fresh session, as a client reconnecting to Hack gets.
  const connect = async (): Promise<Client> => {
    const server = createMcpServer({ cwd: project, env });
    const client = new Client({ name: "hack-mcp-logs", version: "1" });
    fixtureClients.push(client);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  };
  return { root, stubDir, connect };
}

type LogsPayload = {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated?: boolean;
  readonly error?: { code: string; reason: string; message: string };
  readonly data: {
    readonly events: readonly Record<string, unknown>[];
    readonly count: number;
    readonly cutoff: { bound: string; limit: number } | null;
    readonly stop_reason?: string;
  };
};

async function callLogs(opts: {
  readonly client: Client;
  readonly tool: "hack.project.logs.tail" | "hack.project.logs.snapshot";
  readonly args?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}): Promise<{ isError: boolean; payload: LogsPayload; text: string }> {
  const result = await opts.client.callTool(
    {
      name: opts.tool,
      arguments: { projectName: "demo", ...opts.args },
    },
    undefined,
    opts.signal ? { signal: opts.signal } : undefined
  );
  const content = result.content as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    payload: result.structuredContent as LogsPayload,
    text: content.map((item) => item.text ?? "").join(""),
  };
}

function logMessages(events: readonly Record<string, unknown>[]): string[] {
  return events
    .filter((event) => event.type === "log")
    .map((event) => {
      const entry = event.entry as { message?: unknown } | undefined;
      return String(entry?.message);
    });
}

async function readStubPids(stubDir: string): Promise<number[]> {
  const text = await readFile(join(stubDir, "pids"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((value) => value.length > 0)
    .map(Number);
}

async function readEmitted(stubDir: string, invocation: number) {
  const text = await readFile(
    join(stubDir, `emitted-${invocation}`),
    "utf8"
  ).catch(() => "");
  return text.split("\n").filter((value) => value.length > 0).length;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() >= end) {
      throw new Error("Timed out waiting for logs fixture");
    }
    await Bun.sleep(20);
  }
}

test("a clean end of stream is complete: ok with a null cutoff for tail and snapshot", async () => {
  const fixture = await startLogsFixture("clean");
  const client = await fixture.connect();
  for (const tool of [
    "hack.project.logs.tail",
    "hack.project.logs.snapshot",
  ] as const) {
    const { isError, payload } = await callLogs({ client, tool });
    expect(isError).toBe(false);
    expect(payload.ok).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(payload.error).toBeUndefined();
    expect(payload.data.cutoff).toBeNull();
    expect(logMessages(payload.data.events)).toEqual(["one", "two"]);
    expect(payload.data.count).toBe(payload.data.events.length);
  }
});

test("maxEvents counts log events only and its cutoff is a success", async () => {
  const fixture = await startLogsFixture("heartbeats");
  const client = await fixture.connect();
  const { isError, payload } = await callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxEvents: 2, maxMs: 10_000 },
  });
  expect(isError).toBe(false);
  expect(payload.ok).toBe(true);
  expect(payload.data.cutoff).toEqual({ bound: "events", limit: 2 });
  expect(payload.data.stop_reason).toBe("max_events");
  expect(logMessages(payload.data.events)).toEqual(["one", "two"]);
  // start + 3 heartbeats are returned but did not consume the event budget.
  expect(payload.data.events.map((event) => event.type)).toEqual([
    "start",
    "heartbeat",
    "log",
    "heartbeat",
    "heartbeat",
    "log",
  ]);
  for (const pid of await readStubPids(fixture.stubDir)) {
    await waitFor(() => !alive(pid));
  }
});

test("the collection window cutoff is a success even though the child is signalled", async () => {
  const fixture = await startLogsFixture("follow");
  const client = await fixture.connect();
  const { isError, payload } = await callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxMs: 300 },
  });
  expect(isError).toBe(false);
  expect(payload.ok).toBe(true);
  expect(payload.exitCode).not.toBe(0);
  expect(payload.data.cutoff).toEqual({ bound: "time", limit: 300 });
  expect(logMessages(payload.data.events)).toEqual(["one"]);
});

test("failure events after a server-initiated stop do not turn a cutoff into an error", async () => {
  const fixture = await startLogsFixture("error-after-stop");
  const client = await fixture.connect();
  const { isError, payload } = await callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxMs: 300 },
  });
  // The stub did report error/end(error) in response to SIGTERM ...
  expect(payload.data.events.map((event) => event.type)).toEqual([
    "start",
    "log",
    "error",
    "end",
  ]);
  // ... yet the outcome is the time cutoff the server caused.
  expect(isError).toBe(false);
  expect(payload.ok).toBe(true);
  expect(payload.data.cutoff).toEqual({ bound: "time", limit: 300 });
});

for (const [scenario, label] of [
  ["backend-error", "an error event"],
  ["exit-end", "a failing end event"],
  ["nonzero-exit", "a non-zero exit at end of stream"],
] as const) {
  test(`${label} is a closed backend_error, not a truncated success`, async () => {
    const fixture = await startLogsFixture(scenario);
    const client = await fixture.connect();
    for (const tool of [
      "hack.project.logs.tail",
      "hack.project.logs.snapshot",
    ] as const) {
      const { isError, payload } = await callLogs({ client, tool });
      expect(isError).toBe(true);
      expect(payload.ok).toBe(false);
      expect(payload.error).toEqual({
        code: "E_UNEXPECTED",
        reason: "backend_error",
        message: MCP_LOG_BACKEND_ERROR.message,
      });
      expect(payload.data.cutoff).toBeNull();
      expect(payload.outputTruncated).toBeUndefined();
      // The closed diagnostic never repeats backend text or caller input.
      expect(payload.error?.message).not.toContain(CANARY);
    }
  });
}

test("the byte cutoff returns earlier events and never splits a code point", async () => {
  const fixture = await startLogsFixture("bytes-utf8");
  const client = await fixture.connect();
  const { isError, payload } = await callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxMs: 30_000 },
  });
  expect(isError).toBe(false);
  expect(payload.ok).toBe(true);
  expect(payload.outputTruncated).toBe(true);
  expect(payload.data.cutoff).toEqual({
    bound: "bytes",
    limit: MCP_OUTPUT_LIMIT_BYTES,
  });
  expect(payload.data.stop_reason).toBe("output_limit");
  expect(logMessages(payload.data.events)).toEqual(["one", "two"]);
  expect(payload.stdout).not.toContain("�");
  const lastLine = payload.stdout.trimEnd().split("\n").at(-1) ?? "";
  expect(lastLine.endsWith("😀")).toBe(true);
  // The cut backed off the three bytes of the split emoji, and no more.
  expect(Buffer.byteLength(payload.stdout)).toBe(
    MCP_OUTPUT_LIMIT_BYTES - 3 + 1
  );
  expect(payload.stderr).toContain("8 MiB capture limit");
  for (const pid of await readStubPids(fixture.stubDir)) {
    await waitFor(() => !alive(pid));
  }
}, 30_000);

test("consecutive tail calls each start a new stream: no cursor, no replay", async () => {
  const fixture = await startLogsFixture("sequenced");
  const client = await fixture.connect();
  const first = await callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxEvents: 3, maxMs: 10_000 },
  });
  const second = await callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxEvents: 3, maxMs: 10_000 },
  });
  expect(logMessages(first.payload.data.events)).toEqual([
    "inv-1-seq-0",
    "inv-1-seq-1",
    "inv-1-seq-2",
  ]);
  // The second call neither repeats the first call's events nor resumes
  // after them; it is an independent read of the backend.
  expect(logMessages(second.payload.data.events)).toEqual([
    "inv-2-seq-0",
    "inv-2-seq-1",
    "inv-2-seq-2",
  ]);
});

test("a disconnect mid-tail stops the backend and a reconnected session never sees its events", async () => {
  const fixture = await startLogsFixture("sequenced");
  const disconnected = await fixture.connect();
  const pending = callLogs({
    client: disconnected,
    tool: "hack.project.logs.tail",
    args: { maxEvents: 10_000, maxMs: 30_000 },
  });
  const settled = pending.then(
    () => "resolved" as const,
    () => "rejected" as const
  );
  await waitFor(async () => (await readEmitted(fixture.stubDir, 1)) >= 3);
  const [firstPid] = await readStubPids(fixture.stubDir);
  expect(alive(firstPid ?? 0)).toBe(true);

  await disconnected.close();
  expect(await settled).toBe("rejected");
  await waitFor(() => !alive(firstPid ?? 0));
  const emittedBeforeClose = await readEmitted(fixture.stubDir, 1);
  expect(emittedBeforeClose).toBeGreaterThanOrEqual(3);

  const reconnected = await fixture.connect();
  const { isError, payload } = await callLogs({
    client: reconnected,
    tool: "hack.project.logs.tail",
    args: { maxEvents: 3, maxMs: 10_000 },
  });
  expect(isError).toBe(false);
  expect(payload.data.cutoff).toEqual({ bound: "events", limit: 3 });
  expect(logMessages(payload.data.events)).toEqual([
    "inv-2-seq-0",
    "inv-2-seq-1",
    "inv-2-seq-2",
  ]);
  expect(payload.stdout).not.toContain("inv-1-");
  // The interrupted stream produced nothing after its session closed.
  expect(await readEmitted(fixture.stubDir, 1)).toBe(emittedBeforeClose);
}, 30_000);

test("a cancelled tail stops its backend and the same session's retry starts fresh", async () => {
  const fixture = await startLogsFixture("sequenced");
  const client = await fixture.connect();
  const controller = new AbortController();
  const pending = callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxEvents: 10_000, maxMs: 30_000 },
    signal: controller.signal,
  });
  const settled = pending.then(
    () => "resolved" as const,
    () => "rejected" as const
  );
  await waitFor(async () => (await readEmitted(fixture.stubDir, 1)) >= 3);
  const [firstPid] = await readStubPids(fixture.stubDir);
  controller.abort();
  expect(await settled).toBe("rejected");
  await waitFor(() => !alive(firstPid ?? 0));

  const retry = await callLogs({
    client,
    tool: "hack.project.logs.tail",
    args: { maxEvents: 2, maxMs: 10_000 },
  });
  expect(retry.payload.ok).toBe(true);
  expect(logMessages(retry.payload.data.events)).toEqual([
    "inv-2-seq-0",
    "inv-2-seq-1",
  ]);
}, 30_000);
