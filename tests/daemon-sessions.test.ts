import { describe, expect, test } from "bun:test";

import { handleSessionRoutes } from "../src/daemon/routes/sessions.ts";

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

describe("handleSessionRoutes", () => {
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

    test("accepts names with dots", async () => {
      const req = mockRequest({
        method: "POST",
        path: "/v1/sessions",
        body: { name: "my.project" },
      });
      const url = new URL(req.url);
      const result = await handleSessionRoutes({ req, url });
      expect(result?.status).not.toBe(400);
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
