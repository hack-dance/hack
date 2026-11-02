import { verifyMcpBundle } from "../src/mcp/bundle.ts";

try {
  const args = Bun.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    throw new Error("Usage: verify-mcp-bundle.ts BUNDLE_DIRECTORY");
  }
  process.stdout.write(
    `${JSON.stringify(await verifyMcpBundle({ directory: args[0] }), null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "MCP bundle verification failed"}\n`
  );
  process.exitCode = 1;
}
