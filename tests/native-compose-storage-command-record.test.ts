import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  holdDirectory,
  writeExclusive,
} from "../src/lib/native-compose-private-state.ts";
import {
  armNativeComposeStorageCommand,
  createNativeComposeStorageCommandOwner,
  type NativeComposeStorageCommandOwner,
  nativeComposeStorageCommandOwnerConfirmed,
  nativeComposeStorageCommandOwnerPublicationPending,
  parseNativeComposeStorageCommandRecord,
  publishNativeComposeStorageCommandChild,
  settleNativeComposeStorageCommand,
} from "../src/lib/native-compose-storage-command-record.ts";
import { runNativeComposeStorageDockerCommand } from "../src/lib/native-compose-storage-witness-docker.ts";
import * as shell from "../src/lib/shell.ts";

const hash = "a".repeat(64);
const executable = {
  path: "/bin/sh",
  dev: "1",
  ino: "1152921500312751116",
  uid: 0,
  mode: 0o10_0755,
  size: 1,
  hash,
};
const host = {
  pid: 100,
  uid: 501,
  birth: "Fri Oct 9 01:00:00 2026",
  boot: "10000000-0000-0000-0000-000000000001",
};
const result = {
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  groupAbsent: true as const,
  captureMode: "held-files-quiescent" as const,
  stdoutHash: hash,
  stderrHash: hash,
};
const roots: string[] = [];
const retained = new Set<string>();
const retainedDirectories = new Set<
  Awaited<ReturnType<typeof holdDirectory>>
>();
const held: Awaited<ReturnType<typeof holdDirectory>>[] = [];
let active = 0,
  unconfirmed = false;
type Completion = {
  state: "pending" | "fulfilled" | "rejected";
  code?: number;
  readonly pid: number;
  readonly group: boolean;
};
let captured: Completion[] = [];
let publications: NativeComposeStorageCommandOwner[] = [];
const originalKill = process.kill.bind(process);
let inspectSpawn: ((args: Parameters<typeof Bun.spawn>) => void) | undefined;
function confirmedTestLifetime(): boolean {
  if (
    publications.some(nativeComposeStorageCommandOwnerPublicationPending) ||
    captured.some((state) => {
      if (
        state.state !== "fulfilled" ||
        !Number.isInteger(state.code) ||
        !Number.isSafeInteger(state.pid) ||
        state.pid <= 1
      ) {
        return true;
      }
      if (!state.group) {
        return false;
      }
      try {
        originalKill(-state.pid, 0);
        return true;
      } catch (error: unknown) {
        return !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ESRCH"
        );
      }
    })
  ) {
    unconfirmed = true;
  }
  return !unconfirmed;
}
beforeEach(() => {
  if (unconfirmed) {
    throw new Error("Owned test continuation unavailable; values omitted.");
  }
});
afterEach(async () => {
  if (active !== 0 || unconfirmed) {
    unconfirmed = true;
    return;
  }
  for (const directory of held.splice(0)) {
    if (retained.has(directory.path)) {
      retainedDirectories.add(directory);
    } else {
      await directory.file.close();
    }
  }
  for (const root of roots.splice(0)) {
    if (!retained.has(root)) {
      await rm(root, { recursive: true, force: true });
    }
  }
});
function ownedCase(operation: () => Promise<void>): () => Promise<void> {
  return async () => {
    active++;
    const states: Completion[] = [];
    captured = states;
    publications = [];
    inspectSpawn = undefined;
    const spawn = Bun.spawn;
    const observe = spyOn(Bun, "spawn").mockImplementation(((
      ...args: Parameters<typeof Bun.spawn>
    ) => {
      inspectSpawn?.(args);
      const child = spawn(...args);
      const state: (typeof states)[number] = {
        state: "pending",
        pid: child.pid,
        group: args[1]?.detached === true,
      };
      states.push(state);
      void child.exited.then(
        (code) => {
          state.state = "fulfilled";
          state.code = code;
        },
        () => {
          state.state = "rejected";
        }
      );
      return child;
    }) as typeof Bun.spawn);
    try {
      await operation();
    } finally {
      if (confirmedTestLifetime()) {
        observe.mockRestore();
      }
      active--;
    }
  };
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-command-record-"))
  );
  roots.push(root);
  const directory = await holdDirectory(root, true);
  held.push(directory);
  const input = join(root, "request.json"),
    text = "synthetic private request";
  const inputInfo = await writeExclusive(input, text);
  const files = {
    held: [directory],
    path: root,
    input,
    inputInfo,
    requestText: text,
    captures: [] as { path: string; info: typeof inputInfo }[],
  };
  let source = "original",
    failChild = false;
  const owner = await createNativeComposeStorageCommandOwner({
    directory,
    binding: {
      invocationId: "b".repeat(32),
      engineId: "synthetic-engine",
      materialHash: hash,
      helperHash: hash,
      requestHash: hash,
      invocationHash: hash,
      sourceHash: hash,
      fixedInvocationHash: hash,
      directory: { dev: directory.info.dev, ino: directory.info.ino },
    },
    check: async () => {
      if (source !== "original") {
        throw new Error("private source canary");
      }
    },
    published: () => {
      const record = parseNativeComposeStorageCommandRecord(
        readFileSync(join(root, "commands.json"), "utf8")
      );
      if (failChild && record.commands.at(-1)?.child) {
        throw new Error("private publication canary");
      }
    },
  });
  publications.push(owner);
  const arm = () =>
    armNativeComposeStorageCommand({
      owner,
      kind: "create",
      carrier: null,
      host,
      executable,
      argumentsHash: hash,
      deadline: Date.now() + 3000,
      stdout: { name: `${"c".repeat(32)}.stdout`, dev: 1, ino: 3 },
      stderr: { name: `${"c".repeat(32)}.stderr`, dev: 1, ino: 4 },
    });
  const read = async () =>
    parseNativeComposeStorageCommandRecord(
      await readFile(join(root, "commands.json"), "utf8")
    );
  return {
    root,
    directory,
    files,
    owner,
    arm,
    read,
    source: (value: string) => {
      source = value;
    },
    failChild: () => {
      failChild = true;
    },
  };
}
test(
  "v2 is closed and never promotes a copied or legacy original owner",
  ownedCase(async () => {
    const f = await fixture();
    const armed = await f.arm();
    await expect(
      publishNativeComposeStorageCommandChild(
        { ...armed },
        { pid: 101, group: 101, birth: host.birth, wrapper: executable }
      )
    ).rejects.toThrow("values omitted");
    await expect(
      settleNativeComposeStorageCommand(armed, result)
    ).rejects.toThrow("values omitted");
    for (const input of [
      { ...(await f.read()), version: 1 },
      { ...(await f.read()), extra: "private" },
      { ...(await f.read()), token: `${"b".repeat(32)}\n` },
    ]) {
      expect(() =>
        parseNativeComposeStorageCommandRecord(JSON.stringify(input))
      ).toThrow("values omitted");
    }
    expect((await f.read()).commands[0]?.settlement).toBeNull();
    expect((await f.read()).commands[0]?.executable.ino).toBe(executable.ino);
    for (const ino of ["01", 2, "18446744073709551616", "2\n"]) {
      const record = await f.read();
      expect(() =>
        parseNativeComposeStorageCommandRecord(
          JSON.stringify({
            ...record,
            commands: record.commands.map((entry) => ({
              ...entry,
              executable: { ...entry.executable, ino },
            })),
          })
        )
      ).toThrow("values omitted");
    }
  }),
  30_000
);
test(
  "only the original one-use sequence advances after complete observed settlement",
  ownedCase(async () => {
    const f = await fixture();
    const armed = await f.arm();
    await expect(f.arm()).rejects.toThrow("values omitted");
    const child = {
      pid: 101,
      group: 101,
      birth: host.birth,
      wrapper: executable,
    };
    await publishNativeComposeStorageCommandChild(armed, child);
    await expect(
      publishNativeComposeStorageCommandChild(armed, child)
    ).rejects.toThrow("values omitted");
    await settleNativeComposeStorageCommand(armed, result);
    await expect(
      settleNativeComposeStorageCommand(armed, result)
    ).rejects.toThrow("values omitted");
    const parsed = await f.read();
    expect(parsed.commands[0]?.child).toEqual(child);
    expect(parsed.commands[0]?.settlement).toEqual(result);
  }),
  30_000
);
test.each(["source", "record-inode", "record-bytes", "parent-sync"] as const)(
  "original writer rejects %s drift",
  (failure) =>
    ownedCase(async () => {
      const f = await fixture();
      let restore: (() => void) | undefined;
      if (failure === "source") {
        f.source("changed");
      }
      if (failure === "record-inode") {
        const path = join(f.root, "commands.json");
        const bytes = await readFile(path);
        await rename(path, `${path}.original`);
        await writeFile(path, bytes, { mode: 0o600 });
      }
      if (failure === "record-bytes") {
        await writeFile(join(f.root, "commands.json"), "{}");
      }
      if (failure === "parent-sync") {
        const spy = spyOn(f.directory.file, "sync").mockRejectedValue(
          new Error("private sync canary")
        );
        restore = () => spy.mockRestore();
      }
      try {
        await expect(f.arm()).rejects.toThrow("values omitted");
      } finally {
        restore?.();
      }
      expect(nativeComposeStorageCommandOwnerConfirmed(f.owner)).toBe(false);
      retained.add(f.root);
    })(),
  30_000
);
test.each(["timedOut", "cancelled"] as const)(
  "a settled %s command never grants the next daemon effect",
  (flag) =>
    ownedCase(async () => {
      const f = await fixture(),
        armed = await f.arm();
      await publishNativeComposeStorageCommandChild(armed, {
        pid: 101,
        group: 101,
        birth: host.birth,
        wrapper: executable,
      });
      await settleNativeComposeStorageCommand(armed, {
        ...result,
        [flag]: true,
      });
      await expect(
        armNativeComposeStorageCommand({
          owner: f.owner,
          kind: "start",
          carrier: { id: hash, createdAt: "2026-10-09T00:00:00Z" },
          host,
          executable,
          argumentsHash: hash,
          deadline: Date.now() + 3000,
          stdout: { name: `${"d".repeat(32)}.stdout`, dev: 1, ino: 5 },
          stderr: { name: `${"d".repeat(32)}.stderr`, dev: 1, ino: 6 },
        })
      ).rejects.toThrow("values omitted");
      expect((await f.read()).commands).toHaveLength(1);
    })(),
  30_000
);
async function transport(
  f: Awaited<ReturnType<typeof fixture>>,
  marker: string,
  timeoutMs = 3000
) {
  try {
    return await runNativeComposeStorageDockerCommand({
      context: {
        signal: new AbortController().signal,
        deadline: Date.now() + timeoutMs,
      },
      files: f.files,
      args: [
        "/bin/sh",
        "-c",
        'printf complete > "$1"; printf value',
        "owned",
        marker,
      ],
      timeoutMs,
      beforeSpawn: () => {},
      assertAdmitted: async () => {},
      originalCommand: { owner: f.owner, kind: "create", carrier: null },
    });
  } finally {
    if (!nativeComposeStorageCommandOwnerConfirmed(f.owner)) {
      retained.add(f.root);
    }
  }
}
test(
  "real fast command cannot execute before its durable stopped-child publication",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect");
    let armedBeforeSpawn = false;
    inspectSpawn = (args) => {
      const argv = args[0];
      if (Array.isArray(argv) && argv[2]?.includes("kill -STOP")) {
        const record = parseNativeComposeStorageCommandRecord(
          readFileSync(join(f.root, "commands.json"), "utf8")
        );
        expect(record.commands[0]?.child).toBeNull();
        expect(existsSync(marker)).toBe(false);
        armedBeforeSpawn = true;
      }
    };
    try {
      expect(await transport(f, marker)).toEqual({
        exitCode: 0,
        stdout: "value",
      });
      expect(armedBeforeSpawn).toBe(true);
      expect(await readFile(marker, "utf8")).toBe("complete");
      const record = await f.read();
      expect(record.commands[0]?.child?.pid).toBeGreaterThan(1);
      expect(record.commands[0]?.settlement).toMatchObject({
        exitCode: 0,
        groupAbsent: true,
        captureMode: "held-files-quiescent",
        timedOut: false,
        cancelled: false,
      });
    } finally {
      if (confirmedTestLifetime()) {
        inspectSpawn = undefined;
      }
    }
  }),
  30_000
);
test(
  "failed PID publication cancels the original stopped child without executing the target",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect");
    f.failChild();
    await expect(transport(f, marker)).rejects.toThrow("values omitted");
    expect(existsSync(marker)).toBe(false);
    expect((await f.read()).commands[0]?.child?.pid).toBeGreaterThan(1);
    expect((await f.read()).commands[0]?.settlement).toBeNull();
  }),
  30_000
);
test(
  "failed arm directory sync prevents the target spawn rather than proving no-spawn from a record",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect"),
      sync = f.directory.file.sync.bind(f.directory.file);
    const observer = spyOn(f.directory.file, "sync").mockImplementation(
      async () => {
        const record = parseNativeComposeStorageCommandRecord(
          readFileSync(join(f.root, "commands.json"), "utf8")
        );
        if (
          record.commands.length === 1 &&
          record.commands[0]?.child === null
        ) {
          throw new Error("private arm sync canary");
        }
        await sync();
      }
    );
    let targetSpawned = false;
    inspectSpawn = (args) => {
      const argv = args[0];
      if (Array.isArray(argv) && argv[2]?.includes("kill -STOP")) {
        targetSpawned = true;
      }
    };
    try {
      await expect(transport(f, marker)).rejects.toThrow("values omitted");
      expect(targetSpawned).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (confirmedTestLifetime()) {
        inspectSpawn = undefined;
        observer.mockRestore();
      }
    }
  }),
  30_000
);
test(
  "missing original exit callback cannot be replaced by capture bytes or group absence",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect"),
      run = shell.run;
    const observer = spyOn(shell, "run").mockImplementation((args, opts) =>
      run(
        args,
        args[2]?.includes("kill -STOP") ? { ...opts, onExit: undefined } : opts
      )
    );
    try {
      await expect(transport(f, marker)).rejects.toThrow("values omitted");
      expect(await readFile(marker, "utf8")).toBe("complete");
      expect((await f.read()).commands[0]?.settlement).toBeNull();
    } finally {
      if (confirmedTestLifetime()) {
        observer.mockRestore();
      }
    }
  }),
  30_000
);
test.each(["stdout", "stderr"] as const)(
  "original exit cannot complete with a replaced %s capture",
  (stream) =>
    ownedCase(async () => {
      const f = await fixture(),
        marker = join(f.root, "effect"),
        run = shell.run;
      const observer = spyOn(shell, "run").mockImplementation((args, opts) =>
        run(
          args,
          args[2]?.includes("kill -STOP")
            ? {
                ...opts,
                onExit: async (event) => {
                  await opts?.onExit?.(event);
                  const path =
                    f.files.captures[stream === "stdout" ? 0 : 1]?.path;
                  if (!path) {
                    throw new Error("Missing owned capture.");
                  }
                  await rename(path, `${path}.original`);
                  await writeFile(path, "", { mode: 0o600 });
                },
              }
            : opts
        )
      );
      try {
        await expect(transport(f, marker)).rejects.toThrow("values omitted");
        expect(await readFile(marker, "utf8")).toBe("complete");
        expect((await f.read()).commands[0]?.settlement).toBeNull();
      } finally {
        if (confirmedTestLifetime()) {
          observer.mockRestore();
        }
      }
    })(),
  30_000
);
test.each(["EPERM", "EIO"] as const)(
  "%s is never group absence or settlement",
  (code) =>
    ownedCase(async () => {
      const f = await fixture(),
        marker = join(f.root, "effect"),
        kill = process.kill;
      let exactGroupRefused = false;
      const observer = spyOn(process, "kill").mockImplementation(
        (pid, signal) => {
          const child = parseNativeComposeStorageCommandRecord(
            readFileSync(join(f.root, "commands.json"), "utf8")
          ).commands[0]?.child;
          if (signal === 0 && child && pid === -child.pid) {
            exactGroupRefused = true;
            throw Object.assign(new Error("private process canary"), { code });
          }
          return kill(pid, signal);
        }
      );
      try {
        await expect(transport(f, marker)).rejects.toThrow("values omitted");
        expect(exactGroupRefused).toBe(true);
        expect(await readFile(marker, "utf8")).toBe("complete");
        expect((await f.read()).commands[0]?.settlement).toBeNull();
      } finally {
        if (confirmedTestLifetime()) {
          observer.mockRestore();
        }
      }
    })(),
  30_000
);
test.each([false, true])(
  "a delayed PID receipt write is bounded and permanently withholds continuation (backward wall clock: %s)",
  (backwardClock) =>
    ownedCase(async () => {
      const f = await fixture(),
        marker = join(f.root, "effect"),
        sync = f.directory.file.sync.bind(f.directory.file);
      let delayed: Promise<void> | undefined;
      let restoreClock: (() => void) | undefined;
      const wallNow = Date.now.bind(Date);
      const observer = spyOn(f.directory.file, "sync").mockImplementation(
        async () => {
          const record = parseNativeComposeStorageCommandRecord(
            readFileSync(join(f.root, "commands.json"), "utf8")
          );
          if (
            !delayed &&
            record.commands[0]?.child &&
            !record.commands[0]?.settlement
          ) {
            if (backwardClock) {
              const clock = spyOn(Date, "now").mockImplementation(
                () => wallNow() - 60_000
              );
              restoreClock = () => clock.mockRestore();
            }
            delayed = new Promise((resolve) => setTimeout(resolve, 2000));
            await delayed;
          }
          await sync();
        }
      );
      const started = performance.now();
      try {
        await expect(transport(f, marker, 1000)).rejects.toThrow(
          "values omitted"
        );
        expect(delayed).toBeDefined();
        expect(performance.now() - started).toBeLessThan(6000);
        expect(existsSync(marker)).toBe(false);
        await delayed;
        const continuationDeadline = performance.now() + 1000;
        while (
          nativeComposeStorageCommandOwnerPublicationPending(f.owner) &&
          performance.now() < continuationDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        expect(
          nativeComposeStorageCommandOwnerPublicationPending(f.owner)
        ).toBe(false);
        expect(nativeComposeStorageCommandOwnerConfirmed(f.owner)).toBe(false);
        expect((await f.read()).commands[0]?.settlement).toBeNull();
      } finally {
        if (confirmedTestLifetime()) {
          restoreClock?.();
          observer.mockRestore();
        }
      }
    })(),
  30_000
);
