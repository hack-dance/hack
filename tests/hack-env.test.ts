import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PROJECT_CONFIG_FILENAME } from "../src/constants.ts";
import { resolveHackEnv } from "../src/lib/hack-env.ts";

const tempDirs = new Set<string>();
const originalHome = process.env.HOME;

afterEach(async () => {
  for (const tempDir of tempDirs) {
    await rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
  process.env.HOME = originalHome;
  process.env.HACK_SECRETS_FILE_KEY = undefined;
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
