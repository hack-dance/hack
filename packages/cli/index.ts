/**
 * Canonical CLI entrypoint. The standard MCP launch avoids initializing the
 * unrelated command graph for every long-lived client. Any additional arguments
 * retain the full parser's help, validation and global-option behavior.
 */
export async function runCli(args: readonly string[]): Promise<number> {
  if (args.length === 2 && args[0] === "mcp" && args[1] === "serve") {
    try {
      const { setNoInteractiveFlag } = await import(
        "../../src/lib/interactivity.ts"
      );
      setNoInteractiveFlag({ enabled: false });
      const { serveMcp } = await import("../../src/mcp/serve.ts");
      return await serveMcp();
    } catch (error) {
      const { handleRunCliError } = await import("@/cli/run.ts");
      return await handleRunCliError({ error, jsonRequested: false });
    }
  }
  const { runCli: runCliImpl } = await import("@/cli/run.ts");
  return await runCliImpl(args);
}
