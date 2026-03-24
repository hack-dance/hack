import { runCli as runCliImpl } from "@/cli/run.ts";

/**
 * Canonical CLI entrypoint for workspace package consumers.
 *
 * This is intentionally a thin wrapper during migration so root scripts and
 * release tooling remain stable while we move source layout in phases.
 */
export function runCli(args: readonly string[]): Promise<number> {
  return runCliImpl(args);
}
