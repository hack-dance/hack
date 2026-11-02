import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../lib/guards.ts";
import type { McpLaunch } from "./bundle-launch.ts";

const HEADER = /^\s*\[.*\]\s*(?:#.*)?$/;
const TRIVIA = /^\s*(?:#.*)?$/;

export function hasCodexLaunch(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new Error("Invalid Codex configuration TOML");
  }
  if (
    !isRecord(parsed) ||
    (parsed.mcp_servers !== undefined && !isRecord(parsed.mcp_servers))
  ) {
    throw new Error("Invalid Codex MCP server table");
  }
  return (
    isRecord(parsed.mcp_servers) && Object.hasOwn(parsed.mcp_servers, "hack")
  );
}

function valueToToml(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "nan";
    }
    if (!Number.isFinite(value)) {
      return value < 0 ? "-inf" : "inf";
    }
    return Object.is(value, -0) ? "-0.0" : String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return `[${value.map(valueToToml).join(", ")}]`;
  }
  if (isRecord(value)) {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${valueToToml(item)}`)
      .join(", ")} }`;
  }
  throw new Error("Unsupported value in Codex MCP configuration");
}

export function renderCodexLaunch(launch: McpLaunch): string {
  return renderEntry({ ...launch, args: [...launch.args] });
}

function renderEntry(entry: Record<string, unknown>): string {
  return [
    "[mcp_servers.hack]",
    ...Object.entries(entry).map(
      ([key, value]) => `${JSON.stringify(key)} = ${valueToToml(value)}`
    ),
  ].join("\n");
}

/** Preserve other tables byte-for-byte and custom Hack values semantically.
 * Reparse and compare the complete document before allowing any write. Unusual
 * inline/dotted layouts we cannot locate safely are refused rather than guessed.
 */
export function replaceCodexLaunch(opts: {
  readonly text: string;
  readonly launch: McpLaunch;
}): string {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(opts.text);
  } catch {
    throw new Error("Invalid Codex configuration TOML");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid Codex configuration root");
  }
  const servers = parsed.mcp_servers ?? {};
  if (!isRecord(servers)) {
    throw new Error("Invalid Codex MCP server table");
  }
  const existing = servers.hack ?? {};
  if (!isRecord(existing) || existing.url !== undefined) {
    throw new Error("Cannot replace a non-stdio Hack MCP configuration");
  }
  if (existing.env !== undefined && !isRecord(existing.env)) {
    throw new Error("Invalid Hack MCP environment table");
  }
  const nextEntry = {
    ...existing,
    ...opts.launch,
    args: [...opts.launch.args],
    env: {
      ...(isRecord(existing.env) ? existing.env : {}),
      ...opts.launch.env,
    },
  };
  const expected = { ...parsed, mcp_servers: { ...servers, hack: nextEntry } };
  if (isDeepStrictEqual(parsed, expected)) {
    return opts.text;
  }
  const prefix = withoutHackSections(opts.text).trimEnd();
  const next = `${prefix}${prefix ? "\n\n" : ""}${renderEntry(nextEntry)}\n`;
  let actual: unknown;
  try {
    actual = Bun.TOML.parse(next);
  } catch {
    throw new Error("Cannot safely update this Codex MCP layout");
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("Cannot safely update this Codex MCP layout");
  }
  return next;
}

function withoutHackSections(text: string): string {
  const kept: string[] = [];
  let trailing: string[] = [];
  let discard = false;
  for (const line of text.split("\n")) {
    if (HEADER.test(line)) {
      let header: unknown;
      try {
        header = Bun.TOML.parse(`${line}\n`);
      } catch {
        throw new Error("Cannot safely locate Codex MCP tables");
      }
      const nextDiscard =
        isRecord(header) &&
        isRecord(header.mcp_servers) &&
        Object.hasOwn(header.mcp_servers, "hack");
      if (discard && !nextDiscard) {
        kept.push(...trailing);
      }
      trailing = [];
      discard = nextDiscard;
    }
    if (!discard) {
      kept.push(line);
    } else if (TRIVIA.test(line)) {
      trailing.push(line);
    } else {
      trailing = [];
    }
  }
  kept.push(...trailing);
  return kept.join("\n");
}

/** Remove the selected server and its nested tables only after a full parse
 * proves that no unrelated configuration was changed. No regex-only deletion.
 */
export function removeCodexLaunch(text: string): string {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new Error("Invalid Codex configuration TOML");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid Codex configuration root");
  }
  const servers = parsed.mcp_servers;
  if (servers === undefined) {
    return text;
  }
  if (!isRecord(servers)) {
    throw new Error("Invalid Codex MCP server table");
  }
  if (!Object.hasOwn(servers, "hack")) {
    return text;
  }
  const { hack: _removed, ...remaining } = servers;
  const expected = { ...parsed, mcp_servers: remaining };
  const next = withoutHackSections(text);
  let actual: unknown;
  try {
    actual = Bun.TOML.parse(next);
  } catch {
    throw new Error("Cannot safely remove this Codex MCP layout");
  }
  if (!isRecord(actual)) {
    throw new Error("Invalid resulting Codex configuration");
  }
  // An omitted empty parent table is equivalent to an explicit empty table.
  const normalized = { ...actual, mcp_servers: actual.mcp_servers ?? {} };
  if (!isDeepStrictEqual(normalized, expected)) {
    throw new Error("Cannot safely remove this Codex MCP layout");
  }
  return next;
}
