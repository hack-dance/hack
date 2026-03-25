import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import { saveHackAuthSession } from "../src/lib/auth-session.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
const originalBrokerUrl = process.env.HACK_AUTH_BROKER_URL;
const originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
const originalLogger = process.env.HACK_LOGGER;

let tempDir: string | null = null;
let tempGlobalConfigPath: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-project-owner-broker-"));
  tempGlobalConfigPath = resolve(tempDir, "hack.config.json");
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
  process.env.HACK_SECRETS_FILE_KEY = "test-project-owner-broker-key";
  process.env.HACK_AUTH_BROKER_URL = "https://auth.hack-cli.hack";
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";

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
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
  tempGlobalConfigPath = null;

  process.env.HOME = originalHome;
  process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  process.env.HACK_SECRETS_FILE_KEY = originalSecretsKey;
  process.env.HACK_AUTH_BROKER_URL = originalBrokerUrl;
  process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  process.env.HACK_LOGGER = originalLogger;
});

test("project owner show includes broker registration when a shared project is visible", async () => {
  const projectRoot = await createHackProject({
    config: {
      name: "hack-cli",
      ownership: {
        mode: "shared",
        owner_type: "organization",
        owner_id: "org_123",
      },
    },
  });
  await saveHackAuthSession({
    session: {
      token: "session-token",
    },
  });

  globalThis.fetch = (async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack-cli.hack/v1/auth/projects/hack-cli") {
      return Response.json({
        ok: true,
        project: {
          id: "project_123",
          slug: "hack-cli",
          name: "Hack CLI",
          currentAccessRole: "owner",
          ownership: {
            mode: "shared",
            ownerType: "organization",
            ownerId: "org_123",
            ownerSlug: "hack",
            ownerName: "Hack Org",
            managedBy: "broker",
          },
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        access: [
          {
            id: "grant_123",
            scope: "team",
            role: "viewer",
            subjectId: "team_123",
            subjectSlug: "cli",
            subjectName: "CLI",
            organizationId: "org_123",
            teamId: "team_123",
            createdAt: "2026-03-25T00:00:00.000Z",
            updatedAt: "2026-03-25T00:00:00.000Z",
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof globalThis.fetch;

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr.trim()).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    project_root: projectRoot,
    ownership: {
      mode: "shared",
      owner_type: "organization",
      owner_id: "org_123",
      managed_by: "broker",
    },
    broker_registration: {
      id: "project_123",
      slug: "hack-cli",
      name: "Hack CLI",
      current_access_role: "owner",
      ownership: {
        mode: "shared",
        owner_type: "organization",
        owner_id: "org_123",
        owner_slug: "hack",
        owner_name: "Hack Org",
        managed_by: "broker",
      },
      access: [
        {
          id: "grant_123",
          scope: "team",
          role: "viewer",
          subject_id: "team_123",
          subject_slug: "cli",
          subject_name: "CLI",
          organization_id: "org_123",
          team_id: "team_123",
          created_at: "2026-03-25T00:00:00.000Z",
          updated_at: "2026-03-25T00:00:00.000Z",
        },
      ],
    },
  });
});

test("project owner show reports explicit conflict when local ownership disagrees with broker state", async () => {
  const projectRoot = await createHackProject({
    config: {
      name: "hack-cli",
      ownership: {
        mode: "shared",
        owner_type: "organization",
        owner_id: "org_123",
      },
    },
  });
  await saveHackAuthSession({
    session: {
      token: "session-token",
    },
  });

  globalThis.fetch = (async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url === "https://auth.hack-cli.hack/v1/auth/projects/hack-cli") {
      return Response.json({
        ok: true,
        project: {
          id: "project_123",
          slug: "hack-cli",
          name: "Hack CLI",
          currentAccessRole: "admin",
          ownership: {
            mode: "shared",
            ownerType: "team",
            ownerId: "team_123",
            ownerSlug: "cli",
            ownerName: "CLI",
            managedBy: "broker",
          },
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        access: [],
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof globalThis.fetch;

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr.trim()).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    project_root: projectRoot,
    ownership: {
      mode: "shared",
      owner_type: "organization",
      owner_id: "org_123",
      managed_by: "broker",
    },
    broker_registration: {
      id: "project_123",
      slug: "hack-cli",
      name: "Hack CLI",
      current_access_role: "admin",
      ownership: {
        mode: "shared",
        owner_type: "team",
        owner_id: "team_123",
        owner_slug: "cli",
        owner_name: "CLI",
        managed_by: "broker",
      },
      access: [],
    },
    conflict: {
      kind: "ownership_mismatch",
      message:
        "The local project ownership does not match the broker registration for this project.",
    },
  });
});

async function createHackProject(input: {
  readonly config: Record<string, unknown>;
}): Promise<string> {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }

  const projectRoot = join(tempDir, "repo");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), "services: {}\n");
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "");
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(input.config, null, 2)}\n`
  );

  return projectRoot;
}

async function runCliWithCapturedOutput(
  args: readonly string[]
): Promise<CapturedRunResult> {
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
    const { runCli } = await import("../src/cli/run.ts");
    const exitCode = await runCli(args);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
