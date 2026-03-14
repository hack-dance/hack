import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type FetchCall = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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

const originalFetch = globalThis.fetch;
const originalLogger = process.env.HACK_LOGGER;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
const originalHome = process.env.HOME;

const { runCli } = await import("../src/cli/run.ts");
const { saveHackAuthSession } = await import("../src/lib/auth-session.ts");

let tempDir: string | null = null;
let tempGlobalConfigPath: string | null = null;

mock.module("../src/lib/os.ts", () => ({
  isMac: () => process.platform === "darwin",
  openUrl: async () => 0,
}));

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-org-team-command-"));
  tempGlobalConfigPath = resolve(tempDir, "hack.config.json");
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
  process.env.HACK_SECRETS_FILE_KEY = "test-org-team-command-key";
  process.env.HACK_LOGGER = "console";
  process.env.HACK_AUTH_BROKER_URL = undefined;
  process.env.HACK_SETUP_SYNC_MODE = "off";

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

  await saveHackAuthSession({
    session: {
      token: "hack-session-token",
      expiresAt: "2099-03-06T19:00:00.000Z",
    },
  });

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

test("org create posts slug and display name to the broker", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack.broker/v1/auth/orgs") {
      return Response.json({
        ok: true,
        organization: {
          id: "org_123",
          slug: "hack",
          name: "Hack",
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await runCliWithCapturedIo({
    argv: ["org", "create", "hack", "--name", "Hack", "--json"],
  });

  expect(result.exitCode).toBe(0);
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0]?.url).toBe("https://auth.hack.broker/v1/auth/orgs");
  expect(fetchCalls[0]?.init?.method).toBe("POST");
  expect(fetchCalls[0]?.init?.headers).toMatchObject({
    authorization: "Bearer hack-session-token",
  });
  expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
    slug: "hack",
    name: "Hack",
  });
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly organization?: { readonly slug?: string };
  };
  expect(payload.ok).toBe(true);
  expect(payload.organization?.slug).toBe("hack");
});

test("org member invite posts pending membership request to the broker", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack.broker/v1/auth/orgs/hack/members/invite") {
      return Response.json({
        ok: true,
        membership: {
          scope: "organization",
          state: "pending",
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await runCliWithCapturedIo({
    argv: ["org", "member", "invite", "hack", "person@example.com", "--json"],
  });

  expect(result.exitCode).toBe(0);
  expect(fetchCalls[0]?.url).toBe(
    "https://auth.hack.broker/v1/auth/orgs/hack/members/invite"
  );
  expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
    target: "person@example.com",
  });
  const payload = JSON.parse(result.stdout) as {
    readonly membership?: { readonly state?: string };
  };
  expect(payload.membership?.state).toBe("pending");
});

test("org member invite includes seeded team targets in the broker request", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack.broker/v1/auth/orgs/hack/members/invite") {
      return Response.json({
        ok: true,
        membership: {
          scope: "organization",
          state: "pending",
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await runCliWithCapturedIo({
    argv: [
      "org",
      "member",
      "invite",
      "hack",
      "person@example.com",
      "--team",
      "cli",
      "--json",
    ],
  });

  expect(result.exitCode).toBe(0);
  expect(fetchCalls[0]?.url).toBe(
    "https://auth.hack.broker/v1/auth/orgs/hack/members/invite"
  );
  expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
    target: "person@example.com",
    teams: ["cli"],
  });
});

test("team create posts to the broker with explicit org scope", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack.broker/v1/auth/teams") {
      return Response.json({
        ok: true,
        team: {
          id: "team_123",
          slug: "cli",
          name: "CLI",
          organizationId: "org_123",
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await runCliWithCapturedIo({
    argv: ["team", "create", "cli", "--org", "hack", "--name", "CLI", "--json"],
  });

  expect(result.exitCode).toBe(0);
  expect(fetchCalls[0]?.url).toBe("https://auth.hack.broker/v1/auth/teams");
  expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
    slug: "cli",
    org: "hack",
    name: "CLI",
  });
  const payload = JSON.parse(result.stdout) as {
    readonly team?: { readonly slug?: string };
  };
  expect(payload.team?.slug).toBe("cli");
});

test("team member remove posts the revoke action to the broker", async () => {
  fetchImpl = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack.broker/v1/auth/teams/cli/members/remove") {
      return Response.json({
        ok: true,
        membership: {
          scope: "team",
          state: "removed",
        },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await runCliWithCapturedIo({
    argv: [
      "team",
      "member",
      "remove",
      "cli",
      "user_123",
      "--org",
      "hack",
      "--json",
    ],
  });

  expect(result.exitCode).toBe(0);
  expect(fetchCalls[0]?.url).toBe(
    "https://auth.hack.broker/v1/auth/teams/cli/members/remove"
  );
  expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
    target: "user_123",
    org: "hack",
  });
});

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
