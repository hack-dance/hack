import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import { saveHackAuthSession } from "../src/lib/auth-session.ts";
import { findProjectContext } from "../src/lib/project.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const hasTmux = isTmuxAvailable();

const originalHome = process.env.HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalSecretsKey = process.env.HACK_SECRETS_FILE_KEY;
const originalBrokerUrl = process.env.HACK_AUTH_BROKER_URL;
const originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
const originalLogger = process.env.HACK_LOGGER;

let tempDir: string | null = null;
let tempGlobalConfigPath: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-cli-offline-optionality-"));
  tempGlobalConfigPath = resolve(tempDir, "hack.config.json");

  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
  process.env.HACK_SECRETS_FILE_KEY = "cli-offline-optionality-test-key";
  process.env.HACK_AUTH_BROKER_URL = "http://127.0.0.1:9";
  process.env.HACK_SETUP_SYNC_MODE = "off";
  process.env.HACK_LOGGER = "console";

  await writeFile(
    tempGlobalConfigPath,
    `${JSON.stringify(
      {
        sessions: {
          mux: "tmux",
        },
        controlPlane: {
          daemon: {
            autoStart: false,
          },
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
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
  tempGlobalConfigPath = null;

  restoreEnvValue({ key: "HOME", value: originalHome });
  restoreEnvValue({
    key: "HACK_GLOBAL_CONFIG_PATH",
    value: originalGlobalConfigPath,
  });
  restoreEnvValue({ key: "HACK_SECRETS_FILE_KEY", value: originalSecretsKey });
  restoreEnvValue({ key: "HACK_AUTH_BROKER_URL", value: originalBrokerUrl });
  restoreEnvValue({
    key: "HACK_SETUP_SYNC_MODE",
    value: originalSetupSyncMode,
  });
  restoreEnvValue({ key: "HACK_LOGGER", value: originalLogger });
});

test("session list stays usable when broker and web surfaces are unavailable", async () => {
  const projectName = uniqueProjectName({ prefix: "offline-session-list" });
  const projectRoot = await createHackProject({ name: projectName });

  const result = await runCliWithCapturedOutput({
    args: ["session", "list"],
    cwd: projectRoot,
  });

  expect(result.exitCode).toBe(0);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  expect(
    combinedOutput.includes("Workspace") ||
      combinedOutput.includes("No active workspaces")
  ).toBe(true);
  expect(combinedOutput).not.toContain("Hack auth broker");
});

test.skipIf(!hasTmux)(
  "session start and stop stay local-first during broker outage",
  async () => {
    const projectName = uniqueProjectName({ prefix: "offline-session-start" });
    const workspaceSuffix = "outage-proof";
    const workspaceName = `${projectName}--${workspaceSuffix}`;
    const projectRoot = await createHackProject({ name: projectName });

    await registerProject({ projectRoot });

    try {
      const startResult = await runCliWithCapturedOutput({
        args: [
          "session",
          "start",
          projectName,
          "--detach",
          "--name",
          workspaceSuffix,
        ],
        cwd: projectRoot,
      });

      expect(startResult.exitCode).toBe(0);
      expect(`${startResult.stdout}\n${startResult.stderr}`).toContain(
        `Created workspace: ${workspaceName}`
      );

      const listResult = await runCliWithCapturedOutput({
        args: ["session", "list"],
        cwd: projectRoot,
      });

      expect(listResult.exitCode).toBe(0);
      expect(`${listResult.stdout}\n${listResult.stderr}`).toContain(
        workspaceName
      );
      expect(`${listResult.stdout}\n${listResult.stderr}`).not.toContain(
        "Hack auth broker"
      );

      const stopResult = await runCliWithCapturedOutput({
        args: ["session", "stop", workspaceName],
        cwd: projectRoot,
      });

      expect(stopResult.exitCode).toBe(0);
      expect(`${stopResult.stdout}\n${stopResult.stderr}`).toContain(
        `Stopped workspace: ${workspaceName}`
      );
    } finally {
      killTmuxSession({ sessionName: workspaceName });
    }
  }
);

test("project owner show keeps local ownership and surfaces broker outage guidance", async () => {
  const projectName = uniqueProjectName({ prefix: "offline-project-owner" });
  const projectRoot = await createHackProject({ name: projectName });
  await saveHackAuthSession({
    session: {
      token: "session-token",
    },
  });

  const result = await runCliWithCapturedOutput({
    args: ["project", "owner", "show", "--path", projectRoot, "--json"],
    cwd: projectRoot,
  });

  expect(result.exitCode).toBe(0);

  const payload = JSON.parse(result.stdout) as {
    readonly project_root: string;
    readonly ownership: {
      readonly mode: string;
      readonly owner_type: string;
      readonly owner_id: string | null;
      readonly managed_by: string;
    };
    readonly broker_error?: {
      readonly message: string;
      readonly login_required: boolean;
    };
  };

  expect(payload.project_root).toBe(projectRoot);
  expect(payload.ownership).toEqual({
    mode: "local",
    owner_type: "user",
    owner_id: null,
    managed_by: "local",
  });
  expect(payload.broker_error?.login_required).toBe(false);
  expect(payload.broker_error?.message).toContain(
    `Unable to reach Hack auth broker route /v1/auth/projects/${projectName}:`
  );
});

test("status --json still resolves repo-local project state when broker and web surfaces are unavailable", async () => {
  const projectName = uniqueProjectName({ prefix: "offline-status" });
  const projectRoot = await createHackProject({
    name: projectName,
    services: ["api"],
  });

  await registerProject({ projectRoot });

  const result = await runCliWithCapturedOutput({
    args: ["status", "--project", projectName, "--json"],
    cwd: projectRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.trim()).toBe("");

  const payload = JSON.parse(result.stdout) as {
    readonly filter: string | null;
    readonly runtime_ok: boolean;
    readonly projects: Array<{
      readonly name: string;
      readonly repo_root?: string;
      readonly status: string;
    }>;
    readonly runtime_error: string | null;
  };

  expect(payload.filter).toBe(projectName);
  expect(payload.projects).toHaveLength(1);
  expect(payload.projects[0]?.name).toBe(projectName);
  expect(payload.projects[0]?.status).toBe(
    payload.runtime_ok ? "stopped" : "unknown"
  );
  expect(payload.projects[0]?.repo_root).toBe(await realpath(projectRoot));
  expect(payload.runtime_error ?? "").not.toContain("Hack auth broker");
});

function uniqueProjectName(opts: { readonly prefix: string }): string {
  return `${opts.prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

async function createHackProject(opts: {
  readonly name: string;
  readonly services?: readonly string[];
}): Promise<string> {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }

  const projectRoot = join(tempDir, opts.name);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  const services =
    opts.services && opts.services.length > 0
      ? Object.fromEntries(
          opts.services.map((service) => [
            service,
            {
              image: "busybox:latest",
              command: ["sh", "-c", "sleep 60"],
            },
          ])
        )
      : {};

  await writeFile(
    join(projectDir, PROJECT_COMPOSE_FILENAME),
    `${JSON.stringify({ services }, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: opts.name,
      },
      null,
      2
    )}\n`
  );
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "");

  return projectRoot;
}

async function registerProject(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  const project = await findProjectContext(opts.projectRoot);
  if (!project) {
    throw new Error(
      `Failed to resolve project context for ${opts.projectRoot}`
    );
  }
  await upsertProjectRegistration({ project });
}

async function runCliWithCapturedOutput(opts: {
  readonly args: readonly string[];
  readonly cwd: string;
}): Promise<CapturedRunResult> {
  const subprocess = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), ...opts.args],
    {
      cwd: opts.cwd,
      env: {
        ...process.env,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function restoreEnvValue(opts: {
  readonly key: string;
  readonly value: string | undefined;
}): void {
  if (opts.value === undefined) {
    Reflect.deleteProperty(process.env, opts.key);
    return;
  }
  process.env[opts.key] = opts.value;
}

function isTmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function killTmuxSession(opts: { readonly sessionName: string }): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", opts.sessionName], {
      stdio: "ignore",
    });
  } catch {
    // Ignore missing-session cleanup failures for unique test-only names.
  }
}
