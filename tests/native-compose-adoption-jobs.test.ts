import { expect, test } from "bun:test";
import type { LegacyComposeVerifiedBinding } from "../src/lib/native-compose-adoption-binding.ts";
import {
  consumeLegacyComposeJobCompletion,
  executeLegacyComposeRetainedPlan,
} from "../src/lib/native-compose-adoption-execution.ts";
import {
  type LegacyComposeJobState,
  legacyComposeFreshJobResult,
  legacyComposeJobStates,
  legacyComposeTimestampInstant,
} from "../src/lib/native-compose-adoption-jobs.ts";
import { legacyComposeRetainedPlan } from "../src/lib/native-compose-adoption-readiness.ts";

const DB = "a".repeat(64),
  JOB = "b".repeat(64),
  APP = "c".repeat(64);
const OLD = "2026-10-08T00:00:01Z",
  START = "2026-10-08T00:00:02.000000001Z",
  FINISH = "2026-10-08T00:00:03Z";
const binding: LegacyComposeVerifiedBinding = {
  binding_version: 1,
  projectRoot: "/synthetic",
  composeFile: "/synthetic/.hack/docker-compose.yml",
  composeProject: "fixture",
  engineId: "synthetic",
  containers: [
    { id: DB, service: "db", name: "fixture-db-1" },
    { id: JOB, service: "seed", name: "fixture-seed-1" },
    { id: APP, service: "app", name: "fixture-app-1" },
  ],
  volumes: [],
  mounts: [],
  network: { id: "d".repeat(64), name: "fixture_default", createdAt: OLD },
};
function plan() {
  return legacyComposeRetainedPlan({
    services: {
      app: { depends_on: [{ job: "seed", condition: "completed" }] },
      db: {
        readiness: {
          kind: "exec",
          command: { exec: ["probe"] },
          interval: "1s",
          timeout: "1s",
          retries: 2,
        },
      },
    },
    jobs: { seed: { depends_on: [{ service: "db", condition: "ready" }] } },
  });
}
function row(id = JOB): LegacyComposeJobState {
  return {
    id,
    running: false,
    paused: false,
    status: "exited",
    health: "",
    exitCode: 0,
    startedAt: OLD,
    finishedAt: FINISH,
    restartPolicy: "no",
    maximumRetryCount: 0,
  };
}
function fixture() {
  const states = new Map([DB, JOB, APP].map((id) => [id, row(id)])),
    commands: string[] = [];
  let attempt = 0;
  return {
    states,
    commands,
    plan: plan(),
    binding,
    operation: "start" as const,
    deadline: Date.now() + 3000,
    assertFresh: async () => {},
    observe: async () => [...states.values()],
    effect: async (operation: "start" | "stop", id: string) => {
      commands.push(`${operation}:${id}`);
      if (id === JOB && operation === "start") {
        attempt++;
        states.set(id, {
          ...row(id),
          startedAt: `2026-10-08T00:00:02.${String(attempt).padStart(9, "0")}Z`,
        });
      } else {
        states.set(id, {
          ...(states.get(id) ?? row(id)),
          running: operation === "start",
          status: operation === "start" ? "running" : "exited",
          health: id === DB && operation === "start" ? "healthy" : "",
        });
      }
      return 0;
    },
  };
}
test("fast exited-zero job gates the consumer; injected scheduler completion carries no production authority", async () => {
  const opts = fixture(),
    outcome = await executeLegacyComposeRetainedPlan(opts);
  expect(opts.commands).toEqual([
    `start:${DB}`,
    `start:${JOB}`,
    `start:${APP}`,
  ]);
  expect(outcome).toBe(0);
  expect(() => consumeLegacyComposeJobCompletion({ ...opts, outcome })).toThrow(
    "pending ownership retained"
  );
});
test("numeric and structural completions cannot acknowledge job startup", async () => {
  const opts = fixture(),
    outcome = await executeLegacyComposeRetainedPlan(opts);
  for (const value of [
    0,
    {},
    typeof outcome === "object" ? { ...outcome } : outcome,
  ]) {
    expect(() =>
      consumeLegacyComposeJobCompletion({ ...opts, outcome: value })
    ).toThrow("values omitted");
  }
  for (const changed of [
    { plan: plan() },
    { binding: { ...binding } },
    { operation: "restart" as const },
    { deadline: opts.deadline + 1 },
    { assertFresh: async () => {} },
  ]) {
    expect(() =>
      consumeLegacyComposeJobCompletion({ ...opts, ...changed, outcome })
    ).toThrow("values omitted");
  }
  expect(() => consumeLegacyComposeJobCompletion({ ...opts, outcome })).toThrow(
    "values omitted"
  );
});
test("reverse stopped recovery starts no jobs; explicit restart is a fresh forward attempt", async () => {
  const opts = fixture();
  await executeLegacyComposeRetainedPlan(opts);
  expect(
    await executeLegacyComposeRetainedPlan({ ...opts, operation: "stop" })
  ).toBe(0);
  expect(opts.commands.slice(3)).toEqual([
    `stop:${APP}`,
    `stop:${JOB}`,
    `stop:${DB}`,
  ]);
  const outcome = await executeLegacyComposeRetainedPlan({
    ...opts,
    operation: "restart",
  });
  expect(opts.commands.slice(6)).toEqual([
    `stop:${APP}`,
    `stop:${JOB}`,
    `stop:${DB}`,
    `start:${DB}`,
    `start:${JOB}`,
    `start:${APP}`,
  ]);
  expect(outcome).toBe(0);
  expect(opts.states.get(JOB)?.startedAt).toBe(
    "2026-10-08T00:00:02.000000002Z"
  );
});
test("new known exit17 refuses immediately with no dependent start", async () => {
  const opts = fixture(),
    effect = opts.effect;
  await expect(
    executeLegacyComposeRetainedPlan({
      ...opts,
      effect: async (action, id) => {
        await effect(action, id);
        if (id === JOB) {
          opts.states.set(id, { ...row(id), startedAt: START, exitCode: 17 });
        }
        return 0;
      },
    })
  ).rejects.toThrow("pending ownership retained");
  expect(opts.commands).toEqual([`start:${DB}`, `start:${JOB}`]);
});
test("historical exit0 and equivalent UTC spellings cannot unblock a consumer", async () => {
  const opts = fixture(),
    effect = opts.effect;
  await expect(
    executeLegacyComposeRetainedPlan({
      ...opts,
      deadline: Date.now() + 50,
      effect: async (action, id) => {
        await effect(action, id);
        if (id === JOB) {
          opts.states.set(id, {
            ...row(id),
            startedAt: "2026-10-08T00:00:01.000Z",
          });
        }
        return 0;
      },
    })
  ).rejects.toThrow("values omitted");
  expect(opts.commands).toEqual([`start:${DB}`, `start:${JOB}`]);
});
test.each([
  "authority",
  "abort",
  "deadline",
])("last observation %s drift cannot mint completion after admitted effects", async (fault) => {
  const opts = fixture(),
    controller = new AbortController();
  let invalid = false;
  await expect(
    executeLegacyComposeRetainedPlan({
      ...opts,
      signal: controller.signal,
      assertFresh: async () => {
        if (invalid && fault === "authority") {
          throw new Error("synthetic authority refused");
        }
      },
      observe: async () => {
        if (opts.states.get(APP)?.running) {
          invalid = true;
          if (fault === "abort") {
            controller.abort();
          }
          if (fault === "deadline") {
            await Bun.sleep(60);
          }
        }
        return [...opts.states.values()];
      },
      deadline: fault === "deadline" ? Date.now() + 50 : opts.deadline,
    })
  ).rejects.toThrow();
  expect(opts.commands).toEqual([
    `start:${DB}`,
    `start:${JOB}`,
    `start:${APP}`,
  ]);
});
test("exact nanos distinguish a new attempt without accepting alternate zero spelling", () => {
  expect(legacyComposeTimestampInstant(OLD)).toBe(
    legacyComposeTimestampInstant("2026-10-08T00:00:01.000000000Z")
  );
  expect(legacyComposeTimestampInstant(START)).not.toBe(
    legacyComposeTimestampInstant("2026-10-08T00:00:02Z")
  );
  for (const startedAt of [
    "0001-01-01T00:00:00Z",
    "0001-01-01T00:00:00.000Z",
    "2026-10-08T00:00:01.0Z",
  ]) {
    expect(
      legacyComposeFreshJobResult({
        attempt: { id: JOB, priorStartedAt: OLD },
        observed: { ...row(), startedAt },
      })
    ).toBe("waiting");
  }
  expect(
    legacyComposeFreshJobResult({
      attempt: { id: JOB, priorStartedAt: OLD },
      observed: { ...row(), startedAt: START },
    })
  ).toBe("ready");
  expect(legacyComposeTimestampInstant("2026-02-30T00:00:00Z")).toBeUndefined();
});
test("closed snapshots refuse missing/duplicate/foreign/accessor/extra facts without reading getters", () => {
  const rows = [row(DB), row(JOB), row(APP)];
  expect(legacyComposeJobStates({ binding, observed: rows })).toEqual(rows);
  let reads = 0;
  const accessor = Object.defineProperty({ ...row() }, "exitCode", {
    get: () => {
      reads++;
      return 0;
    },
  });
  for (const observed of [
    rows.slice(1),
    [...rows, row()],
    [row(DB), row(DB), row(APP)],
    [row(DB), row("f".repeat(64)), row(APP)],
    [row(DB), accessor, row(APP)],
    [row(DB), { ...row(), unknown: "synthetic-private" }, row(APP)],
  ]) {
    expect(() => legacyComposeJobStates({ binding, observed })).toThrow(
      "values omitted"
    );
  }
  expect(reads).toBe(0);
});
test.each([
  { readiness: {} },
  { restart: { kind: "always" } },
  { restart: { kind: "on-failure", max_retries: 1 } },
  { profiles: ["inactive"] },
])("job role policy refuses %j before any effects", (job) => {
  expect(() =>
    legacyComposeRetainedPlan({ services: {}, jobs: { seed: job } })
  ).toThrow("values omitted");
});

test("dependency accessors, sparse edges and root job profiles refuse without getter execution", () => {
  let reads = 0;
  const accessor = Object.defineProperty([], "0", {
    enumerable: true,
    get: () => {
      reads++;
      return { job: "seed", condition: "completed" };
    },
  });
  for (const depends_on of [accessor, new Array(1)]) {
    expect(() =>
      legacyComposeRetainedPlan({
        services: { app: { depends_on } },
        jobs: { seed: {} },
      })
    ).toThrow("values omitted");
  }
  expect(reads).toBe(0);
  expect(() =>
    legacyComposeRetainedPlan({
      services: {},
      jobs: { seed: {} },
      profiles: { inactive: {} },
    })
  ).toThrow("values omitted");
});
