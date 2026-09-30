import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  listenPublishedUnixSocket,
  UnixSocketEndpointExists,
  type UnixSocketIdentity,
} from "../src/lib/unix-socket-publish.ts";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "hk-usp-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}

function echoServer(clients?: Set<Socket>): Server {
  const server = createServer((socket) => {
    clients?.add(socket);
    socket.on("close", () => clients?.delete(socket));
    socket.on("error", () => undefined);
    socket.end("ok");
  });
  servers.push(server);
  return server;
}

async function reply(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect(path);
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
    });
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** The caller's cleanup: remove the endpoint only while it is still this socket. */
async function removeOwned(path: string, identity: UnixSocketIdentity) {
  const current = await lstat(path).catch(() => null);
  if (current?.dev === identity.dev && current.ino === identity.ino) {
    await unlink(path);
  }
}

test("a published endpoint serves clients, survives close and is removed only by identity", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "mcp.sock");
  const server = echoServer();
  const bound: string[] = [];
  const listen = server.listen.bind(server) as (...args: unknown[]) => Server;
  server.listen = ((...args: unknown[]) => {
    bound.push(String(args[0]));
    return listen(...args);
  }) as typeof server.listen;
  const identity = await listenPublishedUnixSocket(server, path);
  // The runtime binds a staging name in the same directory, never longer than the
  // endpoint's own name; only the published endpoint remains.
  expect(bound).toHaveLength(1);
  const staging = bound[0] ?? "";
  expect(dirname(staging)).toBe(directory);
  expect(basename(staging)).not.toBe("mcp.sock");
  expect(basename(staging).length).toBeLessThanOrEqual("mcp.sock".length);
  expect(await readdir(directory)).toEqual(["mcp.sock"]);
  const stat = await lstat(path);
  expect(stat.isSocket()).toBe(true);
  expect(stat.mode & 0o777 & 0o077).toBe(0);
  expect({ dev: stat.dev, ino: stat.ino }).toEqual(identity);
  expect(await reply(path)).toBe("ok");
  await close(server);
  // Closing never removes the endpoint; the owner's identity-checked cleanup does.
  const after = await lstat(path);
  expect({ dev: after.dev, ino: after.ino }).toEqual(identity);
  await removeOwned(path, identity);
  expect(await readdir(directory)).toEqual([]);
});

test("a replacement at the endpoint survives normal and forced close", async () => {
  for (const forced of [false, true]) {
    const directory = await privateDirectory();
    const path = join(directory, "owner.sock");
    const clients = new Set<Socket>();
    const server = echoServer(clients);
    const identity = await listenPublishedUnixSocket(server, path);
    const held = connect(path);
    held.on("error", () => undefined);
    await new Promise<void>((resolve) => held.once("connect", () => resolve()));
    await unlink(path);
    await writeFile(path, "foreign replacement", { mode: 0o600 });
    if (forced) {
      for (const client of clients) {
        client.destroy();
      }
    }
    held.destroy();
    await close(server);
    expect(await readFile(path, "utf8")).toBe("foreign replacement");
    await removeOwned(path, identity);
    expect(await readFile(path, "utf8")).toBe("foreign replacement");
    expect(await readdir(directory)).toEqual(["owner.sock"]);
  }
});

test("an existing endpoint refuses startup and is never replaced", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "control.sock");
  await writeFile(path, "existing endpoint", { mode: 0o600 });
  const server = echoServer();
  await expect(listenPublishedUnixSocket(server, path)).rejects.toBeInstanceOf(
    UnixSocketEndpointExists
  );
  expect(server.listening).toBe(false);
  expect(await readFile(path, "utf8")).toBe("existing endpoint");
  expect(await readdir(directory)).toEqual(["control.sock"]);
});

test("concurrent owners publish exactly one endpoint and the other leaves it intact", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "mcp.sock");
  const first = echoServer();
  const second = echoServer();
  const results = await Promise.allSettled([
    listenPublishedUnixSocket(first, path),
    listenPublishedUnixSocket(second, path),
  ]);
  const won = results.filter((result) => result.status === "fulfilled");
  const lost = results.filter((result) => result.status === "rejected");
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
    UnixSocketEndpointExists
  );
  expect([first.listening, second.listening].filter(Boolean)).toHaveLength(1);
  const identity = (won[0] as PromiseFulfilledResult<UnixSocketIdentity>).value;
  const stat = await lstat(path);
  expect({ dev: stat.dev, ino: stat.ino }).toEqual(identity);
  expect(await reply(path)).toBe("ok");
  expect(await readdir(directory)).toEqual(["mcp.sock"]);
});

test("a restart after owned cleanup publishes a fresh endpoint at the same path", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "mcp.sock");
  const first = echoServer();
  const initial = await listenPublishedUnixSocket(first, path);
  await close(first);
  await removeOwned(path, initial);
  const second = echoServer();
  const restarted = await listenPublishedUnixSocket(second, path);
  expect(restarted).not.toEqual(initial);
  expect(await reply(path)).toBe("ok");
  expect(await readdir(directory)).toEqual(["mcp.sock"]);
});

test("a startup that cannot bind creates nothing", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "absent", "mcp.sock");
  const server = echoServer();
  await expect(listenPublishedUnixSocket(server, path)).rejects.toThrow();
  expect(server.listening).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});
