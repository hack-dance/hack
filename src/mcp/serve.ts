import { startMcpServer } from "./server.ts";

/** Shared implementation for the exact stdio entrypoint and parsed CLI command. */
export async function serveMcp(): Promise<number> {
  if (process.stdout.isTTY) {
    process.stderr.write(
      "MCP server running on stdio (waiting for client)...\n"
    );
  }
  await startMcpServer();
  return 0;
}
