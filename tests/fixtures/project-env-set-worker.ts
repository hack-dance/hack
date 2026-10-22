import { mock } from "bun:test";
import * as fs from "node:fs/promises";

/**
 * Runs one `setProjectEnvValue` secret write in a disposable child and pauses
 * it at the commit rename. Everything before that boundary (reading the layer,
 * encrypting, creating, writing and fsyncing the staging file) runs unmocked;
 * the parent then SIGKILLs the child to test a real pre-commit interruption.
 * Values are synthetic test strings passed on stdin, never in argv. The optional
 * third argument, `tracked` (default) or `local`, selects the layer written.
 */
const [projectRoot, projectDir, layer = "tracked"] = process.argv.slice(2);
if (
  !(projectRoot && projectDir && (layer === "tracked" || layer === "local"))
) {
  throw new Error("Missing project env worker arguments");
}

const rename = fs.rename;
mock.module("node:fs/promises", () => ({
  ...fs,
  rename: async (from: string, to: string) => {
    process.stdout.write("prepared\n");
    // Hold the staged write open until the parent kills this process.
    await Bun.sleep(120_000);
    return await rename(from, to);
  },
}));

const value = await Bun.stdin.text();

const { setProjectEnvValue } = await import(
  "../../src/lib/project-env-config.ts"
);
await setProjectEnvValue({
  projectRoot,
  projectDir,
  envName: null,
  scope: "global",
  key: "API_TOKEN",
  value,
  secret: true,
  local: layer === "local",
});
process.stdout.write("committed\n");
