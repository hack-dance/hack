import { afterEach, test as bunTest, expect } from "bun:test";
import { constants } from "node:fs";
import {
  chmod,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMcpSocketBackend } from "../src/mcp/socket-backend.ts";

const binary = process.env.HACK_MCP_ADAPTER_TEST_BINARY;
const test = bunTest.skipIf(!binary);
const roots: string[] = [];
const clients: Client[] = [];
const children: Bun.Subprocess[] = [];
const sockets: Socket[] = [];
const servers: Server[] = [];
const backends: Awaited<ReturnType<typeof startMcpSocketBackend>>[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  }
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function directory() {
  const root = await mkdtemp("/tmp/hack-ma-");
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function fakeBackend(greeting: string) {
  const root = await directory();
  const socketPath = join(root, "mcp.sock");
  let received = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      received += chunk.length;
    });
    socket.write(greeting);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return { root, socketPath, received: () => received };
}

function spawn(socketPath: string, root: string) {
  if (!binary) {
    throw new Error("Native adapter binary must be explicitly provided");
  }
  const child = Bun.spawn(
    [binary, "--socket", socketPath, "--backend-id", "expected"],
    {
      cwd: root,
      env: { HOME: root, SYNTHETIC_SECRET: "must-not-transfer-on-mismatch" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  children.push(child);
  return child;
}

test("native adapter preserves distinct cwd/env with real SDK clients", async () => {
  if (!binary) {
    throw new Error("Missing adapter binary");
  }
  const root = await directory();
  const backend = await startMcpSocketBackend({
    directory: root,
    backendId: "expected",
  });
  backends.push(backend);
  const command = join(root, "command");
  await writeFile(
    command,
    `#!${process.execPath}\nconsole.log(JSON.stringify({marker:process.env.MARKER,cwd:process.cwd()}));\n`
  );
  await chmod(command, 0o700);
  const cases = await Promise.all(
    ["first", "second"].map(async (marker) => {
      const cwd = await directory();
      const client = new Client({ name: "native-fixture", version: "1" });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: binary,
          args: ["--socket", backend.socketPath, "--backend-id", "expected"],
          cwd,
          env: {
            HOME: cwd,
            HACK_HOME: cwd,
            HACK_MCP_COMMAND: command,
            MARKER: marker,
          },
          stderr: "pipe",
        })
      );
      return { client, cwd, marker };
    })
  );
  for (const item of cases) {
    const result = await item.client.callTool({
      name: "hack.projects.list",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      exitCode: 0,
      data: { marker: item.marker, cwd: await realpath(item.cwd) },
    });
  }
  await cases[0]?.client.close();
  expect((await cases[1]?.client.listTools())?.tools.length).toBeGreaterThan(0);
});

for (const greeting of [
  '{"hack_mcp":1,"backend_id":"wrong"}\n',
  '{"hack_mcp":2,"backend_id":"expected"}\n',
  '{"private":"must-not-echo"}\n',
  `${"x".repeat(4097)}\n`,
]) {
  test(`adapter rejects bad handshake before sending context (${greeting.length} bytes)`, async () => {
    const backend = await fakeBackend(greeting);
    const child = spawn(backend.socketPath, backend.root);
    const exit = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exit).toBe(1);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(backend.received()).toBe(0);
    expect(stderr).not.toContain("must-not-echo");
    expect(stderr).not.toContain("must-not-transfer-on-mismatch");
  });
}

test("adapter rejects public socket directory without connecting", async () => {
  const backend = await fakeBackend('{"hack_mcp":1,"backend_id":"expected"}\n');
  await chmod(backend.root, 0o755);
  const child = spawn(backend.socketPath, backend.root);
  expect(await child.exited).toBe(1);
  expect(sockets).toHaveLength(0);
  expect(backend.received()).toBe(0);
});

test("backend closure exits adapter while stdin remains open", async () => {
  const root = await directory();
  const backend = await startMcpSocketBackend({
    directory: root,
    backendId: "expected",
  });
  backends.push(backend);
  const child = spawn(backend.socketPath, root);
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await child.stdin.flush();
  const reader = child.stdout.getReader();
  const response = await reader.read();
  expect(new TextDecoder().decode(response.value)).toContain('"id":1');
  await backend.close();
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("not replayed");
  reader.releaseLock();
});

test("stdin EOF cleanly disconnects adapter", async () => {
  const root = await directory();
  const backend = await startMcpSocketBackend({
    directory: root,
    backendId: "expected",
  });
  backends.push(backend);
  const child = spawn(backend.socketPath, root);
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await child.stdin.flush();
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    '"id":1'
  );
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  reader.releaseLock();
});

test("stdin read failure exits unsuccessfully", async () => {
  if (!binary) {
    throw new Error("Missing adapter binary");
  }
  const root = await directory();
  const backend = await startMcpSocketBackend({
    directory: root,
    backendId: "expected",
  });
  backends.push(backend);
  const input = await open(root, "r");
  try {
    const child = Bun.spawn(
      [binary, "--socket", backend.socketPath, "--backend-id", "expected"],
      {
        cwd: root,
        env: { HOME: root },
        stdin: input.fd,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    children.push(child);
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(
      "stdin relay failed"
    );
  } finally {
    await input.close();
  }
});

for (const mode of ["disconnect", "stall", "kill"] as const) {
  test(`stalled stdout is bounded and preserves caller flags (${mode})`, async () => {
    const root = await directory();
    const socketPath = join(root, "mcp.sock");
    let flooded = false;
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.write('{"hack_mcp":1,"backend_id":"expected"}\n');
      socket.once("data", () => {
        socket.write('{"hack_mcp":1,"ready":true}\n');
        socket.write(Buffer.alloc(8 * 1024 * 1024, 65));
        flooded = true;
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    if (!binary) {
      throw new Error("Missing adapter binary");
    }
    const fifo = join(root, "output.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const output = await open(fifo, constants.O_RDWR);
    const child = Bun.spawn(
      [binary, "--socket", socketPath, "--backend-id", "expected"],
      {
        cwd: root,
        env: { HOME: root },
        stdin: "pipe",
        stdout: output.fd,
        stderr: "pipe",
      }
    );
    children.push(child);
    try {
      const readyDeadline = Date.now() + 3000;
      while (!flooded && Date.now() < readyDeadline) {
        await Bun.sleep(10);
      }
      expect(flooded).toBe(true);
      await Bun.sleep(100);
      expect(nonblockingFlag(output.fd)).toBe(false);
      if (mode === "kill") {
        child.kill("SIGKILL");
        await child.exited;
        expect(nonblockingFlag(output.fd)).toBe(false);
        return;
      }
      if (mode === "disconnect") {
        for (const socket of sockets) {
          socket.destroy();
        }
      }
      const deadline = Date.now() + 6500;
      while (child.exitCode === null && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(child.exitCode).toBe(1);
      expect(nonblockingFlag(output.fd)).toBe(false);
    } finally {
      await output.close();
    }
  }, 10_000);
}

test("backend that stops reading cannot retain a blocked stdin relay", async () => {
  if (!binary) {
    throw new Error("Missing adapter binary");
  }
  const root = await directory();
  const socketPath = join(root, "mcp.sock");
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.write('{"hack_mcp":1,"backend_id":"expected"}\n');
    socket.once("data", () => {
      socket.pause();
      socket.write('{"hack_mcp":1,"ready":true}\n');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  const inputPath = join(root, "input");
  await writeFile(inputPath, Buffer.alloc(16 * 1024 * 1024, 65));
  const input = await open(inputPath, "r");
  try {
    const child = Bun.spawn(
      [binary, "--socket", socketPath, "--backend-id", "expected"],
      {
        cwd: root,
        env: { HOME: root },
        stdin: input.fd,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    children.push(child);
    const deadline = Date.now() + 7000;
    while (child.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(child.exitCode).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(
      "stdin relay failed"
    );
  } finally {
    await input.close();
  }
}, 10_000);

test("temporarily paused stdout resumes without losing bytes", async () => {
  if (!binary) {
    throw new Error("Missing adapter binary");
  }
  const root = await directory();
  const socketPath = join(root, "mcp.sock");
  const payload = Buffer.from(
    Array.from({ length: 512 * 1024 }, (_, index) => index % 251)
  );
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.write('{"hack_mcp":1,"backend_id":"expected"}\n');
    socket.once("data", () => {
      socket.write('{"hack_mcp":1,"ready":true}\n');
      socket.write(payload);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  const fifo = join(root, "output.fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const output = await open(fifo, constants.O_RDWR);
  try {
    const child = Bun.spawn(
      [binary, "--socket", socketPath, "--backend-id", "expected"],
      {
        cwd: root,
        env: { HOME: root },
        stdin: "pipe",
        stdout: output.fd,
        stderr: "pipe",
      }
    );
    children.push(child);
    await Bun.sleep(100);
    const consumer = Bun.spawn(["head", "-c", String(payload.length), fifo], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(consumer);
    const received = Buffer.from(
      await new Response(consumer.stdout).arrayBuffer()
    );
    expect(await consumer.exited).toBe(0);
    expect(received.equals(payload)).toBe(true);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  } finally {
    await output.close();
  }
}, 10_000);

function nonblockingFlag(fd: number): boolean {
  const observed = Bun.spawnSync(
    [
      "python3",
      "-c",
      "import fcntl,os; print(int(bool(fcntl.fcntl(0,fcntl.F_GETFL)&os.O_NONBLOCK)))",
    ],
    { stdin: fd, stdout: "pipe", stderr: "pipe" }
  );
  expect(observed.exitCode).toBe(0);
  return observed.stdout.toString().trim() === "1";
}

test("full backend accept queue cannot hang an adapter", async () => {
  const root = await directory();
  const socketPath = join(root, "mcp.sock");
  const fixture = Bun.spawn(
    [
      "python3",
      "-u",
      "-c",
      `
import socket, os, sys, errno
listener = socket.socket(socket.AF_UNIX)
listener.bind(sys.argv[1])
os.chmod(sys.argv[1], 0o600)
listener.listen(1)
held = []
for _ in range(128):
    client = socket.socket(socket.AF_UNIX)
    client.setblocking(False)
    result = client.connect_ex(sys.argv[1])
    held.append(client)
    if result != 0:
        assert result in (errno.EAGAIN, errno.EINPROGRESS, errno.ECONNREFUSED), result
        break
else:
    raise RuntimeError("failed to saturate accept queue")
print("ready", flush=True)
sys.stdin.buffer.read()
`,
      socketPath,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  children.push(fixture);
  const reader = fixture.stdout.getReader();
  let ready = "";
  while (!ready.includes("\n") && ready.length < 64) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    ready += new TextDecoder().decode(chunk.value);
  }
  expect(ready).toBe("ready\n");
  reader.releaseLock();
  const child = spawn(socketPath, root);
  const deadline = Date.now() + 6500;
  while (child.exitCode === null && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(child.exitCode).toBe(1);
  expect(await new Response(child.stdout).text()).toBe("");
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toContain(
    process.platform === "linux"
      ? "backend connection timed out"
      : "backend connection failed"
  );
  expect(stderr).not.toContain("must-not-transfer-on-mismatch");
}, 10_000);
