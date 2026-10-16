import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  "mcp server lists the hack-init prompt",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const prompts = await mcp.listPrompts();
    const names = prompts.prompts.map((prompt) => prompt.name);

    expect(names).toContain("hack-init");
  }
);

testIntegration(
  "hack-init prompt returns the onboarding prompt content",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.getPrompt({
      name: "hack-init",
      arguments: { mode: "new-project", projectName: "demo" },
    });

    const message = result.messages[0];
    expect(message?.role).toBe("user");
    const content = message?.content;
    if (content?.type !== "text") {
      throw new Error("Expected text prompt content");
    }
    expect(content.text).toContain("stand up hack in this repo");
    expect(content.text).toContain("(project: demo)");
    expect(content.text).toContain("## Phase 1 — Inventory the repo");
    expect(content.text).toContain("node_modules:/app/node_modules");
  }
);

testIntegration(
  "hack-init prompt defaults to existing-project mode on unknown mode values",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.getPrompt({
      name: "hack-init",
      arguments: { mode: "bogus" },
    });

    const content = result.messages[0]?.content;
    if (content?.type !== "text") {
      throw new Error("Expected text prompt content");
    }
    expect(content.text).toContain(
      "adopt the existing hack setup in this repo"
    );
  }
);

async function startMcpClient(): Promise<Client> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-mcp-prompts-"));
  const homeDir = join(tempDir, "home");
  await mkdir(homeDir, { recursive: true });

  const repoRoot = resolve(import.meta.dir, "..");

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["index.ts", "mcp", "serve"],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    stderr: "pipe",
  });

  const mcp = new Client({ name: "hack-cli-tests", version: "0.0.0" });
  await mcp.connect(transport);
  client = mcp;
  return mcp;
}
