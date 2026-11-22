/**
 * What the selected Docker engine supports, for the global stack's Compose
 * files. Hack renders `healthcheck.start_interval` only for an engine that
 * accepts it: Compose refuses the key below Docker Engine 25 ("feature
 * require Docker Engine v25 or later"), which would stop the proxy from
 * starting at all.
 */
import { exec } from "./shell.ts";

/** The first Docker Engine major version that accepts `start_interval`. */
export const START_INTERVAL_MIN_ENGINE_MAJOR = 25;

const ENGINE_MAJOR = /^\s*v?(\d+)\./;

/** The engine's major version from `docker version`, or null when unknown. */
export function parseEngineMajor(version: string): number | null {
  const match = ENGINE_MAJOR.exec(version);
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * True only when the engine answers and its major version is 25 or later.
 * No answer, or an output this does not understand, is false: the file
 * without `start_interval` works on every engine.
 */
export async function dockerEngineSupportsStartInterval(
  run: (argv: readonly string[]) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }> = async (argv) => await exec(argv, { stdin: "ignore", timeoutMs: 5000 })
): Promise<boolean> {
  const result = await run([
    "docker",
    "version",
    "--format",
    "{{.Server.Version}}",
  ]).catch(() => null);
  if (!result || result.exitCode !== 0) {
    return false;
  }
  const major = parseEngineMajor(result.stdout);
  return major !== null && major >= START_INTERVAL_MIN_ENGINE_MAJOR;
}
