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

test(
  "env backend status defaults to keychain",
  async () => {
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
      readonly status: {
        readonly storage_mode: string;
        readonly trust_model: string;
        readonly portability: string;
        readonly plaintext_compatibility: string;
        readonly classification: {
          readonly trust_model: string;
          readonly custody: string;
          readonly portability: string;
          readonly shared_state: string;
        };
      };
    };
    expect(json.backend).toBe("keychain");
    expect(json.encrypted_file.path).toBe("~/.hack/secrets.enc.json");
    expect(json.status.storage_mode).toContain("Encrypted OS-managed");
    expect(json.status.trust_model).toBe("Machine-local secret custody");
    expect(json.status.plaintext_compatibility).toContain(".hack/.env");
    expect(json.status.classification).toEqual({
      trust_model: "local_secret_backend",
      custody: "local_secret_backend",
      portability: "local_only",
      shared_state: "plaintext_compatible",
    });
  },
  { timeout: 20_000 }
);

test(
  "env backend use encrypted_file persists selection",
  async () => {
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
  },
  { timeout: 20_000 }
);

test(
  "env backend use encrypted_file can provision a stable key file",
  async () => {
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
  },
  { timeout: 40_000 }
);

test(
  "env backend use cloud requires provider and stores cloud settings",
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
  },
  { timeout: 40_000 }
);

test(
  "env set --secret stores value using encrypted backend",
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
    const plaintextCompatibility = await readFile(
      resolve(projectDir, ".env"),
      "utf8"
    ).catch(() => "");
    expect(plaintextCompatibility).not.toContain("super-secret");

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
        readonly storage: {
          readonly kind: string;
          readonly backend: string;
          readonly location: string;
          readonly mode: string;
        };
      }>;
    };
    const apiKey = listJson.vars.find((entry) => entry.key === "API_KEY");
    expect(apiKey?.source).toBe("keychain");
    expect(apiKey?.storage.kind).toBe("secret");
    expect(apiKey?.storage.backend).toBe("encrypted_file");
    expect(apiKey?.storage.mode).toBe("native");
    expect(apiKey?.value).toBe("super-secret");

    const redactedListResult = await runHack({
      args: ["env", "list", "--json"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-backend-command-key",
      },
      cwd: projectRoot,
    });
    expect(redactedListResult.exitCode).toBe(0);
    const redactedListJson = JSON.parse(redactedListResult.stdout) as {
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly value: string | null;
      }>;
    };
    expect(
      redactedListJson.vars.find((entry) => entry.key === "API_KEY")?.value
    ).toBe("***");

    const listTextResult = await runHack({
      args: ["env", "list", "--show-secrets"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-backend-command-key",
      },
      cwd: projectRoot,
    });
    expect(listTextResult.exitCode).toBe(0);
    expect(listTextResult.stdout).toContain("API_KEY\toptional\tkeychain\t");
    expect(listTextResult.stdout).toContain("secret:encrypted_file");
  },
  { timeout: 40_000 }
);

test(
  "env set rejects plaintext writes for keychain contract keys",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    const projectRoot = resolve(tempDir, "repo-secret-mismatch");
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
          name: "env-secret-mismatch-project",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              encryptedFile: {
                path: resolve(tempDir, "secret-mismatch.enc.json"),
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
              key: "SECRET_TOKEN",
              required: false,
              source: "keychain",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const result = await runHack({
      args: ["env", "set", "SECRET_TOKEN=super-secret"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
      },
      cwd: projectRoot,
    });
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'declared as source "keychain"'
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain("--secret");
    const envText = await readFile(resolve(projectDir, ".env"), "utf8").catch(
      () => ""
    );
    expect(envText).not.toContain("super-secret");
  },
  { timeout: 40_000 }
);

test(
  "env list reports missing encrypted key recovery guidance without a stack trace",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    const projectRoot = resolve(tempDir, "repo-missing-key");
    const projectDir = resolve(projectRoot, ".hack");
    const keyPath = resolve(tempDir, "missing-secrets-file.key");
    const storePath = resolve(tempDir, "missing-secrets.enc.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "env-missing-key-project",
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
    await writeFile(
      resolve(projectDir, "hack.env.json"),
      `${JSON.stringify(
        {
          version: 1,
          vars: [
            {
              key: "SECRET_TOKEN",
              required: false,
              source: "keychain",
            },
          ],
        },
        null,
        2
      )}\n`
    );
    await writeFile(storePath, '{"ciphertext":"existing"}\n');

    const result = await runHack({
      args: ["env", "list", "--json"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "true",
      },
      cwd: projectRoot,
    });
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Missing encrypted backend key"
    );
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "will not fall back to plaintext .hack/.env"
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "resolveEncryptedFileKeyMaterial"
    );
  },
  { timeout: 40_000 }
);

test(
  "env list json exposes compatibility mode and local-only portable status",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    process.env.HACK_SECRETS_FILE_KEY = "env-backend-command-key";
    const projectRoot = resolve(tempDir, "repo-list");
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
          name: "env-list-project",
          controlPlane: {
            secrets: {
              backend: "cloud",
              encryptedFile: {
                path: resolve(tempDir, "cloud-shim.enc.json"),
              },
              cloud: {
                provider: "aws",
                project: "dev-account",
                secretPrefix: "hack",
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
              key: "PUBLIC_URL",
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
    await writeFile(
      resolve(projectDir, ".env"),
      "PUBLIC_URL=https://example.test\n"
    );

    const result = await runHack({
      args: ["env", "list", "--json"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-backend-command-key",
      },
      cwd: projectRoot,
    });
    expect(result.exitCode).toBe(1);

    const json = JSON.parse(result.stdout) as {
      readonly status: {
        readonly trust_model: string;
        readonly custody: string;
        readonly portability: string;
        readonly shared_state: string;
      };
      readonly storage: {
        readonly local_plaintext: {
          readonly path: string;
          readonly exists: boolean;
          readonly classification: {
            readonly trust_model: string;
            readonly custody: string;
            readonly portability: string;
            readonly shared_state: string;
          };
        };
        readonly local_secrets: {
          readonly backend: string;
          readonly mode: string;
          readonly trust_model: string;
          readonly classification: {
            readonly trust_model: string;
            readonly custody: string;
            readonly portability: string;
            readonly shared_state: string;
          };
        };
        readonly portable_state: {
          readonly status: string;
          readonly trust_model: string;
          readonly message: string;
          readonly classification: {
            readonly trust_model: string;
            readonly custody: string;
            readonly portability: string;
            readonly shared_state: string;
          };
        };
        readonly compatibility_mode: {
          readonly plaintext_target: string;
          readonly secret_backend: string;
          readonly summary: string;
        };
      };
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly storage: {
          readonly kind: string;
          readonly backend: string;
          readonly location: string;
          readonly mode: string;
        };
      }>;
      readonly missing_required: readonly string[];
    };

    expect(json.status).toMatchObject({
      trust_model: "local_only",
      custody: "machine_local",
      portability: "local_only",
      shared_state: "plaintext_compatible",
    });
    expect(json.storage.local_plaintext.exists).toBe(true);
    expect(json.storage.local_plaintext.classification).toEqual({
      trust_model: "unenforced_plaintext_file",
      custody: "local_plaintext_file",
      portability: "local_only",
      shared_state: "plaintext_compatible",
    });
    expect(json.storage.compatibility_mode.plaintext_target).toContain(
      ".hack/.env"
    );
    expect(json.storage.compatibility_mode.secret_backend).toBe("cloud");
    expect(json.storage.compatibility_mode.summary).toContain(
      "configured secret backend"
    );
    expect(json.storage.local_secrets.mode).toBe("shim");
    expect(json.storage.local_secrets.trust_model).toBe(
      "local_secret_backend_shim"
    );
    expect(json.storage.local_secrets.classification).toEqual({
      trust_model: "local_secret_backend_shim",
      custody: "local_secret_backend_shim",
      portability: "local_only",
      shared_state: "local_only",
    });
    expect(json.storage.portable_state.status).toBe("not_configured");
    expect(json.storage.portable_state.trust_model).toBe("local_only");
    expect(json.storage.portable_state.message).toContain(
      "not portable across machines"
    );
    expect(json.storage.portable_state.classification).toEqual({
      trust_model: "local_only",
      custody: "machine_local",
      portability: "local_only",
      shared_state: "plaintext_compatible",
    });
    const publicUrl = json.vars.find((entry) => entry.key === "PUBLIC_URL");
    const databaseUrl = json.vars.find((entry) => entry.key === "DATABASE_URL");
    expect(publicUrl?.storage.kind).toBe("plaintext");
    expect(publicUrl?.storage.backend).toBe("dotenv");
    expect(publicUrl?.storage.location).toContain(".hack/.env");
    expect(databaseUrl?.storage.kind).toBe("secret");
    expect(databaseUrl?.storage.backend).toBe("cloud");
    expect(databaseUrl?.storage.mode).toBe("shim");
    expect(json.missing_required).toContain("DATABASE_URL");
  },
  { timeout: 40_000 }
);

test(
  "env set preserves multiline plain_env values through .env round-trip",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    const projectRoot = resolve(tempDir, "repo");
    const projectDir = resolve(projectRoot, ".hack");
    const multilineValue = [
      "-----BEGIN PUBLIC KEY-----",
      String.raw`line\with\backslashes+plus`,
      'line"with"quotes',
      "-----END PUBLIC KEY-----",
    ].join("\n");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, "hack.env.json"),
      `${JSON.stringify(
        {
          version: 1,
          vars: [
            {
              key: "PUBLIC_CERT",
              required: false,
              source: "plain_env",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const setResult = await runHack({
      args: ["env", "set", `PUBLIC_CERT=${multilineValue}`],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
      },
      cwd: projectRoot,
    });
    expect(setResult.exitCode).toBe(0);

    const envText = await readFile(resolve(projectDir, ".env"), "utf8");
    expect(envText).toContain("PUBLIC_CERT=");
    expect(envText).toContain("\\\\");
    expect(envText).toContain('\\"');

    const listResult = await runHack({
      args: ["env", "list", "--show-secrets", "--json"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
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
    const publicCert = listJson.vars.find(
      (entry) => entry.key === "PUBLIC_CERT"
    );
    expect(publicCert?.source).toBe("plain_env");
    expect(publicCert?.value).toBe(multilineValue);
  },
  { timeout: 40_000 }
);

test(
  "env set can bundle plain_env values into encrypted backend for portability",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    process.env.HACK_SECRETS_FILE_KEY = "env-backend-command-key";
    const projectRoot = resolve(tempDir, "repo-bundled");
    const projectDir = resolve(projectRoot, ".hack");
    const storePath = resolve(projectRoot, ".hack-secrets.enc.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "env-bundled-project",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              storePlaintextInBackend: true,
              encryptedFile: {
                path: storePath,
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
              key: "PUBLIC_URL",
              required: true,
              source: "plain_env",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const setResult = await runHack({
      args: ["env", "set", "PUBLIC_URL=https://example.test"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-backend-command-key",
      },
      cwd: projectRoot,
    });
    expect(setResult.exitCode).toBe(0);
    expect(`${setResult.stdout}\n${setResult.stderr}`).toContain(
      "Mirrored portable plaintext"
    );

    const envText = await readFile(resolve(projectDir, ".env"), "utf8");
    expect(envText).toContain("PUBLIC_URL=");

    await rm(resolve(projectDir, ".env"), { force: true });

    const listResult = await runHack({
      args: ["env", "list", "--json", "--show-secrets"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-backend-command-key",
      },
      cwd: projectRoot,
    });
    expect(listResult.exitCode).toBe(0);
    const listJson = JSON.parse(listResult.stdout) as {
      readonly storage: {
        readonly local_plaintext: {
          readonly mirrored_to_backend: boolean;
        };
        readonly portable_state: {
          readonly status: string;
        };
      };
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly resolved_from: string | null;
        readonly value: string | null;
        readonly storage: {
          readonly backend: string;
        };
      }>;
    };
    expect(listJson.storage.local_plaintext.mirrored_to_backend).toBe(true);
    expect(listJson.storage.portable_state.status).toBe("backend_bundle");
    const publicUrl = listJson.vars.find((entry) => entry.key === "PUBLIC_URL");
    expect(publicUrl?.resolved_from).toBe("portable_backend");
    expect(publicUrl?.storage.backend).toBe("encrypted_file");
    expect(publicUrl?.value).toBe("https://example.test");
  },
  { timeout: 40_000 }
);

test(
  "env overlays layer on top of base values and honor defaultEnvConfig",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    process.env.HACK_SECRETS_FILE_KEY = "env-overlay-command-key";
    const projectRoot = resolve(tempDir, "repo-overlays");
    const projectDir = resolve(projectRoot, ".hack");
    const storePath = resolve(projectRoot, ".hack-secrets.enc.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "env-overlay-project",
          defaultEnvConfig: "qa",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              storePlaintextInBackend: true,
              encryptedFile: {
                path: storePath,
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
              key: "PUBLIC_URL",
              required: true,
              source: "plain_env",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const baseSet = await runHack({
      args: ["env", "set", "--env=base", "PUBLIC_URL=https://base.test"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-overlay-command-key",
      },
      cwd: projectRoot,
    });
    expect(baseSet.exitCode).toBe(0);

    const overlaySet = await runHack({
      args: ["env", "set", "--env=qa", "PUBLIC_URL=https://qa.test"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-overlay-command-key",
      },
      cwd: projectRoot,
    });
    expect(overlaySet.exitCode).toBe(0);

    const baseEnvText = await readFile(resolve(projectDir, ".env"), "utf8");
    const overlayEnvText = await readFile(
      resolve(projectDir, ".env.qa"),
      "utf8"
    );
    expect(baseEnvText).toContain("https://base.test");
    expect(overlayEnvText).toContain("https://qa.test");

    const defaultList = await runHack({
      args: ["env", "list", "--json", "--show-secrets"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-overlay-command-key",
      },
      cwd: projectRoot,
    });
    expect(defaultList.exitCode).toBe(0);
    const defaultJson = JSON.parse(defaultList.stdout) as {
      readonly env_selection: {
        readonly effective: string | null;
        readonly overlay_path: string | null;
      };
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly value: string | null;
      }>;
    };
    expect(defaultJson.env_selection.effective).toBe("qa");
    expect(defaultJson.env_selection.overlay_path).toContain(".env.qa");
    expect(
      defaultJson.vars.find((entry) => entry.key === "PUBLIC_URL")?.value
    ).toBe("https://qa.test");

    const baseList = await runHack({
      args: ["env", "list", "--json", "--show-secrets", "--env=base"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-overlay-command-key",
      },
      cwd: projectRoot,
    });
    expect(baseList.exitCode).toBe(0);
    const baseJson = JSON.parse(baseList.stdout) as {
      readonly env_selection: {
        readonly effective: string | null;
      };
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly value: string | null;
      }>;
    };
    expect(baseJson.env_selection.effective).toBe(null);
    expect(
      baseJson.vars.find((entry) => entry.key === "PUBLIC_URL")?.value
    ).toBe("https://base.test");
  },
  { timeout: 40_000 }
);

test(
  "env overlays resolve from the bundled backend when the overlay .env file is missing",
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    process.env.HACK_SECRETS_FILE_KEY = "env-overlay-backend-key";
    const projectRoot = resolve(tempDir, "repo-overlay-bundle");
    const projectDir = resolve(projectRoot, ".hack");
    const storePath = resolve(projectRoot, ".hack-secrets.enc.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, "docker-compose.yml"),
      "services: {}\n"
    );
    await writeFile(
      resolve(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "env-overlay-bundle-project",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              storePlaintextInBackend: true,
              encryptedFile: {
                path: storePath,
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
              key: "PUBLIC_URL",
              required: true,
              source: "plain_env",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    const overlaySet = await runHack({
      args: ["env", "set", "--env=qa", "PUBLIC_URL=https://qa-bundled.test"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-overlay-backend-key",
      },
      cwd: projectRoot,
    });
    expect(overlaySet.exitCode).toBe(0);

    await rm(resolve(projectDir, ".env.qa"), { force: true });

    const listResult = await runHack({
      args: ["env", "list", "--json", "--show-secrets", "--env=qa"],
      env: {
        ...process.env,
        HACK_GLOBAL_CONFIG_PATH: tempGlobalConfigPath ?? "",
        HACK_SECRETS_FILE_KEY: "env-overlay-backend-key",
      },
      cwd: projectRoot,
    });
    expect(listResult.exitCode).toBe(0);
    const listJson = JSON.parse(listResult.stdout) as {
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly resolved_from: string | null;
        readonly value: string | null;
      }>;
    };
    const publicUrl = listJson.vars.find((entry) => entry.key === "PUBLIC_URL");
    expect(publicUrl?.resolved_from).toBe("portable_backend");
    expect(publicUrl?.value).toBe("https://qa-bundled.test");
  },
  { timeout: 40_000 }
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
