import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let tempGlobalConfigPath: string | null = null;
let previousGlobalConfigPath: string | undefined;
let previousSecretsKey: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-env-backend-"));
  tempGlobalConfigPath = resolve(tempDir, "hack.config.json");
  previousGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  previousSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  tempGlobalConfigPath = null;
  if (previousGlobalConfigPath !== undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = previousGlobalConfigPath;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  }
  if (previousSecretsKey !== undefined) {
    process.env.HACK_SECRETS_FILE_KEY = previousSecretsKey;
  } else {
    process.env.HACK_SECRETS_FILE_KEY = undefined;
  }
});

test("env backend status defaults to keychain", async () => {
  const result = await runHack({
    args: ["env", "backend", "status", "--json"],
    env: {
      ...process.env,
      HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
    },
  });
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(result.stdout) as {
    readonly backend: string;
    readonly encrypted_file: { readonly path: string };
  };
  expect(json.backend).toBe("keychain");
  expect(json.encrypted_file.path).toBe("~/.hack/secrets.enc.json");
});

test("env backend use encrypted_file persists selection", async () => {
  const result = await runHack({
    args: [
      "env",
      "backend",
      "use",
      "encrypted_file",
      "--store-path",
      "/tmp/custom-secrets.enc.json",
      "--json",
    ],
    env: {
      ...process.env,
      HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
    },
  });
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(result.stdout) as {
    readonly backend: string;
    readonly encrypted_file: { readonly path: string };
  };
  expect(json.backend).toBe("encrypted_file");
  expect(json.encrypted_file.path).toBe("/tmp/custom-secrets.enc.json");

  const configText = await readFile(tempGlobalConfigPath!, "utf8");
  expect(configText).toContain('"backend": "encrypted_file"');
  expect(configText).toContain('"/tmp/custom-secrets.enc.json"');
});

test("env backend use encrypted_file can provision a stable key file", async () => {
  if (!(tempDir && tempGlobalConfigPath)) {
    throw new Error("Missing temp global config state");
  }

  const keyPath = resolve(tempDir, "secrets-file.key");
  const result = await runHack({
    args: [
      "env",
      "backend",
      "use",
      "encrypted_file",
      "--store-path",
      "/tmp/custom-secrets.enc.json",
      "--key-path",
      keyPath,
      "--provision-key",
      "--json",
    ],
    env: {
      ...process.env,
      HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath,
    },
  });
  expect(result.exitCode).toBe(0);

  const json = JSON.parse(result.stdout) as {
    readonly backend: string;
    readonly encrypted_file: {
      readonly path: string;
      readonly keyPath?: string;
    };
  };
  expect(json.backend).toBe("encrypted_file");
  expect(json.encrypted_file.keyPath).toBe(keyPath);

  const keyText = await readFile(keyPath, "utf8");
  expect(keyText.trim().length).toBeGreaterThan(10);

  const configText = await readFile(tempGlobalConfigPath, "utf8");
  expect(configText).toContain('"keyPath"');
  expect(configText).toContain(keyPath);
});

test(
  "env backend use cloud requires provider and stores cloud settings",
  { timeout: 10_000 },
  async () => {
    const invalid = await runHack({
      args: ["env", "backend", "use", "cloud"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
      },
    });
    expect(invalid.exitCode).toBe(1);
    expect(`${invalid.stdout}\n${invalid.stderr}`).toContain(
      "Cloud backend requires --provider"
    );

    const valid = await runHack({
      args: [
        "env",
        "backend",
        "use",
        "cloud",
        "--provider",
        "aws",
        "--secret-project",
        "dev-account",
        "--secret-prefix",
        "hack-cli",
        "--json",
      ],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
      },
    });
    expect(valid.exitCode).toBe(0);
    const json = JSON.parse(valid.stdout) as {
      readonly backend: string;
      readonly cloud: {
        readonly provider?: string;
        readonly project?: string;
        readonly secretPrefix: string;
      };
    };
    expect(json.backend).toBe("cloud");
    expect(json.cloud.provider).toBe("aws");
    expect(json.cloud.project).toBe("dev-account");
    expect(json.cloud.secretPrefix).toBe("hack-cli");
  }
);

test(
  "env set --secret stores value using encrypted backend",
  { timeout: 20_000 },
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    process.env.HACK_SECRETS_FILE_KEY = "env-backend-command-key";
    const projectRoot = resolve(tempDir, "repo");
    const projectDir = resolve(projectRoot, ".hack");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "env-backend-project",
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
    await writeFile(
      resolve(projectDir, "hack.env.json"),
      `${JSON.stringify(
        {
          version: 1,
          vars: [
            {
              key: "API_KEY",
              required: false,
              source: "keychain",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const setResult = await runHack({
      args: ["env", "set", "--secret", "API_KEY=super-secret"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-backend-command-key",
      },
      cwd: projectRoot,
    });
    expect(setResult.exitCode).toBe(0);
    expect(`${setResult.stdout}\n${setResult.stderr}`).toContain(
      "encrypted_file"
    );

    const listResult = await runHack({
      args: ["env", "list", "--show-secrets", "--json"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-backend-command-key",
      },
      cwd: projectRoot,
    });
    expect(listResult.exitCode).toBe(0);
    const listJson = JSON.parse(listResult.stdout) as {
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly value: string | null;
        readonly source: string;
      }>;
    };
    const apiKey = listJson.vars.find((entry) => entry.key === "API_KEY");
    expect(apiKey?.source).toBe("keychain");
    expect(apiKey?.value).toBe("super-secret");
  }
);

test(
  "env list --json explains storage and trust boundaries",
  { timeout: 20_000 },
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    process.env.HACK_SECRETS_FILE_KEY = "env-storage-summary-key";
    const projectRoot = resolve(tempDir, "storage-repo");
    const projectDir = resolve(projectRoot, ".hack");
    const encryptedStorePath = resolve(tempDir, "storage-secrets.enc.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, ".env"),
      'PUBLIC_TOKEN="hello world"\n'
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "storage-summary-project",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              encryptedFile: {
                path: encryptedStorePath,
              },
            },
          },
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      resolve(projectDir, "hack.env.json"),
      `${JSON.stringify(
        {
          version: 1,
          vars: [
            {
              key: "PUBLIC_TOKEN",
              required: true,
              source: "plain_env",
            },
            {
              key: "DATABASE_URL",
              required: true,
              source: "keychain",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const result = await runHack({
      args: ["env", "list", "--json"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-storage-summary-key",
      },
      cwd: projectRoot,
    });

    expect(result.exitCode).toBe(1);

    const json = JSON.parse(result.stdout) as {
      readonly storage?: {
        readonly contract?: {
          readonly path: string;
          readonly trust_model: string;
        };
        readonly local_plaintext?: {
          readonly path: string;
          readonly exists: boolean;
          readonly trust_model: string;
        };
        readonly local_secrets?: {
          readonly backend: string;
          readonly location: string;
          readonly mode: string;
          readonly trust_model: string;
        };
        readonly portable_state?: {
          readonly status: string;
          readonly trust_model: string;
          readonly message: string;
        };
      };
    };

    expect(json.storage?.contract?.path).toBe(
      resolve(projectDir, "hack.env.json")
    );
    expect(json.storage?.contract?.trust_model).toBe("committed_no_values");
    expect(json.storage?.local_plaintext?.path).toBe(
      resolve(projectDir, ".env")
    );
    expect(json.storage?.local_plaintext?.exists).toBe(true);
    expect(json.storage?.local_plaintext?.trust_model).toBe(
      "gitignored_plaintext"
    );
    expect(json.storage?.local_secrets?.backend).toBe("encrypted_file");
    expect(json.storage?.local_secrets?.location).toBe(encryptedStorePath);
    expect(json.storage?.local_secrets?.mode).toBe("native");
    expect(json.storage?.local_secrets?.trust_model).toBe(
      "local_secret_backend"
    );
    expect(json.storage?.portable_state?.status).toBe("not_configured");
    expect(json.storage?.portable_state?.trust_model).toBe("local_only");
    expect(json.storage?.portable_state?.message).toContain("not portable");
  }
);

test(
  "env list shows storage summary even when no contract exists",
  { timeout: 20_000 },
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    process.env.HACK_SECRETS_FILE_KEY = "env-storage-no-contract-key";
    const projectRoot = resolve(tempDir, "no-contract-repo");
    const projectDir = resolve(projectRoot, ".hack");
    const encryptedStorePath = resolve(tempDir, "no-contract-secrets.enc.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "no-contract-project",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              encryptedFile: {
                path: encryptedStorePath,
              },
            },
          },
        },
        null,
        2
      )}\n`
    );

    const result = await runHack({
      args: ["env", "list"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_LOGGER: "console",
        HACK_SECRETS_FILE_KEY: "env-storage-no-contract-key",
      },
      cwd: projectRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Env storage");
    expect(result.stdout).toContain(resolve(projectDir, "hack.env.json"));
    expect(result.stdout).toContain(resolve(projectDir, ".env"));
    expect(result.stdout).toContain("not_configured");
    expect(result.stderr).toContain("No");
    expect(result.stderr).toContain("hack.env.json contract found");
  }
);

async function runHack(input: {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): Promise<RunResult> {
  const proc = Bun.spawn(
    ["bun", resolve(import.meta.dir, "../index.ts"), ...input.args],
    {
      cwd: input.cwd ?? resolve(import.meta.dir, ".."),
      env: input.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
