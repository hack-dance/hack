import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";

const count = Number(Bun.argv.at(-1));
if (!Number.isSafeInteger(count) || count < 1 || count > 32) {
  throw new Error("Supply an integer session count from 1 to 32");
}
const root = await mkdtemp(join(tmpdir(), "hack-shared-mcp-core-"));
const clients: Client[] = [];
const started = performance.now();
try {
  const schemas = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const cwd = join(root, String(index));
      await mkdir(cwd);
      const server = createMcpServer({
        cwd,
        env: { HOME: cwd, HACK_HOME: join(cwd, "state") },
      });
      const client = new Client({ name: "shared-core-probe", version: "1" });
      clients.push(client);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "hack.projects.list")) {
        throw new Error("Expected tools are missing");
      }
      return JSON.stringify(tools);
    })
  );
  const readyMs = performance.now() - started;
  if (new Set(schemas).size !== 1) {
    throw new Error("Tool schemas differ across sessions");
  }
  const cpu = process.cpuUsage();
  const idleStarted = performance.now();
  await Bun.sleep(2000);
  const elapsed = performance.now() - idleStarted;
  const idleCpu = process.cpuUsage(cpu);
  const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(process.pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const rssKiB = Number(new TextDecoder().decode(ps.stdout).trim());
  if (ps.exitCode !== 0 || !Number.isFinite(rssKiB) || rssKiB <= 0) {
    throw new Error("Could not measure owned process RSS");
  }
  await Promise.all(clients.map((client) => client.listTools()));
  process.stdout.write(
    `${JSON.stringify({ sessions: count, ready_ms: readyMs, rss_kib: rssKiB, idle_ms: elapsed, idle_cpu_seconds: (idleCpu.user + idleCpu.system) / 1_000_000, scope: "one process containing MCP servers AND in-memory SDK clients; excludes IPC adapters, listener, auth and command execution" })}\n`
  );
} finally {
  await Promise.all(clients.map((client) => client.close()));
  await rm(root, { recursive: true, force: true });
}
