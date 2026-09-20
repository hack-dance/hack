import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { startMcpSocketBackend } from "../src/mcp/socket-backend.ts";

type Peer = {
  readonly socket: Socket;
  readonly send: (value: unknown) => void;
  readonly next: () => Promise<unknown>;
  readonly closed: () => Promise<void>;
};

const roots: string[] = [];
const backends: Awaited<ReturnType<typeof startMcpSocketBackend>>[] = [];
const peers: Peer[] = [];

afterEach(async () => {
  for (const connection of peers.splice(0)) {
    connection.socket.destroy();
  }
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function peer(socketPath: string): Peer {
  const socket = createConnection(socketPath);
  const messages: unknown[] = [];
  let buffer = "";
  let ended = false;
  socket.on("error", () => {});
  socket.once("end", () => socket.destroy());
  socket.on("close", () => {
    ended = true;
  });
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const result = {
    socket,
    send(value: unknown) {
      socket.write(`${JSON.stringify(value)}\n`);
    },
    async next(): Promise<unknown> {
      const deadline = Date.now() + 3000;
      while (!(messages.length || ended) && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      if (!messages.length) {
        throw new Error("No MCP frame received");
      }
      return messages.shift();
    },
    async closed() {
      const deadline = Date.now() + 3000;
      while (!ended && Date.now() < deadline) {
        await Bun.sleep(5);
      }
      expect(ended).toBe(true);
    },
  };
  peers.push(result);
  return result;
}

async function directory() {
  const root = await mkdtemp("/tmp/hack-ms-");
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function fixture(maxActiveCommands?: number) {
  const root = await directory();
  const backend = await startMcpSocketBackend({
    directory: root,
    backendId: "fixture-v1",
    maxActiveCommands,
  });
  backends.push(backend);
  return { root, backend };
}

async function session(
  socketPath: string,
  root: string,
  env: Record<string, string> = {}
) {
  const client = peer(socketPath);
  expect(await client.next()).toEqual({
    hack_mcp: 1,
    backend_id: "fixture-v1",
  });
  client.send({
    hack_mcp: 1,
    cwd: root,
    env: { HOME: root, HACK_HOME: root, ...env },
  });
  expect(await client.next()).toEqual({ hack_mcp: 1, ready: true });
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "socket-fixture", version: "1" },
    },
  });
  expect(await client.next()).toEqual(
    expect.objectContaining({
      id: 1,
      result: expect.objectContaining({ capabilities: expect.any(Object) }),
    })
  );
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return client;
}

async function listTools(client: Peer, id = 2) {
  client.send({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
  const response = await client.next();
  expect(response).toEqual(
    expect.objectContaining({
      id,
      result: expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "hack.project.status" }),
        ]),
      }),
    })
  );
  return response;
}

test("32 socket sessions initialize independently and survive another session disconnect", async () => {
  const { root, backend } = await fixture();
  expect((await lstat(backend.socketPath)).mode & 0o777).toBe(0o600);
  const clients = await Promise.all(
    Array.from({ length: 32 }, () => session(backend.socketPath, root))
  );
  const responses = await Promise.all(
    clients.map((client) => listTools(client))
  );
  for (const response of responses) {
    expect(response).toEqual(responses[0]);
  }
  clients[0]?.socket.end();
  await clients[0]?.closed();
  await listTools(clients[1]!, 3);
  await backend.close();
  await Promise.all(clients.map((client) => client.closed()));
  await backend.close();
  const restarted = await startMcpSocketBackend({
    directory: root,
    backendId: "fixture-v1",
  });
  backends.push(restarted);
  await listTools(await session(restarted.socketPath, root));
});

test("malformed and oversized sessions close without disrupting a healthy session", async () => {
  const { root, backend } = await fixture();
  const healthy = await session(backend.socketPath, root);
  const badFrames = [
    Buffer.from('{"hack_mcp":1,"cwd":"relative","env":{}}\n'),
    Buffer.from('{"hack_mcp":1,"cwd":"/tmp","env":{"X":3}}\n'),
    Buffer.from([0xff, 10]),
    Buffer.alloc(256 * 1024 + 1, 65),
  ];
  for (const bytes of badFrames) {
    const bad = peer(backend.socketPath);
    await bad.next();
    bad.socket.write(bytes);
    await bad.closed();
    await listTools(healthy);
  }
  const badRequest = await session(backend.socketPath, root);
  badRequest.socket.write(Buffer.alloc(1024 * 1024 + 1, 65));
  await badRequest.closed();
  await listTools(healthy);
});

test("fragmented context and batched MCP frames retain framing", async () => {
  const { root, backend } = await fixture();
  const client = peer(backend.socketPath);
  await client.next();
  const frame = JSON.stringify({ hack_mcp: 1, cwd: root, env: {} });
  for (const character of frame) {
    client.socket.write(character);
  }
  client.socket.write("\n");
  expect(await client.next()).toEqual({ hack_mcp: 1, ready: true });
  client.socket.write(
    '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
  );
  expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
});

test("backend refuses public or symlinked directories and preserves an existing endpoint", async () => {
  const { root, backend } = await fixture();
  await expect(
    startMcpSocketBackend({ directory: root, backendId: "duplicate" })
  ).rejects.toThrow();
  await listTools(await session(backend.socketPath, root));
  const unsafe = await directory();
  await chmod(unsafe, 0o755);
  await expect(
    startMcpSocketBackend({ directory: unsafe, backendId: "public" })
  ).rejects.toThrow("private");
  const holder = await directory();
  const link = join(holder, "link");
  await symlink(root, link);
  await expect(
    startMcpSocketBackend({ directory: link, backendId: "symlink" })
  ).rejects.toThrow("private");
  const existing = join(holder, "mcp.sock");
  await writeFile(existing, "must survive");
  await expect(
    startMcpSocketBackend({ directory: holder, backendId: "file" })
  ).rejects.toThrow();
  expect(await Bun.file(existing).text()).toBe("must survive");
});

test("socket commands share admission and cancellation releases only the disconnected client", async () => {
  const { root, backend } = await fixture(1);
  const firstRoot = await directory();
  const secondRoot = await directory();
  const command = join(root, "command");
  await writeFile(
    command,
    `#!${process.execPath}\nawait Bun.write("started", String(process.pid));\nawait Bun.sleep(Number(process.env.DELAY));\nconsole.log(JSON.stringify({marker:process.env.MARKER,cwd:process.cwd()}));\n`
  );
  await chmod(command, 0o700);
  const first = await session(backend.socketPath, firstRoot, {
    HACK_MCP_COMMAND: command,
    MARKER: "first",
    DELAY: "10000",
  });
  const second = await session(backend.socketPath, secondRoot, {
    HACK_MCP_COMMAND: command,
    MARKER: "second",
    DELAY: "1",
  });
  const request = {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "hack.projects.list", arguments: {} },
  };
  first.send(request);
  await waitForFile(join(firstRoot, "started"));
  second.send(request);
  const busy = await second.next();
  expect(busy).toEqual(
    expect.objectContaining({
      id: 4,
      result: expect.objectContaining({ isError: true }),
    })
  );
  expect(JSON.stringify(busy)).toContain("busy");
  expect(await Bun.file(join(secondRoot, "started")).exists()).toBe(false);
  first.socket.end();
  await first.closed();
  await waitForFile(join(firstRoot, "mcp-audit.log"));
  // File creation precedes append completion and the admission release. Observe
  // the actual protocol boundary instead of treating existence as completion.
  const deadline = Date.now() + 3000;
  let id = 5;
  let success: unknown;
  for (;;) {
    second.send({ ...request, id });
    success = await second.next();
    if (
      !(isRecord(success) && isRecord(success.result)) ||
      success.result.isError !== true
    ) {
      break;
    }
    expect(success.id).toBe(id);
    expect(JSON.stringify(success)).toContain(
      "MCP backend is busy; retry after an active command finishes"
    );
    expect(await Bun.file(join(secondRoot, "started")).exists()).toBe(false);
    if (Date.now() >= deadline) {
      throw new Error("Disconnected command did not release admission");
    }
    id++;
    await Bun.sleep(10);
  }
  expect(success).toEqual(
    expect.objectContaining({
      id,
      result: expect.objectContaining({
        structuredContent: expect.objectContaining({
          exitCode: 0,
          data: expect.objectContaining({ marker: "second" }),
        }),
      }),
    })
  );
  await backend.close();
  const pid = Number(await Bun.file(join(firstRoot, "started")).text());
  expect(() => process.kill(pid, 0)).toThrow();
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await Bun.file(path).exists()) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(path).exists()).toBe(true);
}

async function idleBackend(idleTimeoutMs: number) {
  const root = await directory();
  const backend = await startMcpSocketBackend({
    directory: root,
    backendId: "fixture-v1",
    idleTimeoutMs,
  });
  backends.push(backend);
  return { root, backend };
}

test("idle retirement removes owned state and permits a fresh backend", async () => {
  const { root, backend } = await idleBackend(40);
  await backend.closed;
  expect(await lstat(backend.socketPath).catch(() => null)).toBeNull();
  expect(await lstat(join(root, ".mcp-owner")).catch(() => null)).toBeNull();
  const next = await startMcpSocketBackend({
    directory: root,
    backendId: "next",
  });
  backends.push(next);
  const connection = peer(next.socketPath);
  expect(await connection.next()).toEqual({ hack_mcp: 1, backend_id: "next" });
});

test("quiet connected clients hold the backend and last disconnect resets idle time", async () => {
  const { backend } = await idleBackend(180);
  let retired = false;
  void backend.closed.then(() => {
    retired = true;
  });
  const first = peer(backend.socketPath);
  await first.next();
  first.send({ hack_mcp: 1, cwd: "/tmp", env: {} });
  await first.next();
  await Bun.sleep(240);
  expect(retired).toBe(false);
  first.socket.destroy();
  await first.closed();
  await Bun.sleep(60);
  const second = peer(backend.socketPath);
  await second.next();
  second.send({ hack_mcp: 1, cwd: "/tmp", env: {} });
  await second.next();
  await Bun.sleep(240);
  expect(retired).toBe(false);
  second.socket.destroy();
  await second.closed();
  await Bun.sleep(60);
  expect(retired).toBe(false);
  await backend.closed;
  expect(retired).toBe(true);
});

test("zero idle timeout preserves explicit lifetime and invalid values create no claim", async () => {
  const { root, backend } = await idleBackend(0);
  let retired = false;
  void backend.closed.then(() => {
    retired = true;
  });
  await Bun.sleep(80);
  expect(retired).toBe(false);
  await backend.close();
  await backend.closed;
  for (const idleTimeoutMs of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ]) {
    await expect(
      startMcpSocketBackend({
        directory: root,
        backendId: "invalid",
        idleTimeoutMs,
      })
    ).rejects.toThrow("MCP idle timeout");
    expect(await lstat(join(root, ".mcp-owner")).catch(() => null)).toBeNull();
  }
});

test("standalone backend exits after idle retirement", async () => {
  const root = await directory();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/run-mcp-socket-backend.ts"),
      root,
      "idle-process",
      "80",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  try {
    const deadline = Date.now() + 5000;
    while (child.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(child.exitCode).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(JSON.parse(await new Response(child.stdout).text()).backendId).toBe(
      "idle-process"
    );
    expect(await lstat(join(root, "mcp.sock")).catch(() => null)).toBeNull();
    expect(await lstat(join(root, ".mcp-owner")).catch(() => null)).toBeNull();
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
}, 10_000);

test("idle cleanup preserves replacement endpoint and claim identities", async () => {
  const { root, backend } = await idleBackend(300);
  const claim = join(root, ".mcp-owner");
  await rename(backend.socketPath, join(root, "original.sock"));
  await writeFile(backend.socketPath, "foreign endpoint");
  await rename(claim, join(root, "original-claim"));
  await mkdir(claim, { mode: 0o700 });
  await writeFile(join(claim, "foreign"), "preserve");
  await backend.closed;
  expect(await readFile(backend.socketPath, "utf8")).toBe("foreign endpoint");
  expect(await readFile(join(claim, "foreign"), "utf8")).toBe("preserve");
});

test("idle completion waits for disconnected command cleanup", async () => {
  const { root, backend } = await idleBackend(100);
  const command = join(root, "command");
  await writeFile(
    command,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nawait Bun.write("started", String(process.pid));\nsetInterval(() => {}, 1000);\n`
  );
  await chmod(command, 0o700);
  const connection = await session(backend.socketPath, root, {
    HACK_MCP_COMMAND: command,
  });
  connection.send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "hack.projects.list", arguments: {} },
  });
  await waitForFile(join(root, "started"));
  const pid = Number(await Bun.file(join(root, "started")).text());
  let retired = false;
  void backend.closed.then(() => {
    retired = true;
  });
  connection.socket.destroy();
  await connection.closed();
  await Bun.sleep(200);
  expect(retired).toBe(false);
  expect(() => process.kill(pid, 0)).not.toThrow();
  await backend.closed;
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await Bun.file(join(root, "mcp-audit.log")).exists()).toBe(true);
  expect(await lstat(backend.socketPath).catch(() => null)).toBeNull();
}, 8000);

test("connection admission rejects overflow and reuses disconnected capacity", async () => {
  const root = await directory();
  const backend = await startMcpSocketBackend({
    directory: root,
    backendId: "capacity",
    maxConnections: 1,
  });
  backends.push(backend);
  const first = peer(backend.socketPath);
  expect(await first.next()).toEqual({ hack_mcp: 1, backend_id: "capacity" });
  const overflow = peer(backend.socketPath);
  await overflow.closed();
  first.socket.end();
  await first.closed();
  const replacement = peer(backend.socketPath);
  expect(await replacement.next()).toEqual({
    hack_mcp: 1,
    backend_id: "capacity",
  });
  for (const maxConnections of [
    0,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    await expect(
      startMcpSocketBackend({
        directory: root,
        backendId: "invalid",
        maxConnections,
      })
    ).rejects.toThrow("connection limit");
  }
});
