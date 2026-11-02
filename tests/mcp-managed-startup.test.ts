import { afterEach, test as bunTest, expect } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isRecord } from "../src/lib/guards.ts";

const adapter = process.env.HACK_MCP_ADAPTER_TEST_BINARY;
const owner = process.env.HACK_MCP_OWNER_TEST_BINARY;
const backend = process.env.HACK_MCP_BACKEND_TEST_BINARY;
const test = bunTest.skipIf(!(adapter && owner && backend));
const roots: string[] = [];
const clients: Client[] = [];
const children: Bun.Subprocess[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const fakeEndpoints: { path: string; ino: number; dev: number }[] = [];

async function retired(root: string) {
  const states = await Promise.all(
    ["mcp.sock", ".mcp-owner", ".mcp-receipt.json"].map((name) =>
      lstat(join(root, name)).catch(() => null)
    )
  );
  return states.every((state) => state === null);
}

async function waitFor(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error("Managed fixture deadline exceeded");
    }
    await Bun.sleep(20);
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
  for (const endpoint of fakeEndpoints.splice(0)) {
    const current = await lstat(endpoint.path).catch(() => null);
    if (current?.ino === endpoint.ino && current?.dev === endpoint.dev) {
      await rm(endpoint.path);
    }
  }
  for (const root of roots.splice(0)) {
    // Real detached fixtures use a short idle timeout. Observe their owned
    // endpoint disappearing before removing the fixture, rather than pruning it.
    await waitFor(() => retired(root));
    await rm(root, { recursive: true, force: true });
  }
});

function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fixture() {
  if (!(adapter && owner && backend)) {
    throw new Error("Explicit compiled adapter, owner and backend required");
  }
  const root = await realpath(await mkdtemp("/tmp/hack-ms-"));
  roots.push(root);
  await chmod(root, 0o700);
  const launcher = join(root, "backend");
  await writeFile(
    launcher,
    `#!/bin/sh\nmode=\nif [ "$1" = --startup-supervised-v2 ]; then mode="--startup-supervised-v2 --"; shift; shift; fi\nprintf '%s\\n' "$$" >> "$1/pids"\nprintf '%s\\n' "$PPID" >> "$1/supervisor-pids"\nexec ${quote(backend)} $mode "$1" "$2" 500\n`,
    { mode: 0o700 }
  );
  const ownerLauncher = join(root, "owner-launcher");
  await writeFile(
    ownerLauncher,
    `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(join(root, "owner-pids"))}\nexec ${quote(owner)} "$@"\n`,
    { mode: 0o700 }
  );
  return {
    root,
    socket: join(root, "mcp.sock"),
    launcher,
    adapter,
    owner: ownerLauncher,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

bunTest.skipIf(
  !(adapter && owner && backend && process.env.HACK_MCP_CLI_TEST_BINARY)
)(
  "managed artifacts execute the pinned CLI with an isolated project registry",
  async () => {
    const executable = process.env.HACK_MCP_CLI_TEST_BINARY;
    if (!executable) {
      throw new Error("Explicit candidate CLI required");
    }
    const f = await fixture();
    const client = new Client({ name: "isolated-cli", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: f.adapter,
        args: args(f),
        cwd: f.root,
        env: {
          HOME: f.root,
          HACK_HOME: join(f.root, "state"),
          HACK_GLOBAL_CONFIG_PATH: join(f.root, "state", "config.json"),
          HACK_MCP_COMMAND: executable,
          HACK_NO_INTERACTIVE: "1",
          PATH: join(f.root, "unavailable-bin"),
          DOCKER_HOST: `unix://${f.root}/unavailable-docker.sock`,
          DOCKER_CONFIG: join(f.root, "docker-config"),
        },
        stderr: "pipe",
      })
    );
    const result = await client.callTool({
      name: "hack.projects.list",
      arguments: {},
    });
    const structured = isRecord(result.structuredContent)
      ? result.structuredContent
      : undefined;
    const data = structured?.data;
    // Report only predicates: failed isolation can contain private host metadata.
    expect(result.isError === true).toBe(false);
    expect(structured?.exitCode === 0).toBe(true);
    expect(
      typeof structured?.command === "string" &&
        structured.command.startsWith(`${executable} `)
    ).toBe(true);
    expect(
      typeof data === "object" &&
        data !== null &&
        "projects" in data &&
        Array.isArray(data.projects) &&
        data.projects.length === 0 &&
        "runtime_ok" in data &&
        data.runtime_ok === false
    ).toBe(true);
    await client.close();
    await waitFor(() => retired(f.root));
    expect(await pids(f.root)).toHaveLength(1);
  },
  15_000
);

function args(f: Fixture) {
  return [
    "--socket",
    f.socket,
    "--backend-id",
    "managed-fixture",
    "--owner",
    f.owner,
    "--backend",
    f.launcher,
  ];
}

async function connect(f: Fixture, marker = "fixture") {
  const client = new Client({ name: marker, version: "1" });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: f.adapter,
      args: args(f),
      cwd: f.root,
      env: {
        HOME: f.root,
        HACK_HOME: f.root,
        MARKER: marker,
        HACK_MCP_COMMAND: join(f.root, "command"),
      },
      stderr: "pipe",
    })
  );
  return client;
}

function raw(f: Fixture) {
  const child = Bun.spawn([f.adapter, ...args(f)], {
    cwd: f.root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function pids(root: string) {
  return (await readFile(join(root, "pids"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
}

test("32 concurrent managed clients share one detached backend and retain independent context", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "command"),
    `#!${process.execPath}\nconsole.log(JSON.stringify({marker:process.env.MARKER}));\n`,
    { mode: 0o700 }
  );
  const connected = await Promise.all(
    Array.from({ length: 32 }, (_, index) => connect(f, `client-${index}`))
  );
  expect(await pids(f.root)).toHaveLength(1);
  const supervisors = (await readFile(join(f.root, "supervisor-pids"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  expect(supervisors).toHaveLength(1);
  expect(supervisors.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(
    true
  );
  await waitFor(async () =>
    supervisors.every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    })
  );
  for (const pid of (await readFile(join(f.root, "owner-pids"), "utf8"))
    .trim()
    .split("\n")
    .map(Number)) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
  for (const [index, client] of connected.entries()) {
    const result = await client.callTool({
      name: "hack.projects.list",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      exitCode: 0,
      data: { marker: `client-${index}` },
    });
  }
  await connected[0]?.close();
  await Bun.sleep(700);
  expect((await connected[1]?.listTools())?.tools.length).toBeGreaterThan(0);
  const reused = await connect(f);
  expect((await reused.listTools()).tools.length).toBeGreaterThan(0);
  expect(await pids(f.root)).toHaveLength(1);
  await Promise.all(connected.map((client) => client.close()));
  await reused.close();
  await waitFor(() => retired(f.root));
  expect(await lstat(join(f.root, ".mcp-owner")).catch(() => null)).toBeNull();
  expect(
    await lstat(join(f.root, ".mcp-receipt.json")).catch(() => null)
  ).toBeNull();
  const lease = await lstat(join(f.root, ".mcp-lease"));
  const next = await connect(f);
  expect((await next.listTools()).tools.length).toBeGreaterThan(0);
  expect(await pids(f.root)).toHaveLength(2);
  expect((await lstat(join(f.root, ".mcp-lease"))).ino).toBe(lease.ino);
}, 15_000);

test("managed startup recovers a witnessed crashed backend without replaying its old session", async () => {
  const f = await fixture();
  const first = await connect(f);
  const [pid] = await pids(f.root);
  expect(pid).toBeGreaterThan(1);
  if (!pid) {
    throw new Error("Missing owned fixture PID");
  }
  process.kill(pid, "SIGKILL");
  await first.close();
  const next = await connect(f);
  expect((await next.listTools()).tools.length).toBeGreaterThan(0);
  expect(await pids(f.root)).toHaveLength(2);
}, 15_000);

test("wrong backend identity refuses context and never launches a replacement", async () => {
  const f = await fixture();
  let received = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("data", (bytes) => {
      received += bytes.length;
    });
    socket.write('{"hack_mcp":1,"backend_id":"foreign"}\n');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(f.socket, resolve));
  await chmod(f.socket, 0o600);
  const identity = await lstat(f.socket);
  fakeEndpoints.push({ path: f.socket, ino: identity.ino, dev: identity.dev });
  const child = raw(f);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain(
    "identity or protocol mismatch"
  );
  expect(received).toBe(0);
  expect(await lstat(join(f.root, ".mcp-lease")).catch(() => null)).toBeNull();
  expect(await lstat(join(f.root, "pids")).catch(() => null)).toBeNull();
});

test("unsafe existing endpoint is preserved without starting an owner", async () => {
  const f = await fixture();
  await writeFile(f.socket, "preserve", { mode: 0o600 });
  const child = raw(f);
  expect(await child.exited).toBe(1);
  expect(await readFile(f.socket, "utf8")).toBe("preserve");
  expect(await lstat(join(f.root, ".mcp-lease")).catch(() => null)).toBeNull();
  await rm(f.socket);
});

for (const hanging of [false, true]) {
  test(`managed startup bounds and reaps a ${hanging ? "hanging" : "failed"} launcher`, async () => {
    const f = await fixture();
    const fakeOwner = join(f.root, "owner");
    await writeFile(
      fakeOwner,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(join(f.root, "owner-pid"))}\n${hanging ? "exec /bin/sleep 30" : "exit 1"}\n`,
      { mode: 0o700 }
    );
    f.owner = fakeOwner;
    const start = Date.now();
    const child = raw(f);
    expect(await child.exited).toBe(1);
    expect(Date.now() - start).toBeLessThan(13_000);
    expect(await new Response(child.stderr).text()).toContain(
      hanging ? "startup timed out" : "backend owner failed"
    );
    const pid = Number(
      (await readFile(join(f.root, "owner-pid"), "utf8")).trim()
    );
    expect(() => process.kill(pid, 0)).toThrow();
    expect(
      await lstat(join(f.root, ".mcp-lease")).catch(() => null)
    ).toBeNull();
  }, 15_000);
}

test("managed startup retries a retiring owner's lease until it is released", async () => {
  const f = await fixture();
  const holder = Bun.spawn(
    [
      f.owner,
      "--directory",
      f.root,
      "--",
      "/bin/sh",
      "-c",
      "printf ready; exec /bin/sleep 0.5",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  children.push(holder);
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready");
  reader.releaseLock();
  const client = await connect(f);
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  expect(await holder.exited).toBe(0);
  expect(await pids(f.root)).toHaveLength(1);
  expect(
    (await readFile(join(f.root, "owner-pids"), "utf8")).trim().split("\n")
      .length
  ).toBeGreaterThan(2);
}, 15_000);

test("failed detached exec times out and releases its stable lease for a later start", async () => {
  const f = await fixture();
  const executable = f.launcher;
  f.launcher = join(f.root, "missing-backend");
  const failed = raw(f);
  expect(await failed.exited).toBe(1);
  expect(await new Response(failed.stderr).text()).toContain(
    "startup timed out"
  );
  expect(await lstat(f.socket).catch(() => null)).toBeNull();
  const lease = await lstat(join(f.root, ".mcp-lease"));
  f.launcher = executable;
  const client = await connect(f);
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  const nextLease = await lstat(join(f.root, ".mcp-lease"));
  expect({
    dev: nextLease.dev,
    ino: nextLease.ino,
    size: nextLease.size,
  }).toEqual({ dev: lease.dev, ino: lease.ino, size: 0 });
}, 15_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} during startup reaps only the direct launcher`, async () => {
    const f = await fixture();
    const fakeOwner = join(f.root, "cancel-owner");
    const pidPath = join(f.root, "cancel-owner-pid");
    await writeFile(
      fakeOwner,
      `#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(pidPath)}\nexec /bin/sleep 30\n`,
      { mode: 0o700 }
    );
    f.owner = fakeOwner;
    const child = raw(f);
    await waitFor(async () =>
      /^\d+\n$/.test(await readFile(pidPath, "utf8").catch(() => ""))
    );
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error("Invalid owned fixture PID");
    }
    try {
      const started = Date.now();
      child.kill(signal);
      expect(await child.exited).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(
        await lstat(join(f.root, ".mcp-lease")).catch(() => null)
      ).toBeNull();
    } finally {
      // Also clean a failed negative control's known fixture child.
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
}

test("startup restores normal signals before relay and preserves another live client", async () => {
  const f = await fixture();
  const first = new Client({ name: "signal-fixture", version: "1" });
  clients.push(first);
  const transport = new StdioClientTransport({
    command: f.adapter,
    args: args(f),
    cwd: f.root,
    env: { HOME: f.root, HACK_HOME: f.root },
    stderr: "pipe",
  });
  await first.connect(transport);
  const second = await connect(f);
  const pid = transport.pid;
  if (!pid) {
    throw new Error("Missing owned adapter PID");
  }
  process.kill(pid, "SIGTERM");
  await waitFor(async () => transport.pid === null, 2000);
  expect((await second.listTools()).tools.length).toBeGreaterThan(0);
  expect(await pids(f.root)).toHaveLength(1);
});
