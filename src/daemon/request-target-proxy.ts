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
const HEADER_TERMINATOR = "\r\n\r\n";
const BAD_REQUEST_STATUS_LINE = "HTTP/1.1 400 Bad Request";
type BinaryBuffer = Buffer<ArrayBufferLike>;

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
  let upstreamSocket: Socket | null = null;
  let upstreamConnected = false;
  let tunnelEstablished = false;
  let awaitingUpgradeResponse = false;
  let pendingReject = false;
  let rejectSent = false;
  let clientBuffer: BinaryBuffer = Buffer.alloc(0);
  let upstreamBuffer: BinaryBuffer = Buffer.alloc(0);
  const pendingUpstreamWrites: BinaryBuffer[] = [];
  const pendingResponses: ForwardedRequest[] = [];

  const destroyUpstream = () => {
    upstreamSocket?.destroy();
    upstreamSocket = null;
    upstreamConnected = false;
  };

  const flushPendingUpstreamWrites = () => {
    if (!(upstreamSocket && upstreamConnected)) {
      return;
    }
    for (const bufferedWrite of pendingUpstreamWrites.splice(0)) {
      upstreamSocket.write(bufferedWrite);
    }
  };

  const ensureUpstreamSocket = () => {
    if (upstreamSocket) {
      return upstreamSocket;
    }

    upstreamSocket = createProxyTargetConnection({ target: opts.target });
    upstreamSocket.once("connect", () => {
      upstreamConnected = true;
      flushPendingUpstreamWrites();
    });
    upstreamSocket.on("data", onUpstreamData);
    upstreamSocket.on("error", () => {
      opts.clientSocket.destroy();
      destroyUpstream();
    });
    upstreamSocket.on("close", () => {
      upstreamSocket = null;
      upstreamConnected = false;
      if (!(pendingReject || tunnelEstablished)) {
        opts.clientSocket.end();
      }
    });

    return upstreamSocket;
  };

  const writeToUpstream = (chunk: Buffer) => {
    const socket = ensureUpstreamSocket();
    if (upstreamConnected) {
      socket.write(chunk);
      return;
    }
    pendingUpstreamWrites.push(Buffer.from(chunk));
  };

  const sendRejectAndClose = () => {
    if (rejectSent) {
      return;
    }
    rejectSent = true;
    writeMalformedPathResponse({ clientSocket: opts.clientSocket });
    opts.clientSocket.end();
    destroyUpstream();
  };

  const handleParsedRequest = (request: ParsedHttpRequest): boolean => {
    const validation =
      request.requestTarget === null
        ? { ok: true as const }
        : validateRawRequestTargetPath({
            requestTarget: request.requestTarget,
          });
    if (!validation.ok) {
      pendingReject = true;
      clientBuffer = Buffer.alloc(0);
      opts.clientSocket.pause();
      if (pendingResponses.length === 0) {
        sendRejectAndClose();
      }
      return false;
    }

    writeToUpstream(request.rawMessage);
    pendingResponses.push({
      method: request.method,
      upgradeRequested: request.upgradeRequested,
    });
    if (request.upgradeRequested) {
      awaitingUpgradeResponse = true;
      return false;
    }
    return true;
  };

  const processClientBuffer = () => {
    if (pendingReject || tunnelEstablished || awaitingUpgradeResponse) {
      return;
    }

    while (true) {
      const request = consumeHttpRequestMessage({ buffered: clientBuffer });
      if (!request) {
        return;
      }
      clientBuffer = request.remaining;
      if (!handleParsedRequest(request)) {
        return;
      }
    }
  };

  const finalizeUpgradeTunnel = () => {
    tunnelEstablished = true;
    if (upstreamBuffer.length > 0) {
      opts.clientSocket.write(upstreamBuffer);
      upstreamBuffer = Buffer.alloc(0);
    }
    if (clientBuffer.length > 0) {
      writeToUpstream(clientBuffer);
      clientBuffer = Buffer.alloc(0);
    }
    opts.clientSocket.resume();
  };

  const completeParsedResponse = (opts: {
    readonly request: ForwardedRequest;
    readonly response: ParsedHttpResponse;
  }): void => {
    if (!opts.response.dequeuesRequest) {
      return;
    }
    pendingResponses.shift();
    if (opts.request.upgradeRequested) {
      awaitingUpgradeResponse = false;
    }
  };

  const maybeSendPendingReject = (): boolean => {
    if (!(pendingReject && pendingResponses.length === 0)) {
      return false;
    }
    sendRejectAndClose();
    return true;
  };

  const resumeHttpInspectionIfNeeded = () => {
    if (!awaitingUpgradeResponse && clientBuffer.length > 0) {
      processClientBuffer();
    }
  };

  const processUpstreamBuffer = () => {
    while (true) {
      const request = pendingResponses[0];
      if (!request) {
        return;
      }

      const response = consumeHttpResponseMessage({
        buffered: upstreamBuffer,
        request,
      });
      if (!response) {
        return;
      }

      upstreamBuffer = response.remaining;
      opts.clientSocket.write(response.rawMessage);
      completeParsedResponse({ request, response });

      if (response.upgradeEstablished) {
        finalizeUpgradeTunnel();
        return;
      }
      if (maybeSendPendingReject()) {
        return;
      }
      resumeHttpInspectionIfNeeded();
    }
  };

  const onClientData = (chunk: BinaryBuffer) => {
    if (pendingReject) {
      return;
    }
    if (tunnelEstablished) {
      writeToUpstream(chunk);
      return;
    }

    clientBuffer = Buffer.concat([clientBuffer, chunk]);
    processClientBuffer();
  };

  const onUpstreamData = (chunk: BinaryBuffer) => {
    if (tunnelEstablished) {
      opts.clientSocket.write(chunk);
      return;
    }

    upstreamBuffer = Buffer.concat([upstreamBuffer, chunk]);
    processUpstreamBuffer();
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

type ForwardedRequest = {
  readonly method: string;
  readonly upgradeRequested: boolean;
};

type ParsedHttpRequest = {
  readonly rawMessage: BinaryBuffer;
  readonly remaining: BinaryBuffer;
  readonly requestTarget: string | null;
  readonly method: string;
  readonly upgradeRequested: boolean;
};

type ParsedHttpResponse = {
  readonly rawMessage: BinaryBuffer;
  readonly remaining: BinaryBuffer;
  readonly dequeuesRequest: boolean;
  readonly upgradeEstablished: boolean;
};

function consumeHttpRequestMessage(opts: {
  readonly buffered: BinaryBuffer;
}): ParsedHttpRequest | null {
  const headerEnd = opts.buffered.indexOf(HEADER_TERMINATOR);
  if (headerEnd < 0) {
    return null;
  }

  const bodyStart = headerEnd + HEADER_TERMINATOR.length;
  const headerText = opts.buffered.subarray(0, headerEnd).toString("latin1");
  const headerLines = headerText.split(REQUEST_LINE_TERMINATOR);
  const requestLine = headerLines[0] ?? "";
  const headers = parseHttpHeaders({
    headerLines: headerLines.slice(1),
  });
  const messageEnd = resolveHttpMessageEnd({
    buffered: opts.buffered,
    bodyStart,
    headers,
    bodyless: false,
  });
  if (messageEnd === null) {
    return null;
  }

  const method = requestLine.split(" ")[0] ?? "GET";
  return {
    rawMessage: opts.buffered.subarray(0, messageEnd),
    remaining: opts.buffered.subarray(messageEnd),
    requestTarget: extractRequestTarget({ requestLine }),
    method,
    upgradeRequested: isUpgradeRequest({ headers }),
  };
}

function consumeHttpResponseMessage(opts: {
  readonly buffered: BinaryBuffer;
  readonly request: ForwardedRequest;
}): ParsedHttpResponse | null {
  const headerEnd = opts.buffered.indexOf(HEADER_TERMINATOR);
  if (headerEnd < 0) {
    return null;
  }

  const bodyStart = headerEnd + HEADER_TERMINATOR.length;
  const headerText = opts.buffered.subarray(0, headerEnd).toString("latin1");
  const headerLines = headerText.split(REQUEST_LINE_TERMINATOR);
  const statusCode = parseStatusCode({ statusLine: headerLines[0] ?? "" });
  const headers = parseHttpHeaders({
    headerLines: headerLines.slice(1),
  });
  const isInterim =
    statusCode !== null &&
    statusCode >= 100 &&
    statusCode < 200 &&
    statusCode !== 101;
  const upgradeEstablished =
    statusCode === 101 && opts.request.upgradeRequested;
  const bodyless =
    opts.request.method.toUpperCase() === "HEAD" ||
    upgradeEstablished ||
    statusCode === 204 ||
    statusCode === 304 ||
    (statusCode !== null && statusCode >= 100 && statusCode < 200);
  const messageEnd = resolveHttpMessageEnd({
    buffered: opts.buffered,
    bodyStart,
    headers,
    bodyless,
  });
  if (messageEnd === null) {
    return null;
  }

  return {
    rawMessage: opts.buffered.subarray(0, messageEnd),
    remaining: opts.buffered.subarray(messageEnd),
    dequeuesRequest: !isInterim,
    upgradeEstablished,
  };
}

function resolveHttpMessageEnd(opts: {
  readonly buffered: BinaryBuffer;
  readonly bodyStart: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyless: boolean;
}): number | null {
  if (opts.bodyless) {
    return opts.bodyStart;
  }
  if (hasChunkedTransferEncoding({ headers: opts.headers })) {
    return resolveChunkedBodyEnd({
      buffered: opts.buffered,
      bodyStart: opts.bodyStart,
    });
  }
  const contentLength = parseContentLength({ headers: opts.headers });
  if (contentLength === null) {
    return opts.bodyStart;
  }
  const messageEnd = opts.bodyStart + contentLength;
  return opts.buffered.length >= messageEnd ? messageEnd : null;
}

function resolveChunkedBodyEnd(opts: {
  readonly buffered: Buffer;
  readonly bodyStart: number;
}): number | null {
  let cursor = opts.bodyStart;
  while (true) {
    const chunkSizeLineEnd = opts.buffered.indexOf(
      REQUEST_LINE_TERMINATOR,
      cursor
    );
    if (chunkSizeLineEnd < 0) {
      return null;
    }
    const chunkSize = parseChunkSize({
      buffered: opts.buffered,
      start: cursor,
      end: chunkSizeLineEnd,
    });
    if (!Number.isFinite(chunkSize)) {
      return null;
    }
    cursor = chunkSizeLineEnd + REQUEST_LINE_TERMINATOR.length;
    if (chunkSize === 0) {
      return resolveZeroChunkEnd({
        buffered: opts.buffered,
        cursor,
      });
    }
    const chunkEnd = cursor + chunkSize;
    if (!hasChunkTerminator({ buffered: opts.buffered, chunkEnd })) {
      return null;
    }
    cursor = chunkEnd + REQUEST_LINE_TERMINATOR.length;
  }
}

function parseChunkSize(opts: {
  readonly buffered: Buffer;
  readonly start: number;
  readonly end: number;
}): number {
  const chunkSizeText = opts.buffered
    .subarray(opts.start, opts.end)
    .toString("latin1")
    .split(";", 1)[0]
    ?.trim();
  return Number.parseInt(chunkSizeText ?? "", 16);
}

function resolveZeroChunkEnd(opts: {
  readonly buffered: Buffer;
  readonly cursor: number;
}): number | null {
  if (opts.buffered.length < opts.cursor + REQUEST_LINE_TERMINATOR.length) {
    return null;
  }
  if (
    opts.buffered
      .subarray(opts.cursor, opts.cursor + REQUEST_LINE_TERMINATOR.length)
      .toString("latin1") === REQUEST_LINE_TERMINATOR
  ) {
    return opts.cursor + REQUEST_LINE_TERMINATOR.length;
  }
  const trailerEnd = opts.buffered.indexOf(HEADER_TERMINATOR, opts.cursor);
  return trailerEnd < 0 ? null : trailerEnd + HEADER_TERMINATOR.length;
}

function hasChunkTerminator(opts: {
  readonly buffered: Buffer;
  readonly chunkEnd: number;
}): boolean {
  const chunkTerminatorEnd = opts.chunkEnd + REQUEST_LINE_TERMINATOR.length;
  return (
    opts.buffered.length >= chunkTerminatorEnd &&
    opts.buffered
      .subarray(opts.chunkEnd, chunkTerminatorEnd)
      .toString("latin1") === REQUEST_LINE_TERMINATOR
  );
}

function parseHttpHeaders(opts: {
  readonly headerLines: readonly string[];
}): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  for (const line of opts.headerLines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (name.length === 0) {
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

function parseContentLength(opts: {
  readonly headers: ReadonlyMap<string, string>;
}): number | null {
  const value = opts.headers.get("content-length")?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasChunkedTransferEncoding(opts: {
  readonly headers: ReadonlyMap<string, string>;
}): boolean {
  return headerHasToken({
    value: opts.headers.get("transfer-encoding") ?? "",
    token: "chunked",
  });
}

function isUpgradeRequest(opts: {
  readonly headers: ReadonlyMap<string, string>;
}): boolean {
  return (
    headerHasToken({
      value: opts.headers.get("connection") ?? "",
      token: "upgrade",
    }) && (opts.headers.get("upgrade")?.trim().length ?? 0) > 0
  );
}

function headerHasToken(opts: {
  readonly value: string;
  readonly token: string;
}): boolean {
  return opts.value
    .split(",")
    .some((segment) => segment.trim().toLowerCase() === opts.token);
}

function parseStatusCode(opts: { readonly statusLine: string }): number | null {
  const [, statusCode] = opts.statusLine.split(" ");
  if (!statusCode) {
    return null;
  }
  const parsed = Number.parseInt(statusCode, 10);
  return Number.isFinite(parsed) ? parsed : null;
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
