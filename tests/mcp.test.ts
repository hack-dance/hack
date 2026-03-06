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
  "mcp server lists hack tools",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const tools = await mcp.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toContain("hack.projects.list");
    expect(names).toContain("hack.project.status");
    expect(names).toContain("hack.project.logs.tail");
    expect(names).toContain("hack.project.open");
    expect(names).toContain("hack.linear.status");
    expect(names).toContain("hack.linear.sync.project");
    expect(names).toContain("hack.linear.deliveries.list");
    expect(names).toContain("hack.linear.deliveries.apply");
    expect(names).toContain("hack.linear.assignee-mappings.list");
    expect(names).toContain("hack.linear.assignee-mappings.upsert");
    expect(names).toContain("hack.linear.assignee-mappings.remove");
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
  "hack.linear.status returns structured data",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.linear.status",
      arguments: {},
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({
      extensionId: "dance.hack.linear",
      selectedProfile: "default",
      tokenResolved: true,
    });
  }
);

testIntegration(
  "hack.linear.deliveries.list forwards status and limit flags",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.linear.deliveries.list",
      arguments: {
        status: "pending",
        limit: 5,
      },
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({
      status: "pending",
      limit: 5,
      deliveries: [{ id: "delivery-1", status: "pending" }],
    });
  }
);

testIntegration(
  "hack.linear.deliveries.apply forwards delivery id",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.linear.deliveries.apply",
      arguments: {
        deliveryId: "delivery-1",
      },
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({
      deliveryId: "delivery-1",
      status: "applied",
    });
  }
);

testIntegration(
  "hack.linear.assignee-mappings.list forwards profile and team filters",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.linear.assignee-mappings.list",
      arguments: {
        profile: "work",
        teamId: "team-1",
      },
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({
      profileId: "work",
      teamId: "team-1",
      mappings: [
        {
          profileId: "work",
          teamId: "team-1",
          localAssignee: "alice@hack",
          linearUserId: "user-1",
        },
      ],
    });
  }
);

testIntegration(
  "hack.linear.assignee-mappings.upsert forwards explicit mapping fields",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.linear.assignee-mappings.upsert",
      arguments: {
        profile: "work",
        teamId: "team-1",
        localAssignee: "alice@hack",
        linearUserId: "user-1",
        linearUserName: "Alice Example",
        linearUserEmail: "alice@example.com",
      },
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({
      upserted: true,
      replacedExisting: false,
      mapping: {
        profileId: "work",
        teamId: "team-1",
        localAssignee: "alice@hack",
        linearUserId: "user-1",
        linearUserName: "Alice Example",
        linearUserEmail: "alice@example.com",
      },
    });
  }
);

testIntegration(
  "hack.linear.assignee-mappings.remove forwards mapping identity",
  { timeout: 20_000 },
  async () => {
    const mcp = await startMcpClient();
    const result = await mcp.callTool({
      name: "hack.linear.assignee-mappings.remove",
      arguments: {
        profile: "work",
        teamId: "team-1",
        localAssignee: "alice@hack",
      },
    });

    const structured = result.structuredContent as {
      ok: boolean;
      data?: unknown;
    };

    expect(result.isError).toBeUndefined();
    expect(structured.ok).toBe(true);
    expect(structured.data).toEqual({
      removed: true,
      profileId: "work",
      teamId: "team-1",
      localAssignee: "alice@hack",
    });
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
    '  const payload = { projects: [{ name: "demo" }] }',
    "  console.log(JSON.stringify(payload))",
    "  process.exit(0)",
    "}",
    'if (cmd === "linear") {',
    '  const sub = args[1] ?? ""',
    '  if (sub === "status") {',
    '    console.log(JSON.stringify({ extensionId: "dance.hack.linear", selectedProfile: "default", tokenResolved: true }))',
    "    process.exit(0)",
    "  }",
    '  if (sub === "deliveries") {',
    '    const statusIndex = args.indexOf("--status")',
    '    const limitIndex = args.indexOf("--limit")',
    '    const status = statusIndex === -1 ? "pending" : args[statusIndex + 1]',
    "    const limit = limitIndex === -1 ? null : Number(args[limitIndex + 1])",
    '    console.log(JSON.stringify({ status, limit, deliveries: [{ id: "delivery-1", status }] }))',
    "    process.exit(0)",
    "  }",
    '  if (sub === "apply-delivery") {',
    '    const idIndex = args.indexOf("--delivery-id")',
    "    const deliveryId = idIndex === -1 ? null : args[idIndex + 1]",
    '    console.log(JSON.stringify({ deliveryId, status: "applied" }))',
    "    process.exit(0)",
    "  }",
    '  if (sub === "assignee-mappings") {',
    '    const profileIndex = args.indexOf("--profile")',
    '    const teamIndex = args.indexOf("--team-id")',
    '    const profileId = profileIndex === -1 ? "default" : args[profileIndex + 1]',
    "    const teamId = teamIndex === -1 ? null : args[teamIndex + 1]",
    '    console.log(JSON.stringify({ profileId, teamId, mappings: [{ profileId, teamId, localAssignee: "alice@hack", linearUserId: "user-1" }] }))',
    "    process.exit(0)",
    "  }",
    '  if (sub === "set-assignee-mapping") {',
    '    const profileIndex = args.indexOf("--profile")',
    '    const teamIndex = args.indexOf("--team-id")',
    '    const localIndex = args.indexOf("--local-assignee")',
    '    const userIdIndex = args.indexOf("--linear-user-id")',
    '    const userNameIndex = args.indexOf("--linear-user-name")',
    '    const userEmailIndex = args.indexOf("--linear-user-email")',
    '    const profileId = profileIndex === -1 ? "default" : args[profileIndex + 1]',
    "    const teamId = teamIndex === -1 ? null : args[teamIndex + 1]",
    "    const localAssignee = localIndex === -1 ? null : args[localIndex + 1]",
    "    const linearUserId = userIdIndex === -1 ? null : args[userIdIndex + 1]",
    "    const linearUserName = userNameIndex === -1 ? null : args[userNameIndex + 1]",
    "    const linearUserEmail = userEmailIndex === -1 ? null : args[userEmailIndex + 1]",
    "    console.log(JSON.stringify({ upserted: true, replacedExisting: false, mapping: { profileId, teamId, localAssignee, linearUserId, linearUserName, linearUserEmail } }))",
    "    process.exit(0)",
    "  }",
    '  if (sub === "remove-assignee-mapping") {',
    '    const profileIndex = args.indexOf("--profile")',
    '    const teamIndex = args.indexOf("--team-id")',
    '    const localIndex = args.indexOf("--local-assignee")',
    '    const profileId = profileIndex === -1 ? "default" : args[profileIndex + 1]',
    "    const teamId = teamIndex === -1 ? null : args[teamIndex + 1]",
    "    const localAssignee = localIndex === -1 ? null : args[localIndex + 1]",
    "    console.log(JSON.stringify({ removed: true, profileId, teamId, localAssignee }))",
    "    process.exit(0)",
    "  }",
    "}",
    "console.error(`unknown command: ${cmd}`)",
    "process.exit(1)",
    "",
  ].join("\n");
}
