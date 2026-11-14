import { expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LifecycleStateEntry,
  readLifecycleState,
  removeLifecycleStateEntry,
  removeLifecycleStateEntryIfMatching,
  removeLifecycleStateEntryIfOwned,
  resolveLifecycleRootDir,
  resolveLifecycleStatePath,
  upsertLifecycleStateEntry,
} from "../src/lib/lifecycle-runtime.ts";

function entry(name: string, cleanupEpoch = "epoch-a"): LifecycleStateEntry {
  return {
    composeProject: name,
    projectName: "example-project",
    branch: name,
    sessionName: `example-lifecycle-${name}`,
    backend: "supervisor",
    ownershipToken: "synthetic-owner",
    cleanupEpoch,
    supervisorPid: 42,
    processes: [
      {
        name: "worker",
        windowName: "worker",
        logPath: "example.log",
        guardPid: 43,
        guardStartTime: 44,
        commandPid: 45,
        processGroupId: 43,
        bootId: "synthetic-boot",
      },
    ],
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

async function fixture(
  run: (opts: {
    projectDir: string;
    root: string;
    path: string;
  }) => Promise<void>
) {
  const projectDir = await mkdtemp(join(tmpdir(), "hack-state-publication-"));
  const root = resolveLifecycleRootDir({ projectDir });
  const path = resolveLifecycleStatePath({ projectDir });
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await run({ projectDir, root, path });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

test("parallel branch publication and all deletion variants preserve unrelated ownership", async () => {
  await fixture(async ({ projectDir }) => {
    const names = ["branch-a", "branch-b", "branch-c", "branch-d"];
    await Promise.all(
      names.map((name) =>
        upsertLifecycleStateEntry({ projectDir, entry: entry(name) })
      )
    );
    expect(
      (await readLifecycleState({ projectDir })).map(
        (item) => item.composeProject
      )
    ).toEqual(names);
    await Promise.all([
      removeLifecycleStateEntry({ projectDir, composeProject: "branch-a" }),
      removeLifecycleStateEntryIfOwned({
        projectDir,
        composeProject: "branch-b",
        ownershipToken: "synthetic-owner",
      }),
      removeLifecycleStateEntryIfMatching({
        projectDir,
        expectedEntry: entry("branch-c"),
      }),
      upsertLifecycleStateEntry({ projectDir, entry: entry("branch-e") }),
    ]);
    expect(
      (await readLifecycleState({ projectDir })).map(
        (item) => item.composeProject
      )
    ).toEqual(["branch-d", "branch-e"]);
  });
});

test("old cleanup epoch cannot delete an adopted entry with the same owner token", async () => {
  await fixture(async ({ projectDir }) => {
    await upsertLifecycleStateEntry({
      projectDir,
      entry: entry("branch-a", "adopted"),
    });
    expect(
      await removeLifecycleStateEntryIfMatching({
        projectDir,
        expectedEntry: entry("branch-a"),
      })
    ).toBe(false);
    expect(
      await removeLifecycleStateEntryIfOwned({
        projectDir,
        composeProject: "branch-a",
        ownershipToken: "foreign-owner",
      })
    ).toBe(false);
    const states = await readLifecycleState({ projectDir });
    expect(states).toEqual([entry("branch-a", "adopted")]);
  });
});

test("atomic readers observe a complete old or new snapshot", async () => {
  await fixture(async ({ projectDir }) => {
    await upsertLifecycleStateEntry({
      projectDir,
      entry: entry("branch-a", "0"),
    });
    let writing = true;
    const writer = (async () => {
      for (let index = 1; index <= 25; index += 1) {
        await upsertLifecycleStateEntry({
          projectDir,
          entry: entry("branch-a", String(index)),
        });
      }
    })().finally(() => {
      writing = false;
    });
    let observations = 0;
    while (writing) {
      const states = await readLifecycleState({ projectDir });
      expect(states).toHaveLength(1);
      expect(states[0]?.composeProject).toBe("branch-a");
      expect(Number(states[0]?.cleanupEpoch)).toBeWithin(0, 26);
      observations += 1;
    }
    await writer;
    expect(observations).toBeGreaterThan(0);
    expect((await readLifecycleState({ projectDir }))[0]?.cleanupEpoch).toBe(
      "25"
    );
  });
});

test.each([
  "",
  "{",
  "null",
  '{"entries":{}}',
  '{"entries":[{}]}',
])("malformed state refuses mutation without overwriting (%p)", async (text) => {
  await fixture(async ({ projectDir, path }) => {
    await writeFile(path, text, { mode: 0o600 });
    await expect(readLifecycleState({ projectDir })).rejects.toThrow(
      "Lifecycle ownership state"
    );
    await expect(
      upsertLifecycleStateEntry({ projectDir, entry: entry("branch-a") })
    ).rejects.toThrow("Lifecycle ownership state");
    expect(await readFile(path, "utf8")).toBe(text);
  });
});

test.each([
  "symlink",
  "hardlink",
])("aliased ownership state is refused without changing either name (%s)", async (kind) => {
  await fixture(async ({ projectDir, root, path }) => {
    const target = join(root, "retained.json");
    const contents = JSON.stringify({ entries: [entry("branch-a")] });
    await writeFile(target, contents, { mode: 0o600 });
    if (kind === "symlink") {
      await symlink(target, path);
    } else {
      await link(target, path);
    }
    await expect(
      upsertLifecycleStateEntry({ projectDir, entry: entry("branch-b") })
    ).rejects.toThrow();
    await expect(readLifecycleState({ projectDir })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(contents);
    expect(await readFile(path, "utf8")).toBe(contents);
  });
});

test("legacy owner-only regular state migrates to private atomic publication", async () => {
  await fixture(async ({ projectDir, root, path }) => {
    await chmod(root, 0o755);
    await writeFile(path, JSON.stringify({ entries: [entry("branch-a")] }), {
      mode: 0o644,
    });
    expect(await readLifecycleState({ projectDir })).toEqual([
      entry("branch-a"),
    ]);
    await upsertLifecycleStateEntry({ projectDir, entry: entry("branch-b") });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readLifecycleState({ projectDir })).toEqual([
      entry("branch-a"),
      entry("branch-b"),
    ]);
  });
});

test("duplicate ownership entries and malformed process rows fail closed", async () => {
  await fixture(async ({ projectDir, path }) => {
    for (const entries of [
      [entry("branch-a"), entry("branch-a")],
      [{ ...entry("branch-a"), processes: [{}] }],
    ]) {
      const text = JSON.stringify({ entries });
      await writeFile(path, text, { mode: 0o600 });
      await expect(
        removeLifecycleStateEntry({ projectDir, composeProject: "branch-a" })
      ).rejects.toThrow("Lifecycle ownership state");
      expect(await readFile(path, "utf8")).toBe(text);
    }
  });
});

test("oversized existing and proposed state are refused without replacement", async () => {
  await fixture(async ({ projectDir, path }) => {
    const oversized = " ".repeat(1024 * 1024 + 1);
    await writeFile(path, oversized, { mode: 0o600 });
    await expect(
      upsertLifecycleStateEntry({ projectDir, entry: entry("branch-a") })
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(oversized);
    const text = JSON.stringify({ entries: [entry("branch-a")] });
    await writeFile(path, text, { mode: 0o600 });
    await expect(
      upsertLifecycleStateEntry({
        projectDir,
        entry: { ...entry("branch-b"), definitionHash: oversized },
      })
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(text);
  });
});
