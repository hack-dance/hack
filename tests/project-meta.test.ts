import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { resolveProjectMeta } from "../src/lib/project-meta.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

test("resolveProjectMeta reads modern env config repos without a legacy contract", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "hack-project-meta-"));
  tempDirs.add(repoRoot);

  const projectRoot = resolve(repoRoot, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });

  const composeFile = resolve(projectDir, PROJECT_COMPOSE_FILENAME);
  await writeFile(composeFile, "services:\n  api: {}\n  web: {}\n");
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "project-meta-test",
        dev_host: "project-meta.hack",
      },
      null,
      2
    )}\n`
  );

  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "global",
    key: "GLOBAL_FLAG",
    value: "1",
    secret: false,
  });
  await setProjectEnvValue({
    projectRoot,
    projectDir,
    envName: null,
    scope: "api",
    key: "SERVICE_TOKEN",
    value: "secret-token",
    secret: true,
  });

  const meta = await resolveProjectMeta({
    projectName: "project-meta-test",
    repoRoot: projectRoot,
    projectDir,
    composeFile,
  });

  expect(meta.env.contractExists).toBe(true);
  expect(meta.env.contractPath).toEndWith(".hack/hack.env.default.yaml");
  expect(meta.env.contractParseError).toBeNull();
  expect(meta.env.missingRequired).toEqual([]);
  expect(meta.env.vars.some((value) => value.key === "GLOBAL_FLAG")).toBe(true);
  expect(meta.env.vars.some((value) => value.key === "SERVICE_TOKEN")).toBe(
    true
  );
});
