import { mock } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const [root, sourceRoot] = process.argv.slice(2);
if (!(root && sourceRoot)) {
  throw new Error("Missing fixture paths");
}
const original = { ...fs };
const originalSync = { ...fsSync };
const directory = await original.realpath(root);
process.umask(0o022);
let observed = false;
const refuseChmod = (path: unknown) => {
  // The socket is created private with its final mode; no socket name is ever
  // chmodded, so a replacement there can never be changed by path.
  if (typeof path === "string" && dirname(path) === directory) {
    throw new Error("A socket name was chmodded by path");
  }
};
mock.module("node:fs/promises", () => ({
  ...original,
  chmod: async (path: string, mode: number) => {
    refuseChmod(path);
    return original.chmod(path, mode);
  },
}));
mock.module("node:fs", () => ({
  ...originalSync,
  chmodSync: (path: string, mode: number) => {
    refuseChmod(path);
    return originalSync.chmodSync(path, mode);
  },
  lstatSync: (...args: Parameters<typeof originalSync.lstatSync>) => {
    const stat = originalSync.lstatSync(...args);
    const [path] = args;
    // The first observation of the staging socket, in the tick that created it.
    if (
      !observed &&
      stat?.isSocket() &&
      typeof path === "string" &&
      dirname(path) === directory &&
      basename(path).startsWith(".")
    ) {
      if ((Number(stat.mode) & 0o777) !== 0o600) {
        throw new Error("Socket was not created private with mode 0600");
      }
      observed = true;
    }
    return stat;
  },
}));
const { startMcpSocketBackend } = await import(
  join(sourceRoot, "src/mcp/socket-backend.ts")
);
const backend = await startMcpSocketBackend({
  directory: root,
  backendId: "private-bind",
  idleTimeoutMs: 50,
});
if (process.umask() !== 0o022) {
  throw new Error("Creation mask leaked past startup");
}
await backend.closed;
if (!observed || process.umask() !== 0o022) {
  throw new Error("Private bind was not observed or mask was not restored");
}
await original.writeFile(join(root, "ordinary-file"), "synthetic");
if (
  ((await original.lstat(join(root, "ordinary-file"))).mode & 0o777) !==
  0o644
) {
  throw new Error("Backend changed later file creation permissions");
}
console.log("private-before-chmod; mask-restored");
