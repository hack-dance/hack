import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  adoptionDependencyHealthcheck,
  assertAdoptionDependencyHealthcheck,
  assertAdoptionDependencyStart,
} from "./e2e/scenarios/native-compose-adoption-dependency-inputs.ts";
import { nativeComposeAdoptionDependencyWorktreesScenario } from "./e2e/scenarios/native-compose-adoption-worktrees.ts";

const db = "a".repeat(64),
  worker = "b".repeat(64);
const running = {
  id: db,
  running: true,
  paused: false,
  status: "running",
  health: "healthy",
};
const options = {
  db,
  worker,
  prior: [db],
  requested: worker,
  condition: "service_healthy" as const,
  observed: running,
};
const refusal =
  "Adoption dependency fixture ordering check failed; values omitted.";

test("actual ordered-start oracle requires original DB first and a healthy prerequisite", () => {
  expect(() =>
    assertAdoptionDependencyStart({ ...options, prior: [], requested: db })
  ).not.toThrow();
  expect(() => assertAdoptionDependencyStart(options)).not.toThrow();
  expect(() =>
    assertAdoptionDependencyStart({
      ...options,
      condition: "service_started",
      observed: { ...running, health: "" },
    })
  ).not.toThrow();
  expect(() =>
    assertAdoptionDependencyStart({
      ...options,
      condition: "service_started",
      observed: { ...running, health: "starting" },
    })
  ).not.toThrow();
});

for (const [name, changed] of [
  ["worker before db", { prior: [] }],
  ["duplicate db start", { requested: db }],
  ["extra start", { prior: [db, worker] }],
  ["foreign requested ID", { requested: "c".repeat(64) }],
  ["foreign DB observation", { observed: { ...running, id: worker } }],
  ["DB stopped", { observed: { ...running, running: false } }],
  ["DB paused", { observed: { ...running, paused: true } }],
  ["DB restarting", { observed: { ...running, status: "restarting" } }],
  ["health starting", { observed: { ...running, health: "starting" } }],
  ["health absent", { observed: { ...running, health: "" } }],
  ["health unhealthy", { observed: { ...running, health: "unhealthy" } }],
  ["malformed health", { observed: { ...running, health: null } }],
  [
    "extra private field",
    { observed: { ...running, private: "PRIVATE_CANARY" } },
  ],
] as const) {
  test(`actual ordered-start oracle refuses ${name} without exposing values`, () => {
    expect(() =>
      assertAdoptionDependencyStart({ ...options, ...changed })
    ).toThrow(refusal);
    expect(() =>
      assertAdoptionDependencyStart({ ...options, ...changed })
    ).not.toThrow("PRIVATE_CANARY");
  });
}

const explicitHealth = {
  test: [...adoptionDependencyHealthcheck.test],
  interval: 1_000_000_000,
  timeout: 1_000_000_000,
  retries: 30,
};
test("actual exec probe oracle requires exact argv and explicit nanosecond timings", () => {
  expect(() =>
    assertAdoptionDependencyHealthcheck(explicitHealth)
  ).not.toThrow();
  for (const row of [
    null,
    { ...explicitHealth, test: ["CMD-SHELL", "PRIVATE_CANARY"] },
    { ...explicitHealth, interval: 0 },
    { ...explicitHealth, timeout: 30_000_000_000 },
    { ...explicitHealth, retries: 3 },
    { ...explicitHealth, startPeriod: 0 },
  ]) {
    expect(() => assertAdoptionDependencyHealthcheck(row)).toThrow(refusal);
    expect(() => assertAdoptionDependencyHealthcheck(row)).not.toThrow(
      "PRIVATE_CANARY"
    );
  }
});

test("new dependency selector is explicit and registered once with failure preservation", async () => {
  expect(nativeComposeAdoptionDependencyWorktreesScenario).toMatchObject({
    name: "native-compose-adoption-dependency-worktrees",
    tier: "docker",
    preserveFixtureOnFailure: true,
  });
  const registry = await readFile(
    new URL("./e2e/run.ts", import.meta.url),
    "utf8"
  );
  const entries = registry.slice(
    registry.indexOf("const ALL_SCENARIOS"),
    registry.indexOf("type CliArgs")
  );
  expect(
    entries.match(/nativeComposeAdoptionDependencyWorktreesScenario/g)
  ).toHaveLength(1);
});
