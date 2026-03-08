import { afterEach, expect, test } from "bun:test";

import { fetchIdentity } from "../src/linear.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("fetchIdentity sends bearer authorization for oauth tokens", async () => {
  let authorization: string | null = null;
  globalThis.fetch = ((_input, init) => {
    authorization =
      init?.headers && !Array.isArray(init.headers)
        ? ((init.headers as Record<string, string>).Authorization ?? null)
        : null;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            viewer: {
              id: "usr_123",
              displayName: "Alice Example",
              email: "alice@example.com",
              organization: {
                id: "org_123",
                name: "Hack",
              },
              teams: {
                nodes: [],
              },
            },
          },
        }),
        { status: 200 }
      )
    );
  }) as typeof fetch;

  const result = await fetchIdentity({
    apiBaseUrl: "https://api.linear.app/graphql",
    token: "linear-oauth-token",
  });

  expect(result.ok).toBe(true);
  expect(String(authorization)).toBe("Bearer linear-oauth-token");
});
