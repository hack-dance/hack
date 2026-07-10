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
