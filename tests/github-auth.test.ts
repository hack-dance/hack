import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  deleteGitHubAppToken,
  exchangeGitHubAppInstallationToken,
  type FetchLike,
  resolveGitHubAppToken,
  resolveGitHubAuthSettings,
  type SecretStore,
  saveGitHubAppToken,
} from "../src/control-plane/extensions/github/auth.ts";
import type { ControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

function createControlPlaneConfig(overrides?: {
  readonly tokenEnv?: string;
  readonly authRef?: string;
  readonly service?: string;
  readonly appId?: string;
  readonly installationId?: string;
  readonly privateKeyEnv?: string;
  readonly privateKeyAuthRef?: string;
  readonly apiBaseUrl?: string;
}): ControlPlaneConfig {
  return {
    extensions: {
      "dance.hack.github": {
        enabled: true,
        config: {
          ...(overrides?.tokenEnv ? { tokenEnv: overrides.tokenEnv } : {}),
          ...(overrides?.authRef ? { authRef: overrides.authRef } : {}),
          ...(overrides?.service ? { service: overrides.service } : {}),
          ...(overrides?.appId ? { appId: overrides.appId } : {}),
          ...(overrides?.installationId
            ? { installationId: overrides.installationId }
            : {}),
          ...(overrides?.privateKeyEnv
            ? { privateKeyEnv: overrides.privateKeyEnv }
            : {}),
          ...(overrides?.privateKeyAuthRef
            ? { privateKeyAuthRef: overrides.privateKeyAuthRef }
            : {}),
          ...(overrides?.apiBaseUrl
            ? { apiBaseUrl: overrides.apiBaseUrl }
            : {}),
        },
      },
    },
    tickets: {
      git: {
        enabled: true,
        branch: "hack/tickets",
        remote: "origin",
        forceBareClone: false,
        refMode: "hidden",
      },
    },
    supervisor: {
      enabled: true,
      maxConcurrentJobs: 4,
      logsMaxBytes: 5_000_000,
    },
    tui: {
      logs: {
        maxEntries: 2000,
        maxLines: 400,
        historyTailStep: 200,
      },
    },
    usage: {
      watchIntervalMs: 2000,
      historySize: 24,
    },
    daemon: {
      autoStart: true,
      launchd: {
        installed: false,
        runAtLoad: true,
        guiSessionOnly: true,
      },
    },
    gateway: {
      enabled: false,
      bind: "127.0.0.1",
      port: 7788,
      allowWrites: false,
    },
    cluster: {
      staleAfterMs: 30_000,
      offlineAfterMs: 120_000,
    },
    providers: {
      profiles: {},
    },
    secrets: {
      backend: "keychain",
      allowEnvAuthRefs: true,
      encryptedFile: {
        path: "~/.hack/secrets.enc.json",
      },
      cloud: {
        secretPrefix: "hack",
      },
    },
    preferences: {
      appearance: { theme: "system" },
      terminal: { defaultApp: "terminal" },
      editor: { defaultApp: "cursor" },
      agents: { defaultApp: "codex", binaryPath: "" },
      sessions: { provider: "tmux", binaryPath: "" },
      containers: { provider: "docker", binaryPath: "" },
    },
  };
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

function readStoredTokenEnvelope(input: {
  readonly raw: string | undefined;
}): { readonly token: string; readonly expiresAt?: string } | null {
  const raw = input.raw?.trim() ?? "";
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (
    !(
      parsed &&
      typeof parsed === "object" &&
      "token" in parsed &&
      typeof parsed.token === "string"
    )
  ) {
    return null;
  }
  return {
    token: parsed.token,
    ...("expiresAt" in parsed && typeof parsed.expiresAt === "string"
      ? { expiresAt: parsed.expiresAt }
      : {}),
  };
}

function createPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const exported = privateKey.export({
    type: "pkcs1",
    format: "pem",
  });
  return `${exported}`.trim();
}

test("resolveGitHubAuthSettings reads extension overrides", () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.team",
    service: "hack-github-team",
  });
  const settings = resolveGitHubAuthSettings({ controlPlaneConfig: config });
  expect(settings.tokenEnv).toBe("GH_TOKEN");
  expect(settings.authRef).toBe("github.app.team");
  expect(settings.service).toBe("hack-github-team");
});

test("resolveGitHubAppToken prefers keychain token", async () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.default",
    service: "hack-github-test",
  });
  const memory = createMemoryStore();
  memory.values.set("hack-github-test:github.app.default", "keychain-token");

  const resolved = await resolveGitHubAppToken({
    controlPlaneConfig: config,
    env: { GH_TOKEN: "env-token" },
    store: memory.store,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.source).toBe("keychain");
  expect(resolved.token).toBe("keychain-token");
});

test("resolveGitHubAppToken falls back to env token", async () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.default",
    service: "hack-github-test",
  });
  const memory = createMemoryStore();

  const resolved = await resolveGitHubAppToken({
    controlPlaneConfig: config,
    env: { GH_TOKEN: "env-token" },
    store: memory.store,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.source).toBe("env");
  expect(resolved.token).toBe("env-token");
});

test("resolveGitHubAppToken returns a clear error when token is missing", async () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.default",
    service: "hack-github-test",
  });
  const memory = createMemoryStore();

  const resolved = await resolveGitHubAppToken({
    controlPlaneConfig: config,
    env: {},
    store: memory.store,
  });
  expect(resolved.ok).toBe(false);
  if (resolved.ok) {
    return;
  }
  expect(resolved.error).toContain("Missing GitHub token");
});

test("save/delete GitHub token uses configured service+authRef", async () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.default",
    service: "hack-github-test",
  });
  const memory = createMemoryStore();

  const saved = await saveGitHubAppToken({
    controlPlaneConfig: config,
    token: "secret-token",
    store: memory.store,
  });
  expect(saved.authRef).toBe("github.app.default");
  expect(saved.service).toBe("hack-github-test");
  const stored = readStoredTokenEnvelope({
    raw: memory.values.get("hack-github-test:github.app.default"),
  });
  expect(stored?.token).toBe("secret-token");

  const deleted = await deleteGitHubAppToken({
    controlPlaneConfig: config,
    store: memory.store,
  });
  expect(deleted.deleted).toBe(true);
  expect(memory.values.size).toBe(0);
});

test("exchangeGitHubAppInstallationToken signs JWT and parses response", async () => {
  const privateKey = createPrivateKeyPem();
  const calls: Array<{
    readonly url: string;
    readonly authorization: string;
  }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const authorization =
      init?.headers && init.headers instanceof Headers
        ? (init.headers.get("Authorization") ?? "")
        : ((init?.headers as Record<string, string> | undefined)
            ?.Authorization ?? "");
    calls.push({ url, authorization });
    return new Response(
      JSON.stringify({
        token: "ghs_exchanged",
        expires_at: "2026-02-21T20:30:00.000Z",
      }),
      { status: 201 }
    );
  };

  const exchanged = await exchangeGitHubAppInstallationToken({
    appId: "12345",
    installationId: "67890",
    privateKey,
    fetcher,
    nowMs: Date.parse("2026-02-21T20:00:00.000Z"),
  });

  expect(exchanged.ok).toBe(true);
  if (!exchanged.ok) {
    return;
  }
  expect(exchanged.token).toBe("ghs_exchanged");
  expect(exchanged.expiresAt).toBe("2026-02-21T20:30:00.000Z");
  expect(calls.length).toBe(1);
  expect(calls[0]?.url).toContain("/app/installations/67890/access_tokens");
  expect(calls[0]?.authorization.startsWith("Bearer ")).toBe(true);
});

test("resolveGitHubAppToken refreshes expired keychain token with App credentials", async () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.default",
    service: "hack-github-test",
    appId: "12345",
    installationId: "67890",
    privateKeyEnv: "GH_APP_PRIVATE_KEY",
  });
  const memory = createMemoryStore();
  const nowMs = Date.parse("2026-02-21T20:00:00.000Z");

  memory.values.set(
    "hack-github-test:github.app.default",
    JSON.stringify({
      token: "expired-token",
      expiresAt: "2026-02-21T19:50:00.000Z",
    })
  );

  const resolved = await resolveGitHubAppToken({
    controlPlaneConfig: config,
    env: {
      GH_TOKEN: "env-token",
      GH_APP_PRIVATE_KEY: createPrivateKeyPem(),
    },
    store: memory.store,
    nowMs,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          token: "refreshed-token",
          expires_at: "2026-02-21T21:00:00.000Z",
        }),
        { status: 201 }
      ),
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.source).toBe("refreshed");
  expect(resolved.token).toBe("refreshed-token");

  const stored = readStoredTokenEnvelope({
    raw: memory.values.get("hack-github-test:github.app.default"),
  });
  expect(stored?.token).toBe("refreshed-token");
  expect(stored?.expiresAt).toBe("2026-02-21T21:00:00.000Z");
});

test("resolveGitHubAppToken falls back to env token when refresh fails", async () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.default",
    service: "hack-github-test",
    appId: "12345",
    installationId: "67890",
    privateKeyEnv: "GH_APP_PRIVATE_KEY",
  });
  const memory = createMemoryStore();

  memory.values.set(
    "hack-github-test:github.app.default",
    JSON.stringify({
      token: "expired-token",
      expiresAt: "2026-02-21T19:50:00.000Z",
    })
  );

  const resolved = await resolveGitHubAppToken({
    controlPlaneConfig: config,
    env: {
      GH_TOKEN: "env-token",
    },
    store: memory.store,
    nowMs: Date.parse("2026-02-21T20:00:00.000Z"),
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    return;
  }
  expect(resolved.source).toBe("env");
  expect(resolved.token).toBe("env-token");
});

test("resolveGitHubAppToken returns refresh error when token is expired and no fallback exists", async () => {
  const config = createControlPlaneConfig({
    tokenEnv: "GH_TOKEN",
    authRef: "github.app.default",
    service: "hack-github-test",
    appId: "12345",
    installationId: "67890",
    privateKeyEnv: "GH_APP_PRIVATE_KEY",
  });
  const memory = createMemoryStore();

  memory.values.set(
    "hack-github-test:github.app.default",
    JSON.stringify({
      token: "expired-token",
      expiresAt: "2026-02-21T19:50:00.000Z",
    })
  );

  const resolved = await resolveGitHubAppToken({
    controlPlaneConfig: config,
    env: {},
    store: memory.store,
    nowMs: Date.parse("2026-02-21T20:00:00.000Z"),
  });

  expect(resolved.ok).toBe(false);
  if (resolved.ok) {
    return;
  }
  expect(resolved.error).toContain(
    "Stored GitHub token is expired and refresh failed"
  );
});
