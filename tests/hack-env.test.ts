import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PROJECT_CONFIG_FILENAME } from "../src/constants.ts";
import { resolveHackEnv } from "../src/lib/hack-env.ts";
import { PRIVATE_ENV_FILE_REFUSAL } from "../src/lib/private-env-file.ts";
import { restoreEnv } from "./helpers/env.ts";

const tempDirs = new Set<string>();
const originalHome = process.env.HOME;

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  restoreEnv("HOME", originalHome);
  Reflect.deleteProperty(process.env, "HACK_SECRETS_FILE_KEY");
});

test("resolveHackEnv skips encrypted backend access when no legacy env contract exists", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "hack-env-home-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "hack-env-repo-"));
  tempDirs.add(tempHome);
  tempDirs.add(repoRoot);
  process.env.HOME = tempHome;

  const globalHackDir = resolve(tempHome, ".hack");
  await mkdir(globalHackDir, { recursive: true });
  await writeFile(
    resolve(globalHackDir, "hack.config.json"),
    `${JSON.stringify(
      {
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
          },
        },
      },
      null,
      2
    )}\n`
  );

  const projectRoot = resolve(repoRoot, "repo");
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, PROJECT_CONFIG_FILENAME),
    `${JSON.stringify(
      {
        name: "hack-env-test",
        dev_host: "hack-env-test.hack",
      },
      null,
      2
    )}\n`
  );

  const resolved = await resolveHackEnv({
    projectDir,
    projectName: "hack-env-test",
  });

  expect(resolved.contractExists).toBe(false);
  expect(resolved.contract.vars).toEqual([]);
  expect(resolved.values).toEqual([]);
  expect(resolved.missingRequired).toEqual([]);
  expect(resolved.envForCompose).toEqual({});
  expect(resolved.storage.localSecrets.backend).toBe("encrypted_file");
  expect(resolved.storage.localSecrets.location).toBe(
    resolve(globalHackDir, "secrets.enc.json")
  );
});

for (const overlay of [false, true]) {
  test(`resolveHackEnv refuses a ${overlay ? "selected overlay" : ".hack/.env"} linked outside the project without reading it (HACK-2165)`, async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "hack-env-home-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "hack-env-repo-"));
    tempDirs.add(tempHome);
    tempDirs.add(repoRoot);
    process.env.HOME = tempHome;
    const sentinel = "synthetic-outside-dotenv-value";
    const outside = resolve(repoRoot, "outside.env");
    await writeFile(outside, `AUTH_TOKEN=${sentinel}\n`, { mode: 0o600 });

    const projectRoot = resolve(repoRoot, "repo");
    const projectDir = resolve(projectRoot, ".hack");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      resolve(projectDir, PROJECT_CONFIG_FILENAME),
      `${JSON.stringify({ name: "hack-env-link", dev_host: "hack-env-link.hack" })}\n`
    );
    await writeFile(
      resolve(projectDir, "hack.env.json"),
      `${JSON.stringify({
        version: 1,
        vars: [{ key: "AUTH_TOKEN", source: "plain_env", required: false }],
      })}\n`
    );
    if (overlay) {
      await writeFile(resolve(projectDir, ".env"), "OTHER=1\n", {
        mode: 0o600,
      });
      await symlink(outside, resolve(projectDir, ".env.qa"));
    } else {
      await symlink(outside, resolve(projectDir, ".env"));
    }

    let caught: unknown;
    try {
      await resolveHackEnv({
        projectDir,
        projectName: "hack-env-link",
        ...(overlay ? { envName: "qa" } : {}),
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(PRIVATE_ENV_FILE_REFUSAL);
    expect((caught as Error).message).not.toContain(sentinel);
  });
}
