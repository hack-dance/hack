import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { isRecord } from "./guards.ts";

export const LIFECYCLE_PROCESS_CLIENT = "--internal-lifecycle-process-client";
const NAME = /^host-launch-[a-f0-9]{32}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LIMIT = 256 * 1024;
type Launch = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};
function refuse(): never {
  throw new Error("Lifecycle process delivery refused; values omitted.");
}
function readLaunch(value: unknown): Launch {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "command,cwd,env" ||
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    !value.command.every((v) => typeof v === "string" && !v.includes("\0")) ||
    value.command[0] === "" ||
    typeof value.cwd !== "string" ||
    !value.cwd.startsWith("/") ||
    value.cwd.includes("\0") ||
    !isRecord(value.env) ||
    !Object.entries(value.env).every(
      ([k, v]) => KEY.test(k) && typeof v === "string" && !v.includes("\0")
    )
  ) {
    return refuse();
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.env)) {
    if (typeof entry !== "string") {
      return refuse();
    }
    Object.defineProperty(env, key, { value: entry, enumerable: true });
  }
  return {
    command: value.command,
    cwd: value.cwd,
    env,
  };
}
async function privateParent(path: string) {
  const parent = dirname(path);
  const info = await lstat(parent);
  if (
    !NAME.test(basename(parent)) ||
    basename(path) !== "delivery.sock" ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(parent)) !== parent
  ) {
    return refuse();
  }
  return async () => {
    const current = await lstat(parent);
    if (
      !current.isDirectory() ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.uid !== info.uid ||
      current.mode !== info.mode ||
      (await realpath(parent)) !== parent
    ) {
      return refuse();
    }
  };
}

/** One launch handoff inside a private directory. Values never enter mux argv,
 * its global environment, or a file. The client joins the existing mux process
 * group; the shared lifecycle controller remains its sole stop/recovery owner.
 */
export async function serveLifecycleProcessDelivery(input: {
  readonly root: string;
  readonly launch: Launch;
  readonly signal: AbortSignal;
  readonly remaining: () => number;
  readonly assertFresh: () => Promise<void>;
}) {
  const opts = { ...input, launch: structuredClone(input.launch) };
  const launch = readLaunch(opts.launch);
  const parent = join(
    opts.root,
    `host-launch-${randomBytes(16).toString("hex")}`
  );
  await opts.assertFresh();
  opts.remaining();
  await mkdir(parent, { mode: 0o700 });
  const path = join(parent, "delivery.sock");
  const check = await privateParent(path);
  const payload = Buffer.from(`${JSON.stringify(launch)}\n`);
  if (payload.length > LIMIT) {
    payload.fill(0);
    await rmdir(parent);
    return refuse();
  }
  const started = Promise.withResolvers<void>();
  // A failed/aborted launch may be observed before the controller awaits started.
  void started.promise.catch(() => undefined);
  const sockets = new Set<Socket>();
  let claimed = false;
  let closed = false;
  const server = createServer((socket) => {
    if (claimed || closed || opts.signal.aborted) {
      socket.destroy();
      return;
    }
    claimed = true;
    sockets.add(socket);
    let text = "";
    let state: "waiting" | "preparing" | "delivered" | "started" = "waiting";
    socket.on("error", () =>
      started.reject(new Error("Lifecycle handoff failed; values omitted."))
    );
    socket.on("close", () => {
      sockets.delete(socket);
      if (state !== "started") {
        started.reject(
          new Error("Lifecycle handoff incomplete; values omitted.")
        );
      }
    });
    socket.on("data", (bytes) => {
      text += bytes.toString("ascii");
      if (
        text.length > 64 ||
        (text.includes("\n") && text !== "claim\n" && text !== "started\n")
      ) {
        socket.destroy();
        return;
      }
      if (text === "claim\n" && state === "waiting") {
        text = "";
        state = "preparing";
        void (async () => {
          await opts.assertFresh();
          await check();
          opts.remaining();
          if (closed || opts.signal.aborted) {
            return refuse();
          }
          state = "delivered";
          socket.write(payload);
        })().catch(() => socket.destroy());
      } else if (text === "started\n" && state === "delivered") {
        text = "";
        state = "started";
        clearTimeout(timer);
        started.resolve();
        socket.end();
      } else if (text.includes("\n")) {
        socket.destroy();
      }
    });
  });
  const abort = () => {
    started.reject(new Error("Lifecycle handoff canceled; values omitted."));
    for (const socket of sockets) {
      socket.destroy();
    }
  };
  const timer = setTimeout(abort, opts.remaining());
  opts.signal.addEventListener("abort", abort, { once: true });
  try {
    opts.remaining();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    await check();
    await opts.assertFresh();
    opts.remaining();
  } catch (error) {
    abort();
    clearTimeout(timer);
    server.close();
    payload.fill(0);
    opts.signal.removeEventListener("abort", abort);
    await unlink(path).catch(() => undefined);
    await rmdir(parent).catch(() => undefined);
    throw error;
  }
  return {
    path,
    started: () => started.promise,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      abort();
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", abort);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      payload.fill(0);
      await check();
      await unlink(path).catch((error) => {
        if (!isRecord(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
      await rmdir(parent);
    },
  };
}

/** Internal delivery client only. It has no discovery, persisted commands, or
 * detached child. The enclosing Hack mux group supplies signals and cleanup.
 */
export async function runLifecycleProcessClient(path: string): Promise<number> {
  const check = await privateParent(path);
  const info = await lstat(path);
  if (
    !info.isSocket() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600
  ) {
    return refuse();
  }
  const socket = createConnection(path);
  const delivery = Promise.withResolvers<Launch>();
  let bytes = Buffer.alloc(0);
  socket.on("error", () =>
    delivery.reject(
      new Error("Lifecycle delivery unavailable; values omitted.")
    )
  );
  socket.on("end", () =>
    delivery.reject(new Error("Lifecycle delivery incomplete; values omitted."))
  );
  socket.on("close", () =>
    delivery.reject(new Error("Lifecycle delivery incomplete; values omitted."))
  );
  socket.on("data", (chunk) => {
    if (typeof chunk === "string") {
      socket.destroy();
      return;
    }
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > LIMIT) {
      socket.destroy();
      delivery.reject(new Error("Lifecycle delivery refused; values omitted."));
      return;
    }
    if (bytes.at(-1) === 10) {
      try {
        delivery.resolve(
          readLaunch(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          )
        );
      } catch {
        delivery.reject(
          new Error("Lifecycle delivery refused; values omitted.")
        );
      }
    }
  });
  socket.on("connect", () => socket.write("claim\n"));
  try {
    const launch = await delivery.promise;
    await check();
    const current = await lstat(path);
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.mode !== info.mode ||
      current.uid !== info.uid
    ) {
      return refuse();
    }
    const child = Bun.spawn([...launch.command], {
      cwd: launch.cwd,
      env: { ...launch.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    bytes.fill(0);
    socket.end("started\n");
    return await child.exited;
  } finally {
    bytes.fill(0);
    socket.destroy();
  }
}
