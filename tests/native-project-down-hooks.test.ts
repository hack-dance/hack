import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitNativeDownHookGeneration,
  createNativeForegroundDownHooks,
  loadNativeDownHookRecord,
  NATIVE_DOWN_HOOK_UNKNOWN,
  type NativeDownHookRecord,
  nativeForegroundStopFailure,
  openNativeDownHookSession,
  replaceNativeDownHookRecord,
} from "../src/backends/native-project-down-hooks.ts";
import {
  type NativeProjectRun,
  type NativeProjectRunScope,
  nativeProjectDownHookPaths,
  prepareNativeProjectRunStorage,
} from "../src/backends/native-project-run.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const run: NativeProjectRun = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  effectiveEnvName: null,
  profiles: [],
  aws: null,
};
async function fixture(): Promise<NativeProjectRunScope> {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-down-hooks-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome, { mode: 0o700 });
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  await prepareNativeProjectRunStorage(scope);
  return scope;
}
const record = (
  state: NativeDownHookRecord["state"],
  generation = "e".repeat(32)
): NativeDownHookRecord => ({ run: run.run, generation, state });
async function expectUnknown(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(HackCliError);
  expect((error as HackCliError).code).toBe("E_LIFECYCLE_FAILED");
  expect((error as Error).message).toBe(NATIVE_DOWN_HOOK_UNKNOWN);
}
function phases() {
  const calls: string[] = [];
  return {
    calls,
    before: (code = 0) => {
      calls.push("down.before");
      return Promise.resolve(code);
    },
    after: (code = 0) => {
      calls.push("down.after");
      return Promise.resolve(code);
    },
  };
}

test("the journal is a private value-free record replaced by compare-and-swap", async () => {
  const scope = await fixture();
  expect(await loadNativeDownHookRecord(scope)).toBeNull();
  expect(await replaceNativeDownHookRecord(scope, null, record("owed"))).toBe(
    true
  );
  // A writer holding a stale expectation loses and changes nothing.
  expect(
    await replaceNativeDownHookRecord(scope, null, record("complete"))
  ).toBe(false);
  expect(await loadNativeDownHookRecord(scope)).toEqual(record("owed"));
  const paths = await nativeProjectDownHookPaths(scope, false);
  expect(JSON.parse(await readFile(paths.file, "utf8"))).toEqual({
    version: 1,
    kind: "hack.native-project-down-hooks",
    ...record("owed"),
  });
  expect((await stat(paths.file)).mode & 0o777).toBe(0o600);
  // Only the mapping directory's own files remain: no temp file or lock.
  expect(
    (await readdir(paths.root)).filter((name) => name.includes("down-hooks"))
  ).toEqual([paths.file.slice(paths.root.length + 1)]);
  expect(await replaceNativeDownHookRecord(scope, record("owed"), null)).toBe(
    true
  );
  expect(await loadNativeDownHookRecord(scope)).toBeNull();
});

test("a tampered or widened record refuses as a closed integrity failure", async () => {
  const scope = await fixture();
  await replaceNativeDownHookRecord(scope, null, record("owed"));
  const { file } = await nativeProjectDownHookPaths(scope, false);
  await chmod(file, 0o644);
  await expect(loadNativeDownHookRecord(scope)).rejects.toThrow(
    "Native down hook journal is unsafe or changed"
  );
  await chmod(file, 0o600);
  await Bun.write(
    file,
    JSON.stringify({
      version: 1,
      kind: "hack.native-project-down-hooks",
      ...record("owed"),
      command: "synthetic",
    })
  );
  await chmod(file, 0o600);
  await expect(loadNativeDownHookRecord(scope)).rejects.toThrow(
    "Native down hook journal is unsafe or changed"
  );
});

test("Ctrl-C on a ready graph runs down.before then down.after once", async () => {
  const scope = await fixture();
  const hooks = createNativeForegroundDownHooks({ scope, run: run.run });
  const p = phases();
  await hooks.owe(() => false);
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("owed");
  expect(
    await hooks.before(
      () => p.before(),
      () => false
    )
  ).toBe("succeeded");
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("after-owed");
  expect(
    await hooks.after(
      () => p.after(),
      () => false
    )
  ).toBe("succeeded");
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("complete");
  // A repeated stop request or finish never reruns a known phase.
  expect(
    await hooks.before(
      () => p.before(),
      () => false
    )
  ).toBe("skipped");
  expect(
    await hooks.after(
      () => p.after(),
      () => false
    )
  ).toBe("skipped");
  expect(p.calls).toEqual(["down.before", "down.after"]);
  // The stopped graph's later down runs nothing.
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: true,
    configured: true,
  });
  await session.before(async () => {
    p.calls.push("down.before");
  });
  await session.after(async () => {
    p.calls.push("down.after");
  });
  expect(p.calls).toEqual(["down.before", "down.after"]);
});

test("a failed or canceled down.before still stops, never owes down.after and is not rerun by down", async () => {
  for (const [code, canceled, outcome] of [
    [1, false, "failed"],
    [130, true, "canceled"],
  ] as const) {
    const scope = await fixture();
    const hooks = createNativeForegroundDownHooks({ scope, run: run.run });
    const p = phases();
    await hooks.owe(() => false);
    expect(
      await hooks.before(
        () => p.before(code),
        () => canceled
      )
    ).toBe(outcome);
    expect((await loadNativeDownHookRecord(scope))?.state).toBe(
      "before-failed"
    );
    expect(
      await hooks.after(
        () => p.after(),
        () => false
      )
    ).toBe("skipped");
    const session = await openNativeDownHookSession({
      scope,
      run,
      graphStopped: true,
      configured: true,
    });
    await session.before(async () => {
      p.calls.push("down.before");
    });
    await session.after(async () => {
      p.calls.push("down.after");
    });
    expect(p.calls).toEqual(["down.before"]);
  }
});

test("an interrupt observed before readiness publication withdraws the owe", async () => {
  const scope = await fixture();
  const hooks = createNativeForegroundDownHooks({ scope, run: run.run });
  await hooks.owe(() => true);
  expect(await loadNativeDownHookRecord(scope)).toBeNull();
  const p = phases();
  expect(
    await hooks.before(
      () => p.before(),
      () => false
    )
  ).toBe("skipped");
  expect(p.calls).toEqual([]);
});

test("a frontend that crashed after up.after leaves owed hooks that down runs once", async () => {
  const scope = await fixture();
  await createNativeForegroundDownHooks({ scope, run: run.run }).owe(
    () => false
  );
  const calls: string[] = [];
  const once = async () => {
    const session = await openNativeDownHookSession({
      scope,
      run,
      graphStopped: true,
      configured: true,
    });
    await session.before(async () => {
      calls.push("down.before");
    });
    await session.after(async () => {
      calls.push("down.after");
    });
  };
  await once();
  await once();
  expect(calls).toEqual(["down.before", "down.after"]);
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("complete");
});

test("a frontend that crashed between down hooks leaves only down.after owed", async () => {
  const scope = await fixture();
  await replaceNativeDownHookRecord(scope, null, record("after-owed"));
  const calls: string[] = [];
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: true,
    configured: true,
  });
  await session.before(async () => {
    calls.push("down.before");
  });
  await session.after(async () => {
    calls.push("down.after");
  });
  expect(calls).toEqual(["down.after"]);
});

test("a crash during a down hook is unknown: down and a new generation refuse without replay", async () => {
  for (const state of ["before-started", "after-started"] as const) {
    const scope = await fixture();
    await replaceNativeDownHookRecord(scope, null, record(state));
    for (const graphStopped of [true, false]) {
      await expectUnknown(
        openNativeDownHookSession({
          scope,
          run,
          graphStopped,
          configured: true,
        })
      );
    }
    await expectUnknown(admitNativeDownHookGeneration(scope));
    expect(await loadNativeDownHookRecord(scope)).toEqual(record(state));
  }
});

test("a new generation supersedes any record that is not started", async () => {
  for (const state of [
    "owed",
    "before-failed",
    "after-owed",
    "complete",
  ] as const) {
    const scope = await fixture();
    await replaceNativeDownHookRecord(scope, null, record(state));
    await admitNativeDownHookGeneration(scope);
    expect(await loadNativeDownHookRecord(scope)).toBeNull();
  }
  // No storage yet means nothing to admit.
  const empty = await realpath(
    await mkdtemp(join(tmpdir(), "native-down-hooks-"))
  );
  roots.push(empty);
  await mkdir(join(empty, ".hack"));
  await admitNativeDownHookGeneration({
    projectRoot: empty,
    projectDir: join(empty, ".hack"),
    nativeHome: empty,
    branch: null,
  });
});

test("down on a live graph claims the frontend's owed hooks, and the frontend's Ctrl-C then skips them", async () => {
  const scope = await fixture();
  const frontend = createNativeForegroundDownHooks({ scope, run: run.run });
  await frontend.owe(() => false);
  const calls: string[] = [];
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: false,
    configured: true,
  });
  await session.before(async () => {
    calls.push("down.before");
  });
  const p = phases();
  expect(
    await frontend.before(
      () => p.before(),
      () => false
    )
  ).toBe("skipped");
  await session.after(async () => {
    calls.push("down.after");
  });
  expect(
    await frontend.after(
      () => p.after(),
      () => false
    )
  ).toBe("skipped");
  expect(calls).toEqual(["down.before", "down.after"]);
  expect(p.calls).toEqual([]);
});

test("down during up.after owns the hooks; the frontend's later owe does not", async () => {
  const scope = await fixture();
  const calls: string[] = [];
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: false,
    configured: true,
  });
  await session.before(async () => {
    calls.push("down.before");
  });
  await session.after(async () => {
    calls.push("down.after");
  });
  const frontend = createNativeForegroundDownHooks({ scope, run: run.run });
  await frontend.owe(() => false);
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("complete");
  const p = phases();
  expect(
    await frontend.before(
      () => p.before(),
      () => false
    )
  ).toBe("skipped");
  expect(calls).toEqual(["down.before", "down.after"]);
});

test("a live down whose down.before fails restores the record so an explicit retry may run it", async () => {
  const scope = await fixture();
  const frontend = createNativeForegroundDownHooks({ scope, run: run.run });
  await frontend.owe(() => false);
  const owed = await loadNativeDownHookRecord(scope);
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: false,
    configured: true,
  });
  await expect(
    session.before(() => Promise.reject(new Error("synthetic hook failure")))
  ).rejects.toThrow("synthetic hook failure");
  expect(await loadNativeDownHookRecord(scope)).toEqual(owed);
});

test("a known down.after failure is final and reported", async () => {
  const scope = await fixture();
  await replaceNativeDownHookRecord(scope, null, record("after-owed"));
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: true,
    configured: true,
  });
  await expect(
    session.after(() => Promise.reject(new Error("synthetic after failure")))
  ).rejects.toThrow("synthetic after failure");
  expect((await loadNativeDownHookRecord(scope))?.state).toBe("complete");
});

test("legacy or hook-free graphs keep today's behavior without a record", async () => {
  const scope = await fixture();
  const calls: string[] = [];
  for (const [graphStopped, configured] of [
    [true, true],
    [false, false],
  ] as const) {
    const session = await openNativeDownHookSession({
      scope,
      run,
      graphStopped,
      configured,
    });
    await session.before(async () => {
      calls.push("down.before");
    });
    await session.after(async () => {
      calls.push("down.after");
    });
  }
  expect(calls).toEqual([]);
  expect(await loadNativeDownHookRecord(scope)).toBeNull();
  // A configured live graph without a record (older frontend) runs both once.
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: false,
    configured: true,
  });
  await session.before(async () => {
    calls.push("down.before");
  });
  await session.after(async () => {
    calls.push("down.after");
  });
  expect(calls).toEqual(["down.before", "down.after"]);
});

test("a record of another run never authorizes this run's hooks", async () => {
  const scope = await fixture();
  await replaceNativeDownHookRecord(scope, null, {
    ...record("owed"),
    run: "f".repeat(32),
  });
  const calls: string[] = [];
  const session = await openNativeDownHookSession({
    scope,
    run,
    graphStopped: true,
    configured: true,
  });
  await session.before(async () => {
    calls.push("down.before");
  });
  await session.after(async () => {
    calls.push("down.after");
  });
  expect(calls).toEqual([]);
});

test("stop reports keep the interrupted status for cancellation and name failures without values", () => {
  expect(
    nativeForegroundStopFailure({ before: "succeeded", after: "succeeded" })
  ).toBeUndefined();
  expect(
    nativeForegroundStopFailure({ before: "canceled", after: "skipped" })
  ).toBeUndefined();
  const before = nativeForegroundStopFailure({
    before: "failed",
    after: "skipped",
  });
  expect(before).toBeInstanceOf(HackCliError);
  expect((before as HackCliError).code).toBe("E_LIFECYCLE_FAILED");
  expect(String(before)).toContain("does not rerun it");
  const after = nativeForegroundStopFailure({
    before: "succeeded",
    after: "failed",
  });
  expect(String(after)).toContain("cleanup was confirmed");
  const refusal = new Error("synthetic refusal");
  expect(
    nativeForegroundStopFailure({ before: "succeeded", after: refusal })
  ).toBe(refusal);
});
