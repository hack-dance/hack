import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { ClosedCliError } from "../../src/lib/cli-result.ts";

const [projectRoot, projectDir, outside, phase] = process.argv.slice(2);
if (!(projectRoot && projectDir && outside)) {
  throw new Error("Missing fixture arguments");
}
const layer = resolve(projectDir, "hack.env.default.yaml");
const outsidePath = outside;
let swapped = false;
async function swap() {
  if (!swapped) {
    swapped = true;
    await fs.unlink(layer);
    await fs.symlink(outsidePath, layer);
  }
}
const realpath = fs.realpath;
const open = fs.open;
mock.module("node:fs/promises", () => ({
  ...fs,
  realpath: async (path: string) => {
    if (phase === "resolve" && path === layer) {
      await swap();
    }
    return await realpath(path);
  },
  open: async (path: string, flags: number, mode?: number) => {
    const file = await open(path, flags, mode);
    if (phase === "stage" && path.endsWith(".tmp")) {
      await swap();
    }
    return file;
  },
}));
const { setProjectEnvValue } = await import(
  "../../src/lib/project-env-config.ts"
);
try {
  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "SETTING",
    value: "synthetic-update",
    secret: false,
  });
  throw new Error("Expected refusal");
} catch (error: unknown) {
  if (!(error instanceof ClosedCliError && swapped)) {
    throw error;
  }
  process.stdout.write("refused\n");
}
