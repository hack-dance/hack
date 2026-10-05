import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import type { ProjectContext } from "../src/lib/project.ts";
import {
  findDeadProjectRegistrations,
  readProjectsRegistry,
  removeProjectsById,
  resolveRegisteredProjectById,
  resolveRegisteredProjectByName,
  touchProjectRegistration,
  upsertProjectRegistration,
} from "../src/lib/projects-registry.ts";
import { withProjectsRegistryLock } from "../src/lib/projects-registry-lock.ts";
import { restoreEnv } from "./helpers/env.ts";
import { projectNameFixture } from "./helpers/project-name-fixture.ts";

const NOW = "2026-01-02T00:00:00Z";
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

async function expectUnchanged(before: string) {
  expect(await readFile(fixture.registryPath, "utf8")).toBe(before);
  expect(await readdir(fixture.state)).toEqual(["projects.json"]);
}

function git(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
}

async function createLinkedProject(primary: ProjectContext) {
  git(primary.projectRoot, ["init", "-b", "main"]);
  git(primary.projectRoot, ["add", "."]);
  git(primary.projectRoot, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  const linked = await fixture.createProject("linked", "target");
  await rm(linked.project.projectRoot, { recursive: true });
  git(primary.projectRoot, [
    "worktree",
    "add",
    "-b",
    "feature/linked",
    linked.project.projectRoot,
  ]);
  return linked.project;
}

for (const reversed of [false, true]) {
  test(`ID and name lookups refuse an ambiguous ID before path liveness (reverse=${reversed})`, async () => {
    const first = await fixture.createProject("first", "first");
    const second = await fixture.createProject("second", "second");
    const entries = [first.entry, { ...second.entry, id: first.entry.id }];
    await rm(second.project.projectRoot, { recursive: true });
    await fixture.writeRegistry(reversed ? entries.reverse() : entries);
    const before = await readFile(fixture.registryPath, "utf8");
    expect((await readProjectsRegistry()).projects).toEqual(entries);
    await expect(
      resolveRegisteredProjectById({ id: first.entry.id })
    ).rejects.toThrow("Ambiguous project ID");
    for (const name of ["first", "second"]) {
      await expect(resolveRegisteredProjectByName({ name })).rejects.toThrow(
        "Ambiguous project ID"
      );
    }
    await expectUnchanged(before);
  });

  for (const scenario of ["primary", "linked", "moved"] as const) {
    test(`upsert refuses duplicate IDs for ${scenario} registrations (reverse=${reversed})`, async () => {
      const primary = await fixture.createProject("primary", "target");
      const other = await fixture.createProject("other", "other");
      const project =
        scenario === "primary"
          ? primary.project
          : await createLinkedProject(primary.project);
      if (scenario === "moved") {
        await rm(primary.project.projectDir, { recursive: true });
      }
      const entries = [primary.entry, { ...other.entry, id: primary.entry.id }];
      await fixture.writeRegistry(reversed ? entries.reverse() : entries);
      const before = await readFile(fixture.registryPath, "utf8");
      await expect(
        upsertProjectRegistration({ project, nowIso: NOW })
      ).rejects.toThrow("Ambiguous project ID");
      expect(
        await touchProjectRegistration({ project, nowIso: NOW })
      ).toBeNull();
      await expectUnchanged(before);
    });
  }

  test(`pruning a dead duplicate cannot remove its live counterpart (reverse=${reversed})`, async () => {
    const live = await fixture.createProject("live", "live");
    const dead = await fixture.createProject("dead", "dead");
    await rm(dead.project.projectRoot, { recursive: true });
    const entries = [live.entry, { ...dead.entry, id: live.entry.id }];
    await fixture.writeRegistry(reversed ? entries.reverse() : entries);
    const before = await readFile(fixture.registryPath, "utf8");
    const found = await findDeadProjectRegistrations({
      projects: (await readProjectsRegistry()).projects,
    });
    expect(found.map(({ project }) => project.name)).toEqual(["dead"]);
    await expect(
      removeProjectsById({ ids: found.map(({ project }) => project.id) })
    ).rejects.toThrow("Ambiguous project ID");
    await expectUnchanged(before);
  });
}

test("a mixed removal request refuses atomically regardless of request order", async () => {
  const unique = await fixture.createProject("unique", "unique");
  const first = await fixture.createProject("first", "first");
  const second = await fixture.createProject("second", "second");
  await fixture.writeRegistry([
    unique.entry,
    first.entry,
    { ...second.entry, id: first.entry.id },
  ]);
  const before = await readFile(fixture.registryPath, "utf8");
  for (const ids of [
    [unique.entry.id, first.entry.id],
    [first.entry.id, unique.entry.id],
  ]) {
    await expect(removeProjectsById({ ids })).rejects.toThrow(
      "Ambiguous project ID"
    );
    await expectUnchanged(before);
  }
});

test("a computed new ID collision cannot create another owner", async () => {
  const incoming = await fixture.createProject("new", "new");
  const other = await fixture.createProject("other", "other");
  const collidingId = createHash("sha1")
    .update(`new\n${incoming.project.projectDir}`)
    .digest("hex")
    .slice(0, 12);
  await fixture.writeRegistry([{ ...other.entry, id: collidingId }]);
  const before = await readFile(fixture.registryPath, "utf8");
  await expect(
    upsertProjectRegistration({ project: incoming.project, nowIso: NOW })
  ).rejects.toThrow("Project ID collision");
  await expectUnchanged(before);
});

test("unrelated duplicate IDs do not block unique lookup, upsert, or removal", async () => {
  const unique = await fixture.createProject("unique", "unique");
  const first = await fixture.createProject("first", "first");
  const second = await fixture.createProject("second", "second");
  const duplicates = [first.entry, { ...second.entry, id: first.entry.id }];
  await fixture.writeRegistry([unique.entry, ...duplicates]);
  expect(
    (await resolveRegisteredProjectById({ id: unique.entry.id }))?.registration
  ).toEqual(unique.entry);
  expect(
    (await resolveRegisteredProjectByName({ name: "unique" }))?.projectRoot
  ).toBe(unique.project.projectRoot);
  expect(
    (await upsertProjectRegistration({ project: unique.project, nowIso: NOW }))
      .status
  ).toBe("updated");
  expect((await readProjectsRegistry()).projects.slice(1)).toEqual(duplicates);
  expect(
    (
      await removeProjectsById({ ids: [unique.entry.id, unique.entry.id] })
    ).removed.map(({ id }) => id)
  ).toEqual([unique.entry.id]);
  expect((await readProjectsRegistry()).projects).toEqual(duplicates);
  expect(await readdir(fixture.state)).toEqual(["projects.json"]);
});

for (const linked of [false, true]) {
  test(`a fresh duplicate ID observation defers instead of returning noop (linked=${linked})`, async () => {
    const first = await fixture.createProject("first", "target");
    const second = await fixture.createProject("second", "second");
    const project = linked
      ? await createLinkedProject(first.project)
      : first.project;
    await fixture.writeRegistry([
      {
        ...first.entry,
        lastSeenAt: NOW,
        ...(linked
          ? {
              worktrees: [
                {
                  path: project.projectRoot,
                  branch: "feature/linked",
                  lastSeenAt: NOW,
                },
              ],
            }
          : {}),
      },
      { ...second.entry, id: first.entry.id },
    ]);
    const before = await readFile(fixture.registryPath, "utf8");
    expect(await touchProjectRegistration({ project, nowIso: NOW })).toBeNull();
    await expectUnchanged(before);
  });
}

test("missing lastSeenAt persists once, preserves live sibling metadata, then coalesces", async () => {
  const primary = await fixture.createProject("primary", "primary");
  const sibling = await fixture.createProject("sibling", "primary");
  const worktrees = [
    { path: sibling.project.projectRoot, branch: "feature", lastSeenAt: NOW },
  ];
  await fixture.writeRegistry([{ ...primary.entry, worktrees }]);
  expect(
    (await touchProjectRegistration({ project: primary.project, nowIso: NOW }))
      ?.status
  ).toBe("updated");
  expect((await readProjectsRegistry()).projects).toEqual([
    { ...primary.entry, lastSeenAt: NOW, worktrees },
  ]);
  const before = await readFile(fixture.registryPath, "utf8");
  const mtime = (await stat(fixture.registryPath)).mtimeMs;
  expect(
    (
      await touchProjectRegistration({
        project: primary.project,
        nowIso: "2026-01-02T00:00:30Z",
      })
    )?.status
  ).toBe("noop");
  expect((await stat(fixture.registryPath)).mtimeMs).toBe(mtime);
  await expectUnchanged(before);
});

test("adding devHost persists even when all existing fields are unchanged", async () => {
  const { project, entry } = await fixture.createProject("primary", "primary");
  const { devHost: _host, ...withoutHost } = entry;
  await fixture.writeRegistry([{ ...withoutHost, lastSeenAt: NOW }]);
  expect(
    (await upsertProjectRegistration({ project, nowIso: NOW })).status
  ).toBe("updated");
  expect((await readProjectsRegistry()).projects).toEqual([
    { ...entry, lastSeenAt: NOW },
  ]);
});

for (const operation of ["upsert", "remove"] as const) {
  test(`${operation} validates target identity after waiting for registry ownership`, async () => {
    const first = await fixture.createProject("first", "first");
    const second = await fixture.createProject("second", "second");
    await fixture.writeRegistry([first.entry]);
    const lockPath = `${fixture.registryPath}.lock`;
    let pending: Promise<unknown> | undefined;
    let result: unknown;
    let before = "";
    try {
      await withProjectsRegistryLock({
        lockPath,
        run: async () => {
          pending = (
            operation === "upsert"
              ? upsertProjectRegistration({
                  project: first.project,
                  nowIso: NOW,
                })
              : removeProjectsById({ ids: [first.entry.id] })
          ).catch((error: unknown) => error);
          const deadline = Date.now() + 5000;
          while (
            !(await readdir(fixture.state)).some((name) =>
              name.endsWith(".owner")
            )
          ) {
            if (Date.now() >= deadline) {
              throw new Error("Writer did not reach locked registry admission");
            }
            await Bun.sleep(5);
          }
          await fixture.writeRegistry([
            first.entry,
            { ...second.entry, id: first.entry.id },
          ]);
          before = await readFile(fixture.registryPath, "utf8");
        },
      });
    } finally {
      result = await pending;
    }
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error ? result.message : "no refusal").toContain(
      "Ambiguous project ID"
    );
    await expectUnchanged(before);
  });
}
