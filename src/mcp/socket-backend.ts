import { chmod, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "../lib/guards.ts";
import { McpCommandAdmission } from "./command-admission.ts";
import { createMcpServer } from "./server.ts";
import { recordMcpSocketReceipt } from "./socket-receipt.ts";
import {
  createMcpStartupChannel,
  type McpStartupChannel,
} from "./startup-channel.ts";

const CONTEXT_LIMIT = 256 * 1024;
const REQUEST_LIMIT = 1024 * 1024;
const WRITE_LIMIT = 64 * 1024 * 1024;

/** Experimental, explicit-lifetime shared backend. Requires an existing private,
 * caller-owned directory, never removes a pre-existing endpoint, and never logs
 * session environment values. Native-owner recovery is separate; no auto-start
 * or installer changes.
 */
interface BackendOptions {
  readonly directory: string;
  readonly backendId: string;
  readonly maxActiveCommands?: number;
  readonly idleTimeoutMs?: number;
  readonly maxConnections?: number;
}

interface Backend {
  readonly socketPath: string;
  readonly closed: Promise<void>;
  readonly close: () => Promise<void>;
}

export async function startMcpSocketBackend(
  opts: BackendOptions
): Promise<Backend> {
  validateBackendOptions(opts);
  const startup = createMcpStartupChannel();
  try {
    return await prepareBackend(opts, startup);
  } finally {
    await startup.close();
  }
}

function validateBackendOptions(opts: BackendOptions): void {
  if (!(opts.backendId.length > 0 && opts.backendId.length <= 256)) {
    throw new Error("Invalid MCP backend identity");
  }
  const idleTimeoutMs = opts.idleTimeoutMs ?? 0;
  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 0 ||
    idleTimeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      "MCP idle timeout must be an integer from 0 to 2147483647 milliseconds"
    );
  }
  const maxConnections = opts.maxConnections ?? 128;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new RangeError("MCP connection limit must be a positive integer");
  }
}

async function prepareBackend(
  opts: BackendOptions,
  startup: McpStartupChannel
): Promise<Backend> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 0;
  const maxConnections = opts.maxConnections ?? 128;
  const directoryStat = await lstat(opts.directory);
  startup.check();
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "MCP socket directory must be owned by this user and private (0700)"
    );
  }
  const directory = await realpath(opts.directory);
  startup.check();
  const socketPath = join(directory, "mcp.sock");
  const admission = new McpCommandAdmission(opts.maxActiveCommands ?? 4);
  // Bun can replace an existing socket on listen. Claim the directory first;
  // native-owned crash recovery runs under the retained lease before this entrypoint.
  const claimPath = join(directory, ".mcp-owner");
  await mkdir(claimPath, { mode: 0o700 });
  const claimStat = await lstat(claimPath);
  async function releaseClaim(): Promise<void> {
    const current = await lstat(claimPath).catch(() => null);
    if (current?.ino === claimStat.ino && current.dev === claimStat.dev) {
      await rmdir(claimPath);
    }
  }
  let releaseReceipt = async (): Promise<void> => undefined;
  let endpointIdentity: { ino: number; dev: number } | undefined;
  async function removeOwnedEndpoint(): Promise<void> {
    const current = await lstat(socketPath).catch(() => null);
    if (
      endpointIdentity &&
      current?.ino === endpointIdentity.ino &&
      current.dev === endpointIdentity.dev
    ) {
      await unlink(socketPath);
    }
  }
  let ready = false;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Existing explicit-lifetime callers may only await close().
  void closed.catch(() => undefined);
  const sockets = new Set<Socket>();
  const pendingSessions = new Map<Socket, () => void>();
  function clearIdle(): void {
    clearTimeout(timer);
    timer = undefined;
  }
  function armIdle(): void {
    clearIdle();
    if (ready && !closing && sockets.size === 0 && idleTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (sockets.size === 0) {
          void close().catch(() => undefined);
        }
      }, idleTimeoutMs);
    }
  }
  const listener = createServer((socket) => {
    if (closing || sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    clearIdle();
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      pendingSessions.delete(socket);
      armIdle();
    });
    const activate = attachSession({
      socket,
      backendId: opts.backendId,
      admission,
    });
    if (ready) {
      activate();
    } else {
      pendingSessions.set(socket, activate);
    }
  });
  try {
    startup.check();
    const endpoint = await lstat(socketPath).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (endpoint) {
      throw new Error("MCP socket endpoint already exists");
    }
    startup.check();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      // Bun binds a local Unix endpoint synchronously in listen(). Restrict its
      // creation mode so concurrent adapters cannot observe a public socket
      // before chmod. Restore immediately; never retain this mask across await
      // or apply it to commands executed for connected clients.
      const previousMask = process.umask();
      process.umask(previousMask | 0o077);
      try {
        listener.listen(socketPath, () => {
          listener.off("error", reject);
          resolve();
        });
      } finally {
        process.umask(previousMask);
      }
    });
    endpointIdentity = await lstat(socketPath);
    startup.check();
    await chmod(socketPath, 0o600);
    startup.check();
    releaseReceipt = await recordMcpSocketReceipt({
      directory,
      claim: claimStat,
      socket: endpointIdentity,
    });
    startup.check();
    await startup.request();
    await startup.close();
  } catch (error) {
    admission.stop();
    for (const socket of sockets) {
      socket.destroy();
    }
    if (listener.listening) {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    await admission.drain();
    await removeOwnedEndpoint();
    await releaseClaim();
    await releaseReceipt();
    throw error;
  }
  function close(): Promise<void> {
    clearIdle();
    closing ??= (async () => {
      admission.stop();
      try {
        const stopped = new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve()))
        );
        for (const socket of sockets) {
          socket.destroy();
        }
        await stopped;
        await admission.drain();
      } finally {
        await removeOwnedEndpoint();
        await releaseClaim();
        await releaseReceipt();
      }
    })();
    void closing.then(resolveClosed, rejectClosed);
    return closing;
  }
  ready = true;
  for (const activate of pendingSessions.values()) {
    activate();
  }
  pendingSessions.clear();
  armIdle();
  return { socketPath, closed, close };
}

function parseContext(value: unknown): {
  cwd: string;
  env: Record<string, string>;
} {
  if (
    !isRecord(value) ||
    value.hack_mcp !== 1 ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd) ||
    value.cwd.includes("\0") ||
    !isRecord(value.env)
  ) {
    throw new Error("Invalid MCP session context");
  }
  const env: Record<string, string> = Object.create(null);
  const entries = Object.entries(value.env);
  for (const [key, item] of entries) {
    if (
      !key ||
      key.includes("=") ||
      key.includes("\0") ||
      typeof item !== "string" ||
      item.includes("\0")
    ) {
      throw new Error("Invalid MCP session environment");
    }
    env[key] = item;
  }
  return {
    cwd: value.cwd,
    env,
  };
}

function attachSession(opts: {
  readonly socket: Socket;
  readonly backendId: string;
  readonly admission: McpCommandAdmission;
}): () => void {
  const { socket } = opts;
  let phase: "pending" | "context" | "ready" | "closed" = "pending";
  let frame = Buffer.alloc(0);
  let bufferedBytes = 0;
  let closeDone = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    closeDone = resolve;
  });
  const deadline = setTimeout(() => socket.destroy(), 5000);
  const transport: Transport = {
    start: async () => {
      if (socket.destroyed) {
        throw new Error("MCP connection closed during initialization");
      }
      phase = "ready";
      clearTimeout(deadline);
      await write(`${JSON.stringify({ hack_mcp: 1, ready: true })}\n`);
    },
    send: async (message) => {
      await write(`${JSON.stringify(message)}\n`);
    },
    close: () => {
      socket.destroy();
      return closed;
    },
  };

  async function write(text: string): Promise<void> {
    if (
      socket.destroyed ||
      Buffer.byteLength(text) + socket.writableLength > WRITE_LIMIT
    ) {
      socket.destroy();
      throw new Error(
        "MCP connection closed or outbound buffer limit exceeded"
      );
    }
    await new Promise<void>((resolve, reject) => {
      socket.write(text, (error) => (error ? reject(error) : resolve()));
    });
  }

  socket.on("error", () => socket.destroy());
  socket.once("end", () => socket.destroy());
  socket.once("close", () => {
    phase = "closed";
    clearTimeout(deadline);
    frame = Buffer.alloc(0);
    bufferedBytes = 0;
    transport.onclose?.();
    closeDone();
  });
  function reserveFrame(requiredBytes: number): void {
    if (requiredBytes <= frame.length) {
      return;
    }
    const capacity = Math.min(
      phase === "ready" ? REQUEST_LIMIT : CONTEXT_LIMIT + 1,
      Math.max(requiredBytes, frame.length * 2, 4096)
    );
    const grown = Buffer.allocUnsafe(capacity);
    frame.copy(grown, 0, 0, bufferedBytes);
    frame = grown;
  }

  function receiveFrame(bytes: Buffer): void {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (phase === "context") {
      const context = parseContext(value);
      const server = createMcpServer({ ...context, admission: opts.admission });
      void server.connect(transport).catch(() => socket.destroy());
    } else {
      transport.onmessage?.(JSONRPCMessageSchema.parse(value));
    }
  }

  function bufferPending(chunk: Buffer): void {
    const requiredBytes = bufferedBytes + chunk.length;
    if (requiredBytes > CONTEXT_LIMIT + 1) {
      socket.destroy();
      return;
    }
    reserveFrame(requiredBytes);
    chunk.copy(frame, bufferedBytes);
    bufferedBytes = requiredBytes;
  }

  function receive(chunk: Buffer): void {
    try {
      if (phase === "pending") {
        bufferPending(chunk);
        return;
      }
      let offset = 0;
      while (offset < chunk.length && phase !== "closed") {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        const requiredBytes = bufferedBytes + part.length;
        if (
          requiredBytes > (phase === "context" ? CONTEXT_LIMIT : REQUEST_LIMIT)
        ) {
          socket.destroy();
          return;
        }
        reserveFrame(requiredBytes);
        part.copy(frame, bufferedBytes);
        bufferedBytes = requiredBytes;
        offset = end + 1;
        if (newline < 0) {
          return;
        }
        receiveFrame(frame.subarray(0, bufferedBytes));
        frame = Buffer.alloc(0);
        bufferedBytes = 0;
      }
    } catch {
      // Context and protocol values may contain credentials; do not echo input.
      socket.destroy();
    }
  }
  socket.on("data", receive);
  return () => {
    if (phase !== "pending" || socket.destroyed) {
      return;
    }
    phase = "context";
    const pending = frame.subarray(0, bufferedBytes);
    frame = Buffer.alloc(0);
    bufferedBytes = 0;
    void write(
      `${JSON.stringify({ hack_mcp: 1, backend_id: opts.backendId })}\n`
    ).catch(() => socket.destroy());
    receive(pending);
  };
}
