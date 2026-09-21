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
