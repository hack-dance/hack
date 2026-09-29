const args = Bun.argv.slice(2);
if (args.length === 1 && args[0] === "--mcp-artifact-info") {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, role: "backend", startupProtocol: 2, wireProtocol: 1, platform: process.platform, architecture: process.arch })}\n`
  );
} else {
  await run(args);
}

async function run(args: string[]): Promise<void> {
  const { startMcpSocketBackend } = await import(
    "../src/mcp/socket-backend.ts"
  );
  const supervised = args[0] === "--startup-supervised-v2";
  if (
    supervised !== (process.env.HACK_MCP_STARTUP_FD !== undefined) ||
    (supervised && args[1] !== "--")
  ) {
    throw new Error("MCP startup mode and channel must agree");
  }
  const [directory, backendId, idleTimeout] = args.slice(supervised ? 2 : 0);
  if (!(directory && backendId)) {
    throw new Error(
      "Usage: run-mcp-socket-backend.ts PRIVATE_DIRECTORY BACKEND_ID [IDLE_TIMEOUT_MS=60000]"
    );
  }
  let backend: Awaited<ReturnType<typeof startMcpSocketBackend>> | undefined;
  let stopRequested = false;
  const close = (): void => {
    stopRequested = true;
    if (backend) {
      void backend.close().catch(() => undefined);
    }
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  try {
    backend = await startMcpSocketBackend({
      directory,
      backendId,
      idleTimeoutMs: idleTimeout === undefined ? 60_000 : Number(idleTimeout),
    });
    if (stopRequested) {
      await backend.close();
    } else {
      process.stdout.write(
        `${JSON.stringify({ socketPath: backend.socketPath, backendId })}\n`
      );
    }
    await backend.closed;
  } finally {
    process.off("SIGTERM", close);
    process.off("SIGINT", close);
  }
}
