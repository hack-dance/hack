import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, copyFileSync, renameSync } from "node:fs";
import * as privateFiles from "node:fs/promises";
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

async function fixture(check = () => Promise.resolve()) {
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
    check: async () => {
      await check();
      await recheckDirectories([parent]);
    },
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

test("selected retirement rechecks file and caller authority after its final process inspection", async () => {
  for (const interference of ["replacement", "cancellation"]) {
    let canceled = false;
    const current = await fixture(() => {
      if (canceled) {
        throw new Error("Caller authority is no longer held.");
      }
      return Promise.resolve();
    });
    await current.kill();
    const selected = await current.lock.selectInterruptedLock();
    const originalSpawn = Bun.spawn;
    let inspections = 0;
    const intercept = spyOn(Bun, "spawn").mockImplementation((...args) => {
      const command = args[0];
      if (
        Array.isArray(command) &&
        command[0] === "/bin/ps" &&
        command[2] === String(current.child.pid)
      ) {
        inspections += 1;
        if (inspections === 4) {
          if (interference === "replacement") {
            const path = join(current.root, "held/owner");
            copyFileSync(path, join(current.root, "replacement"));
            chmodSync(join(current.root, "replacement"), 0o600);
            renameSync(join(current.root, "replacement"), path);
          } else {
            canceled = true;
          }
        }
      }
      const child: ReturnType<typeof Bun.spawn> = Reflect.apply(
        originalSpawn,
        Bun,
        args
      );
      return child;
    });
    try {
      await expect(
        current.lock.recoverSelectedInterruptedLock(selected)
      ).rejects.toThrow();
      expect(inspections).toBe(4);
      expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
      if (interference === "replacement") {
        expect((await lstat(join(current.root, "held/owner"))).ino).not.toBe(
          selected.file.ino
        );
      }
    } finally {
      intercept.mockRestore();
    }
  }
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

test("durable frontend retirement retains the issued named recovery lease and refuses a copied or foreign lease", async () => {
  const current = await fixture();
  await current.kill();
  const selected = await current.lock.selectInterruptedLock();
  const parent = await holdDirectory(current.root, true);
  try {
    const owner = (name: string) =>
      createNativeComposePrivateMutationLock({
        lockPath: join(current.root, name),
        recoveryPath: join(current.root, `${name}.recovery`),
        parent,
        check: () => recheckDirectories([parent]),
      });
    await owner("foreign").withLock(async (lease) => {
      await expect(
        current.lock.retireSelectedUnderRecoveryLease({ selected, lease })
      ).rejects.toThrow();
      expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
    });
    await owner("recovering").withLock(async (lease) => {
      expect(() =>
        current.lock.retireSelectedUnderRecoveryLease({
          selected,
          lease: { ...lease },
        })
      ).toThrow();
      await current.lock.retireSelectedUnderRecoveryLease({ selected, lease });
      await lease.assertHeld();
      expect((await readdir(current.root)).includes("held")).toBe(false);
      expect(await readdir(join(current.root, "recovering"))).toEqual([
        "owner",
      ]);
    });
    expect(await readdir(current.root)).toEqual(["ready"]);
  } finally {
    await parent.file.close();
  }
});

test("owned recovery lease permits missing owner only at caller's committed retirement phase", async () => {
  const current = await fixture();
  await current.kill();
  const selected = await current.lock.selectInterruptedLock();
  const parent = await holdDirectory(current.root, true);
  try {
    const recovery = createNativeComposePrivateMutationLock({
      lockPath: join(current.root, "recovering"),
      recoveryPath: join(current.root, "recovering.recovery"),
      parent,
      check: () => recheckDirectories([parent]),
    });
    await recovery.withLock(async (lease) => {
      await unlink(join(current.root, "held/owner"));
      await expect(
        current.lock.retireSelectedUnderRecoveryLease({ selected, lease })
      ).rejects.toThrow();
      expect(await readdir(join(current.root, "held"))).toEqual([]);
      await current.lock.retireSelectedUnderRecoveryLease({
        selected,
        lease,
        allowOwnerAbsent: true,
      });
      await lease.assertHeld();
    });
    expect(await readdir(current.root)).toEqual(["ready"]);
  } finally {
    await parent.file.close();
  }
});

test("held recovery retirement refuses guard loss during its dead-process inspection", async () => {
  let changed = false;
  const current = await fixture(() => {
    if (changed) {
      throw new Error("Retained caller authority changed.");
    }
    return Promise.resolve();
  });
  await current.kill();
  const selected = await current.lock.selectInterruptedLock();
  const parent = await holdDirectory(current.root, true);
  try {
    const recovery = createNativeComposePrivateMutationLock({
      lockPath: join(current.root, "recovering"),
      recoveryPath: join(current.root, "recovering.recovery"),
      parent,
      check: () => recheckDirectories([parent]),
    });
    await recovery.withLock(async (lease) => {
      const actual = Bun.spawn;
      const intercept = spyOn(Bun, "spawn").mockImplementation((...args) => {
        const command = args[0];
        if (
          Array.isArray(command) &&
          command[0] === "/bin/ps" &&
          command[2] === String(current.child.pid)
        ) {
          changed = true;
        }
        const child: ReturnType<typeof Bun.spawn> = Reflect.apply(
          actual,
          Bun,
          args
        );
        return child;
      });
      try {
        await expect(
          current.lock.retireSelectedUnderRecoveryLease({ selected, lease })
        ).rejects.toThrow();
        expect(changed).toBe(true);
        expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
        await lease.assertHeld();
      } finally {
        intercept.mockRestore();
      }
    });
  } finally {
    await parent.file.close();
  }
});

test("retirement cannot unlink the selected owner when its recovery callback settles during the final read", async () => {
  const current = await fixture();
  await current.kill();
  const selected = await current.lock.selectInterruptedLock();
  const parent = await holdDirectory(current.root, true);
  let readReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    readReached = resolve;
  });
  let finishRead!: () => void;
  const paused = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const originalOpen = privateFiles.open;
  const readers: ReturnType<typeof spyOn>[] = [];
  const intercept = spyOn(privateFiles, "open").mockImplementation(
    async (...args) => {
      const file: Awaited<ReturnType<typeof privateFiles.open>> =
        await Reflect.apply(originalOpen, privateFiles, args);
      if (args[0] === join(current.root, "held/owner")) {
        const originalRead = file.read;
        readers.push(
          spyOn(file, "read").mockImplementation(async (...readArgs) => {
            const result = await Reflect.apply(originalRead, file, readArgs);
            readReached();
            await paused;
            return result;
          })
        );
      }
      return file;
    }
  );
  let request: Promise<void> | undefined;
  try {
    const recovery = createNativeComposePrivateMutationLock({
      lockPath: join(current.root, "recovering"),
      recoveryPath: join(current.root, "recovering.recovery"),
      parent,
      check: () => recheckDirectories([parent]),
    });
    await recovery.withLock(async (lease) => {
      request = current.lock.retireSelectedUnderRecoveryLease({
        selected,
        lease,
      });
      void request.catch(() => undefined);
      await Promise.race([
        reached,
        Bun.sleep(3000).then(() => {
          throw new Error("Owned read pause was not reached.");
        }),
      ]);
      // Returning ends the actual issued lease while its retirement is awaiting read.
    });
    expect((await readdir(current.root)).includes("recovering")).toBe(false);
    finishRead();
    await expect(request).rejects.toThrow();
    expect(await readdir(join(current.root, "held"))).toEqual(["owner"]);
    expect((await lstat(join(current.root, "held/owner"))).ino).toBe(
      selected.file.ino
    );
  } finally {
    finishRead();
    await request?.catch(() => undefined);
    for (const reader of readers) {
      reader.mockRestore();
    }
    intercept.mockRestore();
    await parent.file.close();
  }
});
