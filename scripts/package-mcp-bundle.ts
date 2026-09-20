import { parseArgs } from "node:util";
import { packageMcpBundle } from "../src/mcp/bundle.ts";

try {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      output: { type: "string" },
      adapter: { type: "string" },
      owner: { type: "string" },
      backend: { type: "string" },
    },
  });
  if (!(values.output && values.adapter && values.owner && values.backend)) {
    throw new Error(
      "Usage: package-mcp-bundle.ts --output PRIVATE_ROOT --adapter BINARY --owner BINARY --backend BINARY"
    );
  }
  const result = await packageMcpBundle({
    outputRoot: values.output,
    inputs: {
      adapter: values.adapter,
      owner: values.owner,
      backend: values.backend,
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "MCP bundle packaging failed"}\n`
  );
  process.exitCode = 1;
}
