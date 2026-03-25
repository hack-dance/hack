import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  let originalSecretsKey: string | undefined;
  let originalDisableKeychainFallback: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hack-test-env-"));

    // Isolate ~/.hack state by pointing the global config path to a temp dir.
    originalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
    originalSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
    originalDisableKeychainFallback =
      process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK;
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
      Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
    }
    if (originalSecretsKey !== undefined) {
      process.env.HACK_SECRETS_FILE_KEY = originalSecretsKey;
    } else {
      Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
    }
    if (originalDisableKeychainFallback !== undefined) {
      process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK =
        originalDisableKeychainFallback;
    } else {
      Reflect.deleteProperty(
        process.env,
        "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK"
      );
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
    expect(body?.status).toMatchObject({
      trust_model: "local_only",
      custody: "machine_local",
      portability: "local_only",
      shared_state: "plaintext_compatible",
    });
    expect(body?.storage).toMatchObject({
      local_plaintext: {
        classification: {
          trust_model: "unenforced_plaintext_file",
          custody: "local_plaintext_file",
          portability: "local_only",
          shared_state: "plaintext_compatible",
        },
      },
      portable_state: {
        classification: {
          trust_model: "local_only",
          custody: "machine_local",
          portability: "local_only",
          shared_state: "plaintext_compatible",
        },
      },
    });
    expect(Array.isArray(body?.values)).toBe(true);
    const values = Array.isArray(body?.values)
      ? (body.values as unknown[])
      : [];
    const foo = values.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).key === "FOO"
    ) as Record<string, unknown> | undefined;
    expect(foo?.storage).toMatchObject({
      classification: {
        trust_model: "unenforced_plaintext_file",
        custody: "local_plaintext_file",
        portability: "local_only",
        shared_state: "plaintext_compatible",
      },
    });
  });

  test("POST /v1/env/set writes to .hack/.env and shows as resolved when broker auth is unavailable", async () => {
    const previousAuthBrokerUrl = process.env.HACK_AUTH_BROKER_URL;
    process.env.HACK_AUTH_BROKER_URL = "http://127.0.0.1:9";
    try {
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
    } finally {
      if (previousAuthBrokerUrl === undefined) {
        Reflect.deleteProperty(process.env, "HACK_AUTH_BROKER_URL");
      } else {
        process.env.HACK_AUTH_BROKER_URL = previousAuthBrokerUrl;
      }
    }
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

  test("secret set/unset uses configured encrypted_file backend", async () => {
    process.env.HACK_SECRETS_FILE_KEY = "daemon-env-secret-key";
    await writeTextFileIfChanged(
      resolve(repoRoot, ".hack", PROJECT_CONFIG_FILENAME),
      `${JSON.stringify(
        {
          name: "env-test",
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
    await writeTextFileIfChanged(
      resolve(repoRoot, ".hack", PROJECT_ENV_CONTRACT_FILENAME),
      `${JSON.stringify(
        {
          version: 1,
          vars: [{ key: "SECRET_TOKEN", required: false, source: "keychain" }],
        },
        null,
        2
      )}\n`
    );

    const setReq = mockRequest({
      method: "POST",
      path: "/v1/env/set",
      body: {
        project: "env-test",
        key: "SECRET_TOKEN",
        value: "secret-value",
        secret: true,
      },
    });
    const setRes = await handleEnvRoutes({
      req: setReq,
      url: new URL(setReq.url),
    });
    expect(setRes).not.toBeNull();
    expect(setRes?.status).toBe(200);
    const setBody = await parseResponse(setRes!);
    expect(setBody?.stored).toBe("encrypted_file");

    const getReq = mockRequest({
      method: "GET",
      path: "/v1/env?project=env-test",
    });
    const getRes = await handleEnvRoutes({
      req: getReq,
      url: new URL(getReq.url),
    });
    const getBody = await parseResponse(getRes!);
    const values = Array.isArray(getBody?.values)
      ? (getBody.values as unknown[])
      : [];
    const secret = values.find(
      (value) =>
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).key === "SECRET_TOKEN"
    ) as Record<string, unknown> | undefined;
    expect(secret?.hasValue).toBe(true);
    expect(secret?.resolvedFrom).toBe("keychain");
    expect(secret).not.toHaveProperty("value");

    const unsetReq = mockRequest({
      method: "POST",
      path: "/v1/env/unset",
      body: { project: "env-test", key: "SECRET_TOKEN" },
    });
    const unsetRes = await handleEnvRoutes({
      req: unsetReq,
      url: new URL(unsetReq.url),
    });
    const unsetBody = await parseResponse(unsetRes!);
    expect(unsetBody?.backend).toBe("encrypted_file");
    expect(unsetBody?.secretDeleted).toBe(true);
  });

  test("secret-contract plaintext writes fail closed before touching .hack/.env", async () => {
    await writeTextFileIfChanged(
      resolve(repoRoot, ".hack", PROJECT_ENV_CONTRACT_FILENAME),
      `${JSON.stringify(
        {
          version: 1,
          vars: [{ key: "SECRET_TOKEN", required: false, source: "keychain" }],
        },
        null,
        2
      )}\n`
    );

    const setReq = mockRequest({
      method: "POST",
      path: "/v1/env/set",
      body: {
        project: "env-test",
        key: "SECRET_TOKEN",
        value: "plaintext-secret",
      },
    });
    const setRes = await handleEnvRoutes({
      req: setReq,
      url: new URL(setReq.url),
    });
    expect(setRes).not.toBeNull();
    expect(setRes?.status).toBe(409);
    const setBody = await parseResponse(setRes!);
    expect(setBody?.error).toBe("contract_source_mismatch");
    expect(setBody?.message).toBeTruthy();
    const envText = await readFile(
      resolve(repoRoot, ".hack", ".env"),
      "utf8"
    ).catch(() => "");
    expect(envText).not.toContain("plaintext-secret");
  });

  test("malformed hack.env.json fails closed before plaintext writes", async () => {
    await writeTextFileIfChanged(
      resolve(repoRoot, ".hack", PROJECT_ENV_CONTRACT_FILENAME),
      '{"version":1,"vars":[{"key":"SECRET_TOKEN","source":"keychain"}\n'
    );

    const setReq = mockRequest({
      method: "POST",
      path: "/v1/env/set",
      body: {
        project: "env-test",
        key: "SECRET_TOKEN",
        value: "plaintext-secret",
      },
    });
    const setRes = await handleEnvRoutes({
      req: setReq,
      url: new URL(setReq.url),
    });
    expect(setRes).not.toBeNull();
    expect(setRes?.status).toBe(409);
    const setBody = await parseResponse(setRes!);
    expect(setBody?.error).toBe("contract_parse_error");
    expect(String(setBody?.message)).toContain("hack.env.json");
    expect(String(setBody?.message)).toContain(
      "Fix or remove the contract file"
    );
    const envText = await readFile(
      resolve(repoRoot, ".hack", ".env"),
      "utf8"
    ).catch(() => "");
    expect(envText).not.toContain("plaintext-secret");
  });

  test("missing encrypted key material returns recovery guidance instead of throwing", async () => {
    const keyPath = resolve(tempDir, "missing-secrets-file.key");
    const storePath = resolve(tempDir, "missing-secrets.enc.json");
    await writeTextFileIfChanged(
      resolve(repoRoot, ".hack", PROJECT_CONFIG_FILENAME),
      `${JSON.stringify(
        {
          name: "env-test",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              encryptedFile: {
                path: storePath,
                keyPath,
              },
            },
          },
        },
        null,
        2
      )}\n`
    );
    await writeTextFileIfChanged(
      resolve(repoRoot, ".hack", PROJECT_ENV_CONTRACT_FILENAME),
      `${JSON.stringify(
        {
          version: 1,
          vars: [{ key: "SECRET_TOKEN", required: false, source: "keychain" }],
        },
        null,
        2
      )}\n`
    );
    await writeFile(storePath, '{"ciphertext":"existing"}\n');
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "true";

    const req = mockRequest({
      method: "GET",
      path: "/v1/env?project=env-test",
    });
    const res = await handleEnvRoutes({ req, url: new URL(req.url) });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(503);
    const body = await parseResponse(res!);
    expect(body?.error).toBe("secret_store_unavailable");
    expect(body?.message).toBeTruthy();
    expect(String(body?.message)).toContain("HACK_SECRETS_FILE_KEY");
    expect(String(body?.message)).toContain(
      "will not fall back to plaintext .hack/.env"
    );
  });
});
