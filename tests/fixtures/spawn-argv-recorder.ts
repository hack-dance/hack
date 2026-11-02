/**
 * Test preload: records argv and env of every child process the CLI spawns.
 *
 * Loaded with `bun --preload` in a fresh subprocess only. Each spawn appends
 * one JSON line `{ via, argv, env }` to the file named by
 * `HACK_TEST_SPAWN_ARGV_LOG`, then delegates to the original implementation,
 * so behavior is unchanged. Tests scan the log for a secret sentinel.
 */
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

const logPath = process.env.HACK_TEST_SPAWN_ARGV_LOG;

function record(input: {
  readonly via: string;
  readonly argv: unknown;
  readonly env: unknown;
}): void {
  if (!logPath) {
    return;
  }
  appendFileSync(
    logPath,
    `${JSON.stringify({ via: input.via, argv: input.argv, env: input.env ?? null })}\n`
  );
}

function bunSpawnArgv(args: readonly unknown[]): {
  readonly argv: unknown;
  readonly env: unknown;
} {
  const [first, second] = args;
  if (Array.isArray(first)) {
    const options = (second ?? {}) as { readonly env?: unknown };
    return { argv: first, env: options.env };
  }
  const options = (first ?? {}) as {
    readonly cmd?: unknown;
    readonly env?: unknown;
  };
  return { argv: options.cmd, env: options.env };
}

const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

Bun.spawn = ((...args: unknown[]) => {
  record({ via: "Bun.spawn", ...bunSpawnArgv(args) });
  return Reflect.apply(originalSpawn, Bun, args);
}) as typeof Bun.spawn;

Bun.spawnSync = ((...args: unknown[]) => {
  record({ via: "Bun.spawnSync", ...bunSpawnArgv(args) });
  return Reflect.apply(originalSpawnSync, Bun, args);
}) as typeof Bun.spawnSync;

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as Record<string, unknown>;
for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]) {
  const original = childProcess[name];
  if (typeof original !== "function") {
    continue;
  }
  childProcess[name] = (...args: unknown[]) => {
    const [command, maybeArgs, maybeOptions] = args;
    const argList = Array.isArray(maybeArgs) ? maybeArgs : [];
    const options = (Array.isArray(maybeArgs) ? maybeOptions : maybeArgs) as
      | { readonly env?: unknown }
      | undefined;
    record({
      via: `child_process.${name}`,
      argv: [command, ...argList],
      env: options?.env,
    });
    return Reflect.apply(original, childProcess, args);
  };
}
