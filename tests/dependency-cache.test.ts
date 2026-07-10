import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveDependencyCacheOverride } from "../src/lib/dependency-cache.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { recursive: true }))
  );
});

async function createProject(): Promise<{
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly composeFile: string;
}> {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "hack-dependency-cache-")
  );
  tempDirs.push(projectRoot);
  const projectDir = resolve(projectRoot, ".hack");
  await mkdir(projectDir);
  const composeFile = resolve(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    [
      "services:",
      "  installer-any-name:",
      "    image: oven/bun",
      "    labels:",
      "      hack.dependencies.cache-volume: workspace-dependencies",
      "      hack.dependencies.lockfiles: bun.lock,package.json",
      "volumes:",
      "  workspace-dependencies: {}",
      "",
    ].join("\n")
  );
  await writeFile(resolve(projectRoot, "bun.lock"), "lock-v1\n");
  await writeFile(
    resolve(projectRoot, "package.json"),
    '{"packageManager":"bun@1.3.14"}\n'
  );
  return { projectRoot, projectDir, composeFile };
}

test("dependency cache shares a lockfile and runtime keyed volume", async () => {
  const project = await createProject();
  const first = await resolveDependencyCacheOverride({
    ...project,
    projectName: "generic-project",
  });
  expect(first.fingerprint).toHaveLength(16);
  expect(first.volumes[0]?.logicalName).toBe("workspace-dependencies");
  expect(first.volumes[0]?.resolvedName).toContain(first.fingerprint ?? "");
  expect(first.overridePath).not.toBeNull();
  const override = await readFile(first.overridePath ?? "", "utf8");
  expect(override).toContain("workspace-dependencies");
  expect(override).toContain(first.volumes[0]?.resolvedName ?? "missing");

  await writeFile(resolve(project.projectRoot, "bun.lock"), "lock-v2\n");
  const second = await resolveDependencyCacheOverride({
    ...project,
    projectName: "generic-project",
  });
  expect(second.fingerprint).not.toBe(first.fingerprint);
  expect(second.volumes[0]?.resolvedName).not.toBe(
    first.volumes[0]?.resolvedName
  );
});
