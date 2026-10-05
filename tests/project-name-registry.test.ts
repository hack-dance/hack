import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { sanitizeProjectSlug } from "../src/lib/project.ts";
import { normalizeProjectName } from "../src/lib/project-name.ts";
import {
  readProjectsRegistry,
  resolveRegisteredProjectByName,
  touchProjectRegistration,
  upsertProjectRegistration,
} from "../src/lib/projects-registry.ts";
import { restoreEnv } from "./helpers/env.ts";
import { projectNameFixture } from "./helpers/project-name-fixture.ts";

let fixture: Awaited<ReturnType<typeof projectNameFixture>>;
const saved = new Map<string, string | undefined>();

beforeEach(async () => {
  fixture = await projectNameFixture();
  for (const key of ["HOME", "HACK_HOME", "HACK_GLOBAL_CONFIG_PATH"]) {
    saved.set(key, process.env[key]);
    process.env[key] = fixture.env[key as keyof typeof fixture.env];
  }
});
afterEach(async () => {
  for (const [key, value] of saved) {
    restoreEnv(key, value);
  }
  saved.clear();
  await rm(fixture.root, { recursive: true, force: true });
});

test("project keys share the slug contract without the generated-name fallback", () => {
  for (const input of [
    "my_app",
    "My App",
    "MY/APP",
    " --My___App-- ",
    "my-app",
  ]) {
    expect(normalizeProjectName(input)).toBe("my-app");
    expect(sanitizeProjectSlug(input)).toBe("my-app");
  }
  for (const input of ["", " ", "---", "💥!."]) {
    expect(normalizeProjectName(input)).toBeNull();
    expect(sanitizeProjectSlug(input)).toBe("project");
  }
});

test("new registrations use canonical keys without rewriting config or Compose identity", async () => {
  const { project } = await fixture.createProject("repo", "My_App");
  const before = await Promise.all([
    readFile(project.configFile, "utf8"),
    readFile(project.composeFile, "utf8"),
  ]);
  const outcome = await upsertProjectRegistration({ project });
  expect(outcome.status).toBe("created");
  expect((await readProjectsRegistry()).projects[0]?.name).toBe("my-app");
  for (const name of ["my_app", "MY APP", "my-app"]) {
    expect((await resolveRegisteredProjectByName({ name }))?.projectDir).toBe(
      project.projectDir
    );
  }
  expect(
    await Promise.all([
      readFile(project.configFile, "utf8"),
      readFile(project.composeFile, "utf8"),
    ])
  ).toEqual(before);
});

test("legacy aliases resolve read-only, then owned registration migrates identity and live worktrees", async () => {
  const { project, entry } = await fixture.createProject("legacy", "my_app");
  const sibling = await fixture.createProject("sibling", "my_app");
  const worktrees = [
    {
      path: sibling.project.projectRoot,
      branch: "feature",
      lastSeenAt: "2026-01-02T00:00:00Z",
    },
  ];
  await fixture.writeRegistry([{ ...entry, worktrees }]);
  const before = await readFile(fixture.registryPath, "utf8");
  for (const name of ["my_app", "my-app", "MY APP"]) {
    expect((await resolveRegisteredProjectByName({ name }))?.projectRoot).toBe(
      project.projectRoot
    );
  }
  expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  expect((await upsertProjectRegistration({ project })).status).toBe("updated");
  expect((await readProjectsRegistry()).projects).toEqual([
    expect.objectContaining({ ...entry, name: "my-app", worktrees }),
  ]);
});

for (const reversed of [false, true]) {
  test(`legacy canonical collisions reject every alias and cannot be migrated (reverse=${reversed})`, async () => {
    const first = await fixture.createProject("first", "my_app");
    const second = await fixture.createProject("second", "my-app");
    const entries = [first.entry, second.entry];
    await fixture.writeRegistry(reversed ? entries.reverse() : entries);
    const before = await readFile(fixture.registryPath, "utf8");
    for (const name of ["my_app", "my-app", "MY APP"]) {
      await expect(resolveRegisteredProjectByName({ name })).rejects.toThrow(
        "Ambiguous project name"
      );
    }
    expect(
      (await upsertProjectRegistration({ project: first.project })).status
    ).toBe("conflict");
    expect(
      (await touchProjectRegistration({ project: second.project }))?.status
    ).toBe("conflict");
    await rm(second.project.projectRoot, { recursive: true });
    await expect(
      resolveRegisteredProjectByName({ name: "my_app" })
    ).rejects.toThrow("Ambiguous project name");
    expect(
      (await upsertProjectRegistration({ project: first.project })).status
    ).toBe("conflict");
    expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  });
}

test("renaming a checkout into another canonical name is rejected without modifying either identity", async () => {
  const first = await fixture.createProject("first", "first");
  const second = await fixture.createProject("second", "my_app");
  await fixture.writeRegistry([first.entry, second.entry]);
  const before = await readFile(fixture.registryPath, "utf8");
  await writeFile(first.project.configFile, JSON.stringify({ name: "my-app" }));
  expect(
    (await upsertProjectRegistration({ project: first.project })).status
  ).toBe("conflict");
  expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
});

test("independent Git checkouts sharing a remote cannot take over a missing project directory", async () => {
  const first = await fixture.createProject("first", "my_app");
  const second = await fixture.createProject("second", "my-app");
  for (const { project } of [first, second]) {
    for (const args of [
      ["init", "--quiet"],
      ["remote", "add", "origin", "https://example.invalid/same-repo.git"],
    ]) {
      const child = Bun.spawn(["git", ...args], {
        cwd: project.projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
    }
  }
  await fixture.writeRegistry([first.entry]);
  const before = await readFile(fixture.registryPath, "utf8");
  expect(
    (await upsertProjectRegistration({ project: second.project })).status
  ).toBe("conflict");
  await rm(first.project.projectDir, { recursive: true });
  expect(
    (await upsertProjectRegistration({ project: second.project })).status
  ).toBe("conflict");
  expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
});

test("invalid configured names and selectors never fall back to a project named project", async () => {
  const fallback = await fixture.createProject("fallback", "project");
  const invalid = await fixture.createProject("invalid", "!!!");
  await fixture.writeRegistry([fallback.entry]);
  const before = await readFile(fixture.registryPath, "utf8");
  for (const name of ["", " ", "!!!"]) {
    expect(await resolveRegisteredProjectByName({ name })).toBeNull();
  }
  await expect(
    upsertProjectRegistration({ project: invalid.project })
  ).rejects.toThrow("Invalid project name");
  expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
});
