import { afterEach, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { testIntegration } from "./helpers/ci.ts";

let tempDir: string | null = null;
let client: Client | null = null;

afterEach(async () => {
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors.
    }
    client = null;
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

testIntegration(
  "mcp server lists the local-first hack tools",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const tools = await mcp.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toContain("hack.projects.list");
    expect(names).toContain("hack.project.status");
    expect(names).toContain("hack.project.logs.tail");
    expect(names).toContain("hack.project.open");
    expect(names).toContain("hack.project.init");
    expect(names).not.toContain("hack.linear.status");
  }
);

testIntegration(
  "hack.projects.list returns structured data",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.projects.list",
      arguments: {},
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({ projects: [{ name: "demo" }] });
  }
);

testIntegration(
  "hack.project.init returns a successful tool result",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const repoRoot = join(tempDir ?? "/tmp", "demo-repo");
    await mkdir(repoRoot, { recursive: true });
    const result = await mcp.callTool({
      name: "hack.project.init",
      arguments: {
        path: repoRoot,
      },
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
  }
);

async function startMcpClient(): Promise<Client> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-mcp-"));
  const homeDir = join(tempDir, "home");
  await mkdir(homeDir, { recursive: true });

  const stubPath = join(tempDir, "hack-stub");
  await writeFile(stubPath, buildHackStubScript());
  await chmod(stubPath, 0o755);

  const repoRoot = resolve(import.meta.dir, "..");

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["index.ts", "mcp", "serve"],
    cwd: repoRoot,
    env: {
      ...process.env,
      HACK_MCP_COMMAND: stubPath,
      HOME: homeDir,
    },
    stderr: "pipe",
  });

  const mcp = new Client({ name: "hack-cli-tests", version: "0.0.0" });
  await mcp.connect(transport);
  client = mcp;
  return mcp;
}

function buildHackStubScript(): string {
  return [
    "#!/usr/bin/env bun",
    "const args = Bun.argv.slice(2)",
    'const cmd = args[0] ?? ""',
    'if (cmd === "projects") {',
    '  console.log(JSON.stringify({ projects: [{ name: "demo" }] }))',
    "  process.exit(0)",
    "}",
    'if (cmd === "ps") {',
    '  console.log(JSON.stringify({ services: [{ name: "deps", status: "running" }] }))',
    "  process.exit(0)",
    "}",
    'if (cmd === "logs") {',
    "  console.log(JSON.stringify({ events: [] }))",
    "  process.exit(0)",
    "}",
    'if (cmd === "open") {',
    '  console.log(JSON.stringify({ url: "https://demo.hack", target: "project" }))',
    "  process.exit(0)",
    "}",
    'if (cmd === "init") {',
    "  console.log(JSON.stringify({ ok: true }))",
    "  process.exit(0)",
    "}",
    'console.error(`unexpected command: ${args.join(" ")}`)',
    "process.exit(1)",
  ].join("\n");
}
