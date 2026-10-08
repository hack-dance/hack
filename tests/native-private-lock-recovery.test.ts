import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNativeComposePrivateMutationLock,
  holdDirectory,
  parseNativeComposeInterruptedLockSelection,
  recheckDirectories,
} from "../src/lib/native-compose-private-state.ts";

const fixtures: Array<{
  readonly root: string;
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly close: () => Promise<void>;
}> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.child.exitCode === null) {
      fixture.child.kill("SIGKILL");
    }
    await fixture.child.exited;
    await fixture.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-dead-lock-"))
  );
  await chmod(root, 0o700);
  const source = join(
    import.meta.dir,
    "../src/lib/native-compose-private-state.ts"
  );
  const program = [
    `import { createNativeComposePrivateMutationLock, holdDirectory, recheckDirectories } from ${JSON.stringify(source)};`,
    `const root = ${JSON.stringify(root)};`,
    "const parent = await holdDirectory(root, true);",
    "const lock = createNativeComposePrivateMutationLock({ lockPath: root+'/held', recoveryPath: root+'/recovering', parent, check: () => recheckDirectories([parent]) });",
    "await lock.withLock(async () => {",
    "await Bun.write(root+'/ready', 'ready');",
    "await new Promise(resolve => setTimeout(resolve, 120000));",
    "});",
    "await parent.file.close();",
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--eval", program], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });
  const parent = await holdDirectory(root, true);
  fixtures.push({ root, child, close: () => parent.file.close() });
  const deadline = performance.now() + 5000;
  while (!(await Bun.file(join(root, "ready")).exists())) {
    if (child.exitCode !== null || performance.now() >= deadline) {
      throw new Error("Owned lock fixture did not publish its ready witness.");
    }
    await Bun.sleep(10);
  }
  const lock = createNativeComposePrivateMutationLock({
    lockPath: join(root, "held"),
    recoveryPath: join(root, "recovering"),
    parent,
    check: () => recheckDirectories([parent]),
  });
  return {
    root,
    child,
    lock,
    async kill() {
      child.kill("SIGKILL");
      expect(await child.exited).toBe(137);
    },
  };
}

test("selected private lock recovery refuses a live owner and reads a dead owner without effects", async () => {
  const current = await fixture();
  await expect(current.lock.selectInterruptedLock()).rejects.toThrow();
  expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
  expect((await readdir(current.root)).includes("recovering")).toBe(false);
  await current.kill();
  const selected = await current.lock.selectInterruptedLock();
  expect(selected.owner.pid).toBe(current.child.pid);
  expect(selected.file.ino).toBe(
    (await lstat(join(current.root, "held/owner"))).ino
  );
  expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
  await current.lock.recoverSelectedInterruptedLock(selected);
  expect(await readdir(current.root)).toEqual(["ready"]);
  await expect(
    current.lock.recoverSelectedInterruptedLock(selected)
  ).rejects.toThrow();
  // The legacy helper's absent-lock behavior is unchanged.
  await current.lock.recoverInterruptedLock();
});

test("selected private lock recovery captures the complete caller selection before its first await", async () => {
  const current = await fixture();
  await current.kill();
  const selected = JSON.parse(
    JSON.stringify(await current.lock.selectInterruptedLock())
  );
  const pending = current.lock.recoverSelectedInterruptedLock(selected);
  selected.file.ino += 1;
  selected.owner.bootId = "00000000-0000-0000-0000-000000000000";
  await pending;
  expect(await readdir(current.root)).toEqual(["ready"]);
});

test("saved private lock selection refuses same-byte replacement owner or directory", async () => {
  for (const replacement of ["owner", "directory"]) {
    const current = await fixture();
    await current.kill();
    const selected = await current.lock.selectInterruptedLock();
    if (replacement === "owner") {
      const path = join(current.root, "held/owner");
      await copyFile(path, join(current.root, "copy"));
      await chmod(join(current.root, "copy"), 0o600);
      await rename(join(current.root, "copy"), path);
    } else {
      await rename(join(current.root, "held"), join(current.root, "original"));
      await mkdir(join(current.root, "held"), { mode: 0o700 });
      await copyFile(
        join(current.root, "original/owner"),
        join(current.root, "held/owner")
      );
      await chmod(join(current.root, "held/owner"), 0o600);
    }
    await expect(
      current.lock.recoverSelectedInterruptedLock(selected)
    ).rejects.toThrow();
    expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
    expect((await readdir(current.root)).includes("recovering")).toBe(false);
  }
});

test("private dead-lock selectors close nested fields and do not admit another host boot", async () => {
  const current = await fixture();
  await current.kill();
  const original = await current.lock.selectInterruptedLock();
  for (const value of [
    { ...original, private: "must-not-reflect" },
    { ...original, file: { ...original.file, path: "must-not-reflect" } },
    { ...original, owner: { ...original.owner, pid: 0 } },
    { ...original, directory: { ...original.directory, ino: -1 } },
  ]) {
    expect(() => parseNativeComposeInterruptedLockSelection(value)).toThrow();
  }
  const wrongBoot = {
    ...original,
    owner: {
      ...original.owner,
      bootId: "00000000-0000-0000-0000-000000000000",
    },
  };
  await expect(
    current.lock.recoverSelectedInterruptedLock(wrongBoot)
  ).rejects.toThrow();
  expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
  await Bun.write(
    join(current.root, "held/owner"),
    JSON.stringify(wrongBoot.owner)
  );
  await expect(current.lock.selectInterruptedLock()).rejects.toThrow();
  expect((await readdir(current.root)).includes("recovering")).toBe(false);
  await unlink(join(current.root, "held/owner"));
  await expect(
    current.lock.recoverSelectedInterruptedLock(original)
  ).rejects.toThrow();
});
