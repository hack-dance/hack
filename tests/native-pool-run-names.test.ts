import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLivePoolRuns } from "../src/backends/native-pool-run-names.ts";
import type { ProjectsRegistry } from "../src/lib/projects-registry.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

const run = (digit: string) => digit.repeat(32);

/** A checkout whose `.hack` dir maps `runs`; returns its `.hack` dir. */
async function checkout(root: string, name: string, runs: readonly string[]) {
  const projectDir = join(root, name, ".hack");
  const mappings = join(projectDir, ".internal", "native-runs");
  await mkdir(mappings, { recursive: true });
  for (const [index, id] of runs.entries()) {
    await writeFile(
      join(mappings, `scope-${index}.json`),
      JSON.stringify({
        version: 1,
        scope: {},
        run: { run: id, namespace: "n" },
      })
    );
  }
  // Files that are not mappings map nothing.
  await writeFile(join(mappings, "notes.txt"), "not a mapping");
  await writeFile(join(mappings, "torn.json"), "{");
  return projectDir;
}

function registry(
  projects: readonly { name: string; projectDir: string; worktree?: string }[]
): () => Promise<ProjectsRegistry> {
  return () =>
    Promise.resolve({
      version: 1,
      projects: projects.map((project) => ({
        id: project.name,
        name: project.name,
        repoRoot: join(project.projectDir, ".."),
        projectDirName: ".hack",
        projectDir: project.projectDir,
        createdAt: "2026-11-22T00:00:00.000Z",
        ...(project.worktree
          ? {
              worktrees: [
                {
                  path: project.worktree,
                  branch: "feature",
                  lastSeenAt: "2026-11-22T00:00:00.000Z",
                },
              ],
            }
          : {}),
      })),
    }) as Promise<ProjectsRegistry>;
}

test("live runs are named by the registered checkout that maps them, three at most", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-pool-names-"));
  scratch.push(root);
  const apps = await Promise.all(
    ["one", "two", "three", "four"].map(async (name, index) => ({
      name: `${name}-app`,
      projectDir: await checkout(root, name, [run(String(index + 1))]),
    }))
  );
  await checkout(root, "wt", [run("9")]);
  const all = registry([
    { ...apps[0], worktree: join(root, "wt") },
    ...apps.slice(1),
  ] as never);
  expect(await describeLivePoolRuns([run("1")], { registry: all })).toBe(
    "one-app"
  );
  expect(await describeLivePoolRuns([run("9")], { registry: all })).toBe(
    "one-app (feature)"
  );
  // Four projects: three named, one counted; an unmapped run is counted too.
  expect(
    await describeLivePoolRuns(
      [run("1"), run("2"), run("3"), run("4"), run("e")],
      { registry: all }
    )
  ).toBe("one-app, two-app, three-app and 2 more");
  // None can be mapped: it says so.
  expect(
    await describeLivePoolRuns([run("e"), run("f")], { registry: all })
  ).toBe("2 live project runs that no registered project's run mapping names");
  // An unreadable registry maps nothing.
  expect(
    await describeLivePoolRuns([run("1")], {
      registry: () => Promise.reject(new Error("unreadable")),
    })
  ).toBe("1 live project run that no registered project's run mapping names");
});
