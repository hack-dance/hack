import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const [root, sourceRoot] = process.argv.slice(2);
if (!(root && sourceRoot)) {
  throw new Error("Missing fixture paths");
}
const original = { ...fs };
const socketPath = join(await original.realpath(root), "mcp.sock");
process.umask(0o022);
let observed = false;
mock.module("node:fs/promises", () => ({
  ...original,
  chmod: async (path: string, mode: number) => {
    if (path === socketPath) {
      const socket = await original.lstat(path);
      if (!socket.isSocket() || (socket.mode & 0o077) !== 0) {
        throw new Error("Socket was public before chmod");
      }
      if (process.umask() !== 0o022) {
        throw new Error("Creation mask leaked across await");
      }
      observed = true;
    }
    return original.chmod(path, mode);
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
