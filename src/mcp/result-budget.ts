import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const MIB = 1024 * 1024;

/**
 * Most UTF-8 bytes one serialized `tools/call` result may occupy.
 *
 * MCP SDK clients on stdio close the transport when their read buffer passes
 * 10 MiB. The 8 MiB capture budget in `output-budget.ts` cannot prevent that: it
 * bounds raw child output, while the message repeats that output in several
 * fields and JSON escaping can grow each copy sixfold. The 512 KiB left under
 * 10 MiB covers the JSON-RPC envelope and the start of a following message that
 * can share the client's last read.
 */
export const MCP_TOOL_RESULT_LIMIT_BYTES = 9.5 * MIB;

/** Most bytes the `content` text may occupy once a result has been cut. */
export const MCP_TOOL_RESULT_TEXT_LIMIT_BYTES = 256 * 1024;

/** Fixed, value-free line appended to `stderr` in any payload that was cut. */
export const MCP_TOOL_RESULT_CUT_NOTE =
  "MCP tool result exceeded its size limit; use the CLI for full output.";

/** Stderr kept even when the primary output could fill the whole budget. */
const STDERR_FLOOR_BYTES = 16 * 1024;

/** Covers the small growth of `count`, `cutoff` and the note's line break. */
const SKELETON_SLACK_BYTES = 64;

/** Serialized size of a value in the channel being filled. */
type Measure = (value: unknown) => number;

type ToolPayload = Record<string, unknown> & {
  readonly ok: boolean;
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type LogData = Record<string, unknown> & {
  readonly events: readonly unknown[];
};

const structuredBytes: Measure = (value) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Size of a value's JSON once it is itself embedded in a JSON string. */
const embeddedTextBytes: Measure = (value) =>
  Buffer.byteLength(JSON.stringify(JSON.stringify(value)), "utf8") - 2;

/**
 * Bound one `tools/call` result. A result within the limit is returned as is.
 *
 * The dispatcher applies this to every tool, so no builder can bypass it. Over
 * the limit, data goes in this order, cheapest loss first:
 *
 * 1. The `content` text. It repeats `structuredContent` with extra escaping (a
 *    quote costs four bytes there), so it buys the most and loses the least. It
 *    stays parseable JSON of the same shape, a smaller view with its own
 *    `outputTruncated` and cutoff, because some clients read only this channel.
 * 2. For the log tools, `stdout`, which repeats `data.events`, then whole
 *    events from the end. For other tools, `data`, which is omitted as it is
 *    after a capture cut so that a prefix is never presented as complete, then
 *    the end of `stdout`.
 * 3. The end of `stderr`, which only the 16 KiB floor protects from step 2.
 *
 * Cuts never split a code point. `ok` and `exitCode` still describe the command:
 * a command that succeeded stays `ok`, and `outputTruncated` reports the cut.
 */
export function boundMcpToolResult(
  result: CallToolResult,
  limits: {
    readonly limitBytes?: number;
    readonly textLimitBytes?: number;
  } = {}
): CallToolResult {
  const limitBytes = limits.limitBytes ?? MCP_TOOL_RESULT_LIMIT_BYTES;
  const textLimitBytes =
    limits.textLimitBytes ?? MCP_TOOL_RESULT_TEXT_LIMIT_BYTES;
  if (structuredBytes(result) <= limitBytes) {
    return result;
  }
  const payload = toToolPayload(result.structuredContent);
  if (!payload) {
    return boundTextOnlyResult({ result, limitBytes });
  }

  const content: CallToolResult["content"] = [
    {
      type: "text",
      text: JSON.stringify(
        cutPayload({
          payload,
          budget: textLimitBytes,
          reportedLimit: textLimitBytes,
          measure: embeddedTextBytes,
        })
      ),
    },
  ];
  const budget =
    limitBytes - structuredBytes({ ...result, content, structuredContent: {} });
  const structuredContent =
    structuredBytes(payload) <= budget
      ? payload
      : cutPayload({
          payload,
          budget,
          reportedLimit: limitBytes,
          measure: structuredBytes,
        });
  const bounded = { ...result, content, structuredContent };
  return structuredBytes(bounded) <= limitBytes
    ? bounded
    : buildLastResortResult({ result, payload });
}

/**
 * Fit a payload in `budget` serialized bytes. `reportedLimit` is the limit a log
 * caller sees in `data.cutoff` when events were removed. A failed collection
 * keeps its null cutoff, because a failure is never a truncated success.
 */
function cutPayload(opts: {
  readonly payload: ToolPayload;
  readonly budget: number;
  readonly reportedLimit: number;
  readonly measure: Measure;
}): ToolPayload {
  const { payload, measure } = opts;
  const logData = toLogData(payload.data);
  const { data: _dropped, ...rest } = payload;
  const command = prefixWithin({
    text: payload.command,
    maxBytes: Math.floor(opts.budget / 8),
    measure,
  });
  const assemble = (parts: {
    readonly stdout: string;
    readonly stderr: string;
    readonly events: readonly unknown[];
  }): ToolPayload => ({
    ...rest,
    command,
    stdout: parts.stdout,
    stderr: appendCutNote(parts.stderr),
    outputTruncated: true,
    ...(logData
      ? {
          data: {
            ...logData,
            events: parts.events,
            count: parts.events.length,
            cutoff:
              payload.ok && parts.events.length < logData.events.length
                ? { bound: "bytes", limit: opts.reportedLimit }
                : logData.cutoff,
          },
        }
      : {}),
  });

  let left =
    opts.budget -
    measure(assemble({ stdout: "", stderr: "", events: [] })) -
    SKELETON_SLACK_BYTES;
  const cost = (text: string): number => measure(text) - measure("");
  const stderrFloor = Math.max(
    0,
    Math.min(STDERR_FLOOR_BYTES, left, cost(payload.stderr))
  );
  left -= stderrFloor;

  const keepPrefix = (text: string): string => {
    const kept = prefixWithin({ text, maxBytes: left, measure });
    left -= cost(kept);
    return kept;
  };
  let stdout = "";
  let events: readonly unknown[] = [];
  if (logData) {
    const kept = eventPrefixWithin({
      events: logData.events,
      maxBytes: left,
      measure,
    });
    events = kept.events;
    left -= kept.bytes;
  } else {
    stdout = keepPrefix(payload.stdout);
  }
  left += stderrFloor;
  const stderr = keepPrefix(payload.stderr);
  if (logData) {
    stdout = keepPrefix(payload.stdout);
  }
  return assemble({ stdout, stderr, events });
}

function appendCutNote(stderr: string): string {
  const separator = stderr === "" || stderr.endsWith("\n") ? "" : "\n";
  return `${stderr}${separator}${MCP_TOOL_RESULT_CUT_NOTE}\n`;
}

/** The longest run of whole events from the start that fits. */
function eventPrefixWithin(opts: {
  readonly events: readonly unknown[];
  readonly maxBytes: number;
  readonly measure: Measure;
}): { readonly events: readonly unknown[]; readonly bytes: number } {
  let bytes = 0;
  let kept = 0;
  for (const event of opts.events) {
    const size = opts.measure(event) + 1;
    if (bytes + size > opts.maxBytes) {
      break;
    }
    bytes += size;
    kept += 1;
  }
  return { events: opts.events.slice(0, kept), bytes };
}

/**
 * The longest prefix whose serialized size fits, ending on a code point
 * boundary. It measures with the real serializer instead of a copy of JSON's
 * escaping rules, which is fast enough for a path only oversized results reach.
 */
function prefixWithin(opts: {
  readonly text: string;
  readonly maxBytes: number;
  readonly measure: Measure;
}): string {
  const { text, measure } = opts;
  const overhead = measure("");
  const fits = (length: number): boolean =>
    measure(text.slice(0, length)) - overhead <= opts.maxBytes;
  // Every code unit serializes to at least one byte.
  let high = Math.min(text.length, Math.max(0, opts.maxBytes));
  if (high === text.length && fits(high)) {
    return text;
  }
  let low = 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, splitsSurrogatePair(text, low) ? low - 1 : low);
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return (
    before >= 0xd8_00 &&
    before <= 0xdb_ff &&
    after >= 0xdc_00 &&
    after <= 0xdf_ff
  );
}

/** Results without a typed payload, such as a dispatcher error message. */
function boundTextOnlyResult(opts: {
  readonly result: CallToolResult;
  readonly limitBytes: number;
}): CallToolResult {
  const text = opts.result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  const kept = prefixWithin({
    text,
    maxBytes:
      opts.limitBytes -
      structuredBytes({
        content: [{ type: "text", text: `\n${MCP_TOOL_RESULT_CUT_NOTE}` }],
        isError: true,
      }),
    measure: structuredBytes,
  });
  return {
    content: [{ type: "text", text: `${kept}\n${MCP_TOOL_RESULT_CUT_NOTE}` }],
    ...(opts.result.isError ? { isError: true } : {}),
  };
}

/** Keeps the size guarantee if an unexpected field defeats the normal cut. */
function buildLastResortResult(opts: {
  readonly result: CallToolResult;
  readonly payload: ToolPayload;
}): CallToolResult {
  const structuredContent = {
    ok: opts.payload.ok,
    command: "",
    exitCode: opts.payload.exitCode,
    stdout: "",
    stderr: `${MCP_TOOL_RESULT_CUT_NOTE}\n`,
    outputTruncated: true,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(opts.result.isError ? { isError: true } : {}),
  };
}

function toToolPayload(value: unknown): ToolPayload | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  return typeof payload.ok === "boolean" &&
    typeof payload.command === "string" &&
    typeof payload.exitCode === "number" &&
    typeof payload.stdout === "string" &&
    typeof payload.stderr === "string"
    ? (payload as ToolPayload)
    : null;
}

function toLogData(value: unknown): LogData | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return Array.isArray((value as Record<string, unknown>).events)
    ? (value as LogData)
    : null;
}
