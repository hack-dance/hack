import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
} from "../src/constants.ts";
import { handleEnvRoutes } from "../src/daemon/routes/env.ts";
import { ensureDir, writeTextFileIfChanged } from "../src/lib/fs.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";

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

describe("handleEnvRoutes", () => {
  let tempDir: string;
  let repoRoot: string;
  let originalConfigPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hack-test-env-"));

    // Isolate ~/.hack state by pointing the global config path to a temp dir.
    originalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
    process.env.HACK_GLOBAL_CONFIG_PATH = join(tempDir, "hack.config.json");

    repoRoot = join(tempDir, "repo");
    const hackDir = join(repoRoot, ".hack");
    await ensureDir(hackDir);

    await writeTextFileIfChanged(
      resolve(hackDir, PROJECT_CONFIG_FILENAME),
      `${JSON.stringify({ name: "env-test", dev_host: "env-test.hack" }, null, 2)}\n`
    );

    await writeTextFileIfChanged(
      resolve(hackDir, PROJECT_COMPOSE_FILENAME),
      ["services:", "  app:", "    image: alpine:3.20", ""].join("\n")
    );

    await writeTextFileIfChanged(
      resolve(hackDir, PROJECT_ENV_CONTRACT_FILENAME),
      `${JSON.stringify(
        {
          version: 1,
          vars: [{ key: "FOO", required: false, source: "plain_env" }],
        },
        null,
        2
      )}\n`
    );

    await upsertProjectRegistration({
      project: {
        projectRoot: repoRoot,
        projectDirName: ".hack",
        projectDir: hackDir,
        composeFile: resolve(hackDir, PROJECT_COMPOSE_FILENAME),
        envFile: resolve(hackDir, ".env"),
        configFile: resolve(hackDir, PROJECT_CONFIG_FILENAME),
      },
    });
  });

  afterEach(async () => {
    if (originalConfigPath !== undefined) {
      process.env.HACK_GLOBAL_CONFIG_PATH = originalConfigPath;
    } else {
      process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns null for non-env routes", async () => {
    const req = mockRequest({ method: "GET", path: "/v1/status" });
    const url = new URL(req.url);
    const result = await handleEnvRoutes({ req, url });
    expect(result).toBeNull();
  });

  test("GET /v1/env without project returns 400", async () => {
    const req = mockRequest({ method: "GET", path: "/v1/env" });
    const url = new URL(req.url);
    const result = await handleEnvRoutes({ req, url });
    expect(result).not.toBeNull();
    expect(result?.status).toBe(400);
    const body = await parseResponse(result!);
    expect(body?.error).toBe("missing_project");
  });

  test("GET /v1/env returns contract and resolution state", async () => {
    const req = mockRequest({
      method: "GET",
      path: "/v1/env?project=env-test",
    });
    const url = new URL(req.url);
    const result = await handleEnvRoutes({ req, url });
    expect(result).not.toBeNull();
    expect(result?.status).toBe(200);
    const body = await parseResponse(result!);
    expect(body?.project).toBeTruthy();
    expect(body?.contract).toBeTruthy();
    expect(Array.isArray(body?.values)).toBe(true);
  });

  test("POST /v1/env/set writes to .hack/.env and shows as resolved", async () => {
    const setReq = mockRequest({
      method: "POST",
      path: "/v1/env/set",
      body: { project: "env-test", key: "FOO", value: "bar" },
    });
    const setUrl = new URL(setReq.url);
    const setRes = await handleEnvRoutes({ req: setReq, url: setUrl });
    expect(setRes).not.toBeNull();
    expect(setRes?.status).toBe(200);

    const getReq = mockRequest({
      method: "GET",
      path: "/v1/env?project=env-test",
    });
    const getUrl = new URL(getReq.url);
    const getRes = await handleEnvRoutes({ req: getReq, url: getUrl });
    expect(getRes).not.toBeNull();
    expect(getRes?.status).toBe(200);
    const body = await parseResponse(getRes!);
    const values = Array.isArray(body?.values)
      ? (body?.values as unknown[])
      : [];
    const foo = values.find(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        (v as Record<string, unknown>).key === "FOO"
    ) as Record<string, unknown> | undefined;
    expect(foo?.hasValue).toBe(true);
    expect(foo?.resolvedFrom).toBe("dotenv");
  });

  test("POST /v1/env/unset clears .hack/.env and shows as missing", async () => {
    const setReq = mockRequest({
      method: "POST",
      path: "/v1/env/set",
      body: { project: "env-test", key: "FOO", value: "bar" },
    });
    const setUrl = new URL(setReq.url);
    await handleEnvRoutes({ req: setReq, url: setUrl });

    const unsetReq = mockRequest({
      method: "POST",
      path: "/v1/env/unset",
      body: { project: "env-test", key: "FOO" },
    });
    const unsetUrl = new URL(unsetReq.url);
    const unsetRes = await handleEnvRoutes({ req: unsetReq, url: unsetUrl });
    expect(unsetRes).not.toBeNull();
    expect(unsetRes?.status).toBe(200);

    const getReq = mockRequest({
      method: "GET",
      path: "/v1/env?project=env-test",
    });
    const getUrl = new URL(getReq.url);
    const getRes = await handleEnvRoutes({ req: getReq, url: getUrl });
    const body = await parseResponse(getRes!);
    const values = Array.isArray(body?.values)
      ? (body?.values as unknown[])
      : [];
    const foo = values.find(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        (v as Record<string, unknown>).key === "FOO"
    ) as Record<string, unknown> | undefined;
    expect(foo?.hasValue).toBe(false);
  });
});
