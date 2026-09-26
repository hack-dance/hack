import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadNativeProjectRun as load,
  removeNativeProjectRun as remove,
  saveNativeProjectRun as save,
} from "../src/backends/native-project-run.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
};
async function fixture() {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-mapping-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome);
  return { projectRoot, projectDir, nativeHome, branch: null };
}
test("exclusive project/branch mapping roundtrips and exact cleanup preserves other branch", async () => {
  const opts = await fixture();
  expect(await load(opts)).toBeNull();
  await save({ ...opts, run });
  expect(await load(opts)).toEqual(run);
  await expect(save({ ...opts, run })).rejects.toThrow();
  await save({
    ...opts,
    branch: "other",
    run: { ...run, run: "e".repeat(32) },
  });
  await expect(
    remove({ ...opts, expected: { ...run, owner: "e".repeat(32) } })
  ).rejects.toThrow();
  expect(await load(opts)).toEqual(run);
  await remove({ ...opts, expected: run });
  expect(await load(opts)).toBeNull();
  expect((await load({ ...opts, branch: "other" }))?.run).toBe("e".repeat(32));
});
test("retained run mapping is replaced only by the same confirmed owner", async () => {
  const opts = await fixture();
  await save({ ...opts, run });
  const resumed = {
    ...run,
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  await expect(
    save({ ...opts, run: resumed, expected: { ...run, owner: "f".repeat(32) } })
  ).rejects.toThrow();
  await expect(
    save({
      ...opts,
      run: { ...resumed, run: "f".repeat(32) },
      expected: run,
    })
  ).rejects.toThrow();
  expect(await load(opts)).toEqual(run);
  await save({ ...opts, run: resumed, expected: run });
  expect(await load(opts)).toEqual(resumed);
  await expect(
    save({ ...opts, run: resumed, expected: run })
  ).rejects.toThrow();
  expect(await load(opts)).toEqual(resumed);
});
test("concurrent admission has one publisher and state stays ignored", async () => {
  const opts = await fixture();
  const results = await Promise.allSettled([
    save({ ...opts, run }),
    save({ ...opts, run }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await readFile(
      join(opts.projectDir, ".internal/native-runs/.gitignore"),
      "utf8"
    )
  ).toBe("*\n");
  expect(await load(opts)).toEqual(run);
});
test("changed candidate home or project directory identity refuses", async () => {
  const opts = await fixture();
  await save({ ...opts, run });
  await rename(opts.nativeHome, `${opts.nativeHome}-old`);
  await mkdir(opts.nativeHome);
  await expect(load(opts)).rejects.toThrow();
});
test("malformed ownership, symlink storage and foreign contents refuse", async () => {
  const opts = await fixture();
  await expect(
    save({ ...opts, run: { ...run, run: "../other" } })
  ).rejects.toThrow();
  await symlink(opts.nativeHome, join(opts.projectDir, ".internal"));
  await expect(save({ ...opts, run })).rejects.toThrow();
  await rm(join(opts.projectDir, ".internal"));
  await save({ ...opts, run });
  const dir = join(opts.projectDir, ".internal/native-runs");
  const name = (await readdir(dir)).find((x) => x.endsWith(".json"));
  expect(name).toBeDefined();
  await writeFile(join(dir, name ?? "absent"), "{}");
  await expect(load(opts)).rejects.toThrow();
});

test("repeated confirmed retirement is idempotent without deleting a replacement", async () => {
  const opts = await fixture();
  await save({ ...opts, run });
  await remove({ ...opts, expected: run });
  await remove({ ...opts, expected: run });
  const replacement = { ...run, run: "f".repeat(32) };
  await save({ ...opts, run: replacement });
  await expect(remove({ ...opts, expected: run })).rejects.toThrow();
  expect(await load(opts)).toEqual(replacement);
});

test("absent mapping does not excuse another owner's cleanup lock", async () => {
  const opts = await fixture();
  await save({ ...opts, run });
  const dir = join(opts.projectDir, ".internal/native-runs");
  const name = (await readdir(dir)).find((value) => value.endsWith(".json"));
  expect(name).toBeDefined();
  await remove({ ...opts, expected: run });
  const lock = join(dir, (name ?? "missing.json").replace(".json", ".lock"));
  await mkdir(lock);
  await expect(remove({ ...opts, expected: run })).rejects.toThrow();
  expect(
    (await readdir(dir)).includes(
      (name ?? "missing.json").replace(".json", ".lock")
    )
  ).toBe(true);
});

test("environment selection distinguishes legacy, explicit base and overlay metadata", async () => {
  for (const selected of [undefined, null, "qa"]) {
    const opts = await fixture();
    const mapped =
      selected === undefined ? run : { ...run, effectiveEnvName: selected };
    await save({ ...opts, run: mapped });
    expect(await load(opts)).toEqual(mapped);
    await remove({ ...opts, expected: mapped });
  }
  const opts = await fixture();
  await expect(
    save({ ...opts, run: { ...run, effectiveEnvName: "../qa" } })
  ).rejects.toThrow();
});

test("stored overlay names cannot normalize to a different selection", async () => {
  const opts = await fixture();
  for (const effectiveEnvName of [
    "QA",
    "qa_env",
    "qa--env",
    "-qa",
    "qa-",
    "qa.local",
    "a".repeat(129),
  ]) {
    await expect(
      save({ ...opts, run: { ...run, effectiveEnvName } })
    ).rejects.toThrow();
  }
  await save({ ...opts, run: { ...run, effectiveEnvName: "qa-local" } });
  expect((await load(opts))?.effectiveEnvName).toBe("qa-local");
});

test("AWS startup selection roundtrips without admitting credentials or ambient selectors", async () => {
  for (const aws of [
    null,
    { profile: "qa" },
    { profile: "qa", region: "us-east-1" },
  ]) {
    const opts = await fixture();
    const selected = { ...run, effectiveEnvName: "qa", aws };
    await save({ ...opts, run: selected });
    expect(await load(opts)).toEqual(selected);
    await remove({ ...opts, expected: selected });
  }
  for (const aws of [
    { profile: "../qa" },
    { profile: "qa", region: "not-a-region" },
    { profile: "qa", AWS_SECRET_ACCESS_KEY: "synthetic-rejected" },
    { profile: "qa", region: "us-east-1", credentials: "synthetic-rejected" },
  ]) {
    const opts = await fixture();
    await expect(
      save({ ...opts, run: { ...run, effectiveEnvName: null, aws } })
    ).rejects.toThrow();
    expect(await load(opts)).toBeNull();
  }
});

test("profile selectors roundtrip canonically while legacy absence stays unknown", async () => {
  const opts = await fixture();
  const selected = {
    ...run,
    effectiveEnvName: null,
    aws: null,
    profiles: ["qa", "worker"],
  };
  await save({ ...opts, run: selected });
  expect(await load(opts)).toEqual(selected);
  await remove({ ...opts, expected: selected });
  for (const profiles of [
    ["worker", "qa"],
    ["qa", "qa"],
    [""],
    ["bad\nprofile"],
  ]) {
    await expect(
      save({ ...opts, run: { ...selected, profiles } })
    ).rejects.toThrow();
  }
  await save({ ...opts, run });
  expect((await load(opts))?.profiles).toBeUndefined();
});

test("restart intent survives mapping retirement and refuses mismatched removal", async () => {
  const {
    loadNativeRestartIntent,
    saveNativeRestartIntent,
    removeNativeRestartIntent,
  } = await import("../src/backends/native-project-run.ts");
  const opts = await fixture();
  const intent = {
    phase: "prepared" as const,
    run,
    finalization: {
      version: 1 as const,
      attempt: "e".repeat(32),
      scope: "f".repeat(64),
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      planId: run.planId,
    },
  };
  await save({ ...opts, run });
  await saveNativeRestartIntent({ ...opts, intent });
  await remove({ ...opts, expected: run });
  expect(await load(opts)).toBeNull();
  expect(await loadNativeRestartIntent(opts)).toEqual(intent);
  await expect(saveNativeRestartIntent({ ...opts, intent })).rejects.toThrow();
  await expect(
    removeNativeRestartIntent({
      ...opts,
      expected: {
        ...intent,
        finalization: { ...intent.finalization, attempt: "1".repeat(32) },
      },
    })
  ).rejects.toThrow();
  expect(await loadNativeRestartIntent(opts)).toEqual(intent);
  await removeNativeRestartIntent({ ...opts, expected: intent });
  expect(await loadNativeRestartIntent(opts)).toBeNull();
});
test("restart operation lock excludes overlap and releases at readiness", async () => {
  const { withNativeRestartLock } = await import(
    "../src/backends/native-project-run.ts"
  );
  const opts = await fixture();
  await withNativeRestartLock(opts, async (release) => {
    await expect(
      withNativeRestartLock(opts, () => Promise.resolve())
    ).rejects.toThrow("already owned");
    await release();
    expect(
      await withNativeRestartLock(opts, () => Promise.resolve("next"))
    ).toBe("next");
  });
});
