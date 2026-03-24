import { expect, test } from "bun:test";

import {
  resolveLinearToken,
  type SecretStore,
  saveLinearToken,
} from "../src/control-plane/extensions/linear/auth.ts";
import type { ControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

function createControlPlaneConfig(overrides?: {
  readonly defaultProfile?: string;
  readonly profiles?: Record<string, Record<string, string>>;
  readonly projectLinearProfile?: string;
}): ControlPlaneConfig {
  return {
    extensions: {
      "dance.hack.linear": {
        enabled: true,
        config: {
          ...(overrides?.defaultProfile
            ? { defaultProfile: overrides.defaultProfile }
            : {}),
          ...(overrides?.profiles ? { profiles: overrides.profiles } : {}),
        },
      },
    },
    ...(overrides?.projectLinearProfile
      ? {
          routing: {
            overrides: {
              linear: {
                profile: overrides.projectLinearProfile,
              },
            },
          },
        }
      : {}),
  } as unknown as ControlPlaneConfig;
}

function createMemoryStore(): {
  readonly store: SecretStore;
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: async (input) =>
        values.get(`${input.service}:${input.name}`) ?? null,
      set: async (input) => {
        values.set(`${input.service}:${input.name}`, input.value);
      },
      delete: async (input) => values.delete(`${input.service}:${input.name}`),
    },
  };
}

test("saveLinearToken persists refresh metadata in the stored envelope", async () => {
  const config = createControlPlaneConfig({
    profiles: {
      work: {
        authRef: "linear.api.work",
        service: "hack-linear-work",
      },
    },
  });
  const memory = createMemoryStore();

  await saveLinearToken({
    controlPlaneConfig: config,
    profileId: "work",
    token: "lin_access_token",
    expiresAt: "2026-03-05T12:00:00.000Z",
    refreshToken: "lin_refresh_token",
    refreshTokenExpiresAt: "2026-04-05T12:00:00.000Z",
    store: memory.store,
  });

  const raw = memory.values.get("hack-linear-work:linear.api.work");
  expect(raw).toBeTruthy();
  const parsed = JSON.parse(raw ?? "{}") as Record<string, string>;
  expect(parsed.token).toBe("lin_access_token");
  expect(parsed.expiresAt).toBe("2026-03-05T12:00:00.000Z");
  expect(parsed.refreshToken).toBe("lin_refresh_token");
  expect(parsed.refreshTokenExpiresAt).toBe("2026-04-05T12:00:00.000Z");
});

test("resolveLinearToken refreshes expired stored credentials via auth broker", async () => {
  const fixedNowMs = Date.parse("2026-03-05T12:30:00.000Z");
  const config = createControlPlaneConfig({
    profiles: {
      default: {
        authRef: "linear.api.default",
        service: "hack-linear-auth",
      },
    },
  });
  const memory = createMemoryStore();
  memory.values.set(
    "hack-linear-auth:linear.api.default",
    JSON.stringify({
      token: "expired_access_token",
      expiresAt: "2025-03-05T12:00:00.000Z",
      refreshToken: "lin_refresh_token",
      refreshTokenExpiresAt: "2026-04-05T12:00:00.000Z",
    })
  );

  let requestBody = "";
  const resolved = await resolveLinearToken({
    controlPlaneConfig: config,
    store: memory.store,
    nowMs: fixedNowMs,
    refreshConfig: {
      baseUrl: "https://auth.hack.broker",
      fetch: (async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : input.toString();
        expect(url).toBe("https://auth.hack.broker/v1/auth/linear/refresh");
        expect(init?.method).toBe("POST");
        requestBody = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({
            ok: true,
            token: "fresh_access_token",
            tokenExpiresAt: "2026-03-06T12:00:00.000Z",
            refreshToken: "fresh_refresh_token",
            refreshTokenExpiresAt: "2026-04-06T12:00:00.000Z",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        );
      }) as typeof fetch,
    },
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.token).toBe("fresh_access_token");
  expect(resolved.expiresAt).toBe("2026-03-06T12:00:00.000Z");
  expect(requestBody).toContain('"refreshToken":"lin_refresh_token"');

  const raw = memory.values.get("hack-linear-auth:linear.api.default");
  expect(raw).toBeTruthy();
  const parsed = JSON.parse(raw ?? "{}") as Record<string, string>;
  expect(parsed.token).toBe("fresh_access_token");
  expect(parsed.refreshToken).toBe("fresh_refresh_token");
  expect(parsed.refreshTokenExpiresAt).toBe("2026-04-06T12:00:00.000Z");
});

test("resolveLinearToken can prefer env-only resolution to avoid keychain access", async () => {
  const config = createControlPlaneConfig();

  const resolved = await resolveLinearToken({
    controlPlaneConfig: config,
    env: {
      HACK_LINEAR_API_TOKEN: "env_linear_token",
      HACK_LINEAR_PREFER_ENV_TOKEN_ONLY: "true",
    },
    store: {
      get: async () => {
        throw new Error("keychain should not be read");
      },
      set: async () => {
        throw new Error("keychain should not be written");
      },
      delete: async () => false,
    },
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.token).toBe("env_linear_token");
  expect(resolved.source).toBe("env");
});

test("resolveLinearToken fails closed in env-only mode when the env token is missing", async () => {
  const config = createControlPlaneConfig();

  let keychainReadCount = 0;
  const resolved = await resolveLinearToken({
    controlPlaneConfig: config,
    env: {
      HACK_LINEAR_PREFER_ENV_TOKEN_ONLY: "true",
    },
    store: {
      get: async () => {
        keychainReadCount += 1;
        throw new Error("keychain should not be read");
      },
      set: async () => {
        throw new Error("keychain should not be written");
      },
      delete: async () => false,
    },
  });

  expect(keychainReadCount).toBe(0);
  expect(resolved.ok).toBe(false);
  if (resolved.ok) {
    return;
  }
  expect(resolved.error).toContain("HACK_LINEAR_API_TOKEN");
  expect(resolved.error).toContain("HACK_LINEAR_PREFER_ENV_TOKEN_ONLY");
});
