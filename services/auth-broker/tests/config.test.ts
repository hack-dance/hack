import { describe, expect, test } from "bun:test";

import { resolveConfig } from "../src/config.ts";

type EnvMap = Record<string, string | undefined>;

const ENV_KEYS = [
  "AUTH_BROKER_PUBLIC_BASE_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_SCOPES",
  "FLOW_STORE_PATH",
  "BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS",
] as const;

describe("auth broker config", () => {
  test("normalizes configured GitHub scopes", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        GITHUB_SCOPES: " read:user user:email,read:org,read:user ",
      },
      () => {
        const config = resolveConfig();
        expect(config.githubScopes).toBe("read:user,user:email,read:org");
      }
    );
  });

  test("applies default GitHub scopes when unset", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        GITHUB_SCOPES: undefined,
      },
      () => {
        const config = resolveConfig();
        expect(config.githubScopes).toBe("read:user,user:email,read:org");
      }
    );
  });

  test("parses Better Auth user auto-provision boolean", () => {
    withEnv(
      {
        GITHUB_CLIENT_ID: "test-client-id",
        GITHUB_CLIENT_SECRET: "test-client-secret",
        BETTER_AUTH_GITHUB_AUTO_PROVISION_USERS: "true",
      },
      () => {
        const config = resolveConfig();
        expect(config.betterAuthGitHubAutoProvisionUsers).toBe(true);
      }
    );
  });
});

function withEnv(overrides: EnvMap, run: () => void): void {
  const snapshot = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    setEnvKey({
      key,
      value,
    });
  }
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      setEnvKey({
        key,
        value: snapshot.get(key),
      });
    }
  }
}

function setEnvKey(input: {
  readonly key: string;
  readonly value: string | undefined;
}): void {
  if (input.value === undefined) {
    delete process.env[input.key];
    return;
  }
  process.env[input.key] = input.value;
}
