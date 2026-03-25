import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateControlPlaneRouteTarget,
  validateRawRequestTargetPath,
} from "../src/daemon/control-plane-route-validation.ts";
import { startRequestTargetProxy } from "../src/daemon/request-target-proxy.ts";
import { handleSessionRoutes } from "../src/daemon/routes/sessions.ts";

/**
 * Check if tmux is available (required for session tests).
 */
function isTmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasTmux = isTmuxAvailable();

/**
 * Helper to create a mock Request.
 */
function mockRequest(opts: {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}): Request {
  const url = `http://localhost${opts.path}`;
  const init: RequestInit = {
    method: opts.method,
    headers: { "content-type": "application/json" },
  };
  if (opts.body) {
    init.body = JSON.stringify(opts.body);
  }
  return new Request(url, init);
}

/**
 * Parse JSON response body.
 */
async function parseResponse(
  res: Response
): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type TestHttpServer = {
  readonly requestTargets: string[];
  close(): Promise<void>;
};

type RawHttpClient = {
  send(request: string): void;
  readResponse(): Promise<string>;
  close(): Promise<void>;
};

async function createRequestTargetProxyTestContext(): Promise<{
  readonly client: RawHttpClient;
  readonly requestTargets: string[];
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "hack-request-target-proxy-"));
  const upstreamSocketPath = join(root, "upstream.sock");
  const proxySocketPath = join(root, "proxy.sock");
  const upstreamServer = await startTestHttpServer({
    socketPath: upstreamSocketPath,
  });
  const proxy = await startRequestTargetProxy({
    listen: { unix: proxySocketPath },
    target: { unix: upstreamSocketPath },
  });
  const client = await connectRawHttpClient({ socketPath: proxySocketPath });

  return {
    client,
    requestTargets: upstreamServer.requestTargets,
    close: async () => {
      await client.close();
      await proxy.close();
      await upstreamServer.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function startTestHttpServer(opts: {
  readonly socketPath: string;
}): Promise<TestHttpServer> {
  const requestTargets: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const message = consumeHttpMessage({ buffered });
        if (!message) {
          return;
        }
        buffered = message.remaining;
        requestTargets.push(message.requestTarget);
        const shouldClose = hasConnectionCloseHeader({
          message: message.rawMessage,
        });
        const body = JSON.stringify({
          requestTarget: message.requestTarget,
        });
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: ${shouldClose ? "close" : "keep-alive"}\r\n\r\n${body}`
        );
        if (shouldClose) {
          socket.end();
          return;
        }
      }
    });
  });

  await listenUnixServer({
    server,
    socketPath: opts.socketPath,
  });

  return {
    requestTargets,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeNetServer({ server });
      await rm(opts.socketPath, { force: true });
    },
  };
}

async function connectRawHttpClient(opts: {
  readonly socketPath: string;
}): Promise<RawHttpClient> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const client = createConnection({ path: opts.socketPath });
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });

  let buffered = Buffer.alloc(0);
  let ended = false;
  let socketError: Error | null = null;
  const waiters = new Set<() => void>();

  const notifyWaiters = () => {
    for (const waiter of waiters) {
      waiter();
    }
  };

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    notifyWaiters();
  });
  socket.on("end", () => {
    ended = true;
    notifyWaiters();
  });
  socket.on("close", () => {
    ended = true;
    notifyWaiters();
  });
  socket.on("error", (error) => {
    socketError = error;
    notifyWaiters();
  });

  return {
    send(request) {
      socket.write(request);
    },
    readResponse: async () =>
      await new Promise((resolve, reject) => {
        const check = () => {
          if (socketError) {
            cleanup();
            reject(socketError);
            return;
          }
          const response = consumeHttpResponse({ buffered });
          if (response) {
            buffered = response.remaining;
            cleanup();
            resolve(response.rawMessage);
            return;
          }
          if (ended) {
            cleanup();
            reject(
              new Error("socket closed before a full HTTP response arrived")
            );
          }
        };

        const cleanup = () => {
          waiters.delete(check);
        };

        waiters.add(check);
        check();
      }),
    close: async () => {
      if (socket.destroyed) {
        return;
      }
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
      });
    },
  };
}

function serializeGetRequest(opts: {
  readonly path: string;
  readonly connection: "keep-alive" | "close";
}): string {
  return `GET ${opts.path} HTTP/1.1\r\nHost: localhost\r\nConnection: ${opts.connection}\r\n\r\n`;
}

function consumeHttpMessage(opts: { readonly buffered: Buffer }): {
  readonly rawMessage: string;
  readonly requestTarget: string;
  readonly remaining: Buffer;
} | null {
  const headerEnd = opts.buffered.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return null;
  }
  const messageEnd = headerEnd + 4;
  const rawMessage = opts.buffered.subarray(0, messageEnd).toString("latin1");
  const [requestLine] = rawMessage.split("\r\n");
  const requestTarget = extractRequestTargetFromLine({ requestLine });
  return {
    rawMessage,
    requestTarget,
    remaining: opts.buffered.subarray(messageEnd),
  };
}

function consumeHttpResponse(opts: {
  readonly buffered: Buffer;
}): { readonly rawMessage: string; readonly remaining: Buffer } | null {
  const headerEnd = opts.buffered.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    return null;
  }
  const headersText = opts.buffered.subarray(0, headerEnd).toString("latin1");
  const contentLength = parseContentLength({ headersText });
  const messageEnd = headerEnd + 4 + contentLength;
  if (opts.buffered.length < messageEnd) {
    return null;
  }
  return {
    rawMessage: opts.buffered.subarray(0, messageEnd).toString("latin1"),
    remaining: opts.buffered.subarray(messageEnd),
  };
}

function parseContentLength(opts: { readonly headersText: string }): number {
  const match = /\r\ncontent-length:\s*(\d+)/i.exec(`\r\n${opts.headersText}`);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function hasConnectionCloseHeader(opts: { readonly message: string }): boolean {
  return /\r\nconnection:\s*close\r\n/i.test(`\r\n${opts.message}`);
}

function extractRequestTargetFromLine(opts: {
  readonly requestLine: string;
}): string {
  const [, requestTarget] = opts.requestLine.split(" ");
  if (!requestTarget) {
    throw new Error(`Invalid request line: ${opts.requestLine}`);
  }
  return requestTarget;
}

async function listenUnixServer(opts: {
  readonly server: Server;
  readonly socketPath: string;
}): Promise<void> {
  await rm(opts.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      opts.server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      opts.server.off("error", handleError);
      resolve();
    };
    opts.server.once("error", handleError);
    opts.server.once("listening", handleListening);
    opts.server.listen(opts.socketPath);
  });
}

async function closeNetServer(opts: {
  readonly server: Server;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    opts.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("control-plane route validation", () => {
  test("rejects raw dot-segment traversal before normalized routing", () => {
    expect(
      validateRawRequestTargetPath({
        requestTarget: "/control-plane/projects/abc123def456/../v1/status",
      })
    ).toEqual({
      ok: false,
      status: 400,
      error: "malformed_path",
    });

    expect(
      validateRawRequestTargetPath({
        requestTarget: "/v1/sessions/./test-session",
      })
    ).toEqual({
      ok: false,
      status: 400,
      error: "malformed_path",
    });

    expect(
      validateRawRequestTargetPath({
        requestTarget:
          "/control-plane/projects/abc123def456%2F..%2F..%2Fv1%2Fstatus/jobs",
      })
    ).toEqual({ ok: true });

    expect(
      validateRawRequestTargetPath({
        requestTarget: "/v1/sessions/test-session",
      })
    ).toEqual({ ok: true });
  });

  test("rejects malformed project identifiers before routing", () => {
    const result = validateControlPlaneRouteTarget({
      url: new URL("http://localhost/control-plane/projects/not-valid/jobs"),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "invalid_project_id",
    });
  });

  test("rejects malformed runtime identifiers before routing", () => {
    const invalidJob = validateControlPlaneRouteTarget({
      url: new URL(
        "http://localhost/control-plane/projects/abc123def456/jobs/not-a-uuid"
      ),
    });
    expect(invalidJob).toEqual({
      ok: false,
      status: 400,
      error: "invalid_job_id",
    });

    const invalidShell = validateControlPlaneRouteTarget({
      url: new URL(
        "http://localhost/control-plane/projects/abc123def456/shells/not-a-uuid/stream"
      ),
    });
    expect(invalidShell).toEqual({
      ok: false,
      status: 400,
      error: "invalid_shell_id",
    });
  });
});

describe("request target proxy", () => {
  test("rejects pipelined traversal after a benign request", async () => {
    const context = await createRequestTargetProxyTestContext();

    try {
      context.client.send(
        `${serializeGetRequest({ path: "/v1/status", connection: "keep-alive" })}${serializeGetRequest({ path: "/v1/sessions/../escape", connection: "close" })}`
      );

      const firstResponse = await context.client.readResponse();
      expect(firstResponse).toContain("HTTP/1.1 200 OK");
      expect(firstResponse).toContain(`"requestTarget":"/v1/status"`);

      const secondResponse = await context.client.readResponse();
      expect(secondResponse).toContain("HTTP/1.1 400 Bad Request");
      expect(secondResponse).toContain(`"error":"malformed_path"`);
      expect(context.requestTargets).toEqual(["/v1/status"]);
    } finally {
      await context.close();
    }
  });

  test("rejects keep-alive traversal after a prior benign response", async () => {
    const context = await createRequestTargetProxyTestContext();

    try {
      context.client.send(
        serializeGetRequest({ path: "/v1/status", connection: "keep-alive" })
      );

      const firstResponse = await context.client.readResponse();
      expect(firstResponse).toContain("HTTP/1.1 200 OK");
      expect(firstResponse).toContain(`"requestTarget":"/v1/status"`);

      context.client.send(
        serializeGetRequest({
          path: "/v1/sessions/./escape",
          connection: "close",
        })
      );

      const secondResponse = await context.client.readResponse();
      expect(secondResponse).toContain("HTTP/1.1 400 Bad Request");
      expect(secondResponse).toContain(`"error":"malformed_path"`);
      expect(context.requestTargets).toEqual(["/v1/status"]);
    } finally {
      await context.close();
    }
  });

  test("keeps benign keep-alive reuse working", async () => {
    const context = await createRequestTargetProxyTestContext();

    try {
      context.client.send(
        serializeGetRequest({ path: "/v1/status", connection: "keep-alive" })
      );
      const firstResponse = await context.client.readResponse();
      expect(firstResponse).toContain("HTTP/1.1 200 OK");
      expect(firstResponse).toContain(`"requestTarget":"/v1/status"`);

      context.client.send(
        serializeGetRequest({
          path: "/v1/sessions/test-session",
          connection: "close",
        })
      );
      const secondResponse = await context.client.readResponse();
      expect(secondResponse).toContain("HTTP/1.1 200 OK");
      expect(secondResponse).toContain(
        `"requestTarget":"/v1/sessions/test-session"`
      );
      expect(context.requestTargets).toEqual([
        "/v1/status",
        "/v1/sessions/test-session",
      ]);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(!hasTmux)("handleSessionRoutes", () => {
  describe("route matching", () => {
    test("returns null for non-session routes", async () => {
      const req = mockRequest({ method: "GET", path: "/v1/status" });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).toBeNull();
    });

    test("returns null for non-v1 routes", async () => {
      const req = mockRequest({ method: "GET", path: "/sessions" });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).toBeNull();
    });

    test("handles GET /v1/sessions", async () => {
      const req = mockRequest({ method: "GET", path: "/v1/sessions" });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(200);
    });

    test("handles POST /v1/sessions with missing name", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: {},
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(400);
      const body = await parseResponse(result!);
      expect(body?.error).toBe("missing_name");
    });

    test("handles POST /v1/sessions with invalid name", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "invalid session!" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(400);
      const body = await parseResponse(result!);
      expect(body?.error).toContain("invalid_name");
    });

    test("returns 404 for unknown session action", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions/test-session/unknown",
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(404);
    });

    test("returns 400 for invalid session id in path", async () => {
      const req = mockRequest({
        method: "GET",
        path: "/v1/sessions/invalid%20name",
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(400);
      const body = await parseResponse(result!);
      expect(body?.error).toContain("invalid_name");
    });
  });

  describe("session name validation", () => {
    test("accepts alphanumeric names", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "myproject123" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      // May fail if tmux isn't available, but should not fail on validation
      expect(result?.status).not.toBe(400);
    });

    test("accepts names with dashes", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "my-project" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).not.toBe(400);
    });

    test("accepts names with underscores", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "my_project" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).not.toBe(400);
    });

    test("rejects names with dots", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "my.project" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).toBe(400);
    });

    test("rejects names with spaces", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "my project" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).toBe(400);
    });

    test("rejects names with special characters", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "my@project" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).toBe(400);
    });

    test("rejects empty names", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).toBe(400);
    });

    test("rejects whitespace-only names", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "   " },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).toBe(400);
    });
  });

  describe("exec endpoint", () => {
    test("requires command parameter", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions/test/exec",
        body: {},
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      // Will be 404 (session not found) or 400 (missing command)
      // Since tmux session doesn't exist, we get 404 first
      expect([400, 404]).toContain(result!.status);
    });

    test("rejects empty command", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions/test/exec",
        body: { command: "" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect([400, 404]).toContain(result!.status);
    });
  });

  describe("input endpoint", () => {
    test("requires keys parameter", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions/test/input",
        body: {},
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect([400, 404]).toContain(result!.status);
    });

    test("rejects empty keys", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions/test/input",
        body: { keys: "" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect([400, 404]).toContain(result!.status);
    });
  });

  describe("stop endpoint", () => {
    test("returns 404 for non-existent session", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions/nonexistent-session-12345/stop",
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(404);
    });
  });

  describe("get session endpoint", () => {
    test("returns 404 for non-existent session", async () => {
      const req = mockRequest({
        method: "GET",
        path: "/v1/sessions/nonexistent-session-12345",
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(404);
    });
  });

  describe("invalid JSON handling", () => {
    test("returns 400 for invalid JSON body on create", async () => {
      const url = "http://localhost/v1/sessions";
      const req = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not valid json",
      });
      const result = await handleSessionRoutes({ req, url: new URL(url) });
      expect(result).not.toBeNull();
      expect(result?.status).toBe(400);
      const body = await parseResponse(result!);
      expect(body?.error).toBe("invalid_json");
    });

    test("returns 400 for invalid JSON body on exec", async () => {
      const url = "http://localhost/v1/sessions/test/exec";
      const req = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      });
      const result = await handleSessionRoutes({ req, url: new URL(url) });
      expect(result).not.toBeNull();
      // Will be 404 (session not found) or 400 (invalid json)
      expect([400, 404]).toContain(result!.status);
    });
  });
});
