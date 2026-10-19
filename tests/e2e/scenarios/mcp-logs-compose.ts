import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMonorepoFixture } from "../fixture.ts";
import {
  buildCliEnv,
  type CliResult,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";

const OWNER = "hack.e2e.mcp-logs-compose-owner";
const PROJECT = "com.docker.compose.project";
const SERVICE = "com.docker.compose.service";
const ONEOFF = "com.docker.compose.oneoff";
const TIMEOUT = 180_000;
const IMAGE = "alpine:3.20";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
/** The MCP server's shared stdout+stderr capture budget (8 MiB). */
const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
/** The closed post-spawn failure the logs tools report (src/mcp/logs-contract.ts). */
const BACKEND_ERROR = {
  code: "E_UNEXPECTED",
  reason: "backend_error",
  message: "Log backend failed. Run 'hack logs' for details.",
} as const;
const REPLACEMENT_CHAR = String.fromCodePoint(0xff_fd);
const TICK = /TICK boot=(\d+) seq=(\d+) →/;
const BOOT = /BOOT (\d+) →/;
/** Bulk lines are 2048 four-byte emoji (8 KiB); 1500 of them exceed 8 MiB. */
const BULK_LINES = 1500;
const BULK_LINE = /BULK (\d+) ((?:😀)+)$/u;
const BULK_EMOJI_PER_LINE = 2048;
const RUNTIME_ENV = {
  HACK_EXECUTION_MODE: "slim",
  HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
} as const;

// Every service exits promptly on SIGTERM so restart and down stay fast. `$$`
// is Compose's escape for a literal `$` in the shell command.
const TICKER = [
  "trap 'exit 0' TERM",
  // The writable layer survives a container restart, so this counts boots.
  "b=$$(( $$(cat /tmp/boot 2>/dev/null || echo 0) + 1 ))",
  "echo $$b > /tmp/boot",
  'echo "BOOT $$b →"',
  "i=0",
  'while :; do i=$$((i + 1)); echo "TICK boot=$$b seq=$$i →"; sleep 0.2; done',
].join("; ");
const QUIET = [
  "trap 'exit 0' TERM",
  "echo 'QUIET ready ✓'",
  "while :; do sleep 1; done",
].join("; ");
const BULK = [
  "trap 'exit 0' TERM",
  "s=😀",
  "i=0",
  "while [ $$i -lt 11 ]; do s=$$s$$s; i=$$((i + 1)); done",
  "n=0",
  `while [ $$n -lt ${BULK_LINES} ]; do n=$$((n + 1)); echo "BULK $$n $$s"; done`,
  "echo BULK-DONE",
  "while :; do sleep 1; done",
].join("; ");

type ToolPayload = {
  readonly isError: boolean;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: unknown;
  /** The serialized result text, for whole-payload UTF-8 checks. */
  readonly text: string;
};

type Tick = { readonly boot: number; readonly seq: number };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function object(value: unknown): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) {
    throw new Error("Expected an object from Docker inspect");
  }
  return parsed;
}

/** Narrow one `tools/call` result to the documented logs/run payload. */
function parsePayload(opts: {
  readonly tool: string;
  readonly result: unknown;
}): ToolPayload {
  const result = record(opts.result);
  const structured = record(result?.structuredContent);
  if (
    !(
      result &&
      structured &&
      typeof structured.ok === "boolean" &&
      typeof structured.exitCode === "number" &&
      typeof structured.stdout === "string" &&
      typeof structured.stderr === "string"
    )
  ) {
    throw new Error(`${opts.tool} returned no structured result payload`);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .map((part) => {
      const entry = record(part);
      return entry && typeof entry.text === "string" ? entry.text : "";
    })
    .join("\n");
  return {
    isError: result.isError === true,
    ok: structured.ok,
    exitCode: structured.exitCode,
    stdout: structured.stdout,
    stderr: structured.stderr,
    outputTruncated: structured.outputTruncated === true,
    data: record(structured.data),
    error: structured.error,
    text,
  };
}

function events(payload: ToolPayload): Record<string, unknown>[] {
  const list = payload.data?.events;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((event) => {
    const parsed = record(event);
    return parsed ? [parsed] : [];
  });
}

/** The raw Compose line of every `type: "log"` event, in stream order. */
function logLines(payload: ToolPayload): string[] {
  return events(payload).flatMap((event) => {
    if (event.type !== "log") {
      return [];
    }
    const entry = record(event.entry);
    return entry && typeof entry.raw === "string" ? [entry.raw] : [];
  });
}

function ticksOf(lines: readonly string[]): Tick[] {
  return lines.flatMap((line) => {
    const match = TICK.exec(line);
    return match ? [{ boot: Number(match[1]), seq: Number(match[2]) }] : [];
  });
}

/** Strictly increasing (boot, seq): no line repeats or arrives out of order. */
function strictlyOrdered(ticks: readonly Tick[]): boolean {
  return ticks.every((tick, index) => {
    const previous = ticks[index - 1];
    return (
      !previous ||
      tick.boot > previous.boot ||
      (tick.boot === previous.boot && tick.seq > previous.seq)
    );
  });
}

/** The leading boot-1 ticks up to the first repeat, reorder or new boot. */
function firstBootRun(ticks: readonly Tick[]): Tick[] {
  const run: Tick[] = [];
  for (const tick of ticks) {
    const previous = run.at(-1);
    if (tick.boot !== 1 || (previous && tick.seq <= previous.seq)) {
      break;
    }
    run.push(tick);
  }
  return run;
}

function cutoffOf(payload: ToolPayload): unknown {
  return payload.data?.cutoff;
}

function sameCutoff(
  actual: unknown,
  expected: { readonly bound: string; readonly limit: number }
): boolean {
  const cutoff = record(actual);
  return (
    cutoff !== null &&
    cutoff.bound === expected.bound &&
    cutoff.limit === expected.limit &&
    Object.keys(cutoff).length === 2
  );
}

function isClosedBackendError(error: unknown): boolean {
  const parsed = record(error);
  return (
    parsed !== null &&
    Object.keys(parsed).length === 3 &&
    parsed.code === BACKEND_ERROR.code &&
    parsed.reason === BACKEND_ERROR.reason &&
    parsed.message === BACKEND_ERROR.message
  );
}

function summarize(payload: ToolPayload): string {
  return JSON.stringify({
    isError: payload.isError,
    ok: payload.ok,
    exitCode: payload.exitCode,
    outputTruncated: payload.outputTruncated,
    cutoff: cutoffOf(payload) ?? null,
    stop_reason: payload.data?.stop_reason ?? null,
    duration_ms: payload.data?.duration_ms ?? null,
    events: events(payload).length,
    logs: logLines(payload).length,
    error: payload.error ?? null,
    stderr: payload.stderr.slice(-400),
  });
}

/** Quote a path for a POSIX shell script. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function composeDocument(opts: {
  readonly name: string;
  readonly image: string;
}): string {
  const labels = { [OWNER]: opts.name };
  const service = (command: string) => ({
    image: opts.image,
    pull_policy: "never",
    labels,
    stop_grace_period: "2s",
    command: ["sh", "-c", command],
  });
  return JSON.stringify({
    name: opts.name,
    services: {
      ticker: service(TICKER),
      quiet: service(QUIET),
      bulk: service(BULK),
    },
    networks: { default: { internal: true, labels } },
  });
}

type Cutoff = { readonly bound: string; readonly limit: number };

type Session = {
  readonly call: (
    tool: string,
    input: Readonly<Record<string, unknown>>
  ) => Promise<ToolPayload>;
  readonly close: () => Promise<void>;
};

type ResourceKind = "container" | "network" | "volume";

/** Owned effects and observations for one scenario run. */
type Stack = {
  readonly tempRoot: string;
  readonly log: (message: string) => void;
  readonly docker: (args: readonly string[]) => Promise<string>;
  readonly cli: (opts: {
    readonly args: readonly string[];
    readonly codes: readonly number[];
  }) => Promise<CliResult>;
  readonly list: (
    kind: ResourceKind,
    filters: readonly string[]
  ) => Promise<string[]>;
  readonly owned: (kind: ResourceKind, id: string) => Promise<void>;
  readonly serviceContainer: (service: string) => Promise<string>;
  readonly openSession: (opts: {
    readonly label: string;
    readonly env?: Readonly<Record<string, string>>;
  }) => Promise<Session>;
};

/** Require a successful result and exactly the expected cutoff (or none). */
function requireOk(opts: {
  readonly step: string;
  readonly payload: ToolPayload;
  readonly cutoff: Cutoff | null;
}): void {
  const { payload } = opts;
  expect({
    that: payload.ok && !payload.isError && payload.error === undefined,
    message: `${opts.step} must succeed without isError or error: ${summarize(payload)}`,
  });
  expect({
    that:
      opts.cutoff === null
        ? cutoffOf(payload) === null && payload.exitCode === 0
        : sameCutoff(cutoffOf(payload), opts.cutoff),
    message: `${opts.step} must report cutoff ${JSON.stringify(opts.cutoff)}: ${summarize(payload)}`,
  });
}

/** The one typed outcome of a tail bounded by `maxMs`, or `untyped`. */
function tailOutcome(opts: {
  readonly payload: ToolPayload;
  readonly maxMs: number;
}): "time-cutoff" | "complete" | "backend_error" | "untyped" {
  const { payload } = opts;
  if (!payload.ok) {
    return isClosedBackendError(payload.error) && cutoffOf(payload) === null
      ? "backend_error"
      : "untyped";
  }
  if (sameCutoff(cutoffOf(payload), { bound: "time", limit: opts.maxMs })) {
    return "time-cutoff";
  }
  return cutoffOf(payload) === null &&
    payload.data?.stop_reason === "eof" &&
    payload.exitCode === 0
    ? "complete"
    : "untyped";
}

async function waitFor(opts: {
  readonly step: string;
  readonly probe: () => Promise<boolean>;
}): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await opts.probe()) {
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for ${opts.step}`);
}

/** Wait until the bulk writer finished and the ticker has several lines. */
async function waitForOutput(session: Session): Promise<void> {
  await waitFor({
    step: "bulk output and ticks",
    probe: async () => {
      const bulk = await session.call("hack.project.logs.snapshot", {
        service: "bulk",
        tail: 1,
      });
      const ticker = await session.call("hack.project.logs.snapshot", {
        service: "ticker",
        tail: 5,
      });
      return (
        logLines(bulk).some((line) => line.endsWith("BULK-DONE")) &&
        ticksOf(logLines(ticker)).length >= 5
      );
    },
  });
}

/** Complete, quiet-wait, live time cutoff and event cutoff outcomes. */
async function checkBoundedOutcomes(session: Session): Promise<void> {
  // Complete: a quiet service reaches end of stream with exit 0.
  const quietSnapshot = await session.call("hack.project.logs.snapshot", {
    service: "quiet",
  });
  requireOk({ step: "quiet snapshot", payload: quietSnapshot, cutoff: null });
  expect({
    that:
      logLines(quietSnapshot).filter((line) => line.endsWith("QUIET ready ✓"))
        .length === 1 &&
      events(quietSnapshot).some(
        (event) => event.type === "end" && event.reason === "eof"
      ),
    message: `quiet snapshot must hold its one line and a clean end event: ${summarize(quietSnapshot)}`,
  });

  // Time cutoff on a quiet stream: the wait ends at maxMs, not in a hang.
  const quietTail = await session.call("hack.project.logs.tail", {
    service: "quiet",
    tail: 1,
    maxMs: 2000,
  });
  requireOk({
    step: "quiet tail",
    payload: quietTail,
    cutoff: { bound: "time", limit: 2000 },
  });
  expect({
    that:
      quietTail.data?.stop_reason === "timeout" &&
      logLines(quietTail).length === 1,
    message: `quiet tail must stop on time with only the replayed line: ${summarize(quietTail)}`,
  });

  // Time cutoff on a live stream: new lines arrive in order until maxMs.
  const timeTail = await session.call("hack.project.logs.tail", {
    service: "ticker",
    tail: 1,
    maxEvents: 10_000,
    maxMs: 3000,
  });
  requireOk({
    step: "ticker time tail",
    payload: timeTail,
    cutoff: { bound: "time", limit: 3000 },
  });
  const timeTicks = ticksOf(logLines(timeTail));
  const duration = Number(timeTail.data?.duration_ms);
  expect({
    that:
      timeTail.data?.stop_reason === "timeout" &&
      timeTicks.length >= 5 &&
      strictlyOrdered(timeTicks) &&
      duration >= 3000 &&
      duration < 30_000,
    message: `ticker tail must follow live lines in order until maxMs: ${summarize(timeTail)}`,
  });

  // Event cutoff: exactly maxEvents log events; other events do not count.
  // Three replayed ticks (the boot line is older) plus two live ones.
  const eventTail = await session.call("hack.project.logs.tail", {
    service: "ticker",
    tail: 3,
    maxEvents: 5,
    maxMs: 30_000,
  });
  requireOk({
    step: "ticker event tail",
    payload: eventTail,
    cutoff: { bound: "events", limit: 5 },
  });
  const eventTicks = ticksOf(logLines(eventTail));
  expect({
    that:
      eventTail.data?.stop_reason === "max_events" &&
      logLines(eventTail).length === 5 &&
      eventTicks.length === 5 &&
      strictlyOrdered(eventTicks) &&
      Number(eventTail.data?.duration_ms) < 30_000,
    message: `ticker tail must stop at exactly 5 log events, all ticks (${eventTicks.length} ticks): ${summarize(eventTail)}`,
  });
}

/**
 * Byte cutoff: more than 8 MiB of four-byte emoji. The partial result keeps
 * its parsed events, in order and whole, and the cut never splits a code
 * point (the per-call check rejects any U+FFFD in the payload).
 */
async function checkByteCutoff(opts: {
  readonly session: Session;
  readonly log: (message: string) => void;
}): Promise<void> {
  const bytes = await opts.session.call("hack.project.logs.snapshot", {
    service: "bulk",
    tail: 10_000,
  });
  requireOk({
    step: "bulk snapshot",
    payload: bytes,
    cutoff: { bound: "bytes", limit: OUTPUT_LIMIT_BYTES },
  });
  const bulkLines = logLines(bytes);
  const bulkBodies = bulkLines.flatMap((line) => {
    const match = BULK_LINE.exec(line);
    return match ? [{ n: Number(match[1]), body: match[2] ?? "" }] : [];
  });
  expect({
    that:
      bytes.outputTruncated &&
      bulkBodies.length > 0 &&
      bulkBodies.length < BULK_LINES &&
      !bulkLines.some((line) => line.endsWith("BULK-DONE")) &&
      bulkBodies.every(
        (entry, index) =>
          entry.n === index + 1 &&
          [...entry.body].length === BULK_EMOJI_PER_LINE
      ),
    message: `bulk snapshot must keep a complete, ordered prefix of whole lines: ${summarize(bytes)}`,
  });
  expect({
    that: !bytes.stdout.includes(REPLACEMENT_CHAR),
    message: "bulk snapshot stdout must not split a code point",
  });
  opts.log(
    `bulk byte cut: ${bulkBodies.length} whole lines, ${Buffer.byteLength(bytes.stdout)} stdout bytes kept (limit ${OUTPUT_LIMIT_BYTES})`
  );
}

/**
 * Backend failure: with the engine unreachable, both tools return the closed
 * backend_error, never a truncated success or a time cutoff.
 */
async function checkBackendError(stack: Stack): Promise<void> {
  const broken = await stack.openSession({
    label: "unreachable-engine",
    env: { DOCKER_HOST: `unix://${join(stack.tempRoot, "absent.sock")}` },
  });
  const snapshot = await broken.call("hack.project.logs.snapshot", {
    service: "ticker",
  });
  const tail = await broken.call("hack.project.logs.tail", {
    service: "ticker",
    maxEvents: 5,
    maxMs: 30_000,
  });
  for (const failed of [snapshot, tail]) {
    expect({
      that:
        !failed.ok &&
        failed.isError &&
        failed.exitCode !== 0 &&
        isClosedBackendError(failed.error) &&
        cutoffOf(failed) === null &&
        logLines(failed).every((line) => !TICK.test(line)) &&
        !JSON.stringify(failed.error).includes(stack.tempRoot),
      message: `logs must return the closed backend_error when the engine is unreachable: ${summarize(failed)}`,
    });
  }
  expect({
    that:
      tail.data?.stop_reason === "eof" &&
      Number(tail.data?.duration_ms) < 30_000,
    message: `a failed tail must end at end of stream, not at maxMs: ${summarize(tail)}`,
  });
  await broken.close();
}

/**
 * Restart the backend container under an in-flight tail, then require both
 * boots exactly once in the stored history and a new tail on the new boot.
 * Returns the last tick sequence number the session saw.
 */
async function checkRestart(opts: {
  readonly stack: Stack;
  readonly session: Session;
}): Promise<number> {
  const { stack, session } = opts;
  const tickerId = await stack.serviceContainer("ticker");
  const startedAt = async () =>
    await stack.docker([
      "inspect",
      tickerId,
      "--format",
      "{{.State.StartedAt}}",
    ]);
  const startedBefore = await startedAt();
  const maxMs = 10_000;
  const inFlight = session.call("hack.project.logs.tail", {
    service: "ticker",
    tail: 1,
    maxEvents: 10_000,
    maxMs,
  });
  await Bun.sleep(2500);
  await stack.owned("container", tickerId);
  await stack.docker(["restart", "--time", "2", tickerId]);
  const spanning = await inFlight;
  const spanningTicks = ticksOf(logLines(spanning));
  const outcome = tailOutcome({ payload: spanning, maxMs });
  // Compose may re-attach to the restarted container from a coarse
  // timestamp, so lines repeated across the restart are recorded, not
  // asserted; the pre-restart run itself must be ordered.
  stack.log(
    `tail across restart: ${outcome}; boots seen ${[...new Set(spanningTicks.map((tick) => tick.boot))].join(",")}; ordered across restart: ${strictlyOrdered(spanningTicks)}`
  );
  expect({
    that:
      outcome !== "untyped" &&
      spanning.isError === !spanning.ok &&
      Number(spanning.data?.duration_ms) < 40_000 &&
      firstBootRun(spanningTicks).length >= 2,
    message: `a tail across a restart must end in one typed outcome after ordered pre-restart lines: ${summarize(spanning)}`,
  });
  expect({
    that:
      (await stack.serviceContainer("ticker")) === tickerId &&
      (await startedAt()) !== startedBefore,
    message:
      "docker restart must restart the same ticker container (positive control)",
  });

  // The stored history holds both boots exactly once, in order.
  const histories: ToolPayload[] = [];
  await waitFor({
    step: "post-restart ticks",
    probe: async () => {
      const history = await session.call("hack.project.logs.snapshot", {
        service: "ticker",
        tail: 10_000,
      });
      histories.push(history);
      return (
        ticksOf(logLines(history)).filter((tick) => tick.boot === 2).length >= 3
      );
    },
  });
  const history = histories.at(-1);
  if (!history) {
    throw new Error("No post-restart snapshot");
  }
  requireOk({ step: "post-restart snapshot", payload: history, cutoff: null });
  const historyLines = logLines(history);
  const boots = historyLines.flatMap((line) => {
    const match = BOOT.exec(line);
    return match ? [Number(match[1])] : [];
  });
  const historyTicks = ticksOf(historyLines);
  expect({
    that:
      JSON.stringify(boots) === "[1,2]" &&
      strictlyOrdered(historyTicks) &&
      historyTicks.some((tick) => tick.boot === 1) &&
      historyTicks.some((tick) => tick.boot === 2),
    message: `snapshot after restart must hold BOOT 1 then BOOT 2 and ordered ticks: ${summarize(history)}`,
  });

  // A new tail starts from the current stream: its one replayed line and
  // every later line belong to the new boot.
  const fresh = await session.call("hack.project.logs.tail", {
    service: "ticker",
    tail: 1,
    maxEvents: 3,
    maxMs: 30_000,
  });
  requireOk({
    step: "post-restart tail",
    payload: fresh,
    cutoff: { bound: "events", limit: 3 },
  });
  const freshTicks = ticksOf(logLines(fresh));
  expect({
    that:
      freshTicks.length === 3 &&
      freshTicks.every((tick) => tick.boot === 2) &&
      strictlyOrdered(freshTicks),
    message: `a tail after restart must stream only the new boot: ${summarize(fresh)}`,
  });
  return freshTicks.at(-1)?.seq ?? 0;
}

/** A new MCP session starts a new stream and never replays older lines. */
async function checkReconnect(opts: {
  readonly session: Session;
  readonly lastSeen: number;
}): Promise<void> {
  const after = await opts.session.call("hack.project.logs.tail", {
    service: "ticker",
    tail: 1,
    maxEvents: 2,
    maxMs: 30_000,
  });
  requireOk({
    step: "reconnected tail",
    payload: after,
    cutoff: { bound: "events", limit: 2 },
  });
  const afterTicks = ticksOf(logLines(after));
  expect({
    that:
      afterTicks.length === 2 &&
      afterTicks.every(
        (tick) => tick.boot === 2 && tick.seq >= opts.lastSeen
      ) &&
      strictlyOrdered(afterTicks),
    message: `a reconnected tail must not replay earlier lines (last seen seq ${opts.lastSeen}): ${summarize(after)}`,
  });
}

/**
 * HACK-1155 (P11): the child's exit status survives the CLI and the MCP
 * envelope. `false` fails with 1; `exit 7` keeps 7 and its output.
 */
async function checkRunExitStatus(opts: {
  readonly stack: Stack;
  readonly session: Session;
}): Promise<void> {
  const { stack, session } = opts;
  await stack.cli({ args: ["run", "quiet", "--", "false"], codes: [1] });
  const seven = await stack.cli({
    args: ["run", "quiet", "--", "sh", "-c", "printf p11-partial; exit 7"],
    codes: [7],
  });
  expect({
    that: seven.stdout.includes("p11-partial"),
    message: "hack run must pass the failed child's output through",
    result: seven,
  });
  const envelope = await session.call("hack.project.run", {
    service: "quiet",
    cmd: ["sh", "-c", "printf p11-partial; exit 7"],
  });
  expect({
    that:
      !envelope.ok &&
      envelope.isError &&
      envelope.exitCode === 7 &&
      envelope.stdout.includes("p11-partial"),
    message: `hack.project.run must report the child's exit 7 as a failure: ${summarize(envelope)}`,
  });
  const passed = await session.call("hack.project.run", {
    service: "quiet",
    cmd: ["true"],
  });
  expect({
    that: passed.ok && !passed.isError && passed.exitCode === 0,
    message: `hack.project.run must report a successful child as ok (positive control): ${summarize(passed)}`,
  });
  expect({
    that: (await stack.list("container", [`${ONEOFF}=True`])).length === 0,
    message: "hack run must not leave a one-off container behind",
  });
}

/** Require a Linux engine with Compose and the cached image; return its ID. */
async function requireCachedImage(docker: Stack["docker"]): Promise<string> {
  expect({
    that: (await docker(["info", "--format", "{{.OSType}}"])) === "linux",
    message: "A Linux Docker daemon is required",
  });
  await docker(["compose", "version"]);
  const image = await docker([
    "image",
    "inspect",
    IMAGE,
    "--format",
    "{{.Id}}",
  ]);
  expect({
    that: IMAGE_ID.test(image),
    message: `${IMAGE} must already be cached with an immutable ID`,
  });
  return image;
}

/** Write the fixture and build the owned-effect helpers for one run. */
async function prepareStack(opts: {
  readonly ctx: ScenarioContext;
  readonly sessions: Session[];
}): Promise<{ readonly stack: Stack; readonly clean: () => Promise<void> }> {
  const { ctx } = opts;
  const docker = async (args: readonly string[]) => {
    const result = await runCommand({
      argv: ["docker", ...args],
      cwd: ctx.tempRoot,
      timeoutMs: TIMEOUT,
    });
    expectExit({
      result,
      codes: [0],
      message: `Docker ${args[0]} must succeed`,
    });
    return result.stdout.trim();
  };
  const image = await requireCachedImage(docker);
  const fixture = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: true,
    lifecycle: { disableInternal: true },
  });
  const name = fixture.name;
  await Bun.write(
    join(fixture.hackDir, "hack.config.json"),
    JSON.stringify({
      name,
      internal: { dns: false, tls: false },
      logs: {
        follow_backend: "compose",
        snapshot_backend: "compose",
        clear_on_down: false,
      },
    })
  );
  await Bun.write(
    join(fixture.hackDir, "docker-compose.yml"),
    composeDocument({ name, image })
  );

  // The MCP server runs `HACK_MCP_COMMAND` for every tool, so point it at the
  // CLI under test (the compiled binary in CI, else the source CLI).
  const mcpCommand = join(ctx.tempRoot, "hack-under-test");
  await Bun.write(
    mcpCommand,
    `#!/bin/sh\nexec ${resolveCliSpawnArgs([]).map(shellQuote).join(" ")} "$@"\n`
  );
  await chmod(mcpCommand, 0o755);

  const list = async (kind: ResourceKind, filters: readonly string[]) => {
    const args =
      kind === "container" ? ["ps", "-aq", "--no-trunc"] : [kind, "ls", "-q"];
    return (
      await docker([
        ...args,
        "--filter",
        `label=${OWNER}=${name}`,
        ...filters.flatMap((filter) => ["--filter", `label=${filter}`]),
      ])
    )
      .split(/\s+/)
      .filter(Boolean);
  };
  const owned = async (kind: ResourceKind, id: string) => {
    const expression =
      kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}";
    const actual = object(
      JSON.parse(await docker([kind, "inspect", id, "--format", expression]))
    );
    expect({
      that: actual[OWNER] === name && actual[PROJECT] === name,
      message: `Refuse ${kind} mutation outside exact fixture ownership`,
    });
  };
  const clean = async () => {
    for (const kind of ["container", "network", "volume"] as const) {
      for (const id of await list(kind, [])) {
        await owned(kind, id);
        await docker([
          kind,
          "rm",
          ...(kind === "container" ? ["--force"] : []),
          id,
        ]);
      }
      expect({
        that: (await list(kind, [])).length === 0,
        message: `Owned ${kind} cleanup must leave no resources`,
      });
    }
  };
  const stack: Stack = {
    tempRoot: ctx.tempRoot,
    log: ctx.log,
    docker,
    list,
    owned,
    cli: async ({ args, codes }) => {
      const result = await ctx.cli({
        args,
        cwd: fixture.root,
        timeoutMs: TIMEOUT,
        env: RUNTIME_ENV,
      });
      expectExit({ result, codes, message: `hack ${args.join(" ")}` });
      return result;
    },
    serviceContainer: async (service) => {
      const ids = await list("container", [
        `${SERVICE}=${service}`,
        `${ONEOFF}=False`,
      ]);
      const id = ids[0];
      if (ids.length !== 1 || !(id && CONTAINER_ID.test(id))) {
        throw new Error(`Expected exactly one owned ${service} container`);
      }
      await owned("container", id);
      return id;
    },
    openSession: async (session) => {
      const opened = await openMcpSession({
        ctx,
        label: session.label,
        cwd: fixture.root,
        env: { ...RUNTIME_ENV, HACK_MCP_COMMAND: mcpCommand, ...session.env },
      });
      opts.sessions.push(opened);
      return opened;
    },
  };
  return { stack, clean };
}

/**
 * Start `hack mcp serve` over stdio with the harness's isolated CLI
 * environment. Every call targets the fixture by path and rejects a payload
 * that contains U+FFFD, so no tool result may split a code point.
 */
async function openMcpSession(opts: {
  readonly ctx: ScenarioContext;
  readonly label: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<Session> {
  const [command, ...args] = resolveCliSpawnArgs(["mcp", "serve"]);
  if (!command) {
    throw new Error("No CLI command to serve MCP");
  }
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: opts.cwd,
    env: buildCliEnv({ hackHome: opts.ctx.hackHome, extra: opts.env }),
    stderr: "pipe",
  });
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-2000);
  });
  const client = new Client({ name: "hack-e2e-mcp-logs", version: "0.0.0" });
  await client.connect(transport);
  return {
    close: async () => {
      await client.close();
    },
    call: async (tool, input) => {
      let raw: unknown;
      try {
        raw = await client.callTool(
          { name: tool, arguments: { ...input } },
          undefined,
          { timeout: TIMEOUT }
        );
      } catch (error) {
        throw new Error(
          `${opts.label} ${tool} failed: ${String(error)}\nserver stderr: ${stderrTail}`
        );
      }
      const payload = parsePayload({ tool, result: raw });
      opts.ctx.log(
        `${opts.label} ${tool} ${JSON.stringify(input)}: ${summarize(payload)}`
      );
      expect({
        that: !payload.text.includes(REPLACEMENT_CHAR),
        message: `${tool} must return valid UTF-8 (no U+FFFD in the payload)`,
      });
      return payload;
    },
  };
}

/**
 * F13 / HACK-1134: the MCP `hack.project.logs.snapshot` and
 * `hack.project.logs.tail` contract against a real Compose project, driven
 * through `hack mcp serve` over stdio with the current CLI as the log backend.
 *
 * Each collection must end in exactly one typed outcome:
 * - complete: a quiet snapshot reaches end of stream (`cutoff: null`);
 * - time cutoff: a tail of a ticking service and of a quiet one stops at
 *   `maxMs` with `data.cutoff = {bound: "time"}`;
 * - event cutoff: exactly `maxEvents` `type: "log"` events, `{bound: "events"}`;
 * - byte cutoff: a snapshot of more than 8 MiB of four-byte emoji stops at the
 *   capture budget with `{bound: "bytes"}`, keeps the parsed events and never
 *   splits a code point (no U+FFFD anywhere in the returned payload);
 * - backend_error: with the Docker engine unreachable, both tools return the
 *   closed `backend_error`, never a truncated success or a time cutoff.
 *
 * Across a container restart, an in-flight tail must still end in one typed
 * outcome inside its bound, the backend keeps both boots' lines exactly once
 * and in order, and a new tail starts from the current stream. A new MCP
 * session never replays events older than the previous session saw.
 *
 * HACK-1155 (P11) on the same stack: `hack run <svc> -- false` and an `exit 7`
 * child return the child's status from the CLI and from the MCP
 * `hack.project.run` envelope (`ok: false`, `exitCode: 7`).
 */
export const mcpLogsComposeScenario: Scenario = {
  name: "mcp-logs-compose",
  tier: "docker",
  summary:
    "MCP logs cutoffs, backend_error, restart and UTF-8 cut on real Compose (F13)",
  run: async (ctx) => {
    const sessions: Session[] = [];
    const { stack, clean } = await prepareStack({ ctx, sessions });
    try {
      await stack.cli({ args: ["up", "--detach"], codes: [0] });
      const session = await stack.openSession({ label: "A" });
      await waitForOutput(session);
      await checkBoundedOutcomes(session);
      await checkByteCutoff({ session, log: ctx.log });
      await checkBackendError(stack);
      const lastSeen = await checkRestart({ stack, session });
      await session.close();
      const reconnected = await stack.openSession({ label: "B" });
      await checkReconnect({ session: reconnected, lastSeen });
      await checkRunExitStatus({ stack, session: reconnected });
      await reconnected.close();

      await stack.cli({ args: ["down"], codes: [0] });
      expect({
        that: (await stack.list("container", [])).length === 0,
        message: "hack down must remove all fixture containers",
      });
    } finally {
      for (const session of sessions) {
        try {
          await session.close();
        } catch {
          // Already closed.
        }
      }
      await clean();
    }
  },
};
