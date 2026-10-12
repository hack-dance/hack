// TEMPORARY X01 measurement probe. Reverted before the final commit.
// Writes closed labels and durations only (no ids, paths or values).
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

const FILE = process.env.HACK_X01_TRACE_FILE;
const VERBS = new Set([
  "up",
  "down",
  "exec",
  "run",
  "restart",
  "ps",
  "logs",
  "status",
  "init",
]);
const SUBS = new Set([
  "info",
  "image",
  "container",
  "volume",
  "network",
  "compose",
  "create",
  "start",
  "rm",
  "inspect",
  "ls",
  "ps",
  "exec",
  "run",
  "logs",
  "version",
  "events",
  "stop",
  "kill",
  "wait",
  "up",
  "down",
  "config",
  "pull",
  "build",
  "restart",
  "port",
  "cp",
  "top",
]);
const verb = (() => {
  for (const arg of process.argv.slice(2)) {
    if (VERBS.has(arg)) {
      return arg;
    }
  }
  return "other";
})();
const scopes = new AsyncLocalStorage<string>();
let enabled = typeof FILE === "string" && FILE.startsWith("/");
let wroteStart = false;

function append(record: Record<string, unknown>): void {
  appendFileSync(
    FILE as string,
    `${JSON.stringify({ p: process.pid, v: verb, ...record })}\n`
  );
}

function write(record: Record<string, unknown>): void {
  if (!enabled) {
    return;
  }
  try {
    if (!wroteStart) {
      wroteStart = true;
      append({ k: "start", t: Math.round(performance.now()) });
      process.on("exit", (code) => {
        try {
          append({ k: "exit", c: code, t: Math.round(performance.now()) });
        } catch {
          // measurement only
        }
      });
    }
    append({
      s: scopes.getStore() ?? "",
      t: Math.round(performance.now()),
      ...record,
    });
  } catch {
    enabled = false;
  }
}

export function x01Enabled(): boolean {
  return enabled;
}

/** Raw line from the phase trace, re-wrapped with process identity. */
export function x01Phase(line: string): void {
  try {
    write({ k: "phase", line: JSON.parse(line) as unknown });
  } catch {
    enabled = false;
  }
}

export function x01Label(argv: readonly string[], binary = true): string {
  const parts: string[] = [];
  let rest = argv;
  if (binary) {
    const name = (argv[0] ?? "").split("/").at(-1) ?? "";
    parts.push(
      ["docker", "ps", "sysctl", "sh", "git", "bun", "tmux"].includes(name)
        ? name
        : "bin"
    );
    rest = argv.slice(1);
  } else {
    parts.push("docker");
  }
  for (const token of rest) {
    if (parts.length >= 3) {
      break;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (SUBS.has(token)) {
      parts.push(token);
    } else {
      break;
    }
  }
  return parts.join(" ");
}

export async function x01Time<T>(
  kind: string,
  label: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!enabled) {
    return await operation();
  }
  const started = performance.now();
  let ok = false;
  try {
    const result = await operation();
    ok = true;
    return result;
  } finally {
    write({
      k: kind,
      l: label,
      ms: Math.round((performance.now() - started) * 10) / 10,
      ok,
    });
  }
}

/** TEMPORARY X03 measurement: a closed-label point event. */
export function x01Mark(kind: string, label: string): void {
  write({ k: kind, l: label });
}

export async function x01Scope<T>(
  label: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!enabled) {
    return await operation();
  }
  const parent = scopes.getStore();
  const path = parent ? `${parent}>${label}` : label;
  return await scopes.run(path, () => x01Time("scope", label, operation));
}
