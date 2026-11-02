import { mock } from "bun:test";
import { join } from "node:path";

const [root, sourceRoot, mode] = process.argv.slice(2);
if (!(root && sourceRoot)) {
  throw new Error("Missing fixture paths");
}
mock.module(join(sourceRoot, "src/mcp/socket-receipt.ts"), () => ({
  recordMcpSocketReceipt: async () => {
    process.stdout.write("bound\n");
    await Bun.stdin.text();
    if (mode === "fail") {
      throw new Error("synthetic publication failure");
    }
    return async () => undefined;
  },
}));
if (mode === "signal") {
  Bun.argv.splice(2, Bun.argv.length - 2, root, "barrier", "0");
  await import(join(sourceRoot, "scripts/run-mcp-socket-backend.ts"));
} else {
  const { startMcpSocketBackend } = await import(
    join(sourceRoot, "src/mcp/socket-backend.ts")
  );
  try {
    const backend = await startMcpSocketBackend({
      directory: root,
      backendId: "barrier",
      idleTimeoutMs: 100,
      maxConnections: 1,
    });
    process.stdout.write("ready\n");
    await backend.closed;
  } catch {
    process.stdout.write("failed\n");
    process.exitCode = 1;
  }
}
