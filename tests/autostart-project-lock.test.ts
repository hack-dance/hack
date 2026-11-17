import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAutostartProjectCurrent,
  withAutostartProjectLock,
} from "../src/lib/autostart-project-lock.ts";

let root = "";
let registryPath = "";
const scope = {
  projectId: "example-id",
  composeProject: "example",
  branch: null,
};
const marker = {
  branch: null,
  paused: false,
  lastResult: null,
  lastAttemptBootId: null,
};
function project(autostart: unknown = marker) {
  return {
    id: scope.projectId,
    name: "example",
    repoRoot: "/example/project",
    projectDir: "/example/project/.hack",
    projectDirName: ".hack",
    createdAt: "2026-01-01T00:00:00Z",
    ...(autostart ? { autostart } : {}),
  };
}
async function registry(projects: unknown[], global?: unknown) {
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects,
      ...(global ? { autostartGlobal: global } : {}),
    }),
    { mode: 0o600 }
  );
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-autostart-lock-"));
  registryPath = join(root, "projects.json");
  await registry([project()]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("start/stop admission serializes the Compose instance even after registry identity changes", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = withAutostartProjectLock({
    scope,
    registryPath,
    run: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  let secondRan = false;
  try {
    await expect(
      withAutostartProjectLock({
        scope: { ...scope, projectId: "renamed-id" },
        registryPath,
        timeoutMs: 30,
        run: async () => {
          secondRan = true;
        },
      })
    ).rejects.toThrow("Project start/stop");
    expect(secondRan).toBe(false);
    let independentBranchRan = false;
    await withAutostartProjectLock({
      scope: { ...scope, branch: "preview" },
      registryPath,
      timeoutMs: 30,
      run: async () => {
        independentBranchRan = true;
      },
    });
    expect(independentBranchRan).toBe(true);
  } finally {
    release.resolve();
    await first;
  }
  await withAutostartProjectLock({
    scope,
    registryPath,
    run: async () => {
      secondRan = true;
    },
  });
  expect(secondRan).toBe(true);
});

test("rechecking intent accepts exactly one unpaused matching registered target", async () => {
  await expect(
    assertAutostartProjectCurrent({ scope, registryPath })
  ).resolves.toBeUndefined();
  for (const entry of [
    undefined,
    { ...marker, paused: true },
    { ...marker, branch: "preview" },
    { paused: "invalid" },
  ]) {
    await registry([project(entry === undefined ? null : entry)]);
    await expect(
      assertAutostartProjectCurrent({ scope, registryPath })
    ).rejects.toMatchObject({ code: "E_CANCELLED" });
  }
  await registry([project(), project()]);
  await expect(
    assertAutostartProjectCurrent({ scope, registryPath })
  ).rejects.toMatchObject({
    code: "E_CANCELLED",
    detail: { reason: "paused" },
  });
  await registry([project()], {
    paused: true,
    loginRun: {
      runId: null,
      bootId: null,
      inProgress: false,
      waitingForEngine: false,
      startedAt: null,
      pending: [],
      started: [],
      failed: [],
    },
  });
  await expect(
    assertAutostartProjectCurrent({ scope, registryPath })
  ).rejects.toMatchObject({
    code: "E_CANCELLED",
    detail: { reason: "global_paused" },
  });
});

for (const kind of ["writable", "symlink"]) {
  test(`an unsafe ${kind} lock directory refuses before running project effects`, async () => {
    const locks = join(root, "autostart-locks");
    if (kind === "symlink") {
      const target = join(root, "other");
      await mkdir(target);
      await symlink(target, locks);
    } else {
      await mkdir(locks);
      await chmod(locks, 0o777);
    }
    let ran = false;
    await expect(
      withAutostartProjectLock({
        scope,
        registryPath,
        run: async () => {
          ran = true;
        },
      })
    ).rejects.toMatchObject({ code: "E_PERMISSION" });
    expect(ran).toBe(false);
  });
}
