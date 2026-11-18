import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectDown } from "../src/backends/native-project-down.ts";
import { beginNativeProjectFinalization } from "../src/backends/native-project-finalization.ts";
import {
  beginNativeProjectStartupObservation,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

/**
 * HACK-2351: a detached start whose launcher gave up can still be building or
 * unwinding with no run published yet, holding the native runtime. `down`
 * must not report "not started" (success) while that start's owner is alive.
 */

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
    await mkdtemp(join(tmpdir(), "native-down-pending-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(projectRoot, "home");
  await mkdir(projectDir);
  await mkdir(nativeHome, { mode: 0o700 });
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  return { scope, runtime: { binary: "/not-invoked", home: nativeHome } };
}

test("down refuses while an unpublished start of the instance is alive, and never reports success", async () => {
  const f = await fixture();
  // This test process is the start's live owner.
  const finish = await beginNativeProjectStartupObservation(f.scope);
  const started = performance.now();
  const error = await nativeProjectDown({ ...f, startupWaitMs: 600 }).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(HackCliError);
  expect((error as HackCliError).code).toBe("E_DOWN_INCOMPLETE");
  expect((error as HackCliError).message).toContain("nothing was stopped");
  // It waited for the start, within its bound.
  expect(performance.now() - started).toBeGreaterThanOrEqual(500);
  await finish();
  // Once that start has ended without a run, down reports "not started".
  expect(await nativeProjectDown({ ...f, startupWaitMs: 600 })).toEqual({
    backend: "native",
    status: "not_started",
    dataPreserved: true,
  });
});

test("down stops the run a start publishes while it waits for that start", async () => {
  const f = await fixture();
  const finish = await beginNativeProjectStartupObservation(f.scope);
  setTimeout(() => {
    saveNativeProjectRun({ ...f.scope, run }).then(finish);
  }, 200);
  // Reaching the runtime proves the down moved on to stop the published run.
  const invoked: string[][] = [];
  const error = await nativeProjectDown({
    ...f,
    startupWaitMs: 5000,
    invoke: (request) => {
      invoked.push([...request.args]);
      return Promise.reject(new Error("synthetic stop"));
    },
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(invoked.length).toBeGreaterThan(0);
  expect(invoked[0]?.join(" ")).toContain(run.run);
});

/** The runtime's inspection of {@link run}'s stopped, retained graph. */
const stoppedGraph = {
  receipt: {
    ...run,
    plan_id: run.planId,
    phase: "stopped-data-retained",
    resources: {
      "container:web": {
        kind: "container",
        key: "web",
        id: "e".repeat(64),
        phase: "started",
      },
    },
  },
  journal_incomplete: false,
  observations: { "container:web": { state: "absent" } },
};

test("down does not call a retained run stopped while a new start of it is alive", async () => {
  // Review finding: a stopped retained mapping, and a new `up` resuming it.
  const f = await fixture();
  await saveNativeProjectRun({ ...f.scope, run });
  const finalization = await beginNativeProjectFinalization({
    scope: f.scope,
    run,
  });
  await finalization.complete();
  const finish = await beginNativeProjectStartupObservation(f.scope);
  const invoke = () => Promise.resolve(stoppedGraph);
  const error = await nativeProjectDown({
    ...f,
    startupWaitMs: 600,
    invoke,
  }).catch((caught: unknown) => caught);
  expect((error as HackCliError).code).toBe("E_DOWN_INCOMPLETE");
  await finish();
  // With no start alive, the retained run is reported stopped as before.
  expect(
    await nativeProjectDown({ ...f, startupWaitMs: 600, invoke })
  ).toMatchObject({ status: "stopped", run: run.run });
});

test("the restart coordinator's down never waits for its own start", async () => {
  const f = await fixture();
  const finish = await beginNativeProjectStartupObservation(f.scope);
  const started = performance.now();
  expect(
    await nativeProjectDown({
      ...f,
      deferFinalization: true,
      startupWaitMs: 5000,
    })
  ).toMatchObject({ status: "not_started" });
  expect(performance.now() - started).toBeLessThan(1000);
  await finish();
});
