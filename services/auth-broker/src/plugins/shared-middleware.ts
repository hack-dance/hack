import { randomUUID } from "node:crypto";

import { Elysia } from "elysia";

const REQUEST_ID_HEADER = "x-request-id";

type SharedMiddlewareContext = {
  readonly requestId: string;
};

/**
 * Shared middleware plugin applied to all auth-broker routes.
 *
 * Responsibilities:
 * 1. Ensure each request has a stable request id for observability.
 * 2. Apply baseline security headers once so feature plugins don't duplicate
 *    middleware glue.
 */
export function createSharedMiddlewarePlugin() {
  return new Elysia({
    name: "hack-auth-broker.shared-middleware",
  })
    .derive(({ request, set }): SharedMiddlewareContext => {
      const requestId =
        normalizeRequestId(request.headers.get(REQUEST_ID_HEADER)) ??
        randomUUID();
      set.headers[REQUEST_ID_HEADER] = requestId;
      return { requestId };
    })
    .onAfterHandle(({ set }) => {
      ensureHeader({
        headers: set.headers,
        key: "x-content-type-options",
        value: "nosniff",
      });
      ensureHeader({
        headers: set.headers,
        key: "x-frame-options",
        value: "DENY",
      });
      ensureHeader({
        headers: set.headers,
        key: "referrer-policy",
        value: "same-origin",
      });
    });
}

function normalizeRequestId(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function ensureHeader(input: {
  readonly headers: Record<string, string | number>;
  readonly key: string;
  readonly value: string;
}): void {
  const existing = input.headers[input.key];
  if (typeof existing === "string" && existing.trim().length > 0) {
    return;
  }
  input.headers[input.key] = input.value;
}
