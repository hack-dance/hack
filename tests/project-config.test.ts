import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import {
  readProjectConfig,
  resolveProjectOauthTld,
} from "../src/lib/project.ts";

let tempDir: string | null = null;
let originalSetupSyncMode: string | undefined;

beforeEach(() => {
  originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
  process.env.HACK_SETUP_SYNC_MODE = "off";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }

  if (originalSetupSyncMode !== undefined) {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  }
});

async function createProjectDir(): Promise<{
  projectRoot: string;
  projectDirName: ".hack";
  projectDir: string;
  composeFile: string;
  envFile: string;
  configFile: string;
}> {
  tempDir = await mkdtemp(join(tmpdir(), "hack-config-"));
  const projectRoot = join(tempDir, "repo");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  const composeFile = join(projectDir, PROJECT_COMPOSE_FILENAME);
  const envFile = join(projectDir, PROJECT_ENV_FILENAME);
  const configFile = join(projectDir, PROJECT_CONFIG_FILENAME);

  await writeFile(composeFile, "services: {}\n");
  await writeFile(envFile, "");

  return {
    projectRoot,
    projectDirName: ".hack",
    projectDir,
    composeFile,
    envFile,
    configFile,
  };
}

test("readProjectConfig parses json config fields", async () => {
  const ctx = await createProjectDir();
  await writeFile(
    ctx.configFile,
    JSON.stringify(
      {
        name: "my-app",
        dev_host: "myapp.hack",
        logs: {
          follow_backend: "compose",
          snapshot_backend: "loki",
          clear_on_down: true,
        },
        oauth: { enabled: true, tld: "gy" },
        internal: {
          dns: true,
          tls: true,
          extra_hosts: {
            "api.example.com": "host-gateway",
            "db.example.com": "127.0.0.1",
          },
        },
        ownership: {
          mode: "shared",
          owner_type: "team",
          owner_id: "team_123",
        },
      },
      null,
      2
    )
  );

  const cfg = await readProjectConfig(ctx);
  expect(cfg.name).toBe("my-app");
  expect(cfg.devHost).toBe("myapp.hack");
  expect(cfg.logs?.followBackend).toBe("compose");
  expect(cfg.logs?.snapshotBackend).toBe("loki");
  expect(cfg.logs?.clearOnDown).toBe(true);
  expect(cfg.oauth?.enabled).toBe(true);
  expect(cfg.oauth?.tld).toBe("gy");
  expect(cfg.internal?.dns).toBe(true);
  expect(cfg.internal?.tls).toBe(true);
  expect(cfg.internal?.extraHosts).toEqual({
    "api.example.com": "host-gateway",
    "db.example.com": "127.0.0.1",
  });
  expect(cfg.ownership).toEqual({
    mode: "shared",
    ownerType: "team",
    ownerId: "team_123",
    managedBy: "broker",
  });
});

test("readProjectConfig captures parse errors", async () => {
  const ctx = await createProjectDir();
  await writeFile(ctx.configFile, "{ invalid json");
  const cfg = await readProjectConfig(ctx);
  expect(cfg.parseError).toBeTruthy();
});

test("readProjectConfig rejects non-object config roots", async () => {
  const ctx = await createProjectDir();
  await writeFile(ctx.configFile, JSON.stringify(["not", "an", "object"]));

  const cfg = await readProjectConfig(ctx);

  expect(cfg.parseError).toBe("Project config root must be an object.");
});

test("readProjectConfig rejects malformed ownership payloads", async () => {
  const ctx = await createProjectDir();
  await writeFile(
    ctx.configFile,
    JSON.stringify({
      ownership: [],
    })
  );

  const cfg = await readProjectConfig(ctx);

  expect(cfg.parseError).toBe("Project ownership must be an object.");
});

test("readProjectConfig rejects ownership fields without an explicit mode", async () => {
  const ctx = await createProjectDir();
  await writeFile(
    ctx.configFile,
    JSON.stringify({
      ownership: {
        owner_type: "team",
        owner_id: "team_123",
      },
    })
  );

  const cfg = await readProjectConfig(ctx);

  expect(cfg.parseError).toBe(
    "Project ownership.mode is required when ownership.owner_type or ownership.owner_id is set."
  );
});

test("readProjectConfig rejects shared ownership without a non-user owner", async () => {
  const ctx = await createProjectDir();
  await writeFile(
    ctx.configFile,
    JSON.stringify({
      ownership: {
        mode: "shared",
        owner_type: "user",
        owner_id: "user_123",
      },
    })
  );

  const cfg = await readProjectConfig(ctx);

  expect(cfg.parseError).toBe(
    "Project shared ownership.owner_type must be 'team' or 'organization'."
  );
});

test("readProjectConfig rejects shared ownership without a concrete owner id", async () => {
  const ctx = await createProjectDir();
  await writeFile(
    ctx.configFile,
    JSON.stringify({
      ownership: {
        mode: "shared",
        owner_type: "team",
        owner_id: "   ",
      },
    })
  );

  const cfg = await readProjectConfig(ctx);

  expect(cfg.parseError).toBe(
    "Project shared ownership.owner_id must be a non-empty string."
  );
});

test("readProjectConfig defaults ownership to local user scope", async () => {
  const ctx = await createProjectDir();

  const cfg = await readProjectConfig(ctx);

  expect(cfg.ownership).toEqual({
    mode: "local",
    ownerType: "user",
    ownerId: null,
    managedBy: "local",
  });
});

test("resolveProjectOauthTld falls back to default when enabled", () => {
  expect(resolveProjectOauthTld({ enabled: true, tld: "" })).toBe("gy");
  expect(resolveProjectOauthTld({ enabled: false })).toBeNull();
});

test("readProjectConfig maps startup shorthand into lifecycle", async () => {
  const ctx = await createProjectDir();
  await writeFile(
    ctx.configFile,
    JSON.stringify(
      {
        startup: [
          {
            name: "aws sso",
            run: "aws sso login",
          },
          {
            name: "ssm proxy",
            run: "cd packages/infra && bun run proxy",
            persistent: true,
            cwd: ".",
          },
          "echo warmup",
        ],
      },
      null,
      2
    )
  );

  const cfg = await readProjectConfig(ctx);
  expect(cfg.lifecycle?.up?.before).toEqual([
    { name: "aws sso", command: "aws sso login" },
    { command: "echo warmup" },
  ]);
  expect(cfg.lifecycle?.processes).toEqual([
    {
      name: "ssm proxy",
      command: "cd packages/infra && bun run proxy",
      cwd: ".",
    },
  ]);
});

test("readProjectConfig parses persistent lifecycle up.before hooks", async () => {
  const ctx = await createProjectDir();
  await writeFile(
    ctx.configFile,
    JSON.stringify(
      {
        lifecycle: {
          up: {
            before: [
              {
                name: "proxy",
                cwd: "packages/infra",
                command: "bun run proxy",
                persistent: true,
              },
              {
                name: "auth",
                command: "bun run aws:qa",
              },
            ],
          },
        },
      },
      null,
      2
    )
  );

  const cfg = await readProjectConfig(ctx);
  expect(cfg.lifecycle?.up?.before).toEqual([
    {
      name: "proxy",
      cwd: "packages/infra",
      command: "bun run proxy",
      persistent: true,
    },
    {
      name: "auth",
      command: "bun run aws:qa",
    },
  ]);
});
