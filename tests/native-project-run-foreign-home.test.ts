import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitNativeProjectFinalization,
  beginNativeProjectFinalization,
  recoverNativeProjectFinalization,
} from "../src/backends/native-project-finalization.ts";
import {
  inspectNativeProjectRunMapping,
  loadNativeProjectRun as load,
  type NativeProjectRun,
  type NativeProjectRunForeignHomeInspection,
  releaseNativeProjectRunForeignHome as release,
  saveNativeProjectRun as save,
} from "../src/backends/native-project-run.ts";
import type { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";

/**
 * HACK-1952: each launcher version has its own native home, and the project's run
 * mapping names the home that wrote it. Two isolated homes share one checkout here;
 * nothing starts a runtime.
 */

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
/** The foreign-home path never asks a runtime; any request fails the test. */
const noRuntime: typeof invokeNativeRuntime = () => {
  throw new Error("foreign-home inspection must not invoke a native runtime");
};

async function fixture(branch: string | null = null) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-foreign-home-"))
  );
  roots.push(root);
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  const homeA = join(root, "versions", "one", "native-home");
  const homeB = join(root, "versions", "two", "native-home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeA, { recursive: true, mode: 0o700 });
  await mkdir(homeB, { recursive: true, mode: 0o700 });
  const a = { projectRoot, projectDir, nativeHome: homeA, branch };
  const b = { projectRoot, projectDir, nativeHome: homeB, branch };
  const inspect = (isAlive?: (pid: number) => boolean) =>
    inspectNativeProjectRunMapping({
      scope: b,
      runtime: { binary: join(root, "absent-runtime"), home: homeB },
      invoke: noRuntime,
      isAlive,
    }) as Promise<NativeProjectRunForeignHomeInspection>;
  const runs = join(projectDir, ".internal", "native-runs");
  return { root, homeA, homeB, a, b, inspect, runs };
}

/** Home A starts the run and, when `stop` is set, acknowledges its clean stop. */
async function startInHomeA(
  f: Awaited<ReturnType<typeof fixture>>,
  stop: boolean
) {
  await save({ ...f.a, run });
  const lifetime = await beginNativeProjectFinalization({
    scope: f.a,
    run,
    httpsPort: null,
  });
  if (stop) {
    await lifetime.complete();
  }
  return lifetime;
}

test("a cleanly stopped run from another home is named, inspectable and releasable", async () => {
  const f = await fixture();
  await startInHomeA(f, true);
  const mapping = (await readdir(f.runs)).find(
    (name) => /^[a-f0-9]{64}\.json$/.test(name) // the run mapping itself
  );
  const bytes = await readFile(join(f.runs, mapping ?? "absent"), "utf8");

  const inspection = await f.inspect();
  expect(inspection).toMatchObject({
    schema: "hack.native-project-run-foreign-home/v1",
    state: "foreign-home",
    ownerHome: f.homeA,
    owner: "stopped",
    ownerPid: null,
    run,
  });
  const selection = inspection.selectionSha256 ?? "";
  expect(selection).toMatch(/^[a-f0-9]{64}$/);
  await expectClosedRefusal(
    load(f.b),
    `Native project run mapping belongs to run ${run.run} in another native home (${f.homeA}), which stopped it cleanly; its retained data stays in that home. To start this instance from this native home, release the mapping with hack doctor --native-run-mapping release --expect-selection ${selection}, or run hack down with the Hack version that owns that home.`
  );

  await expectClosedRefusal(
    release({ scope: f.b, expectSelection: "e".repeat(64) }),
    "Native project run mapping is unsafe, changed, or owned by another run"
  );
  expect(await load(f.a)).toEqual(run);

  const released = await release({ scope: f.b, expectSelection: selection });
  expect(released).toMatchObject({
    released: true,
    owner: "stopped",
    ownerHome: f.homeA,
  });
  expect(await load(f.b)).toBeNull();
  const audit = JSON.parse(await readFile(released.auditPath, "utf8"));
  expect(audit).toMatchObject({
    schema: "hack.native-project-run-foreign-home/v1",
    selectionSha256: selection,
    ownerHome: f.homeA,
    mapping: bytes,
  });
  // The owning home keeps its own frontend history; nothing there was removed.
  expect(
    (
      await readdir(join(f.homeA, ".hack-local", "frontend-finalization"), {
        recursive: true,
      })
    ).filter((name) => name.endsWith(".json"))
  ).toHaveLength(2);
  // This home can now publish its own fresh owner for the same instance.
  await save({ ...f.b, run: { ...run, run: "f".repeat(32) } });
  expect((await load(f.b))?.run).toBe("f".repeat(32));
  await expectClosedRefusal(load(f.a), "another native home");
});

test("a live owner in another home is refused by name and never released", async () => {
  const f = await fixture("feature-api");
  await startInHomeA(f, false);
  const inspection = await f.inspect();
  expect(inspection).toMatchObject({
    state: "foreign-home",
    ownerHome: f.homeA,
    owner: "live",
    ownerPid: process.pid,
    selectionSha256: null,
  });
  const live = `Native project run mapping is owned by live run ${run.run} in another native home (${f.homeA}), frontend pid ${process.pid}. Stop it first: press Ctrl-C in that hack up, or run hack down with the Hack version that owns that home; then retry here.`;
  await expectClosedRefusal(load(f.b), live);
  await expectClosedRefusal(
    release({ scope: f.b, expectSelection: "e".repeat(64) }),
    live
  );
  expect(await load(f.a)).toEqual(run);
});

test("an interrupted or unrecorded owner is named but cannot be released", async () => {
  const f = await fixture();
  await startInHomeA(f, false);
  expect(await f.inspect(() => false)).toMatchObject({
    owner: "interrupted",
    ownerPid: process.pid,
    selectionSha256: null,
  });

  const g = await fixture();
  await save({ ...g.a, run });
  expect(await g.inspect()).toMatchObject({
    owner: "unproven",
    selectionSha256: null,
  });
  await expectClosedRefusal(
    load(g.b),
    `Native project run mapping belongs to run ${run.run} in another native home (${g.homeA}), and its clean stop cannot be proven from this home. Before using this home, run hack down with the Hack version that owns that home.`
  );
  await expectClosedRefusal(
    release({ scope: g.b, expectSelection: "e".repeat(64) }),
    "cannot be proven"
  );
  expect(await load(g.a)).toEqual(run);
});

test("an explicitly recovered dead owner does not attest a clean stop", async () => {
  const f = await fixture();
  const lifetime = await startInHomeA(f, false);
  await recoverNativeProjectFinalization({
    scope: f.a,
    run,
    token: lifetime.token,
    expectAttempt: lifetime.token.attempt,
    verifyEffects: async () => undefined,
    isDead: () => true,
  });
  expect(await f.inspect(() => false)).toMatchObject({
    owner: "unproven",
    selectionSha256: null,
  });
});

test("a retained startup admission in the owning home excludes release until retired", async () => {
  const f = await fixture();
  await startInHomeA(f, true);
  const selection = (await f.inspect()).selectionSha256 ?? "";
  const admission = await admitNativeProjectFinalization({ scope: f.a, run });
  expect(await f.inspect()).toMatchObject({
    owner: "live",
    ownerPid: process.pid,
    selectionSha256: null,
  });
  await expectClosedRefusal(
    release({ scope: f.b, expectSelection: selection }),
    "is owned by live run"
  );
  expect(await load(f.a)).toEqual(run);
  // An admission whose startup exited without registering a lifetime is interrupted.
  expect(await f.inspect(() => false)).toMatchObject({
    owner: "interrupted",
    ownerPid: process.pid,
  });
  await admission.retire();
  await admission.retire();
  expect((await f.inspect()).selectionSha256).toBe(selection);
  expect(
    (await release({ scope: f.b, expectSelection: selection })).released
  ).toBe(true);
  // A startup admitted after the release finds no mapping at its last check.
  const late = await admitNativeProjectFinalization({ scope: f.a, run });
  expect(await load(f.a)).toBeNull();
  await late.retire();
});

test("a selection goes stale when the owning home starts the run again", async () => {
  const f = await fixture();
  await startInHomeA(f, true);
  const stale = (await f.inspect()).selectionSha256 ?? "";
  // Home A resumes the retained run: a new lifetime begins after the completed one.
  await beginNativeProjectFinalization({ scope: f.a, run, httpsPort: null });
  await expectClosedRefusal(
    release({ scope: f.b, expectSelection: stale }),
    "owned by live run"
  );
  expect(await load(f.a)).toEqual(run);
});

test("a replaced owning home is unproven even with completed records copied in", async () => {
  const f = await fixture();
  await startInHomeA(f, true);
  await rename(f.homeA, `${f.homeA}-moved`);
  await mkdir(f.homeA, { mode: 0o700 });
  await rename(
    join(`${f.homeA}-moved`, ".hack-local"),
    join(f.homeA, ".hack-local")
  );
  expect(await f.inspect()).toMatchObject({
    owner: "unproven",
    selectionSha256: null,
  });
});

test("pending down hooks, held locks and the owning home's lock refuse release", async () => {
  const f = await fixture();
  await startInHomeA(f, true);
  const selection = (await f.inspect()).selectionSha256 ?? "";
  const mapping =
    (await readdir(f.runs)).find((name) => /^[a-f0-9]{64}\.json$/.test(name)) ??
    "absent.json";
  const base = join(f.runs, mapping.slice(0, -5));

  await writeFile(`${base}.down-hooks.json`, "{}", { mode: 0o600 });
  await expect(
    release({ scope: f.b, expectSelection: selection })
  ).rejects.toThrow();
  await rm(`${base}.down-hooks.json`);

  await mkdir(`${base}.lock`);
  await expect(
    release({ scope: f.b, expectSelection: selection })
  ).rejects.toThrow();
  await rm(`${base}.lock`, { recursive: true });

  const finalization = join(f.homeA, ".hack-local", "frontend-finalization");
  const [scopeHash] = await readdir(finalization);
  const ownerLock = join(
    finalization,
    scopeHash ?? "absent",
    run.run,
    "operation.lock"
  );
  await mkdir(ownerLock);
  await expect(
    release({ scope: f.b, expectSelection: selection })
  ).rejects.toThrow();
  await rm(ownerLock, { recursive: true });

  expect(await load(f.a)).toEqual(run);
  // No release lock or audit was left behind by the refusals.
  expect(
    (await readdir(f.runs)).filter(
      (name) => name.endsWith(".lock") || name.includes("operation")
    )
  ).toEqual([]);
  expect(
    (await release({ scope: f.b, expectSelection: selection })).released
  ).toBe(true);
});

test("a mapping that differs in more than its native home keeps the generic refusal", async () => {
  const f = await fixture();
  await startInHomeA(f, true);
  // Replace the project directory: its identity no longer matches the mapping.
  await rename(f.a.projectDir, `${f.a.projectDir}-old`);
  await mkdir(f.a.projectDir);
  await rename(
    join(`${f.a.projectDir}-old`, ".internal"),
    join(f.a.projectDir, ".internal")
  );
  await expectClosedRefusal(
    load(f.b),
    "Native project run mapping is unsafe, changed, or owned by another run; inspect native state before recovery."
  );
});
