import { closeSync, fstatSync, readSync, writeSync } from "node:fs";

/** The native startup supervisor grants permission only after relinquishing its
 * timeout-kill authority. No MCP session may activate before this returns.
 */
export function requireMcpStartupGrant(): void {
  const descriptor = process.env.HACK_MCP_STARTUP_FD;
  if (descriptor === undefined) {
    return;
  }
  const fd = Number(descriptor);
  if (!Number.isSafeInteger(fd) || fd <= 2 || !fstatSync(fd).isSocket()) {
    throw new Error("Invalid MCP startup channel");
  }
  try {
    if (writeSync(fd, Buffer.from("R")) !== 1) {
      throw new Error("MCP startup request failed");
    }
    const grant = Buffer.alloc(1);
    if (readSync(fd, grant) !== 1 || grant[0] !== 71) {
      throw new Error("MCP startup grant refused");
    }
  } finally {
    closeSync(fd);
  }
}
