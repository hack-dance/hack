import { mock } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";

/**
 * Runs one `hydrateProjectEnvLocalLayer` secret import in a disposable child
 * and pauses it at a chosen point of the layer write. Everything before the
 * pause runs unmocked.
 *
 * - `rename`: pause at the commit rename, after the staging file is written
 *   and fsynced. The parent SIGKILLs the child to test a real interruption.
 * - `staging`: pause when the staging file is opened, before the
 *   compare-and-swap recheck, until `<projectDir>/go` exists. The parent
 *   changes the layer meanwhile to test a concurrent writer.
 *
 * Entries arrive on stdin as `KEY=value` lines of synthetic test strings,
 * never in argv. The child prints `prepared`, then `committed` or
 * `refused:<reason>`.
 */
const [projectRoot, projectDir, pauseAt] = process.argv.slice(2);
if (
  !(
    projectRoot &&
    projectDir &&
    (pauseAt === "rename" || pauseAt === "staging")
  )
) {
  throw new Error("Missing project env hydrate worker arguments");
}

const rename = fs.rename;
const open = fs.open;
mock.module("node:fs/promises", () => ({
  ...fs,
  rename: async (from: string, to: string) => {
    if (pauseAt === "rename" && from.endsWith(".tmp")) {
      process.stdout.write("prepared\n");
      // Hold the staged write open until the parent kills this process.
      await Bun.sleep(120_000);
    }
    return await rename(from, to);
  },
  open: async (...args: Parameters<typeof fs.open>) => {
    const [path] = args;
    if (
      pauseAt === "staging" &&
      typeof path === "string" &&
      path.endsWith(".tmp")
    ) {
      process.stdout.write("prepared\n");
      while (!existsSync(`${projectDir}/go`)) {
        await Bun.sleep(10);
      }
    }
    return await open(...args);
  },
}));

const entries = new Map<string, string>();
for (const line of (await Bun.stdin.text()).split("\n")) {
  const equals = line.indexOf("=");
  if (equals > 0) {
    entries.set(line.slice(0, equals), line.slice(equals + 1));
  }
}

const { hydrateProjectEnvLocalLayer, ProjectEnvHydrationRefusalError } =
  await import("../../src/lib/project-env-config.ts");
try {
  await hydrateProjectEnvLocalLayer({
    projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    entries,
    secret: true,
  });
  process.stdout.write("committed\n");
} catch (error: unknown) {
  if (!(error instanceof ProjectEnvHydrationRefusalError)) {
    throw error;
  }
  process.stdout.write(`refused:${error.reason}\n`);
}
