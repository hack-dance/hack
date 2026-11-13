import { isRecord } from "../lib/guards.ts";

/**
 * Argv builders and result parsing for the background command tools
 * (`hack.project.command.start|read|inspect|cancel`). The tools are thin
 * adapters over the CLI (`hack exec|run --detach`, `hack commands ...`), so
 * the CLI and MCP share one implementation and one journal.
 */

export const MCP_COMMAND_WAIT_DEFAULT_MS = 25_000;
/** Under the shortest known client tool-call limit. */
export const MCP_COMMAND_WAIT_MAX_MS = 30_000;
/** Child budget beyond the wait: project resolution and process start. */
export const MCP_COMMAND_CHILD_SLACK_MS = 20_000;
export const MCP_COMMAND_CONTROL_TIMEOUT_MS = 30_000;

/**
 * `hack exec|run --detach --json` argv. Every option value is fused and `--`
 * precedes the service, so nothing in `cmd` reaches hack's parser.
 */
export function buildCommandStartArgs(opts: {
  readonly operation: "exec" | "run";
  readonly projectArgs: readonly string[];
  readonly branch?: string;
  readonly workdir?: string;
  readonly requestKey: string;
  readonly timeoutMs?: number;
  readonly stallAfterMs?: number;
  readonly capture?: "full" | "metadata";
  readonly service: string;
  readonly cmd: readonly string[];
}): string[] {
  return [
    opts.operation,
    ...opts.projectArgs,
    ...(opts.branch ? [`--branch=${opts.branch}`] : []),
    ...(opts.workdir ? [`--workdir=${opts.workdir}`] : []),
    "--detach",
    "--json",
    `--request-key=${opts.requestKey}`,
    ...(opts.timeoutMs === undefined ? [] : [`--timeout-ms=${opts.timeoutMs}`]),
    ...(opts.stallAfterMs === undefined
      ? []
      : [`--stall-after-ms=${opts.stallAfterMs}`]),
    ...(opts.capture ? [`--capture=${opts.capture}`] : []),
    "--",
    opts.service,
    ...opts.cmd,
  ];
}

/** `hack commands <action> <id> --json` argv with the caller's scope. */
export function buildCommandControlArgs(opts: {
  readonly action: "read" | "show" | "cancel";
  readonly commandId: string;
  readonly projectArgs: readonly string[];
  readonly branch?: string;
  readonly after?: string;
  readonly waitMs?: number;
  readonly maxBytes?: number;
}): string[] {
  return [
    "commands",
    opts.action,
    ...opts.projectArgs,
    ...(opts.branch ? [`--branch=${opts.branch}`] : []),
    ...(opts.after === undefined ? [] : [`--after=${opts.after}`]),
    ...(opts.waitMs === undefined ? [] : [`--wait-ms=${opts.waitMs}`]),
    ...(opts.maxBytes === undefined ? [] : [`--max-bytes=${opts.maxBytes}`]),
    "--json",
    "--",
    opts.commandId,
  ];
}

export type CliEnvelope =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** Parse a single `{ok, data | error}` envelope printed by a `--json` command. */
export function parseCliEnvelope(stdout: string): CliEnvelope | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return toEnvelope(value);
}

function toEnvelope(value: unknown): CliEnvelope | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return null;
  }
  if (value.ok) {
    return { ok: true, data: value.data };
  }
  const error = value.error;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return null;
}

/**
 * Parse `hack commands read --json`: event lines followed by one `read.end`
 * line. An error envelope (printed instead, before any event) is returned as
 * such. Null when the output matches neither shape.
 */
export function parseCommandReadOutput(stdout: string):
  | {
      readonly ok: true;
      readonly data: Record<string, unknown>;
    }
  | Extract<CliEnvelope, { ok: false }>
  | null {
  const envelope = parseCliEnvelope(stdout);
  if (envelope && !envelope.ok) {
    return envelope;
  }
  const events: unknown[] = [];
  let end: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (isRecord(value) && value.type === "read.end") {
      end = value;
    } else {
      events.push(value);
    }
  }
  if (!end) {
    return null;
  }
  const { type: _type, ...rest } = end;
  return { ok: true, data: { ...rest, events } };
}
