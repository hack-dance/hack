import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
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
  expect(stat.mode & 0o777).toBe(0o600);
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

test("a listen that binds the staging name and then fails leaves no socket or listener", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "control.sock");
  const inner = createServer();
  servers.push(inner);
  let closed = false;
  // A runtime that creates the staging socket and then reports a listen error.
  const partial = Object.assign(new EventEmitter(), {
    listen(staging: string) {
      inner.listen(staging, () => {
        partial.emit("error", new Error("injected failure after bind"));
      });
      return partial;
    },
    close(callback?: () => void) {
      closed = true;
      inner.close(() => callback?.());
      return partial;
    },
  });
  await expect(
    listenPublishedUnixSocket(partial as unknown as Server, path)
  ).rejects.toThrow("injected failure after bind");
  expect(closed).toBe(true);
  expect(inner.listening).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});

async function foreignFile(path: string) {
  await writeFile(path, "foreign bytes", { mode: 0o644 });
  const stat = await lstat(path);
  return { ino: stat.ino, mode: stat.mode & 0o777 };
}

async function expectForeignFileKept(
  path: string,
  original: { ino: number; mode: number }
) {
  const stat = await lstat(path);
  expect({ ino: stat.ino, mode: stat.mode & 0o777 }).toEqual(original);
  expect(await readFile(path, "utf8")).toBe("foreign bytes");
}

test("an ambiguous partial bind keeps a foreign same-uid socket at the staging name", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "control.sock");
  const foreign = createServer((socket) => socket.end("foreign"));
  servers.push(foreign);
  let closed = false;
  let original: { ino: number; mode: number } | undefined;
  // A listen that never proves it bound anything, while a foreign socket takes the name.
  const partial = Object.assign(new EventEmitter(), {
    listen(staging: string) {
      setTimeout(() => {
        foreign.listen(staging, async () => {
          const stat = await lstat(staging);
          original = { ino: stat.ino, mode: stat.mode & 0o777 };
          partial.emit("error", new Error("injected ambiguous bind failure"));
        });
      }, 10);
      return partial;
    },
    close(callback?: () => void) {
      closed = true;
      callback?.();
      return partial;
    },
  });
  await expect(
    listenPublishedUnixSocket(partial as unknown as Server, path)
  ).rejects.toThrow("injected ambiguous bind failure");
  expect(closed).toBe(true);
  const [staging] = (await readdir(directory)).filter((name) =>
    name.startsWith(".")
  );
  expect(staging).toBeDefined();
  const stat = await lstat(join(directory, staging ?? ""));
  expect({ ino: stat.ino, mode: stat.mode & 0o777 }).toEqual(
    original ?? { ino: 0, mode: 0 }
  );
  expect(await reply(join(directory, staging ?? ""))).toBe("foreign");
  expect(await readdir(directory)).toEqual([staging ?? ""]);
});

test("a replacement after bind is refused and kept: never chmodded, adopted or removed", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "owner.sock");
  const server = echoServer();
  let staging = "";
  let original: { ino: number; mode: number } | undefined;
  await expect(
    listenPublishedUnixSocket(server, path, {
      hooks: {
        afterBind: async (name) => {
          staging = name;
          await unlink(name);
          original = await foreignFile(name);
        },
      },
    })
  ).rejects.toThrow("changed before publication");
  expect(server.listening).toBe(false);
  // The helper's own server close could not remove it either.
  await expectForeignFileKept(staging, original ?? { ino: 0, mode: 0 });
  expect(await readdir(directory)).toEqual([basename(staging)]);
});

test("a replacement after publication is kept when the staging name is retired", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "mcp.sock");
  const server = echoServer();
  let staging = "";
  let original: { ino: number; mode: number } | undefined;
  const identity = await listenPublishedUnixSocket(server, path, {
    hooks: {
      afterLink: async (name) => {
        staging = name;
        await unlink(name);
        original = await foreignFile(name);
      },
    },
  });
  const stat = await lstat(path);
  expect({ dev: stat.dev, ino: stat.ino }).toEqual(identity);
  expect(await reply(path)).toBe("ok");
  await expectForeignFileKept(staging, original ?? { ino: 0, mode: 0 });
  expect((await readdir(directory)).sort()).toEqual(
    [basename(staging), "mcp.sock"].sort()
  );
});

test("an occupied holding name is never overwritten; the next free one keeps the staging entry", async () => {
  const directory = await privateDirectory();
  const path = join(directory, "owner.sock");
  const server = echoServer();
  let staging = "";
  let original: { ino: number; mode: number } | undefined;
  let occupied: { ino: number; mode: number } | undefined;
  await expect(
    listenPublishedUnixSocket(server, path, {
      hooks: {
        afterBind: async (name) => {
          staging = name;
          await unlink(name);
          original = await foreignFile(name);
          await writeFile(`${name}.held-a`, "holding bytes", { mode: 0o640 });
          const stat = await lstat(`${name}.held-a`);
          occupied = { ino: stat.ino, mode: stat.mode & 0o777 };
        },
        holdingNames: (name) => [`${name}.held-a`, `${name}.held-b`],
      },
    })
  ).rejects.toThrow("changed before publication");
  expect(server.listening).toBe(false);
  // The staging entry went to the free name for the close and came back unchanged.
  await expectForeignFileKept(staging, original ?? { ino: 0, mode: 0 });
  const held = await lstat(`${staging}.held-a`);
  expect({ ino: held.ino, mode: held.mode & 0o777 }).toEqual(
    occupied ?? { ino: 0, mode: 0 }
  );
  expect(await readFile(`${staging}.held-a`, "utf8")).toBe("holding bytes");
  expect((await readdir(directory)).sort()).toEqual(
    [basename(staging), `${basename(staging)}.held-a`].sort()
  );
});

test("an endpoint at the AF_UNIX path limit publishes and serves, and one byte over is refused cleanly or served at its full name", async () => {
  // sun_path holds 104 bytes on macOS and 108 on Linux, including the terminating NUL.
  // Bun 1.3.9 refuses a longer path; Bun 1.4 binds it in full. Neither may truncate it
  // or leave a partial staging entry.
  const limit = process.platform === "darwin" ? 103 : 107;
  const name = "mcp.sock";
  for (const extra of [0, 1]) {
    const directory = await privateDirectory();
    const fill = limit - Buffer.byteLength(directory) - 2 - name.length + extra;
    expect(fill).toBeGreaterThan(0);
    const parent = join(directory, "d".repeat(fill));
    await mkdir(parent, { mode: 0o700 });
    const path = join(parent, name);
    expect(Buffer.byteLength(path)).toBe(limit + extra);
    const server = echoServer();
    const identity = await listenPublishedUnixSocket(server, path).catch(
      () => null
    );
    if (identity) {
      const stat = await lstat(path);
      expect({ dev: stat.dev, ino: stat.ino }).toEqual(identity);
      expect(await reply(path)).toBe("ok");
      expect(await readdir(parent)).toEqual([name]);
      await close(server);
      await removeOwned(path, identity);
    } else {
      expect(extra).toBe(1);
      expect(server.listening).toBe(false);
    }
    expect(await readdir(parent)).toEqual([]);
  }
});
