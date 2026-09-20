import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { YAML } from "bun";
import {
  resolveDependencyCacheBootstrapServices,
  resolveDependencyCacheOverride,
} from "../src/lib/dependency-cache.ts";

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
      "    platform: linux/arm64",
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

async function changeRuntime(
  project: Awaited<ReturnType<typeof createProject>>,
  runtime: Record<string, unknown>
) {
  await writeFile(
    project.composeFile,
    YAML.stringify({
      services: {
        installer: {
          ...runtime,
          labels: {
            "hack.dependencies.cache-volume": "workspace-dependencies",
          },
        },
      },
      volumes: { "workspace-dependencies": {} },
    })
  );
  return await resolveDependencyCacheOverride({
    ...project,
    projectName: "generic-project",
  });
}

test("image, platform, build target and build args isolate otherwise identical cache inputs", async () => {
  const project = await createProject();
  const runtime = {
    image: "oven/bun:1.3.9",
    platform: "linux/arm64",
    build: { context: "..", target: "deps", args: { VERSION: "one" } },
  };
  const first = await changeRuntime(project, runtime);
  for (const changed of [
    { ...runtime, image: "oven/bun:1.3.14" },
    { ...runtime, platform: "linux/amd64" },
    { ...runtime, build: { ...runtime.build, target: "production" } },
    { ...runtime, build: { ...runtime.build, args: { VERSION: "two" } } },
    { ...runtime, build: { ...runtime.build, context: "../other" } },
    { ...runtime, build: { ...runtime.build, dockerfile: "Dockerfile.deps" } },
  ]) {
    const next = await changeRuntime(project, changed);
    expect(next.fingerprint).not.toBeNull();
    expect(next.fingerprint).not.toBe(first.fingerprint);
  }
  const reordered = await changeRuntime(project, {
    build: { args: { VERSION: "one" }, target: "deps", context: ".." },
    platform: runtime.platform,
    image: runtime.image,
  });
  expect(reordered.fingerprint).toBe(first.fingerprint);
});

test("unresolved runtime inputs disable sharing without writing an override", async () => {
  const project = await createProject();
  for (const runtime of [
    { image: "oven/bun:${VERSION}", platform: "linux/arm64" },
    { image: "oven/bun", platform: "${PLATFORM}" },
    { platform: "linux/arm64", build: { context: "..", args: ["FROM_ENV"] } },
    {
      platform: "linux/arm64",
      build: { context: "..", args: { FROM_ENV: null } },
    },
  ]) {
    const result = await changeRuntime(project, runtime);
    expect(result.sharingDisabledReason).toBe("runtime_identity_unresolved");
    expect(result.overridePath).toBeNull();
    expect(result.volumes).toEqual([]);
  }
  expect(
    await Bun.file(
      resolve(project.projectDir, ".internal/compose.dependencies.override.yml")
    ).exists()
  ).toBe(false);
});

test("default platform is explicit and never inferred from host architecture", async () => {
  const project = await createProject();
  const original = process.env.DOCKER_DEFAULT_PLATFORM;
  try {
    process.env.DOCKER_DEFAULT_PLATFORM = undefined;
    expect(
      (await changeRuntime(project, { image: "oven/bun" }))
        .sharingDisabledReason
    ).toBe("runtime_platform_unresolved");
    process.env.DOCKER_DEFAULT_PLATFORM = "linux/amd64";
    const amd = await changeRuntime(project, { image: "oven/bun" });
    expect(amd.fingerprint).not.toBeNull();
    process.env.DOCKER_DEFAULT_PLATFORM = "linux/arm64";
    const arm = await changeRuntime(project, { image: "oven/bun" });
    expect(arm.fingerprint).not.toBe(amd.fingerprint);
    expect(
      (
        await changeRuntime(project, {
          image: "oven/bun",
          platform: "linux/amd64",
        })
      ).fingerprint
    ).toBe(amd.fingerprint);
  } finally {
    process.env.DOCKER_DEFAULT_PLATFORM = original;
  }
});

test("compatible linked worktrees share the same declared runtime cache", async () => {
  const project = await createProject();
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: project.projectRoot,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 5000,
    });
    const [code, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(error);
    }
  };
  await git(["init", "-b", "main"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const linked = resolve(project.projectRoot, "linked");
  await git(["worktree", "add", "-b", "linked", linked]);
  const first = await resolveDependencyCacheOverride({
    ...project,
    projectName: "generic-project",
  });
  const second = await resolveDependencyCacheOverride({
    projectRoot: linked,
    projectDir: resolve(linked, ".hack"),
    composeFile: resolve(linked, ".hack/docker-compose.yml"),
    projectName: "generic-project",
  });
  expect(first.fingerprint).not.toBeNull();
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(second.volumes).toEqual(first.volumes);
});

test("identical inputs share cache across checkouts and runtime changes isolate it", async () => {
  const firstProject = await createProject();
  const secondProject = await createProject();
  const first = await resolveDependencyCacheOverride({
    ...firstProject,
    projectName: "shared",
  });
  const second = await resolveDependencyCacheOverride({
    ...secondProject,
    projectName: "shared",
  });
  expect(second.volumes).toEqual(first.volumes);
  await writeFile(
    resolve(secondProject.projectRoot, "package.json"),
    '{"packageManager":"bun@1.4.0"}\n'
  );
  const changed = await resolveDependencyCacheOverride({
    ...secondProject,
    projectName: "shared",
  });
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});

test("explicit protocol producers bootstrap scoped consumers without command-name heuristics", async () => {
  const project = await createProject();
  await writeFile(
    project.composeFile,
    YAML.stringify({
      services: {
        custom: {
          command: ["/fixture/initialize"],
          volumes: ["dependencies:/deps"],
        },
        app: { volumes: ["dependencies:/deps:ro"] },
        unrelated: { volumes: [] },
      },
    })
  );
  const cache = {
    overridePath: "/fixture/override.yml",
    fingerprint: "fixture",
    inputs: [],
    progressServices: ["custom"],
    volumes: [
      {
        logicalName: "dependencies",
        resolvedName: "fixture-cache",
        services: ["custom"],
      },
    ],
  };
  expect(
    await resolveDependencyCacheBootstrapServices({
      composeFile: project.composeFile,
      cache,
      targetServices: ["app"],
    })
  ).toEqual(["custom"]);
  expect(
    await resolveDependencyCacheBootstrapServices({
      composeFile: project.composeFile,
      cache,
      targetServices: ["unrelated"],
    })
  ).toEqual([]);
  expect(
    await resolveDependencyCacheBootstrapServices({
      composeFile: project.composeFile,
      cache,
      targetServices: ["custom"],
    })
  ).toEqual([]);
  expect(
    await resolveDependencyCacheBootstrapServices({
      composeFile: project.composeFile,
      cache: { ...cache, overridePath: null },
      targetServices: ["app"],
    })
  ).toEqual([]);
});
