#!/usr/bin/env bun
/**
 * Local entry point for the compiled-bundle CLI checks that CI runs in the
 * "Config compiler" job (HACK-1294). Each script copies `dist/hack` and
 * `dist/hack-config-compiler` into an isolated temporary bundle with a private
 * HOME, so the current branch must be built first:
 *
 *   bun run build && bun run build:config-compiler && bun run check:native-plan-cli
 *
 * The scripts run one at a time, in the CI order, and the first failure stops
 * the run. `tests/native-plan-cli-wiring.test.ts` fails when a
 * `scripts/check-native-*-plan-cli.ts` is missing from this list or from CI.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Repository-relative scripts, in the order CI runs them. */
export const NATIVE_PLAN_CLI_CHECKS = [
  "scripts/check-config-compiler-cli.ts",
  "scripts/check-native-env-plan-cli.ts",
  "scripts/check-native-host-plan-cli.ts",
  "scripts/check-native-routing-plan-cli.ts",
  "scripts/check-native-endpoint-plan-cli.ts",
  "scripts/check-native-process-plan-cli.ts",
  "scripts/check-native-acquisition-plan-cli.ts",
  "scripts/check-native-config-import-cli.ts",
] as const;

const PREREQUISITES = ["dist/hack", "dist/hack-config-compiler"] as const;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  for (const prerequisite of PREREQUISITES) {
    if (!(await isFile(resolve(root, prerequisite)))) {
      process.stderr.write(
        `${prerequisite} is missing. Build the current branch first: ` +
          "bun run build && bun run build:config-compiler\n"
      );
      process.exitCode = 1;
      return;
    }
  }
  for (const script of NATIVE_PLAN_CLI_CHECKS) {
    process.stdout.write(`check:native-plan-cli: ${script}\n`);
    const child = Bun.spawn([process.execPath, script], {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const exit = await child.exited;
    if (exit !== 0) {
      process.stderr.write(
        `check:native-plan-cli: ${script} failed (exit ${exit}).\n`
      );
      process.exitCode = exit > 0 ? exit : 1;
      return;
    }
  }
}

if (import.meta.main) {
  await main();
}
