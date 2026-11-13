import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveLifecycleEnvForProject } from "../src/commands/project.ts";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONFIG_DEFAULT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";
import type { ProjectContext } from "../src/lib/project.ts";
import { restoreEnv } from "./helpers/env.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

test("lifecycle host execution applies host overrides on top of global overlay values", async () => {
  const project = await createProject({
    envConfig: [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    SHARED_MODE: "container"',
      '    GLOBAL_ONLY: "global-value"',
      "  host:",
      '    SHARED_MODE: "host"',
      '    HOST_ONLY: "host-value"',
      "  api:",
      '    SERVICE_ONLY: "service-value"',
      "",
    ].join("\n"),
  });

  const env = await resolveLifecycleEnvForProject({
    project,
    projectName: "lifecycle-env-test",
    envName: null,
  });

  expect(env).toEqual({
    GLOBAL_ONLY: "global-value",
    HOST_ONLY: "host-value",
    SHARED_MODE: "host",
  });
  expect(env.SERVICE_ONLY).toBeUndefined();
});

test("lifecycle host execution resolves host overrides from the selected overlay", async () => {
  const project = await createProject({
    envConfig: [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    EXECUTION_MODE: "local"',
      "  host:",
      '    RUNNER_KIND: "laptop"',
      "",
    ].join("\n"),
    overlayConfig: [
      "version: 1",
      "environment: runner",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      '    EXECUTION_MODE: "runner"',
      "  host:",
      '    RUNNER_KIND: "remote"',
      "",
    ].join("\n"),
  });

  const env = await resolveLifecycleEnvForProject({
    project,
    projectName: "lifecycle-env-test",
    envName: "runner",
  });

  expect(env).toEqual({
    EXECUTION_MODE: "runner",
    RUNNER_KIND: "remote",
  });
});

async function createProject(opts: {
  readonly envConfig: string;
  readonly overlayConfig?: string;
}): Promise<ProjectContext> {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "hack-lifecycle-env-"));
  tempDirs.add(projectRoot);
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  const composeFile = resolve(projectDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(projectDir, PROJECT_CONFIG_FILENAME);
  const envFile = resolve(projectDir, PROJECT_ENV_FILENAME);
  await writeFile(composeFile, "services:\n  api: {}\n");
  await writeFile(
    configFile,
    `${JSON.stringify({ name: "lifecycle-env-test", dev_host: "lifecycle-env.hack" }, null, 2)}\n`
  );
  await writeFile(
    resolve(projectDir, PROJECT_ENV_CONFIG_DEFAULT_FILENAME),
    opts.envConfig
  );
  if (opts.overlayConfig) {
    await writeFile(
      resolve(projectDir, "hack.env.runner.yaml"),
      opts.overlayConfig
    );
  }

  return {
    projectRoot,
    projectDirName: ".hack",
    projectDir,
    composeFile,
    envFile,
    configFile,
  };
}

test("legacy lifecycle commands receive global contract values without other services' values", async () => {
  const project = await createProject({ envConfig: "" });
  await rm(resolve(project.projectDir, PROJECT_ENV_CONFIG_DEFAULT_FILENAME));
  await writeFile(
    resolve(project.projectDir, "hack.env.json"),
    JSON.stringify({
      version: 1,
      vars: [
        { key: "GLOBAL", source: "plain_env", required: false },
        {
          key: "APP_TOKEN",
          source: "plain_env",
          required: false,
          services: ["api"],
        },
        {
          key: "OTHER_TOKEN",
          source: "plain_env",
          required: false,
          services: ["worker"],
        },
      ],
    })
  );
  await writeFile(
    project.envFile,
    "GLOBAL=kept\nAPP_TOKEN=synthetic-service-token\nOTHER_TOKEN=synthetic-other-token\n"
  );
  const saved = {
    HOME: process.env.HOME,
    HACK_GLOBAL_CONFIG_PATH: process.env.HACK_GLOBAL_CONFIG_PATH,
    HACK_NO_INTERACTIVE: process.env.HACK_NO_INTERACTIVE,
    HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK:
      process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK,
  };
  try {
    process.env.HOME = project.projectRoot;
    process.env.HACK_GLOBAL_CONFIG_PATH = resolve(
      project.projectRoot,
      "global-config.json"
    );
    process.env.HACK_NO_INTERACTIVE = "1";
    process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
    expect(
      await resolveLifecycleEnvForProject({
        project,
        projectName: "fixture",
        envName: null,
      })
    ).toEqual({ GLOBAL: "kept" });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      restoreEnv(key, value);
    }
  }
});
