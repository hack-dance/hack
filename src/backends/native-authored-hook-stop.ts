import { randomBytes, timingSafeEqual } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { isRecord } from "../lib/guards.ts";

const SHA = /^[a-f0-9]{64}$/;
const RUN = /^[a-f0-9]{32}$/;
const MAX_CONNECTIONS = 32;
function appendAscii(text: string, input: Buffer | string): string {
  const bytes = typeof input === "string" ? Buffer.from(input) : input;
  if (
    Buffer.byteLength(text) + bytes.length > 512 ||
    bytes.some((byte) => byte > 127)
  ) {
    throw new Error("Native stop control refused; values omitted.");
  }
  return text + bytes.toString("ascii");
}
function observe(callback: (() => unknown) | undefined): void {
  try {
    void Promise.resolve(callback?.()).catch(() => undefined);
  } catch {
    /* observation only */
  }
}

/** Loopback control is authenticated by a private, per-admission random capability.
 * No command, environment value or graph selection can be supplied by a client.
 * A request timeout does not cancel/replay the foreground owner's stop operation.
 */
export async function serveNativeHookStop(input: {
  readonly run: string;
  readonly stop: () => Promise<boolean>;
  readonly assertFresh: () => Promise<void>;
  readonly onRefusal?: (stage: "request" | "owner" | "stop") => void;
}): Promise<{
  readonly port: number;
  readonly token: string;
  readonly close: (force?: boolean) => Promise<void>;
}> {
  const opts = { ...input };
  if (!RUN.test(opts.run)) {
    throw new Error("Native stop owner refused; values omitted.");
  }
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let operation: Promise<boolean> | undefined;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
    let text = "";
    socket.on("data", (bytes) => {
      try {
        text = appendAscii(text, bytes);
      } catch {
        socket.destroy();
        return;
      }
      if (!text.endsWith("\n")) {
        return;
      }
      socket.pause();
      void (async () => {
        let stage: "request" | "owner" | "stop" = "request";
        try {
          const value: unknown = JSON.parse(text);
          if (
            !isRecord(value) ||
            Object.keys(value).sort().join(",") !== "kind,run,token" ||
            value.kind !== "native-authored-stop" ||
            value.run !== opts.run ||
            typeof value.token !== "string" ||
            !SHA.test(value.token) ||
            !timingSafeEqual(Buffer.from(value.token), Buffer.from(token))
          ) {
            socket.destroy();
            return;
          }
          stage = "owner";
          await opts.assertFresh();
          socket.setTimeout(0);
          stage = "stop";
          operation ??= opts.stop();
          const removed = await operation;
          socket.end(
            `${JSON.stringify({
              version: 1,
              kind: "native-authored-stop-result",
              run: opts.run,
              removed,
            })}\n`
          );
        } catch {
          const refusedStage = stage;
          observe(() => opts.onRefusal?.(refusedStage));
          socket.destroy();
        }
      })();
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Native stop owner is unavailable; values omitted.");
  }
  return {
    port: address.port,
    token,
    close: async (force = false) => {
      if (force) {
        for (const socket of sockets) {
          socket.destroy();
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function requestNativeHookStop(input: {
  readonly run: string;
  readonly port: number;
  readonly token: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const opts = { ...input };
  if (
    !(
      RUN.test(opts.run) &&
      SHA.test(opts.token) &&
      Number.isInteger(opts.port)
    ) ||
    opts.port < 1 ||
    opts.port > 65_535 ||
    !Number.isSafeInteger(opts.timeoutMs) ||
    opts.timeoutMs < 1 ||
    opts.signal?.aborted
  ) {
    throw new Error("Native stop selection is invalid; values omitted.");
  }
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: opts.port });
    const fail = () => {
      socket.destroy();
      reject(
        new Error(
          "Native stop outcome is retained or unavailable; values omitted."
        )
      );
    };
    const timer = setTimeout(fail, opts.timeoutMs);
    const close = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", fail);
    };
    opts.signal?.addEventListener("abort", fail, { once: true });
    let text = "";
    socket.on("connect", () =>
      socket.end(
        `${JSON.stringify({
          kind: "native-authored-stop",
          run: opts.run,
          token: opts.token,
        })}\n`
      )
    );
    socket.on("data", (bytes) => {
      try {
        text = appendAscii(text, bytes);
      } catch {
        fail();
      }
    });
    socket.on("error", fail);
    socket.on("end", () => {
      try {
        const value: unknown = JSON.parse(text);
        if (
          !isRecord(value) ||
          Object.keys(value).sort().join(",") !== "kind,removed,run,version" ||
          value.version !== 1 ||
          value.kind !== "native-authored-stop-result" ||
          value.run !== opts.run ||
          value.removed !== true
        ) {
          fail();
          return;
        }
        resolve();
      } catch {
        fail();
      }
    });
    socket.on("close", close);
    if (opts.signal?.aborted) {
      fail();
    }
  });
}
