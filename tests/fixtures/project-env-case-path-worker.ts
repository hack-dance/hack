import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";

/** Model case-insensitive lookup with canonical realpath spelling on Linux. */
const [projectRoot, projectAlias] = process.argv.slice(2);
if (!(projectRoot && projectAlias)) {
  throw new Error("Missing fixture paths");
}
const canonicalRoot = projectRoot;
const aliasRoot = projectAlias;
function canonical(path: string): string {
  return path === aliasRoot || path.startsWith(`${aliasRoot}/`)
    ? canonicalRoot + path.slice(aliasRoot.length)
    : path;
}
const lstat = fs.lstat;
const realpath = fs.realpath;
const readlink = fs.readlink;
mock.module("node:fs/promises", () => ({
  ...fs,
  lstat: async (path: string) => await lstat(canonical(path)),
  realpath: async (path: string) => await realpath(canonical(path)),
  readlink: async (path: string) => await readlink(canonical(path)),
}));
const { assertProjectEnvLayerPath } = await import(
  "../../src/lib/project-env-layer-path.ts"
);
await assertProjectEnvLayerPath({
  projectRoot: projectAlias,
  path: resolve(projectAlias, ".hack", "hack.env.default.yaml"),
});
await assertProjectEnvLayerPath({
  projectRoot: projectAlias,
  path: resolve(projectAlias, ".hack", "hack.env.new.yaml"),
});
process.stdout.write("allowed\n");
