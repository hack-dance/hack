import { expect, test } from "bun:test";
import type { LegacyComposeVerifiedBinding } from "../src/lib/native-compose-adoption-binding.ts";
import { executeLegacyComposeRetainedPlan } from "../src/lib/native-compose-adoption-execution.ts";
import {
  type LegacyComposeReadinessState,
  legacyComposeRetainedPlan,
} from "../src/lib/native-compose-adoption-readiness.ts";

const DB = "a".repeat(64),
  WEB = "b".repeat(64);
const binding: LegacyComposeVerifiedBinding = {
  binding_version: 1,
  projectRoot: "/synthetic",
  composeFile: "/synthetic/.hack/docker-compose.yml",
  composeProject: "fixture",
  engineId: "synthetic-engine",
  containers: [
    { id: DB, service: "db", name: "fixture-db-1" },
    { id: WEB, service: "web", name: "fixture-web-1" },
  ],
  volumes: [],
  mounts: [],
  network: {
    id: "c".repeat(64),
    name: "fixture_default",
    createdAt: "2026-01-01T00:00:00Z",
  },
};
const HEALTH = {
  kind: "exec",
  command: { exec: ["probe"] },
  interval: "1s",
  timeout: "1s",
  retries: 2,
};
function plan(condition = "ready") {
  return legacyComposeRetainedPlan({
    services: {
      web: { depends_on: [{ service: "db", condition }] },
      db: { readiness: HEALTH },
    },
  });
}
function fixture() {
  const commands: string[] = [];
  const states = new Map<string, LegacyComposeReadinessState>(
    [DB, WEB].map((id) => [
      id,
      { id, running: false, paused: false, status: "exited", health: "" },
    ])
  );
  let reads = 0,
    rechecks = 0;
  return {
    commands,
    states,
    counts: () => ({ reads, rechecks }),
    assertFresh: async () => {
      rechecks++;
    },
    observe: async () => {
      reads++;
      return [...states.values()];
    },
    effect: async (action: "start" | "stop", id: string) => {
      commands.push(`${action}:${id}`);
      states.set(id, {
        id,
        running: action === "start",
        paused: false,
        status: action === "start" ? "running" : "exited",
        health: id === DB && action === "start" ? "healthy" : "",
      });
      return 0;
    },
  };
}

test("healthy prerequisite starts by original ID before its dependent; stop reverses order", async () => {
  const owned = fixture();
  const options = {
    plan: plan(),
    binding,
    deadline: Date.now() + 3000,
    ...owned,
  };
  expect(
    await executeLegacyComposeRetainedPlan({ ...options, operation: "start" })
  ).toBe(0);
  expect(owned.commands).toEqual([`start:${DB}`, `start:${WEB}`]);
  expect(
    await executeLegacyComposeRetainedPlan({ ...options, operation: "stop" })
  ).toBe(0);
  expect(owned.commands.slice(2)).toEqual([`stop:${WEB}`, `stop:${DB}`]);
  expect(owned.counts().rechecks).toBe(4);
});

test("started edge admits dependent before health while final readiness still requires health", async () => {
  const owned = fixture();
  let sawDependentBeforeHealthy = false;
  const baseEffect = owned.effect;
  const result = await executeLegacyComposeRetainedPlan({
    plan: plan("started"),
    binding,
    operation: "start",
    deadline: Date.now() + 3000,
    ...owned,
    effect: async (action, id) => {
      if (id === WEB) {
        sawDependentBeforeHealthy = owned.states.get(DB)?.health === "starting";
        owned.states.set(DB, {
          id: DB,
          running: true,
          paused: false,
          status: "running",
          health: "healthy",
        });
      }
      const code = await baseEffect(action, id);
      if (id === DB) {
        owned.states.set(DB, {
          id: DB,
          running: true,
          paused: false,
          status: "running",
          health: "starting",
        });
      }
      return code;
    },
  });
  expect(result).toBe(0);
  expect(sawDependentBeforeHealthy).toBe(true);
});

test("restart stops reverse order and starts through the same healthy gate", async () => {
  const owned = fixture();
  expect(
    await executeLegacyComposeRetainedPlan({
      plan: plan(),
      binding,
      operation: "restart",
      deadline: Date.now() + 3000,
      ...owned,
    })
  ).toBe(0);
  expect(owned.commands).toEqual([
    `stop:${WEB}`,
    `stop:${DB}`,
    `start:${DB}`,
    `start:${WEB}`,
  ]);
});

test("unhealthy prerequisite cannot start dependent or turn deadline expiry into success", async () => {
  const owned = fixture();
  await expect(
    executeLegacyComposeRetainedPlan({
      plan: plan(),
      binding,
      operation: "start",
      deadline: Date.now() + 100,
      ...owned,
      effect: async (action, id) => {
        await owned.effect(action, id);
        owned.states.set(DB, {
          id: DB,
          running: true,
          paused: false,
          status: "running",
          health: "unhealthy",
        });
        return 0;
      },
    })
  ).rejects.toThrow("Values omitted");
  expect(owned.commands).toEqual([`start:${DB}`]);
});

test("failed effect stops the sequence, and source recheck refusal permits no next effect", async () => {
  const owned = fixture();
  expect(
    await executeLegacyComposeRetainedPlan({
      plan: plan(),
      binding,
      operation: "start",
      deadline: Date.now() + 3000,
      ...owned,
      effect: async (action, id) => {
        await owned.effect(action, id);
        return 7;
      },
    })
  ).toBe(7);
  expect(owned.commands).toEqual([`start:${DB}`]);
  const changed = fixture();
  await expect(
    executeLegacyComposeRetainedPlan({
      plan: plan(),
      binding,
      operation: "start",
      deadline: Date.now() + 3000,
      ...changed,
      assertFresh: async () => {
        if (changed.commands.length) {
          throw new Error("fixed synthetic source drift");
        }
      },
    })
  ).rejects.toThrow("fixed synthetic source drift");
  expect(changed.commands).toEqual([`start:${DB}`]);
});

test("captured cancellation before effects or during health wait prevents later starts", async () => {
  const controller = new AbortController(),
    owned = fixture();
  controller.abort("synthetic-private-reason");
  await expect(
    executeLegacyComposeRetainedPlan({
      plan: plan(),
      binding,
      operation: "start",
      deadline: Date.now() + 3000,
      signal: controller.signal,
      ...owned,
    })
  ).rejects.toThrow("Values omitted");
  expect(owned.commands).toEqual([]);
  expect(owned.counts()).toEqual({ reads: 0, rechecks: 0 });
  const during = new AbortController(),
    waiting = fixture();
  await expect(
    executeLegacyComposeRetainedPlan({
      plan: plan(),
      binding,
      operation: "start",
      deadline: Date.now() + 3000,
      signal: during.signal,
      ...waiting,
      observe: async () => {
        during.abort();
        return await waiting.observe();
      },
    })
  ).rejects.toThrow("Values omitted");
  expect(waiting.commands).toEqual([`start:${DB}`]);
});

test.each([
  {
    services: {
      web: { depends_on: [{ service: "missing", condition: "started" }] },
    },
  },
  {
    services: {
      web: { depends_on: [{ service: "db", condition: "ready" }] },
      db: {},
    },
  },
  {
    services: {
      web: { depends_on: [{ service: "db", condition: "started" }] },
      db: { depends_on: [{ service: "web", condition: "started" }] },
    },
  },
  {
    services: {
      web: { depends_on: [{ job: "db", condition: "completed" }] },
      db: {},
    },
  },
])("unsupported/missing/cyclic graph fails before retained execution %j", (candidate) => {
  expect(() => legacyComposeRetainedPlan(candidate)).toThrow("values omitted");
});
