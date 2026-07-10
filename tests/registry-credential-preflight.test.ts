import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  discoverDependencyBootstrapServices,
  discoverRegistryCredentialReferences,
  discoverSuccessfulCompletionServices,
  preflightRegistryCredentials,
} from "../src/lib/registry-credential-preflight.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true }))
  );
});

async function createTempProject(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), "hack-registry-preflight-"));
  tempDirs.push(path);
  return path;
}

test("registry preflight reports referenced credentials without values", async () => {
  const projectRoot = await createTempProject();
  await writeFile(
    resolve(projectRoot, ".npmrc"),
    "@private:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n"
  );

  expect(await discoverRegistryCredentialReferences({ projectRoot })).toEqual([
    {
      key: "GITHUB_TOKEN",
      path: resolve(projectRoot, ".npmrc"),
      line: 2,
    },
  ]);
  const missing = await preflightRegistryCredentials({ projectRoot, env: {} });
  expect(missing.missing.map((entry) => entry.key)).toEqual(["GITHUB_TOKEN"]);
  const present = await preflightRegistryCredentials({
    projectRoot,
    env: { GITHUB_TOKEN: "redacted-token" },
  });
  expect(present.missing).toEqual([]);
});

test("dependency bootstrap detection is name agnostic", async () => {
  const projectRoot = await createTempProject();
  const composeFile = resolve(projectRoot, "compose.yml");
  await writeFile(
    composeFile,
    [
      "services:",
      "  arbitrary-installer:",
      "    image: oven/bun",
      "    command: bun install --frozen-lockfile",
      "  api:",
      "    image: app",
      "",
    ].join("\n")
  );
  expect(await discoverDependencyBootstrapServices({ composeFile })).toEqual([
    "arbitrary-installer",
  ]);
});

test("successful completion recognizes installers, labels, and Compose completion gates", async () => {
  const projectRoot = await createTempProject();
  const composeFile = resolve(projectRoot, "compose.yml");
  await writeFile(
    composeFile,
    [
      "services:",
      "  installer:",
      "    image: oven/bun",
      "    command: bun install",
      "  migrate:",
      "    image: app",
      "    labels:",
      '      hack.service.one-shot: "true"',
      "  database-init:",
      "    image: app",
      "  api:",
      "    image: app",
      "    depends_on:",
      "      database-init:",
      "        condition: service_completed_successfully",
      "  exited-api:",
      "    image: app",
      "  profiled-worker:",
      "    image: app",
      "    profiles: [benchmark]",
      "    depends_on:",
      "      exited-api:",
      "        condition: service_completed_successfully",
      "",
    ].join("\n")
  );

  expect(await discoverSuccessfulCompletionServices({ composeFile })).toEqual([
    "database-init",
    "installer",
    "migrate",
  ]);
  expect(
    await discoverSuccessfulCompletionServices({
      composeFile,
      activeProfiles: ["benchmark"],
    })
  ).toEqual(["database-init", "exited-api", "installer", "migrate"]);
  expect(
    await discoverSuccessfulCompletionServices({
      composeFile,
      activeProfiles: ["benchmark"],
      selectedServices: ["api"],
    })
  ).toEqual(["database-init", "installer", "migrate"]);
  expect(
    await discoverSuccessfulCompletionServices({
      composeFile,
      selectedServices: ["database-init"],
    })
  ).toEqual(["database-init", "installer", "migrate"]);
});
