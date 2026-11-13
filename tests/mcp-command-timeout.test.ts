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
import { replaceCodexLaunch } from "../src/mcp/codex-launch.ts";
import { installMcpConfig } from "../src/mcp/install.ts";
import { createMcpServer } from "../src/mcp/server.ts";

// ---------------------------------------------------------------------------
// HACK-2083: a foreground tool call that runs past its timeoutMs. The hack
// binary is a stub that sleeps, so no project, Docker or engine is involved.
// ---------------------------------------------------------------------------

const roots: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function startServer(stubBody: string): Promise<Client> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-mcp-tmo-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".hack"), { recursive: true });
  await writeFile(join(repo, ".hack", "docker-compose.yml"), "services: {}\n");
  await writeFile(
    join(repo, ".hack", "hack.config.json"),
    JSON.stringify({ name: "demo" })
  );
  const stub = join(root, "hack-stub");
  await writeFile(stub, `#!/bin/sh\n${stubBody}\n`);
  await chmod(stub, 0o755);
  const server = createMcpServer({
    cwd: repo,
    env: {
      ...process.env,
      HOME: root,
      HACK_HOME: join(root, "state"),
      HACK_GLOBAL_CONFIG_PATH: join(root, "config.json"),
      HACK_MCP_COMMAND: stub,
    },
  });
  const client = new Client({ name: "hack-mcp-timeout", version: "1" });
  clients.push(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("a foreground command stopped by its timeoutMs says so, not just exit 143", async () => {
  const client = await startServer("echo start; sleep 30; echo done");
  const started = performance.now();
  const result = await client.callTool({
    name: "hack.project.exec",
    arguments: { service: "api", cmd: ["true"], timeoutMs: 1000 },
  });
  expect(performance.now() - started).toBeLessThan(10_000);
  const payload = result.structuredContent as Record<string, unknown>;
  expect(result.isError).toBe(true);
  expect(payload.timedOut).toBe(true);
  expect(payload.stdout).toBe("start\n");
  expect(String(payload.stderr)).toContain(
    "Stopped by the MCP server after timeoutMs (1000 ms)."
  );
  expect(String(payload.stderr)).toContain("hack.project.command.start");
});

for (const [name, body] of [
  // The child handles SIGTERM by exiting 0.
  [
    "a child that exits 0 on SIGTERM",
    "trap 'exit 0' TERM; echo start; sleep 30 & wait",
  ],
  // The leader exits 0 at once; a descendant keeps the output open.
  [
    "a leader that exits 0 before a descendant holding the output",
    "echo start; sleep 30 & exit 0",
  ],
] as const) {
  test(`a timeout is an error even for ${name}`, async () => {
    const client = await startServer(body);
    const result = await client.callTool({
      name: "hack.project.exec",
      arguments: { service: "api", cmd: ["true"], timeoutMs: 1000 },
    });
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.timedOut).toBe(true);
    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.exitCode).not.toBe(0);
  });
}

test("a command that ends on its own carries no timedOut field", async () => {
  const client = await startServer("echo fine");
  const result = await client.callTool({
    name: "hack.project.exec",
    arguments: { service: "api", cmd: ["true"], timeoutMs: 5000 },
  });
  const payload = result.structuredContent as Record<string, unknown>;
  expect(result.isError).not.toBe(true);
  expect(Object.hasOwn(payload, "timedOut")).toBe(false);
});

test("Codex setup gives Hack's tools a call limit above Hack's own, keeping one the user set", () => {
  const launch = {
    command: "hack",
    args: ["mcp", "serve"],
    env: {},
  } as const;
  const fresh = Bun.TOML.parse(replaceCodexLaunch({ text: "", launch })) as {
    mcp_servers: { hack: Record<string, unknown> };
  };
  expect(fresh.mcp_servers.hack.tool_timeout_sec).toBe(660);
  const custom = Bun.TOML.parse(
    replaceCodexLaunch({
      text: '[mcp_servers.hack]\ncommand = "hack"\nargs = ["mcp", "serve"]\ntool_timeout_sec = 900\n',
      launch,
    })
  ) as { mcp_servers: { hack: Record<string, unknown> } };
  expect(custom.mcp_servers.hack.tool_timeout_sec).toBe(900);
});

test("reinstalling Codex adds the limit to an entry written without one and keeps everything else", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hack-mcp-tmo-")));
  roots.push(home);
  const path = join(home, ".codex", "config.toml");
  await mkdir(join(home, ".codex"));
  const before = [
    'model = "m"',
    "",
    "[mcp_servers.other]",
    'command = "other"',
    "",
    "[mcp_servers.hack]",
    'command = "hack"',
    'args = ["mcp", "serve"]',
    "",
    "[mcp_servers.hack.env]",
    'HACK_X = "1"',
    "",
  ].join("\n");
  await writeFile(path, before);
  const install = () =>
    installMcpConfig({ targets: ["codex"], scope: "user", home });
  expect((await install())[0]?.status).toBe("updated");
  const parsed = Bun.TOML.parse(await readFile(path, "utf8"));
  expect(parsed).toEqual({
    ...(Bun.TOML.parse(before) as Record<string, unknown>),
    mcp_servers: {
      other: { command: "other" },
      hack: {
        command: "hack",
        args: ["mcp", "serve"],
        env: { HACK_X: "1" },
        tool_timeout_sec: 660,
      },
    },
  });
  expect((await install())[0]?.status).toBe("noop");

  const custom =
    '[mcp_servers.hack]\ncommand = "hack"\nargs = ["mcp", "serve"]\ntool_timeout_sec = 30\n';
  await writeFile(path, custom);
  expect((await install())[0]?.status).toBe("noop");
  expect(await readFile(path, "utf8")).toBe(custom);
});
