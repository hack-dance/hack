import { describe, expect, test } from "bun:test";

import { handleAuthRoutes } from "../src/daemon/routes/auth.ts";

/**
 * Build a request for daemon auth route tests.
 */
function createRequest(input: {
  readonly path: string;
  readonly method?: string;
}): Request {
  return new Request(`http://127.0.0.1:8787${input.path}`, {
    method: input.method ?? "GET",
  });
}

describe("daemon auth routes", () => {
  test("health route returns service status", async () => {
    const response = await handleAuthRoutes({
      req: createRequest({ path: "/health" }),
      baseUrl: "https://auth.local.test",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly status: string;
      readonly service: string;
      readonly now: string;
    };
    expect(payload.status).toBe("ok");
    expect(payload.service).toBe("hack-auth");
    expect(payload.now.length).toBeGreaterThan(0);
  });

  test("providers route returns registered provider list", async () => {
    const response = await handleAuthRoutes({
      req: createRequest({ path: "/v1/auth/providers" }),
      baseUrl: "https://auth.local.test",
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly providers: readonly string[];
    };
    expect(payload.providers).toContain("github");
  });

  test("unsupported method returns method_not_allowed", async () => {
    const response = await handleAuthRoutes({
      req: createRequest({
        path: "/health",
        method: "DELETE",
      }),
      baseUrl: "https://auth.local.test",
    });
    expect(response.status).toBe(405);
    const payload = (await response.json()) as {
      readonly error: string;
    };
    expect(payload.error).toBe("method_not_allowed");
  });

  test("unknown path returns not_found payload", async () => {
    const response = await handleAuthRoutes({
      req: createRequest({ path: "/v1/auth/unknown" }),
      baseUrl: "https://auth.local.test",
    });
    expect(response.status).toBe(404);
    const payload = (await response.json()) as {
      readonly error: string;
    };
    expect(payload.error).toBe("not_found");
  });
});
