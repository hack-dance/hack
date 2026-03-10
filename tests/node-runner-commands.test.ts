import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readNodeAuthToken,
  readNodesRegistry,
  upsertNodeRecord,
} from "../src/lib/nodes-registry.ts";
import { findProjectContext } from "../src/lib/project.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type CliRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let fetchImpl: FetchLike;
const fetchCalls: Array<{ readonly url: string; readonly init?: RequestInit }> =
  [];

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
const originalLogger = process.env.HACK_LOGGER;
const originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;

const { runCli } = await import("../src/cli/run.ts");

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-node-runner-"));
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = resolve(tempDir, "hack.config.json");
  process.env.HACK_SECRETS_FILE_KEY = "test-node-runner-key";
  process.env.HACK_LOGGER = "console";
  process.env.HACK_SETUP_SYNC_MODE = "off";

  await writeFile(
    process.env.HACK_GLOBAL_CONFIG_PATH,
    `${JSON.stringify(
      {
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            allowEnvAuthRefs: true,
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

  await createGatewayEnabledProject({ root: resolve(tempDir, "project") });

  fetchCalls.length = 0;
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
    tempDir = null;
  }
  fetchCalls.length = 0;

  if (originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = originalHome;
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
  if (originalLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = originalLogger;
  }
  if (originalSetupSyncMode === undefined) {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("node auth verify reports missing_token when auth ref has no stored token", async () => {
  const node = await upsertNodeRecord({
    id: "node-missing-token",
    name: "Missing Token Node",
    endpoint: "http://127.0.0.1:7788",
    authRef: "env:HACK_NODE_MISSING_TOKEN",
    status: "unknown",
  });

  const result = await runCliWithCapturedIo({
    argv: ["node", "auth", "verify", "--node", node.node.id, "--json"],
  });

  expect(result.exitCode).toBe(1);
  expect(fetchCalls).toHaveLength(0);

  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly state: string;
    readonly node?: { readonly id?: string };
    readonly error?: string;
  };
  expect(payload.ok).toBe(false);
  expect(payload.state).toBe("missing_token");
  expect(payload.node?.id).toBe(node.node.id);
  expect(payload.error).toContain("Missing auth token");
});

test("node auth verify reports invalid_token on 401 response", async () => {
  process.env.HACK_NODE_INVALID_TOKEN = "node-invalid-token";
  const node = await upsertNodeRecord({
    id: "node-invalid-token",
    name: "Invalid Token Node",
    endpoint: "http://127.0.0.1:7788",
    authRef: "env:HACK_NODE_INVALID_TOKEN",
    status: "unknown",
  });

  fetchImpl = async (_input, init) => {
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer node-invalid-token",
    });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  };

  const result = await runCliWithCapturedIo({
    argv: ["node", "auth", "verify", "--node", node.node.id, "--json"],
  });

  expect(result.exitCode).toBe(1);
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly state: string;
    readonly error?: string;
  };
  expect(payload.ok).toBe(false);
  expect(payload.state).toBe("invalid_token");
  expect(payload.error).toContain("HTTP 401");
});

test("node auth verify reports ok when node status endpoint accepts the token", async () => {
  process.env.HACK_NODE_OK_TOKEN = "node-ok-token";
  const node = await upsertNodeRecord({
    id: "node-ok-token",
    name: "Healthy Node",
    endpoint: "http://127.0.0.1:7788",
    authRef: "env:HACK_NODE_OK_TOKEN",
    status: "unknown",
  });

  fetchImpl = async (_input, init) => {
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer node-ok-token",
    });
    return Response.json({
      status: "ok",
      node: {
        version: "1.2.3",
        platform: "linux",
        arch: "arm64",
      },
    });
  };

  const result = await runCliWithCapturedIo({
    argv: ["node", "auth", "verify", "--node", node.node.id, "--json"],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly state: string;
    readonly node?: {
      readonly id?: string;
      readonly version?: string;
      readonly platform?: string;
      readonly arch?: string;
    };
  };
  expect(payload.ok).toBe(true);
  expect(payload.state).toBe("ok");
  expect(payload.node?.id).toBe(node.node.id);
  expect(payload.node?.version).toBe("1.2.3");
  expect(payload.node?.platform).toBe("linux");
  expect(payload.node?.arch).toBe("arm64");
});

test("node ensure creates a local registration and stores a token for the provided auth ref", async () => {
  fetchImpl = async (_input, init) => {
    expect(init?.headers).toMatchObject({
      Authorization: expect.stringContaining("Bearer "),
    });
    return Response.json({
      status: "ok",
      node: {
        version: "2.0.0",
        platform: "darwin",
        arch: "arm64",
      },
    });
  };

  const result = await runCliWithCapturedIo({
    argv: [
      "node",
      "ensure",
      "--auth-ref",
      "env:HACK_NODE_ENSURE_TOKEN",
      "--name",
      "Runner Node",
      "--default",
      "--json",
    ],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly created: boolean;
    readonly node?: { readonly name?: string; readonly authRef?: string };
    readonly token?: string;
  };
  expect(payload.ok).toBe(true);
  expect(payload.created).toBe(true);
  expect(payload.node?.name).toBe("Runner Node");
  expect(payload.node?.authRef).toBe("env:HACK_NODE_ENSURE_TOKEN");
  expect(payload.token).toBe(process.env.HACK_NODE_ENSURE_TOKEN);

  const registry = await readNodesRegistry();
  expect(registry.nodes).toHaveLength(1);
  expect(registry.defaultNodeId).toBe(registry.nodes[0]?.id ?? null);
});

test("node ensure reuses an existing healthy node without minting a new token", async () => {
  fetchImpl = async () =>
    Response.json({
      status: "ok",
      node: {
        version: "2.0.0",
        platform: "darwin",
        arch: "arm64",
      },
    });

  const first = await runCliWithCapturedIo({
    argv: [
      "node",
      "ensure",
      "--auth-ref",
      "env:HACK_NODE_REUSE_TOKEN",
      "--name",
      "Reusable Runner",
      "--json",
    ],
  });
  expect(first.exitCode).toBe(0);
  const firstPayload = JSON.parse(first.stdout) as {
    readonly node?: { readonly id?: string };
    readonly token?: string;
  };
  const firstToken = firstPayload.token;

  const second = await runCliWithCapturedIo({
    argv: [
      "node",
      "ensure",
      "--auth-ref",
      "env:HACK_NODE_REUSE_TOKEN",
      "--name",
      "Reusable Runner",
      "--json",
    ],
  });

  expect(second.exitCode).toBe(0);
  const secondPayload = JSON.parse(second.stdout) as {
    readonly ok: boolean;
    readonly created: boolean;
    readonly node?: { readonly id?: string };
    readonly token?: string;
  };
  expect(secondPayload.ok).toBe(true);
  expect(secondPayload.created).toBe(false);
  expect(secondPayload.node?.id).toBe(firstPayload.node?.id);
  expect(secondPayload.token).toBeUndefined();
  expect(process.env.HACK_NODE_REUSE_TOKEN).toBe(firstToken);
});

test("node ensure repairs a missing token for an existing auth ref", async () => {
  const existing = await upsertNodeRecord({
    id: "node-repair-token",
    name: "Repair Me",
    endpoint: "http://127.0.0.1:7788",
    authRef: "env:HACK_NODE_REPAIR_TOKEN",
    status: "unknown",
  });

  fetchImpl = async () =>
    Response.json({
      status: "ok",
      node: {
        version: "2.0.0",
        platform: "darwin",
        arch: "arm64",
      },
    });

  const result = await runCliWithCapturedIo({
    argv: [
      "node",
      "ensure",
      "--auth-ref",
      "env:HACK_NODE_REPAIR_TOKEN",
      "--name",
      "Repair Me",
      "--json",
    ],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly ok: boolean;
    readonly created: boolean;
    readonly node?: { readonly id?: string };
    readonly token?: string;
  };
  expect(payload.ok).toBe(true);
  expect(payload.created).toBe(false);
  expect(payload.node?.id).toBe(existing.node.id);
  expect(payload.token).toBe(process.env.HACK_NODE_REPAIR_TOKEN);
  expect(
    await readNodeAuthToken({ authRef: "env:HACK_NODE_REPAIR_TOKEN" })
  ).toBe(process.env.HACK_NODE_REPAIR_TOKEN);
});

async function createGatewayEnabledProject(input: {
  readonly root: string;
}): Promise<void> {
  await mkdir(resolve(input.root, ".hack"), { recursive: true });
  await writeFile(
    resolve(input.root, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(
    resolve(input.root, ".hack", "hack.config.json"),
    `${JSON.stringify(
      {
        name: "node-runner-test-project",
        controlPlane: {
          gateway: {
            enabled: true,
          },
        },
      },
      null,
      2
    )}\n`
  );
  const ctx = await findProjectContext(input.root);
  if (!ctx) {
    throw new Error("Missing project context");
  }
  await upsertProjectRegistration({ project: ctx });
}

async function runCliWithCapturedIo(input: {
  readonly argv: readonly string[];
}): Promise<CliRunResult> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    const exitCode = await runCli(input.argv);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
