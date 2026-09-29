import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.ts";
import { captureMcpSessionContext } from "../src/mcp/session-context.ts";

const clients: Client[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(marker: string, delayMs = 20) {
  const root = await mkdtemp(join(tmpdir(), "hack-mcp-context-"));
  roots.push(root);
  const project = join(root, "repo");
  const projectDir = join(project, ".hack");
  const state = join(root, "state");
  const registryDir = join(root, "registry");
  await mkdir(projectDir, { recursive: true });
  await mkdir(registryDir);
  await writeFile(join(projectDir, "docker-compose.yml"), "services: {}\n");
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "shared-name" })
  );
  await writeFile(
    join(registryDir, "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: marker,
          createdAt: "2026-01-01T00:00:00Z",
          name: "shared-name",
          repoRoot: project,
          projectDirName: ".hack",
          projectDir,
        },
      ],
    })
  );
  const command = join(project, "command");
  await writeFile(
    command,
    `#!${process.execPath}\nawait Bun.write("request-started", String(process.pid));\nawait Bun.sleep(${delayMs});\nconsole.log(JSON.stringify({ marker: process.env.SYNTHETIC_SESSION_MARKER, cwd: process.cwd(), args: Bun.argv.slice(2) }));\n`
  );
  await chmod(command, 0o755);
  const env = {
    ...process.env,
    HOME: root,
    HACK_HOME: state,
    HACK_GLOBAL_CONFIG_PATH: join(registryDir, "config.json"),
    HACK_MCP_COMMAND: "./command",
    SYNTHETIC_SESSION_MARKER: marker,
  };
  const server = createMcpServer({ cwd: project, env });
  // Mutating the caller's object after creation must not affect the session.
  env.SYNTHETIC_SESSION_MARKER = "changed-after-capture";
  const client = new Client({
    name: "session-isolation-fixture",
    version: "1",
  });
  clients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, root, project, state, registryDir };
}

test("MCP sessions preserve independent cwd, environment, registry selection and audit roots", async () => {
  const cwdBefore = process.cwd();
  const markerBefore = process.env.SYNTHETIC_SESSION_MARKER;
  const signalListeners = process.listenerCount("SIGTERM");
  const [first, second] = await Promise.all([
    fixture("first"),
    fixture("second"),
  ]);
  const results = await Promise.all(
    [first, second].map(({ client }) =>
      client.callTool({
        name: "hack.project.status",
        arguments: { projectName: "shared-name" },
      })
    )
  );
  for (const [index, item] of [first, second].entries()) {
    expect(results[index]?.isError).toBeUndefined();
    expect(results[index]?.structuredContent).toMatchObject({
      ok: true,
      data: {
        marker: index === 0 ? "first" : "second",
        cwd: await realpath(item.project),
        args: ["ps", "--project", "shared-name", "--json"],
      },
    });
    const audit = await readFile(join(item.state, "mcp-audit.log"), "utf8");
    expect(audit).toContain('"tool":"hack.project.status"');
    expect(audit).not.toContain("SYNTHETIC_SESSION_MARKER");
  }
  expect(process.cwd()).toBe(cwdBefore);
  expect(process.env.SYNTHETIC_SESSION_MARKER).toBe(markerBefore);
  expect(process.listenerCount("SIGTERM")).toBe(signalListeners);
});

test("MCP path authorization uses only that session's registry", async () => {
  const [first, second] = await Promise.all([
    fixture("first"),
    fixture("second"),
  ]);
  const denied = await first.client.callTool({
    name: "hack.project.status",
    arguments: { path: second.project },
  });
  expect(denied.isError).toBe(true);
  expect(denied.structuredContent).toMatchObject({
    stderr: "Path is outside registered hack projects.",
  });
  const accepted = await second.client.callTool({
    name: "hack.project.status",
    arguments: { path: second.project },
  });
  expect(accepted.isError).toBeUndefined();
  await first.client.close();
  const stillConnected = await second.client.listTools();
  expect(
    stillConnected.tools.some((tool) => tool.name === "hack.projects.list")
  ).toBe(true);
});

test("session paths resolve relative overrides against the captured checkout", () => {
  const context = captureMcpSessionContext({
    cwd: "/tmp/captured-session",
    env: {
      HACK_HOME: ".state",
      HACK_GLOBAL_CONFIG_PATH: ".registry/config.json",
    },
  });
  expect(context.hackHome).toBe("/tmp/captured-session/.state");
  expect(context.registryPath).toBe(
    "/tmp/captured-session/.registry/projects.json"
  );
  expect(Object.isFrozen(context.env)).toBe(true);
  expect(Object.isFrozen(context)).toBe(true);
});

test("32 MCP sessions can share a process without mixing command context", async () => {
  const sessions = await Promise.all(
    Array.from({ length: 32 }, (_, index) => fixture(`session-${index}`))
  );
  const results = await Promise.all(
    sessions.map(({ client }) =>
      client.callTool({ name: "hack.projects.list", arguments: {} })
    )
  );
  for (const [index, result] of results.entries()) {
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { marker: `session-${index}` },
    });
  }
}, 20_000);

test("disconnecting an in-flight session cancels only its own command", async () => {
  const [first, second] = await Promise.all([
    fixture("cancelled", 10_000),
    fixture("survivor", 100),
  ]);
  const cancelled = first.client
    .callTool({ name: "hack.projects.list", arguments: {} })
    .then(
      () => "completed",
      () => "disconnected"
    );
  const survivor = second.client.callTool({
    name: "hack.projects.list",
    arguments: {},
  });
  const deadline = Date.now() + 5000;
  while (!(await Bun.file(join(first.project, "request-started")).exists())) {
    if (Date.now() > deadline) {
      throw new Error("Command did not start");
    }
    await Bun.sleep(10);
  }
  await first.client.close();
  expect(await cancelled).toBe("disconnected");
  expect((await survivor).structuredContent).toMatchObject({
    ok: true,
    data: { marker: "survivor" },
  });
  // Audit publication occurs after the owned child exits and output drains.
  while (!(await Bun.file(join(first.state, "mcp-audit.log")).exists())) {
    if (Date.now() > deadline) {
      throw new Error("Cancelled command did not drain");
    }
    await Bun.sleep(10);
  }
  expect((await second.client.listTools()).tools.length).toBeGreaterThan(0);
}, 10_000);
