import { Buffer } from "node:buffer";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

import { validateRawRequestTargetPath } from "./control-plane-route-validation.ts";
import { removeFileIfExists } from "./process.ts";

const REQUEST_LINE_TERMINATOR = "\r\n";
const BAD_REQUEST_STATUS_LINE = "HTTP/1.1 400 Bad Request";

type ProxyListenTarget =
  | { readonly unix: string }
  | { readonly host: string; readonly port: number };

type EventfulServer = Server & {
  once(
    eventName: string,
    listener: (...args: readonly unknown[]) => void
  ): Server;
  off(
    eventName: string,
    listener: (...args: readonly unknown[]) => void
  ): Server;
};

export interface RequestTargetProxy {
  close(): Promise<void>;
}

/**
 * Starts a transparent TCP proxy that rejects raw `.`/`..` path segments before
 * Bun normalizes the request target.
 */
export async function startRequestTargetProxy(opts: {
  readonly listen: ProxyListenTarget;
  readonly target: ProxyListenTarget;
}): Promise<RequestTargetProxy> {
  if ("unix" in opts.listen) {
    await removeFileIfExists({ path: opts.listen.unix });
  }

  const activeSockets = new Set<Socket>();
  const server = createServer((clientSocket) => {
    activeSockets.add(clientSocket);
    clientSocket.on("close", () => {
      activeSockets.delete(clientSocket);
    });
    handleProxyConnection({
      clientSocket,
      target: opts.target,
    });
  });

  await listenServer({
    server,
    listen: opts.listen,
  });

  return {
    close: async () => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      await closeServer({ server });
      if ("unix" in opts.listen) {
        await removeFileIfExists({ path: opts.listen.unix });
      }
    },
  };
}

function handleProxyConnection(opts: {
  readonly clientSocket: Socket;
  readonly target: ProxyListenTarget;
}): void {
  let bufferedChunks: Buffer[] = [];
  let inspectionComplete = false;
  let upstreamSocket: Socket | null = null;

  const destroyUpstream = () => {
    upstreamSocket?.destroy();
    upstreamSocket = null;
  };

  const onClientData = (chunk: Buffer) => {
    if (inspectionComplete) {
      return;
    }

    bufferedChunks.push(chunk);
    const buffered = Buffer.concat(bufferedChunks);
    const requestLineEnd = buffered.indexOf(REQUEST_LINE_TERMINATOR);
    if (requestLineEnd < 0) {
      return;
    }

    const requestLine = buffered.subarray(0, requestLineEnd).toString("latin1");
    const requestTarget = extractRequestTarget({ requestLine });
    const validation =
      requestTarget === null
        ? { ok: true as const }
        : validateRawRequestTargetPath({ requestTarget });
    if (!validation.ok) {
      writeMalformedPathResponse({ clientSocket: opts.clientSocket });
      opts.clientSocket.end();
      return;
    }

    inspectionComplete = true;
    opts.clientSocket.off("data", onClientData);
    upstreamSocket = createProxyTargetConnection({ target: opts.target });

    upstreamSocket.once("connect", () => {
      const connection = upstreamSocket;
      if (!connection) {
        opts.clientSocket.destroy();
        return;
      }
      connection.write(buffered);
      opts.clientSocket.pipe(connection);
      connection.pipe(opts.clientSocket);
      bufferedChunks = [];
    });

    upstreamSocket.on("error", () => {
      opts.clientSocket.destroy();
      destroyUpstream();
    });
  };

  opts.clientSocket.on("data", onClientData);
  opts.clientSocket.on("error", destroyUpstream);
  opts.clientSocket.on("close", destroyUpstream);
}

function extractRequestTarget(opts: {
  readonly requestLine: string;
}): string | null {
  const [method, requestTarget] = opts.requestLine.split(" ");
  if (!(method && requestTarget)) {
    return null;
  }
  return requestTarget;
}

function createProxyTargetConnection(opts: {
  readonly target: ProxyListenTarget;
}): Socket {
  if ("unix" in opts.target) {
    return createConnection({ path: opts.target.unix });
  }
  return createConnection({
    host: opts.target.host,
    port: opts.target.port,
  });
}

function writeMalformedPathResponse(opts: {
  readonly clientSocket: Socket;
}): void {
  const body = JSON.stringify({ error: "malformed_path" });
  opts.clientSocket.write(
    `${BAD_REQUEST_STATUS_LINE}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  );
}

function listenServer(opts: {
  readonly server: Server;
  readonly listen: ProxyListenTarget;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = opts.server as EventfulServer;
    const handleError = (...args: readonly unknown[]) => {
      const [error] = args;
      server.off("listening", handleListening);
      reject(
        error instanceof Error ? error : new Error(String(error ?? "unknown"))
      );
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    if ("unix" in opts.listen) {
      server.listen(opts.listen.unix);
      return;
    }
    server.listen(opts.listen.port, opts.listen.host);
  });
}

function closeServer(opts: { readonly server: Server }): Promise<void> {
  return new Promise((resolve, reject) => {
    opts.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
