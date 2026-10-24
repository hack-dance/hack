import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  nativeComposeEffectRefusal,
  retainNativeComposeEffectRefusal,
} from "../src/lib/native-compose-effect-diagnostics.ts";
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
import {
  nativeComposeStorageCarrierBudgetReason,
  nativeComposeStorageCarrierReason,
  runNativeComposeStorageDockerCommand,
} from "../src/lib/native-compose-storage-witness-docker.ts";
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
  let checkRefusal: unknown;
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
      if (checkRefusal !== undefined) {
        throw checkRefusal;
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
    /** The owner check refuses with this error from now on. */
    refuseCheck: (error: unknown) => {
      checkRefusal = error;
    },
  };
}
/** A fixed refusal with an issued owner boundary, as a carrier check makes. */
function issuedRefusal(
  diagnostic: Parameters<typeof retainNativeComposeEffectRefusal>[1]
): Error {
  const error = new Error(
    "Native storage xattr proof refused; values omitted."
  );
  retainNativeComposeEffectRefusal(error, diagnostic);
  return error;
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
  timeoutMs = 3000,
  script = 'printf complete > "$1"; printf value'
) {
  try {
    return await runNativeComposeStorageDockerCommand({
      context: {
        signal: new AbortController().signal,
        deadline: Date.now() + timeoutMs,
      },
      files: f.files,
      args: ["/bin/sh", "-c", script, "owned", marker],
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
test.each(["unchanged", "replaced", "tampered"] as const)(
  "a recorded executable %s after its digest was cached: only unchanged runs the target",
  (change) =>
    ownedCase(async () => {
      const f = await fixture(),
        marker = join(f.root, "effect");
      const bin = await realpath(
        await mkdtemp(join(tmpdir(), "native-command-executable-"))
      );
      roots.push(bin);
      const program = join(bin, "program");
      const text = '#!/bin/sh\nprintf complete > "$1"; printf value\n';
      await writeFile(program, text, { mode: 0o700 });
      // Settle past the racy window so the arming digest is cached for this command.
      await new Promise((resolve) => setTimeout(resolve, 2100));
      try {
        const run = runNativeComposeStorageDockerCommand({
          context: {
            signal: new AbortController().signal,
            deadline: Date.now() + 5000,
          },
          files: f.files,
          args: [program, marker],
          timeoutMs: 5000,
          // After the record is armed with the cached digest, before spawn.
          beforeSpawn: () => {
            if (change === "replaced") {
              renameSync(program, join(bin, "original"));
              writeFileSync(program, text, { mode: 0o700 });
            } else if (change === "tampered") {
              const before = statSync(program);
              writeFileSync(program, text.replace("value", "VALUE"));
              utimesSync(program, before.atime, before.mtime);
            }
          },
          assertAdmitted: async () => {},
          originalCommand: { owner: f.owner, kind: "create", carrier: null },
        });
        if (change === "unchanged") {
          expect(await run).toEqual({ exitCode: 0, stdout: "value" });
          expect(await readFile(marker, "utf8")).toBe("complete");
          expect((await f.read()).commands[0]?.settlement).toMatchObject({
            exitCode: 0,
          });
          return;
        }
        await expect(run).rejects.toThrow("values omitted");
        expect(existsSync(marker)).toBe(false);
        expect((await f.read()).commands[0]?.settlement).toBeNull();
      } finally {
        if (!nativeComposeStorageCommandOwnerConfirmed(f.owner)) {
          retained.add(f.root);
        }
      }
    })(),
  30_000
);
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
    const caught = await transport(f, marker).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("values omitted");
    // An ordinary refusal keeps no command cause.
    expect(nativeComposeStorageCarrierReason(caught)).toBe("unclassified");
    expect(existsSync(marker)).toBe(false);
    expect((await f.read()).commands[0]?.child?.pid).toBeGreaterThan(1);
    expect((await f.read()).commands[0]?.settlement).toBeNull();
  }),
  30_000
);
test.each([
  ["before arming", 1, false],
  ["after arming", 2, false],
  ["after the stopped child is published", 3, false],
  // Thrown before the bounded await sees it: only the child-publication catch
  // records it as the publication-stopping refusal.
  ["thrown synchronously after the stopped child is published", 3, true],
] as const)(
  "a helper policy refusal %s keeps its own reason after the carrier deadline",
  (_, failingCall, synchronous) =>
    ownedCase(async () => {
      const f = await fixture(),
        marker = join(f.root, "effect"),
        signal = new AbortController().signal,
        deadline = Date.now() + 5000;
      let calls = 0;
      try {
        const caught = await runNativeComposeStorageDockerCommand({
          context: { signal, deadline },
          files: f.files,
          args: ["/bin/sh", "-c", 'printf complete > "$1"', "owned", marker],
          timeoutMs: 5000,
          beforeSpawn: () => {},
          // The carrier's admission re-inspects the helper; the chosen call
          // observes a policy refusal with its own issued boundary.
          assertAdmitted: () => {
            calls += 1;
            if (calls === failingCall) {
              const policy = issuedRefusal({
                stage: "storage-helper-policy",
                reason: "helper-host-policy",
              });
              if (synchronous) {
                throw policy;
              }
              return Promise.reject(policy);
            }
            return Promise.resolve();
          },
          originalCommand: { owner: f.owner, kind: "create", carrier: null },
        }).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("values omitted");
        expect(calls).toBe(failingCall);
        expect(existsSync(marker)).toBe(false);
        // The replaced command refusal keeps the first issued boundary.
        expect(nativeComposeEffectRefusal(caught)).toEqual({
          stage: "storage-helper-policy",
          reason: "helper-host-policy",
        });
        // Caught after the carrier deadline (fake clock), it still names the
        // policy failure, never the storage budget.
        expect(
          nativeComposeStorageCarrierBudgetReason({
            error: caught,
            signal,
            deadline,
            now: () => deadline + 1,
          })
        ).toBe("helper-host-policy");
      } finally {
        if (!nativeComposeStorageCommandOwnerConfirmed(f.owner)) {
          retained.add(f.root);
        }
      }
    })(),
  30_000
);
test(
  "an owner check refusal while arming keeps its own reason after the carrier deadline",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect"),
      signal = new AbortController().signal,
      deadline = Date.now() + 5000;
    let calls = 0;
    // The saved material binding changed: the owner check refuses the arm
    // publication, inside the runner's bounded publication await.
    f.refuseCheck(
      issuedRefusal({ stage: "storage-helper-start", reason: "private-state" })
    );
    try {
      const caught = await runNativeComposeStorageDockerCommand({
        context: { signal, deadline },
        files: f.files,
        args: ["/bin/sh", "-c", 'printf complete > "$1"', "owned", marker],
        timeoutMs: 5000,
        beforeSpawn: () => {},
        assertAdmitted: () => {
          calls += 1;
          return Promise.resolve();
        },
        originalCommand: { owner: f.owner, kind: "create", carrier: null },
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("values omitted");
      // Refused while arming: no later admission and no spawned target.
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(nativeComposeStorageCommandOwnerConfirmed(f.owner)).toBe(false);
      expect(nativeComposeEffectRefusal(caught)).toEqual({
        stage: "storage-helper-start",
        reason: "private-state",
      });
      expect(
        nativeComposeStorageCarrierBudgetReason({
          error: caught,
          signal,
          deadline,
          now: () => deadline + 1,
        })
      ).toBe("private-state");
    } finally {
      if (!nativeComposeStorageCommandOwnerConfirmed(f.owner)) {
        retained.add(f.root);
      }
    }
  }),
  30_000
);
test(
  "a record publication refused by its owner check keeps the check's issued boundary",
  ownedCase(async () => {
    const f = await fixture();
    f.refuseCheck(
      issuedRefusal({ stage: "storage-helper-create", reason: "private-state" })
    );
    const caught = await f.arm().catch((error: unknown) => error);
    expect((caught as Error).message).toBe(
      "Native storage xattr proof refused; values omitted."
    );
    expect(nativeComposeEffectRefusal(caught)).toEqual({
      stage: "storage-helper-create",
      reason: "private-state",
    });
    // The writer stays permanently invalidated, exactly as before.
    expect(nativeComposeStorageCommandOwnerConfirmed(f.owner)).toBe(false);
    retained.add(f.root);
  })
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
// HACK-1281 replay: a stalled owner resumes with its timer already due. A
// one-second identity read refused this healthy command after its stopped child
// was published, leaving the durable uncertainty that blocks saved recovery.
test(
  "a host stall in a child identity read stays within the command budget",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect"),
      run = shell.run;
    let stalled = 0;
    const observer = spyOn(shell, "run").mockImplementation((args, opts) => {
      const pid = args[args.indexOf("-p") + 1];
      if (
        stalled === 0 &&
        args[4] === "/bin/ps" &&
        pid !== undefined &&
        pid !== String(process.pid)
      ) {
        stalled++;
        // The read itself stalls past the former one-second bound.
        return run(
          [
            args[0] ?? "",
            args[1] ?? "",
            `sleep 1.2; ${args[2]}`,
            ...args.slice(3),
          ],
          opts
        );
      }
      return run(args, opts);
    });
    try {
      expect(await transport(f, marker, 15_000)).toEqual({
        exitCode: 0,
        stdout: "value",
      });
      expect(stalled).toBe(1);
      expect(await readFile(marker, "utf8")).toBe("complete");
      expect((await f.read()).commands[0]?.settlement).toMatchObject({
        exitCode: 0,
        timedOut: false,
        groupAbsent: true,
      });
    } finally {
      if (confirmedTestLifetime()) {
        observer.mockRestore();
      }
    }
  }),
  30_000
);
test(
  "a multi-second host stall after exit still settles the original command",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect"),
      sync = f.directory.file.sync.bind(f.directory.file);
    let stalled = false;
    // One post-exit sync stalls past the former three-second settlement budget.
    const observer = spyOn(f.directory.file, "sync").mockImplementation(
      async () => {
        if (existsSync(marker) && !stalled) {
          stalled = true;
          await Bun.sleep(3500);
        }
        await sync();
      }
    );
    try {
      expect(await transport(f, marker)).toEqual({
        exitCode: 0,
        stdout: "value",
      });
      expect(stalled).toBe(true);
      expect((await f.read()).commands[0]?.settlement).toMatchObject({
        exitCode: 0,
        groupAbsent: true,
      });
      expect(nativeComposeStorageCommandOwnerConfirmed(f.owner)).toBe(true);
    } finally {
      if (confirmedTestLifetime()) {
        observer.mockRestore();
      }
    }
  }),
  30_000
);
test(
  "a settlement that outlasts its post-exit budget refuses as probe-budget and stays unsettled",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect"),
      kill = process.kill,
      monotonic = performance.now.bind(performance);
    let elapsed = 0;
    // The post-exit group observation sees 16 s of monotonic time pass: past
    // the finite settlement budget, without a real 16 s wait.
    const clock = spyOn(performance, "now").mockImplementation(
      () => monotonic() + elapsed
    );
    const observer = spyOn(process, "kill").mockImplementation(
      (pid, signal) => {
        if (
          signal === 0 &&
          typeof pid === "number" &&
          pid < 0 &&
          existsSync(marker)
        ) {
          elapsed = 16_000;
        }
        return kill(pid, signal);
      }
    );
    try {
      const caught = await transport(f, marker).catch(
        (error: unknown) => error
      );
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("values omitted");
      expect(nativeComposeStorageCarrierReason(caught)).toBe("probe-budget");
      expect(await readFile(marker, "utf8")).toBe("complete");
      expect((await f.read()).commands[0]?.settlement).toBeNull();
      expect(nativeComposeStorageCommandOwnerConfirmed(f.owner)).toBe(false);
      retained.add(f.root);
    } finally {
      if (confirmedTestLifetime()) {
        clock.mockRestore();
        observer.mockRestore();
      }
    }
  }),
  30_000
);
test(
  "an unrecorded command whose group never becomes absent refuses as probe-budget on monotonic time",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect"),
      kill = process.kill,
      monotonic = performance.now.bind(performance),
      wall = Date.now();
    let elapsed = 0,
      polls = 0;
    // Fake clocks: the wall clock is frozen, so only a monotonic deadline can
    // expire. Each post-exit poll still sees the exited group and 4 s pass.
    const frozen = spyOn(Date, "now").mockImplementation(() => wall);
    const clock = spyOn(performance, "now").mockImplementation(
      () => monotonic() + elapsed
    );
    const observer = spyOn(process, "kill").mockImplementation(
      (pid, signal) => {
        if (
          signal === 0 &&
          typeof pid === "number" &&
          pid < 0 &&
          existsSync(marker)
        ) {
          polls += 1;
          elapsed += 4000;
          return true;
        }
        return kill(pid, signal);
      }
    );
    try {
      const caught = await runNativeComposeStorageDockerCommand({
        context: {
          signal: new AbortController().signal,
          deadline: wall + 3000,
        },
        files: f.files,
        args: ["/bin/sh", "-c", 'printf complete > "$1"', "owned", marker],
        timeoutMs: 3000,
        beforeSpawn: () => {},
        assertAdmitted: async () => {},
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("values omitted");
      expect(nativeComposeStorageCarrierReason(caught)).toBe("probe-budget");
      expect(polls).toBe(1);
      expect(await readFile(marker, "utf8")).toBe("complete");
      retained.add(f.root);
    } finally {
      if (confirmedTestLifetime()) {
        frozen.mockRestore();
        clock.mockRestore();
        observer.mockRestore();
      }
    }
  }),
  30_000
);
test(
  "a recorded child that outlives its command budget refuses as probe-timeout",
  ownedCase(async () => {
    const f = await fixture(),
      marker = join(f.root, "effect");
    const caught = await transport(
      f,
      marker,
      1500,
      'printf started > "$1"; exec sleep 10'
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("values omitted");
    expect(nativeComposeStorageCarrierReason(caught)).toBe("probe-timeout");
    expect(await readFile(marker, "utf8")).toBe("started");
    expect((await f.read()).commands[0]?.settlement).toMatchObject({
      timedOut: true,
      groupAbsent: true,
    });
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
