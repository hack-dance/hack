import { isRecord } from "../lib/guards.ts";
import { formatPrettyLogLine } from "./log-format.ts";
import { parseLokiLogLine, writeJsonLogLine } from "./log-json.ts";
import type { LogStreamContext } from "./log-stream.ts";
import {
  buildLogStreamEndEvent,
  buildLogStreamErrorEvent,
  buildLogStreamLogEvent,
  buildLogStreamStartEvent,
  writeLogStreamEvent,
} from "./log-stream.ts";

export interface LokiLogsParams {
  readonly baseUrl: string;
  readonly query: string;
  readonly follow: boolean;
  readonly tail: number;
  readonly pretty: boolean;
  readonly json?: boolean;
  readonly showProjectPrefix: boolean;
  readonly start?: Date;
  readonly end?: Date;
  readonly streamContext?: LogStreamContext;
}

type LokiLabelSet = Record<string, string>;

export async function canReachLoki(opts: {
  readonly baseUrl: string;
}): Promise<boolean> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const url = new URL(`${baseUrl}/ready`);
  const ctrl = new AbortController();
  const timeoutMs = parseTimeoutMs(process.env.HACK_LOKI_READY_TIMEOUT_MS, 800);
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function requestLokiDelete(opts: {
  readonly baseUrl: string;
  readonly query: string;
  readonly start: Date;
  readonly end?: Date;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const url = new URL(`${baseUrl}/loki/api/v1/delete`);
  url.searchParams.set("query", opts.query);
  url.searchParams.set("start", toRfc3339(opts.start));
  if (opts.end) {
    url.searchParams.set("end", toRfc3339(opts.end));
  }

  try {
    const res = await fetch(url, { method: "POST" });
    if (res.status === 204) {
      return { ok: true };
    }
    const text = await res.text();
    return {
      ok: false,
      message: `Loki delete failed (${res.status}): ${text.trim() || "unknown error"}`,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      ok: false,
      message: `Failed to connect to Loki at ${baseUrl}: ${message}`,
    };
  }
}

type LokiStream = {
  readonly stream: LokiLabelSet;
  readonly values: readonly (readonly [timestampNs: string, line: string])[];
};

type LokiTailMessage = {
  readonly streams: readonly LokiStream[];
};

type LokiQueryRangeResponse = {
  readonly status: "success" | "error";
  readonly data?: {
    readonly resultType?: string;
    readonly result?: readonly LokiStream[];
  };
  readonly error?: string;
};

export async function lokiLogs(opts: LokiLogsParams): Promise<number> {
  if (opts.follow) {
    return await lokiTail(opts);
  }

  return await lokiQueryRange(opts);
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replaceAll(/\/+$/g, "");
  return trimmed.length > 0 ? trimmed : "http://127.0.0.1:3100";
}

function toRfc3339(date: Date): string {
  // Loki delete API docs accept RFC3339. Prefer no milliseconds for readability.
  return date.toISOString().replaceAll(/\.\d{3}Z$/g, "Z");
}

function toWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return `wss://${httpUrl.slice("https://".length)}`;
  }
  if (httpUrl.startsWith("http://")) {
    return `ws://${httpUrl.slice("http://".length)}`;
  }
  return httpUrl;
}

function linePrefix(opts: {
  readonly labels: LokiLabelSet;
  readonly showProjectPrefix: boolean;
}): string {
  const service = opts.labels.service ?? "service";
  const project = opts.labels.project;
  if (!(opts.showProjectPrefix && project)) {
    return service;
  }
  return `${project}/${service}`;
}

async function lokiQueryRange(opts: LokiLogsParams): Promise<number> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const endDate = opts.end ?? new Date();
  const endNs = BigInt(endDate.getTime()) * 1_000_000n;
  const startDate = opts.start ?? new Date(endDate.getTime() - 15 * 60 * 1000);
  const startNs = BigInt(startDate.getTime()) * 1_000_000n;

  const url = new URL(`${baseUrl}/loki/api/v1/query_range`);
  url.searchParams.set("query", opts.query);
  url.searchParams.set("direction", "BACKWARD");
  url.searchParams.set("limit", String(opts.tail));
  url.searchParams.set("start", startNs.toString());
  url.searchParams.set("end", endNs.toString());

  let res: Response;
  try {
    res = await fetch(url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (opts.json && opts.streamContext) {
      writeLogStreamEvent({
        event: buildLogStreamErrorEvent({
          context: opts.streamContext,
          message,
        }),
      });
      writeLogStreamEvent({
        event: buildLogStreamEndEvent({
          context: opts.streamContext,
          reason: "error",
        }),
      });
    }
    process.stderr.write(
      `Failed to connect to Loki at ${baseUrl}: ${message}\n`
    );
    process.stderr.write(
      "Tip: run `hack global install` (or `hack global up`) and ensure Loki is reachable.\n"
    );
    return 1;
  }
  if (!res.ok) {
    if (opts.json && opts.streamContext) {
      writeLogStreamEvent({
        event: buildLogStreamErrorEvent({
          context: opts.streamContext,
          message: `Loki HTTP ${res.status}`,
        }),
      });
      writeLogStreamEvent({
        event: buildLogStreamEndEvent({
          context: opts.streamContext,
          reason: "error",
        }),
      });
    }
    process.stderr.write(
      `Failed to query Loki (${res.status}): ${await res.text()}\n`
    );
    return 1;
  }

  const json: unknown = await res.json();
  const parsed = parseQueryRangeResponse(json);
  if (!parsed) {
    if (opts.json && opts.streamContext) {
      writeLogStreamEvent({
        event: buildLogStreamErrorEvent({
          context: opts.streamContext,
          message: "Failed to parse Loki query response",
        }),
      });
      writeLogStreamEvent({
        event: buildLogStreamEndEvent({
          context: opts.streamContext,
          reason: "error",
        }),
      });
    }
    process.stderr.write("Failed to parse Loki query response.\n");
    return 1;
  }

  if (parsed.status !== "success") {
    if (opts.json && opts.streamContext) {
      writeLogStreamEvent({
        event: buildLogStreamErrorEvent({
          context: opts.streamContext,
          message: `Loki error: ${parsed.error ?? "unknown error"}`,
        }),
      });
      writeLogStreamEvent({
        event: buildLogStreamEndEvent({
          context: opts.streamContext,
          reason: "error",
        }),
      });
    }
    process.stderr.write(`Loki error: ${parsed.error ?? "unknown error"}\n`);
    return 1;
  }

  const streams = parsed.data?.result ?? [];
  if (opts.json && opts.streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamStartEvent({ context: opts.streamContext }),
    });
  }
  const entries: Array<{
    readonly labels: LokiLabelSet;
    readonly tsNs: string;
    readonly line: string;
  }> = [];
  for (const s of streams) {
    for (const [tsNs, line] of s.values) {
      entries.push({ labels: s.stream, tsNs, line });
    }
  }

  // query_range BACKWARD returns newest→oldest; print oldest→newest for readability
  for (const e of entries.reverse()) {
    if (opts.json) {
      const entry = parseLokiLogLine({
        labels: e.labels,
        tsNs: e.tsNs,
        line: e.line,
      });
      if (opts.streamContext) {
        writeLogStreamEvent({
          event: buildLogStreamLogEvent({ context: opts.streamContext, entry }),
        });
      } else {
        writeJsonLogLine(entry);
      }
      continue;
    }

    writeFormattedLine({
      prefix: linePrefix({
        labels: e.labels,
        showProjectPrefix: opts.showProjectPrefix,
      }),
      tsNs: e.tsNs,
      line: e.line,
      pretty: opts.pretty,
    });
  }

  if (opts.json && opts.streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamEndEvent({ context: opts.streamContext }),
    });
  }

  return 0;
}

async function lokiTail(opts: LokiLogsParams): Promise<number> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const wsBase = toWsUrl(baseUrl);

  const url = new URL(`${wsBase}/loki/api/v1/tail`);
  url.searchParams.set("query", opts.query);
  url.searchParams.set("limit", String(opts.tail));
  if (opts.start) {
    const startNs = BigInt(opts.start.getTime()) * 1_000_000n;
    url.searchParams.set("start", startNs.toString());
  }

  const ws = new WebSocket(url.toString());

  let closed = false;
  let exitCode = 0;

  const stop = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  process.once("SIGINT", () => {
    stop();
  });

  ws.addEventListener("error", () => {
    exitCode = 1;
    if (opts.json && opts.streamContext) {
      writeLogStreamEvent({
        event: buildLogStreamErrorEvent({
          context: opts.streamContext,
          message: "Loki WebSocket error",
        }),
      });
    }
    stop();
  });

  if (opts.json && opts.streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamStartEvent({ context: opts.streamContext }),
    });
  }

  ws.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : null;
    if (!text) {
      return;
    }

    const json = safeJsonParse(text);
    const msg = parseTailMessage(json);
    if (!msg) {
      return;
    }

    for (const s of msg.streams) {
      const prefix = linePrefix({
        labels: s.stream,
        showProjectPrefix: opts.showProjectPrefix,
      });
      for (const [tsNs, line] of s.values) {
        if (opts.json) {
          const entry = parseLokiLogLine({
            labels: s.stream,
            tsNs,
            line,
          });
          if (opts.streamContext) {
            writeLogStreamEvent({
              event: buildLogStreamLogEvent({
                context: opts.streamContext,
                entry,
              }),
            });
          } else {
            writeJsonLogLine(entry);
          }
          continue;
        }
        writeFormattedLine({ prefix, tsNs, line, pretty: opts.pretty });
      }
    }
  });

  await new Promise<void>((resolve) => {
    ws.addEventListener("close", () => {
      closed = true;
      resolve();
    });
  });

  if (opts.json && opts.streamContext) {
    writeLogStreamEvent({
      event: buildLogStreamEndEvent({
        context: opts.streamContext,
        reason: exitCode === 0 ? "closed" : "error",
      }),
    });
  }

  return exitCode;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseTailMessage(value: unknown): LokiTailMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const streams = value.streams;
  if (!Array.isArray(streams)) {
    return null;
  }

  const out: LokiStream[] = [];
  for (const item of streams) {
    const stream = parseStream(item);
    if (stream) {
      out.push(stream);
    }
  }

  return { streams: out };
}

function parseQueryRangeResponse(
  value: unknown
): LokiQueryRangeResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = value.status;
  if (status !== "success" && status !== "error") {
    return null;
  }

  const error = typeof value.error === "string" ? value.error : undefined;

  const data = value.data;
  let dataOut: LokiQueryRangeResponse["data"] | undefined;
  if (isRecord(data)) {
    const result = data.result;
    const streams: LokiStream[] = [];
    if (Array.isArray(result)) {
      for (const item of result) {
        const stream = parseStream(item);
        if (stream) {
          streams.push(stream);
        }
      }
    }

    dataOut = {
      resultType:
        typeof data.resultType === "string" ? data.resultType : undefined,
      result: streams,
    };
  }

  return {
    status,
    ...(error ? { error } : {}),
    ...(dataOut ? { data: dataOut } : {}),
  };
}

function parseStream(value: unknown): LokiStream | null {
  if (!isRecord(value)) {
    return null;
  }
  const streamRaw = value.stream;
  const valuesRaw = value.values;
  if (!(isRecord(streamRaw) && Array.isArray(valuesRaw))) {
    return null;
  }

  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(streamRaw)) {
    if (typeof v === "string") {
      labels[k] = v;
    }
  }

  const values: Array<readonly [string, string]> = [];
  for (const pair of valuesRaw) {
    if (!Array.isArray(pair) || pair.length < 2) {
      continue;
    }
    const ts = pair[0];
    const line = pair[1];
    if (typeof ts !== "string" || typeof line !== "string") {
      continue;
    }
    values.push([ts, line] as const);
  }

  return { stream: labels, values };
}

function writeFormattedLine(opts: {
  readonly prefix: string;
  readonly tsNs?: string;
  readonly line: string;
  readonly pretty: boolean;
}): void {
  const tsPrefix = opts.tsNs ? `${formatNsTimestamp(opts.tsNs)} ` : "";
  const synthetic = `${opts.prefix} | ${tsPrefix}${opts.line}`;
  if (opts.pretty) {
    const formatted = formatPrettyLogLine({
      line: synthetic,
      stream: "stdout",
      format: "docker-compose",
    });
    process.stdout.write(`${formatted}\n`);
    return;
  }

  process.stdout.write(`${synthetic}\n`);
}

function formatNsTimestamp(ns: string): string {
  const value = safeParseBigInt(ns);
  if (value === null) {
    return ns;
  }
  const ms = value / 1_000_000n;
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) {
    return ns;
  }
  return date.toISOString();
}

function safeParseBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
