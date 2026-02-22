import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECT_CONFIG_FILENAME } from "../src/constants.ts";
import { readControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

let tempDir: string | null = null;
let tempGlobalConfig: string | null = null;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;

beforeEach(() => {
  tempGlobalConfig = join(
    tmpdir(),
    `hack-global-config-${Date.now()}-${Math.random()}.json`
  );
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfig;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (tempGlobalConfig) {
    await rm(tempGlobalConfig, { force: true });
    tempGlobalConfig = null;
  }
  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
});

test("readControlPlaneConfig returns defaults when config is missing", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const result = await readControlPlaneConfig({ projectDir });
  expect(result.parseError).toBeUndefined();
  expect(result.config.tickets.git.branch).toBe("hack/tickets");
  expect(result.config.supervisor.enabled).toBe(true);
  expect(result.config.daemon.autoStart).toBe(true);
  expect(result.config.daemon.launchd.runAtLoad).toBe(true);
});

test("readControlPlaneConfig reads controlPlane overrides", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const payload = {
    controlPlane: {
      supervisor: { enabled: false },
      extensions: {
        "dance.hack.supervisor": { enabled: true, cliNamespace: "jobs" },
      },
    },
  };

  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(payload, null, 2)}\n`
  );

  const result = await readControlPlaneConfig({ projectDir });
  expect(result.parseError).toBeUndefined();
  expect(result.config.supervisor.enabled).toBe(false);
  expect(result.config.extensions["dance.hack.supervisor"]?.enabled).toBe(true);
  expect(result.config.extensions["dance.hack.supervisor"]?.cliNamespace).toBe(
    "jobs"
  );
});

test("readControlPlaneConfig keeps gateway enable project-scoped and uses global-only settings", async () => {
  if (!tempGlobalConfig) {
    throw new Error("Missing global config path");
  }

  const globalPayload = {
    controlPlane: {
      gateway: {
        enabled: true,
        bind: "0.0.0.0",
        port: 8899,
        allowWrites: true,
      },
      extensions: {
        "dance.hack.cloudflare": {
          enabled: true,
          config: { hostname: "gateway.example.com" },
        },
        "dance.hack.github": {
          enabled: true,
          config: {
            authRef: "github.app.default",
            tokenEnv: "HACK_GITHUB_APP_TOKEN",
          },
        },
      },
    },
  };

  await writeFile(
    tempGlobalConfig,
    `${JSON.stringify(globalPayload, null, 2)}\n`
  );

  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const projectPayload = {
    controlPlane: {
      gateway: { enabled: false, allowWrites: false, port: 9999 },
      extensions: {
        "dance.hack.cloudflare": {
          enabled: false,
        },
        "dance.hack.github": {
          enabled: false,
          config: {
            authRef: "project-override",
          },
        },
      },
    },
  };

  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(projectPayload, null, 2)}\n`
  );

  const result = await readControlPlaneConfig({ projectDir });
  expect(result.config.gateway.allowWrites).toBe(true);
  expect(result.config.gateway.bind).toBe("0.0.0.0");
  expect(result.config.gateway.port).toBe(8899);
  expect(result.config.gateway.enabled).toBe(false);
  expect(result.config.extensions["dance.hack.cloudflare"]?.enabled).toBe(true);
  expect(
    result.config.extensions["dance.hack.cloudflare"]?.config?.hostname
  ).toBe("gateway.example.com");
  expect(result.config.extensions["dance.hack.github"]?.enabled).toBe(true);
  expect(result.config.extensions["dance.hack.github"]?.config?.authRef).toBe(
    "github.app.default"
  );
});

test("readControlPlaneConfig reports parse errors and falls back to defaults", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  await writeFile(join(projectDir, PROJECT_CONFIG_FILENAME), "{bad json}");

  const result = await readControlPlaneConfig({ projectDir });
  expect(result.parseError).toBeTruthy();
  expect(result.config.gateway.enabled).toBe(false);
});

test("readControlPlaneConfig keeps nodeId project-scoped and merges cluster defaults", async () => {
  if (!tempGlobalConfig) {
    throw new Error("Missing global config path");
  }
  await writeFile(
    tempGlobalConfig,
    `${JSON.stringify(
      {
        controlPlane: {
          nodeId: "global-node",
          cluster: {
            defaultNodeId: "global-default",
            staleAfterMs: 45_000,
            offlineAfterMs: 180_000,
          },
        },
      },
      null,
      2
    )}\n`
  );

  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ controlPlane: { supervisor: { enabled: true } } }, null, 2)}\n`
  );

  const inherited = await readControlPlaneConfig({ projectDir });
  expect(inherited.config.nodeId).toBeUndefined();
  expect(inherited.config.cluster.defaultNodeId).toBe("global-default");
  expect(inherited.config.cluster.staleAfterMs).toBe(45_000);
  expect(inherited.config.cluster.offlineAfterMs).toBe(180_000);

  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ controlPlane: { nodeId: "project-node" } }, null, 2)}\n`
  );
  const scoped = await readControlPlaneConfig({ projectDir });
  expect(scoped.config.nodeId).toBe("project-node");
});

test("readControlPlaneConfig supports provider defaults and project-scoped routing", async () => {
  if (!tempGlobalConfig) {
    throw new Error("Missing global config path");
  }
  await writeFile(
    tempGlobalConfig,
    `${JSON.stringify(
      {
        controlPlane: {
          providers: {
            defaultProvider: "railway",
            defaultProfile: "railway/default",
            profiles: {
              "railway/default": {
                provider: "railway",
                enabled: true,
                config: {
                  project: "runtime",
                  privateNetworking: true,
                },
              },
            },
          },
          routing: {
            provider: "aws",
            profile: "aws/prod",
          },
        },
      },
      null,
      2
    )}\n`
  );

  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        controlPlane: {
          routing: {
            provider: "railway",
            profile: "railway/default",
            mode: "prefer_existing_then_bootstrap",
            bootstrap: {
              enabled: true,
              setAsProjectNode: true,
            },
            overrides: {
              labelsCsv: "railway,project-a",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  const resolved = await readControlPlaneConfig({ projectDir });
  expect(resolved.config.providers.defaultProvider).toBe("railway");
  expect(resolved.config.providers.defaultProfile).toBe("railway/default");
  expect(resolved.config.providers.profiles["railway/default"]?.provider).toBe(
    "railway"
  );
  expect(resolved.config.routing?.provider).toBe("railway");
  expect(resolved.config.routing?.profile).toBe("railway/default");
  expect(resolved.config.routing?.mode).toBe("prefer_existing_then_bootstrap");
  expect(resolved.config.routing?.bootstrap.enabled).toBe(true);
  expect(resolved.config.routing?.bootstrap.setAsProjectNode).toBe(true);
  expect(resolved.config.routing?.overrides.labelsCsv).toBe(
    "railway,project-a"
  );
});

test("readControlPlaneConfig does not inherit global routing into project scope", async () => {
  if (!tempGlobalConfig) {
    throw new Error("Missing global config path");
  }
  await writeFile(
    tempGlobalConfig,
    `${JSON.stringify(
      {
        controlPlane: {
          routing: {
            provider: "aws",
            profile: "aws/prod",
            mode: "bootstrap_only",
          },
        },
      },
      null,
      2
    )}\n`
  );

  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify({ controlPlane: { supervisor: { enabled: true } } }, null, 2)}\n`
  );

  const resolved = await readControlPlaneConfig({ projectDir });
  expect(resolved.config.routing).toBeUndefined();
});

test("readControlPlaneConfig merges secrets backend strategy config", async () => {
  if (!tempGlobalConfig) {
    throw new Error("Missing global config path");
  }
  await writeFile(
    tempGlobalConfig,
    `${JSON.stringify(
      {
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            allowEnvAuthRefs: true,
            encryptedFile: {
              path: "~/.hack/custom-secrets.enc.json",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  tempDir = await mkdtemp(join(tmpdir(), "hack-control-plane-config-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const inherited = await readControlPlaneConfig({ projectDir });
  expect(inherited.config.secrets.backend).toBe("encrypted_file");
  expect(inherited.config.secrets.allowEnvAuthRefs).toBe(true);
  expect(inherited.config.secrets.encryptedFile.path).toBe(
    "~/.hack/custom-secrets.enc.json"
  );

  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        controlPlane: {
          secrets: {
            backend: "cloud",
            cloud: {
              provider: "aws",
              project: "dev-account",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );

  const projectOverride = await readControlPlaneConfig({ projectDir });
  expect(projectOverride.config.secrets.backend).toBe("cloud");
  expect(projectOverride.config.secrets.cloud.provider).toBe("aws");
  expect(projectOverride.config.secrets.cloud.project).toBe("dev-account");
  expect(projectOverride.config.secrets.cloud.secretPrefix).toBe("hack");
});
