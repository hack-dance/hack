import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { GLOBAL_PROJECTS_REGISTRY_FILENAME } from "../src/constants.ts";
import { readDomainMigrationClaims } from "../src/lib/project-domain-command.ts";

let root = "";
let target = "";
let registryPath = "";
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.HACK_HOME;
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-domain-claims-")));
  const home = join(root, "isolated-home");
  target = join(root, "target/.hack");
  await mkdir(home);
  await mkdir(target, { recursive: true });
  process.env.HACK_HOME = home;
  registryPath = join(home, GLOBAL_PROJECTS_REGISTRY_FILENAME);
});

afterEach(async () => {
  if (previousHome === undefined) {
    Reflect.deleteProperty(process.env, "HACK_HOME");
  } else {
    process.env.HACK_HOME = previousHome;
  }
  await rm(root, { recursive: true, force: true });
});

async function compose(
  name: string,
  labels: unknown,
  directoryName = ".hack"
): Promise<string> {
  const directory = join(root, name, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "docker-compose.yml"),
    JSON.stringify({ services: { web: { image: "fixture", labels } } })
  );
  return directory;
}

async function registry(projects: unknown): Promise<void> {
  await writeFile(registryPath, JSON.stringify({ version: 1, projects }));
}

test("absent registry has no known claims and writes nothing", async () => {
  expect(await readDomainMigrationClaims(target)).toEqual([]);
  expect(await Bun.file(registryPath).exists()).toBe(false);
});

test("map, list, wildcard and numbered static claims are collected and normalized", async () => {
  const map = await compose("map", {
    caddy: "APP.hack.local., api.hack.local",
    caddy_2: "*.branch.hack.local",
    "caddy.reverse_proxy": "{{upstreams 3000}}",
  });
  const list = await compose("list", [
    "caddy=other.hack.local, app.hack.local",
    "caddy_0=*.hack.local",
    "unrelated=ignored",
  ]);
  await registry([
    { projectDir: map },
    { projectDir: list },
    { projectDir: map },
  ]);
  const paths = [
    registryPath,
    join(map, "docker-compose.yml"),
    join(list, "docker-compose.yml"),
  ];
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  expect(await readDomainMigrationClaims(target)).toEqual([
    "app.hack.local",
    "api.hack.local",
    "*.branch.hack.local",
    "other.hack.local",
    "*.hack.local",
  ]);
  expect(
    await Promise.all(paths.map((path) => readFile(path, "utf8")))
  ).toEqual(before);
});

test("exclude only target config while preserving other registered worktree claims", async () => {
  await writeFile(
    join(target, "docker-compose.yml"),
    "malformed target is the planner's responsibility"
  );
  const primary = await compose("primary", { caddy: "primary.hack.local" });
  const linked = await compose("linked", { caddy: "linked.hack.local" });
  await registry([
    {
      projectDir: primary,
      projectDirName: ".hack",
      worktrees: [{ path: dirname(target) }, { path: dirname(linked) }],
    },
    { projectDir: target },
  ]);
  expect(await readDomainMigrationClaims(target)).toEqual([
    "primary.hack.local",
    "linked.hack.local",
  ]);
});

test("legacy .dev worktrees are inspected using their registered directory name", async () => {
  const primary = await compose(
    "primary",
    { caddy: "primary.hack.local" },
    ".dev"
  );
  const linked = await compose(
    "linked",
    { caddy: "legacy.hack.local" },
    ".dev"
  );
  await registry([
    {
      projectDir: primary,
      projectDirName: ".dev",
      worktrees: [{ path: dirname(linked) }],
    },
  ]);
  expect(await readDomainMigrationClaims(target)).toEqual([
    "primary.hack.local",
    "legacy.hack.local",
  ]);
});

test("missing stale project/worktree paths and absent compose files are skipped", async () => {
  const empty = join(root, "empty/.hack");
  await mkdir(empty, { recursive: true });
  await registry([
    {
      projectDir: join(root, "missing/.hack"),
      worktrees: [{ path: join(root, "missing-worktree") }],
    },
    { projectDir: empty },
  ]);
  expect(await readDomainMigrationClaims(target)).toEqual([]);
});

for (const value of [
  "not json",
  "null",
  "[]",
  '{"version":2,"projects":[]}',
  '{"version":1,"projects":{}}',
]) {
  test(`malformed registry refuses collision preflight (${value})`, async () => {
    await writeFile(registryPath, value);
    await expect(readDomainMigrationClaims(target)).rejects.toThrow("registry");
  });
}

for (const entry of [
  null,
  {},
  { projectDir: "" },
  { projectDir: "relative/.hack" },
  { projectDir: "/fixture/.hack", projectDirName: "other" },
  { projectDir: "/fixture/.hack", worktrees: {} },
  { projectDir: "/fixture/.hack", worktrees: [null] },
  { projectDir: "/fixture/.hack", worktrees: [{ path: "relative" }] },
]) {
  test(`malformed registered entry fails closed (${JSON.stringify(entry)})`, async () => {
    await registry([entry]);
    await expect(readDomainMigrationClaims(target)).rejects.toThrow(
      "refusing domain migration"
    );
  });
}

for (const labels of [
  null,
  42,
  [42],
  ["caddy"],
  ["caddy=x.hack.local", "caddy=y.hack.local"],
  { caddy: "${DYNAMIC_HOST}" },
  { caddy: "https://foo.hack.local" },
  { caddy: "foo.hack.local," },
  { caddy_0: ":443" },
  { "${LABEL}": "x.hack.local" },
]) {
  test(`ambiguous or dynamic registered labels refuse preflight (${JSON.stringify(labels)})`, async () => {
    const directory = await compose("other", labels);
    await registry([{ projectDir: directory }]);
    await expect(readDomainMigrationClaims(target)).rejects.toThrow(
      "collision review"
    );
  });
}

for (const document of [
  "invalid: [",
  "services: {}\ninclude: []\n",
  "services: {web: {extends: {file: elsewhere.yml}}}\n",
]) {
  test(`unreadable Compose semantics fail closed (${document.length})`, async () => {
    const directory = await compose("other", {});
    await writeFile(join(directory, "docker-compose.yml"), document);
    await registry([{ projectDir: directory }]);
    await expect(readDomainMigrationClaims(target)).rejects.toThrow();
  });
}

for (const location of [
  "registry",
  "compose",
  "config-directory",
  "worktree-root",
] as const) {
  test(`symlinked ${location} is refused`, async () => {
    const directory = await compose("other", { caddy: "claimed.hack.local" });
    if (location === "registry") {
      const actual = join(root, "registry-source.json");
      await writeFile(
        actual,
        JSON.stringify({ version: 1, projects: [{ projectDir: directory }] })
      );
      await symlink(actual, registryPath);
    } else if (location === "compose") {
      const path = join(directory, "docker-compose.yml");
      const actual = join(root, "source-compose.yml");
      await writeFile(actual, await readFile(path));
      await rm(path);
      await symlink(actual, path);
      await registry([{ projectDir: directory }]);
    } else if (location === "config-directory") {
      const alias = join(root, "alias/.hack");
      await mkdir(dirname(alias));
      await symlink(directory, alias);
      await registry([{ projectDir: alias }]);
    } else {
      const alias = join(root, "worktree-alias");
      await symlink(dirname(directory), alias);
      await registry([
        {
          projectDir: target,
          projectDirName: ".hack",
          worktrees: [{ path: alias }],
        },
      ]);
    }
    await expect(readDomainMigrationClaims(target)).rejects.toThrow();
  });
}

test("oversized registered configuration is refused without echoing its contents", async () => {
  const directory = await compose("other", {});
  await writeFile(
    join(directory, "docker-compose.yml"),
    "private-marker".repeat(100_000)
  );
  await registry([{ projectDir: directory }]);
  try {
    await readDomainMigrationClaims(target);
    throw new Error("expected refusal");
  } catch (error) {
    expect(String(error)).toContain("bounded file");
    expect(String(error)).not.toContain("private-marker");
  }
});
