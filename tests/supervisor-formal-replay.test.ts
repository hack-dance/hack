import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Replay,
  replayManifest,
  replayMarker,
  runStrictReplay,
} from "../scripts/check-supervisor-replays.ts";
import {
  createJobStore,
  type JobStore,
} from "../src/control-plane/extensions/supervisor/job-store.ts";
import {
  type JobRunResult,
  type JobSpawnListener,
  runJob,
} from "../src/control-plane/extensions/supervisor/runner.ts";
import { createSupervisorService } from "../src/control-plane/extensions/supervisor/service.ts";
import { logger } from "../src/ui/logger.ts";

/** Only this error can become named property evidence; setup/IO errors cannot. */
class PropertyViolation extends Error {
  readonly property: string;

  constructor(property: string) {
    super(`Requested property violated: ${property}`);
    this.name = "PropertyViolation";
    this.property = property;
  }
}

function assertProperty(property: string, holds: boolean): void {
  if (!holds) {
    throw new PropertyViolation(property);
  }
}

/** Signal delivery and exit are distinct. No timer controls a replay schedule. */
function controlledChild(pid: number) {
  const exit = Promise.withResolvers<number>();
  const awaitingExit = Promise.withResolvers<void>();
  const secondExitRead = Promise.withResolvers<void>();
  let exitReads = 0;
  const child = {
    alive: true,
    signals: 0,
    awaitingExit: awaitingExit.promise,
    secondExitRead: secondExitRead.promise,
    exit: () => {
      child.alive = false;
      exit.resolve(0);
    },
    proc: {
      pid,
      stdout: new ReadableStream<Uint8Array>({
        start: (stream) => stream.close(),
      }),
      stderr: new ReadableStream<Uint8Array>({
        start: (stream) => stream.close(),
      }),
      get exited() {
        exitReads += 1;
        awaitingExit.resolve();
        if (exitReads === 2) {
          secondExitRead.resolve();
        }
        return exit.promise;
      },
      kill: () => {
        child.signals += 1;
      },
    },
  };
  return child;
}

type Child = ReturnType<typeof controlledChild>;
type Control = Parameters<JobSpawnListener>[0];
type Fixture = {
  readonly store: JobStore;
  readonly projectDir: string;
  readonly children: Child[];
  readonly spawned: Promise<Child>;
  readonly runs: Promise<unknown>[];
};

async function withFixture(
  replay: (fixture: Fixture) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(
    join(
      process.env.HACK_SUPERVISOR_REPLAY_DATA ?? tmpdir(),
      "hack-supervisor-replay-"
    )
  );
  const projectDir = join(dir, ".hack");
  const children: Child[] = [];
  const runs: Promise<unknown>[] = [];
  const spawned = Promise.withResolvers<Child>();
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => {
    const child = controlledChild(10_000 + children.length);
    children.push(child);
    spawned.resolve(child);
    return child.proc;
  }) as unknown as typeof Bun.spawn);
  try {
    await replay({
      store: await createJobStore({ projectDir }),
      projectDir,
      children,
      spawned: spawned.promise,
      runs,
    });
  } finally {
    for (const child of children) {
      child.exit();
    }
    await Promise.allSettled(runs);
    spawn.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seed(store: JobStore): Promise<void> {
  await store.createJob({
    jobId: "replay",
    runner: "generic",
    command: ["controlled-child"],
  });
}

function start(fixture: Fixture) {
  const ready = Promise.withResolvers<Control>();
  const run = runJob({
    jobStore: fixture.store,
    jobId: "replay",
    onSpawn: ready.resolve,
  });
  fixture.runs.push(run);
  // Observe rejection immediately, including while the schedule awaits onSpawn.
  void run.catch(() => {});
  return { run, ready: ready.promise };
}

async function requireSpawn(
  started: ReturnType<typeof start>
): Promise<Control> {
  return await Promise.race([
    started.ready,
    started.run.then(() => {
      throw new Error("Expected a process to start");
    }),
  ]);
}

function childAt(fixture: Fixture, index: number): Child {
  const child = fixture.children[index];
  if (!child) {
    throw new Error("Missing controlled child");
  }
  return child;
}

async function singleRunner(fixture: Fixture): Promise<void> {
  await seed(fixture.store);
  const first = start(fixture);
  await requireSpawn(first);
  const second = start(fixture);
  await Promise.race([second.ready, second.run]);
  const liveChildren = fixture.children.filter((child) => child.alive).length;
  expect(liveChildren).toBeGreaterThanOrEqual(1);
  // Finish separately: this replay does not assume concurrent store writes are atomic.
  childAt(fixture, 0).exit();
  await first.run;
  fixture.children[1]?.exit();
  await second.run;
  assertProperty("SingleRunner", liveChildren <= 1);
}

async function cancelQuiescent(fixture: Fixture): Promise<void> {
  await seed(fixture.store);
  const first = start(fixture);
  const control = await requireSpawn(first);
  const child = childAt(fixture, 0);
  const cancellation = control
    .cancel()
    .then((accepted) => ({ accepted, alive: child.alive }));
  fixture.runs.push(cancellation);
  // The reference reads exited a second time inside cancel. Release only after
  // that wait is reached, or after actual code has acknowledged a still-live child.
  await Promise.race([cancellation, child.secondExitRead]);
  child.exit();
  const acknowledgement = await cancellation;
  expect(acknowledgement.accepted).toBe(true);
  expect(child.signals).toBe(1);
  expect((await first.run).status).toBe("cancelled");
  const retry = start(fixture);
  await Promise.race([retry.ready, retry.run]);
  const restarted = fixture.children.length > 1;
  fixture.children[1]?.exit();
  await retry.run;
  assertProperty("CancelQuiescent", !(acknowledgement.alive || restarted));
}

async function retryIdempotent(fixture: Fixture): Promise<void> {
  await seed(fixture.store);
  const first = start(fixture);
  await requireSpawn(first);
  childAt(fixture, 0).exit();
  expect((await first.run).status).toBe("completed");
  expect((await fixture.store.readJobMeta({ jobId: "replay" }))?.status).toBe(
    "completed"
  );
  const retry = start(fixture);
  await Promise.race([retry.ready, retry.run]);
  fixture.children[1]?.exit();
  await retry.run;
  assertProperty("RetryIdempotent", fixture.children.length === 1);
}

async function claimedTerminal(fixture: Fixture): Promise<void> {
  const fault = new Error("Injected single terminal status write rejection");
  let failures = 0;
  const errors: string[] = [];
  const service = createSupervisorService({
    logger: { ...logger, error: ({ message }) => errors.push(message) },
    createStore: async () => ({
      ...fixture.store,
      updateJobStatus: async (input) => {
        if (input.status === "cancelled" && failures === 0) {
          failures += 1;
          throw fault;
        }
        return await fixture.store.updateJobStatus(input);
      },
    }),
  });
  const created = await service.createJob({
    projectDir: fixture.projectDir,
    runner: "generic",
    command: ["controlled-child"],
  });
  fixture.runs.push(created.run);
  let runSettled = false;
  const outcome = created.run.then(
    (result) => {
      runSettled = true;
      return { result, error: undefined };
    },
    (error: unknown) => {
      runSettled = true;
      return { result: undefined, error };
    }
  );
  const child = await Promise.race([
    fixture.spawned,
    outcome.then(() => {
      throw new Error("Service settled before spawn");
    }),
  ]);
  // The runner reads exited after onSpawn has registered the service handle.
  await child.awaitingExit;
  const input = { projectDir: fixture.projectDir, jobId: created.jobId };
  let cancellationError: unknown;
  let cancellationAccepted = false;
  try {
    cancellationAccepted = (await service.cancelJob(input)).ok;
  } catch (error: unknown) {
    expect(error).toBe(fault);
    cancellationError = error;
  }
  expect(child.alive).toBe(true);
  expect(child.signals).toBe(1);
  expect(runSettled).toBe(false);
  child.exit();
  const settled = await outcome;
  expect(failures).toBe(1);
  if (settled.error !== undefined) {
    expect(cancellationError).toBe(fault);
    expect(settled.error).toBe(fault);
    expect(errors).toHaveLength(1);
  } else {
    expect(cancellationAccepted).toBe(true);
    expect(settled.result?.status).toBe("cancelled");
    expect(errors).toHaveLength(0);
  }
  const stored = await service.getJob(input);
  if (!stored) {
    throw new Error("Missing service metadata");
  }
  // Prove the filesystem is writable after the finite fault without repairing it.
  await fixture.store.updateJobStatus({
    jobId: created.jobId,
    status: stored.status,
  });
  expect(await service.cancelJob(input)).toEqual({
    ok: false,
    status: "not_running",
  });
  const events = await fixture.store.readEvents(input);
  const terminal = events.filter((event) => terminalEventTypes.has(event.type));
  if (settled.error !== undefined) {
    expect(stored.status).toBe("running");
    expect(terminal).toHaveLength(0);
  }
  assertProperty(
    "ClaimedTerminal",
    stored.status === "cancelled" &&
      terminal.length === 1 &&
      terminal[0]?.type === "job.cancelled"
  );
}

const terminalEventTypes = new Set([
  "job.cancelled",
  "job.completed",
  "job.failed",
]);

async function cancelWins(fixture: Fixture): Promise<void> {
  await seed(fixture.store);
  const first = start(fixture);
  const control = await requireSpawn(first);
  expect(await control.cancel()).toBe(true);
  expect(await control.cancel()).toBe(true);
  childAt(fixture, 0).exit();
  const result: JobRunResult = await first.run;
  const repeated = await control.cancel();
  const stored = await fixture.store.readJobMeta({ jobId: "replay" });
  const terminal = (await fixture.store.readEvents({ jobId: "replay" })).filter(
    (event) => terminalEventTypes.has(event.type)
  );
  assertProperty(
    "CancelWins",
    result.status === "cancelled" &&
      stored?.status === "cancelled" &&
      repeated &&
      childAt(fixture, 0).signals === 1 &&
      terminal.length === 1 &&
      terminal[0]?.type === "job.cancelled"
  );
}

const schedules = {
  P1: singleRunner,
  P2: cancelQuiescent,
  P3: retryIdempotent,
  P4: claimedTerminal,
  P5: cancelWins,
} satisfies Record<Replay["id"], (fixture: Fixture) => Promise<void>>;

const strictId = process.env.HACK_SUPERVISOR_STRICT_REPLAY;
if (strictId === undefined) {
  for (const replay of replayManifest) {
    test(`${replay.id} ${replay.property}: documented actual ${replay.actual}`, async () => {
      await runStrictReplay({ replay, expected: replay.actual });
    }, 20_000);
  }
} else {
  const replay = replayManifest.find((entry) => entry.id === strictId);
  if (!replay) {
    throw new Error("Unknown strict supervisor replay");
  }
  test(`${replay.id} requested property ${replay.property}`, async () => {
    try {
      await withFixture(schedules[replay.id]);
    } catch (error: unknown) {
      if (
        error instanceof PropertyViolation &&
        error.property === replay.property
      ) {
        process.stdout.write(
          `${replayMarker({ replay, outcome: "VIOLATION" })}\n`
        );
      }
      throw error;
    }
    process.stdout.write(`${replayMarker({ replay, outcome: "PASS" })}\n`);
  });
}
