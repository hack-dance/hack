import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const openUrlCalls: string[] = [];

type FetchCall = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

let fetchCalls: FetchCall[] = [];
let fetchImpl: FetchLike = async () =>
  new Response("not mocked", {
    status: 500,
    headers: { "content-type": "text/plain" },
  });

mock.module("../src/lib/os.ts", () => ({
  isMac: () => process.platform === "darwin",
  openUrl: async (url: string) => {
    openUrlCalls.push(url);
    return 0;
  },
}));

const originalFetch = globalThis.fetch;
const originalLogger = process.env.HACK_LOGGER;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
const originalHome = process.env.HOME;

const { runCli } = await import("../src/cli/run.ts");
const { loadHackAuthSession, saveHackAuthSession } = await import(
  "../src/lib/auth-session.ts"
);

let tempDir: string | null = null;
let tempGlobalConfigPath: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-auth-command-"));
  tempGlobalConfigPath = resolve(tempDir, "hack.config.json");
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
  process.env.HACK_SECRETS_FILE_KEY = "test-auth-command-key";
  process.env.HACK_LOGGER = "console";
  process.env.HACK_AUTH_BROKER_URL = undefined;

  await writeFile(
    tempGlobalConfigPath,
    `${JSON.stringify(
      {
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: {
              path: resolve(tempDir, "secrets.enc.json"),
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  openUrlCalls.length = 0;
  fetchCalls = [];
  fetchImpl = async () =>
    new Response("not mocked", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetchCalls.push({ url, init });
    return await fetchImpl(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
  tempGlobalConfigPath = null;

  if (originalLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = originalLogger;
  }
  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
  if (originalSecretsKey === undefined) {
    process.env.HACK_SECRETS_FILE_KEY = undefined;
  } else {
    process.env.HACK_SECRETS_FILE_KEY = originalSecretsKey;
  }
  if (originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = originalHome;
  }
});

afterAll(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
});

test("auth login opens browser, claims token, and stores the auth session", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack.broker/v1/auth/session/start") {
      return Response.json({
        ok: true,
        flow: {
          flowId: "flow-123",
          authorizeUrl:
            "https://auth.hack.broker/auth?flowId=flow-123&deviceCode=device-123",
          deviceCode: "device-123",
          pollUrl: "https://auth.hack.broker/v1/auth/session/flows/flow-123",
          expiresAt: "2099-03-06T18:00:00.000Z",
          socialProviders: [{ id: "github", label: "GitHub" }],
        },
      });
    }
    if (
      url ===
      "https://auth.hack.broker/v1/auth/session/flows/flow-123?claim=1&deviceCode=device-123"
    ) {
      return Response.json({
        ok: true,
        status: {
          status: "claimed",
          managementToken: "hack-session-token",
          managementTokenExpiresAt: "2099-03-06T19:00:00.000Z",
        },
      });
    }
    if (url === "https://auth.hack.broker/v1/auth/me") {
      return Response.json({
        ok: true,
        authenticated: true,
        accessControlMode: "better_auth_team_owned",
        session: {
          userId: "user_123",
          organizationId: "org_123",
          teamId: "team_123",
        },
        user: {
          id: "user_123",
          email: "dio@hack.dance",
          name: "Dio",
        },
        activeOrganization: {
          id: "org_123",
          slug: "hack",
          name: "Hack",
        },
        activeTeam: {
          id: "team_123",
          slug: "cli",
          name: "CLI",
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await runCliWithCapturedIo({
    argv: ["auth", "login", "--json"],
  });

  expect(result.exitCode).toBe(0);
  expect(openUrlCalls).toEqual([
    "https://auth.hack.broker/auth?flowId=flow-123&deviceCode=device-123",
  ]);
  expect(fetchCalls.map((call) => call.url)).toEqual([
    "https://auth.hack.broker/v1/auth/session/start",
    "https://auth.hack.broker/v1/auth/session/flows/flow-123?claim=1&deviceCode=device-123",
    "https://auth.hack.broker/v1/auth/me",
  ]);

  const stored = await readStoredTokenEnvelope();
  expect(stored?.token).toBe("hack-session-token");
  expect(stored?.expiresAt).toBe("2099-03-06T19:00:00.000Z");

  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly authenticated: boolean;
    readonly flowId: string;
    readonly brokerBaseUrl: string;
    readonly tokenStored: boolean;
    readonly accessControlMode: string;
    readonly user?: {
      readonly email?: string;
    };
    readonly activeOrganization?: {
      readonly slug?: string;
    };
    readonly activeTeam?: {
      readonly slug?: string;
    };
  };
  expect(payload.ok).toBe(true);
  expect(payload.authenticated).toBe(true);
  expect(payload.flowId).toBe("flow-123");
  expect(payload.brokerBaseUrl).toBe("https://auth.hack.broker");
  expect(payload.tokenStored).toBe(true);
  expect(payload.accessControlMode).toBe("better_auth_team_owned");
  expect(payload.user?.email).toBe("dio@hack.dance");
  expect(payload.activeOrganization?.slug).toBe("hack");
  expect(payload.activeTeam?.slug).toBe("cli");
});

test("auth login forwards a desktop return URL to the broker session start route", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (
      url ===
      "https://auth.hack.broker/v1/auth/session/start?redirect=hack%3A%2F%2Fauth%2Fcomplete"
    ) {
      return Response.json({
        ok: true,
        flow: {
          flowId: "flow-redirect",
          authorizeUrl:
            "https://auth.hack.broker/auth?flowId=flow-redirect&deviceCode=device-redirect&redirect=hack%3A%2F%2Fauth%2Fcomplete",
          deviceCode: "device-redirect",
          pollUrl:
            "https://auth.hack.broker/v1/auth/session/flows/flow-redirect",
          expiresAt: "2099-03-06T18:00:00.000Z",
          socialProviders: [{ id: "github", label: "GitHub" }],
        },
      });
    }
    if (
      url ===
      "https://auth.hack.broker/v1/auth/session/flows/flow-redirect?claim=1&deviceCode=device-redirect"
    ) {
      return Response.json({
        ok: true,
        status: {
          status: "claimed",
          managementToken: "hack-session-token",
        },
      });
    }
    if (url === "https://auth.hack.broker/v1/auth/me") {
      return Response.json({
        ok: true,
        authenticated: true,
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await runCliWithCapturedIo({
    argv: ["auth", "login", "--json", "--redirect", "hack://auth/complete"],
  });

  expect(result.exitCode).toBe(0);
  expect(fetchCalls.map((call) => call.url)).toEqual([
    "https://auth.hack.broker/v1/auth/session/start?redirect=hack%3A%2F%2Fauth%2Fcomplete",
    "https://auth.hack.broker/v1/auth/session/flows/flow-redirect?claim=1&deviceCode=device-redirect",
    "https://auth.hack.broker/v1/auth/me",
  ]);
  expect(openUrlCalls).toEqual([
    "https://auth.hack.broker/auth?flowId=flow-redirect&deviceCode=device-redirect&redirect=hack%3A%2F%2Fauth%2Fcomplete",
  ]);
});

test("auth whoami uses stored token against broker /v1/auth/me", async () => {
  await writeStoredTokenEnvelope({ token: "hack-session-token" });

  fetchImpl = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    expect(url).toBe("https://auth.hack.broker/v1/auth/me");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer hack-session-token",
    });
    return Response.json({
      ok: true,
      authenticated: true,
      accessControlMode: "better_auth_team_owned",
      session: {
        userId: "user_123",
        organizationId: "org_123",
        teamId: "team_123",
      },
    });
  };

  const result = await runCliWithCapturedIo({
    argv: ["auth", "whoami", "--json"],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly authenticated: boolean;
    readonly session: {
      readonly userId: string;
      readonly organizationId: string;
      readonly teamId: string;
    };
  };
  expect(payload.ok).toBe(true);
  expect(payload.authenticated).toBe(true);
  expect(payload.session.userId).toBe("user_123");
  expect(payload.session.organizationId).toBe("org_123");
  expect(payload.session.teamId).toBe("team_123");
});

test("auth status includes resolved account, org, and team metadata", async () => {
  await writeStoredTokenEnvelope({ token: "hack-session-token" });

  fetchImpl = async () =>
    Response.json({
      ok: true,
      authenticated: true,
      accessControlMode: "better_auth_team_owned",
      user: {
        id: "user_123",
        email: "hack@example.com",
        name: "Hack User",
        emailVerified: true,
      },
      activeOrganization: {
        id: "org_123",
        name: "Hack Org",
      },
      activeTeam: {
        id: "team_123",
        name: "Infra",
      },
      session: {
        userId: "user_123",
        organizationId: "org_123",
        teamId: "team_123",
      },
      shellPath: "/auth",
      accountPath: "/auth/account",
    });

  const result = await runCliWithCapturedIo({
    argv: ["auth", "status", "--json"],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly authenticated: boolean;
    readonly validated: boolean;
    readonly user?: {
      readonly id: string;
      readonly email: string;
      readonly name: string;
    };
    readonly activeOrganization?: {
      readonly id: string;
      readonly name: string;
    };
    readonly activeTeam?: {
      readonly id: string;
      readonly name: string;
    };
    readonly shellPath?: string;
    readonly accountPath?: string;
  };
  expect(payload.authenticated).toBe(true);
  expect(payload.validated).toBe(true);
  expect(payload.user?.email).toBe("hack@example.com");
  expect(payload.activeOrganization?.name).toBe("Hack Org");
  expect(payload.activeTeam?.name).toBe("Infra");
  expect(payload.shellPath).toBe("/auth");
  expect(payload.accountPath).toBe("/auth/account");
});

test("auth logout clears the stored auth session", async () => {
  await writeStoredTokenEnvelope({ token: "hack-session-token" });

  const result = await runCliWithCapturedIo({
    argv: ["auth", "logout", "--json"],
  });

  expect(result.exitCode).toBe(0);
  const stored = await readStoredTokenEnvelope();
  expect(stored).toBeNull();
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly loggedOut: boolean;
    readonly hadToken: boolean;
  };
  expect(payload.ok).toBe(true);
  expect(payload.loggedOut).toBe(true);
  expect(payload.hadToken).toBe(true);
});

test("auth login reports a helpful error when broker session start is unavailable", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    expect(url).toBe("https://auth.hack.broker/v1/auth/session/start");
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const result = await runCliWithCapturedIo({
    argv: ["auth", "login"],
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("/v1/auth/session/start");
  expect(result.stderr.toLowerCase()).toContain("auth broker");
});

test("auth status reports stored-token state even when broker validation endpoint is missing", async () => {
  await writeStoredTokenEnvelope({ token: "hack-session-token" });

  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    expect(url).toBe("https://auth.hack.broker/v1/auth/me");
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  const result = await runCliWithCapturedIo({
    argv: ["auth", "status", "--json"],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly authenticated: boolean;
    readonly tokenStored: boolean;
    readonly validated: boolean;
    readonly error: string;
  };
  expect(payload.authenticated).toBe(false);
  expect(payload.tokenStored).toBe(true);
  expect(payload.validated).toBe(false);
  expect(payload.error).toContain("/v1/auth/me");
});

test("auth status interactive output tells the user to run hack auth login when no session exists", async () => {
  const result = await runCliWithCapturedIo({
    argv: ["auth", "status"],
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("Not authenticated with Hack auth");
  expect(result.stderr).toContain("hack auth login");
});

test("auth status json includes a next step when login is required", async () => {
  const result = await runCliWithCapturedIo({
    argv: ["auth", "status", "--json"],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly authenticated: boolean;
    readonly tokenStored: boolean;
    readonly loginRequired?: boolean;
    readonly nextStep?: string;
  };
  expect(payload.authenticated).toBe(false);
  expect(payload.tokenStored).toBe(false);
  expect(payload.loginRequired).toBe(true);
  expect(payload.nextStep).toContain("hack auth login");
});

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type StoredTokenEnvelope = {
  readonly token: string;
  readonly expiresAt?: string;
};

async function writeStoredTokenEnvelope(
  input: StoredTokenEnvelope
): Promise<void> {
  await saveHackAuthSession({
    session: input,
  });
}

async function readStoredTokenEnvelope(): Promise<StoredTokenEnvelope | null> {
  return await loadHackAuthSession();
}

async function runCliWithCapturedIo(input: {
  readonly argv: readonly string[];
}): Promise<CapturedRunResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    );
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    );
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await runCli([...input.argv]);
    return {
      exitCode,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
