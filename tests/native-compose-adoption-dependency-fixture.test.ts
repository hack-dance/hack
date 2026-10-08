import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  adoptionDependencyHealthcheck,
  adoptionDependencyReadAllowed,
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

const readScope = {
  projectRoot: "/synthetic/nc04-checkout",
  project: "fixture",
  containerIds: [db, worker],
  networkId: "c".repeat(64),
  volumeName: "fixture_data",
  generationId: "d".repeat(32),
};
const composePrefix = [
  "compose",
  "--project-name",
  "fixture",
  "--project-directory",
  "/synthetic/nc04-checkout/.hack",
  "--env-file",
  "/dev/null",
  "--profile",
  "*",
  "--file",
];
const composeSuffix = ["config", "--no-env-resolution", "--hash", "*"];
const originalCompose = "/synthetic/nc04-checkout/.hack/docker-compose.yml";
const savedCompose = `/synthetic/nc04-checkout/.hack/.internal/legacy-compose-adoption-v1/generations/${readScope.generationId}/legacy-compose.yml`;
const statesFormat =
  '{"id":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"status":{{json .State.Status}}}';

test("dependency forwarder accepts only canonical original or receipt-anchored saved config hashes", () => {
  for (const file of [originalCompose, savedCompose]) {
    expect(
      adoptionDependencyReadAllowed({
        ...readScope,
        args: [...composePrefix, file, ...composeSuffix],
      })
    ).toBe(true);
  }
  expect(
    adoptionDependencyReadAllowed({
      ...readScope,
      generationId: undefined,
      args: [...composePrefix, originalCompose, ...composeSuffix],
    })
  ).toBe(true);
  expect(
    adoptionDependencyReadAllowed({
      ...readScope,
      args: ["info", "--format", "{{json .ID}}"],
    })
  ).toBe(true);
  expect(
    adoptionDependencyReadAllowed({
      ...readScope,
      args: ["container", "inspect", "--format", statesFormat, db],
    })
  ).toBe(true);
});

for (const [name, args] of [
  ["Compose up", [...composePrefix, originalCompose, "up", "--detach"]],
  ["Compose down", [...composePrefix, originalCompose, "down"]],
  ["unbounded config", [...composePrefix, originalCompose, "config"]],
  [
    "foreign authored file",
    [...composePrefix, "/synthetic/foreign-compose.yml", ...composeSuffix],
  ],
  [
    "foreign generation file",
    [
      ...composePrefix,
      savedCompose.replace("d".repeat(32), "e".repeat(32)),
      ...composeSuffix,
    ],
  ],
  ["container removal", ["container", "rm", db]],
  ["container start passthrough", ["container", "start", db]],
  ["container exec", ["container", "exec", db, "true"]],
  ["volume removal", ["volume", "rm", "fixture_data"]],
  ["network removal", ["network", "rm", readScope.networkId]],
  ["image inspect", ["image", "inspect", "fixture"]],
  [
    "foreign container inspect",
    ["container", "inspect", "--format", statesFormat, "e".repeat(64)],
  ],
  [
    "container env inspect",
    ["container", "inspect", "--format", "{{json .Config.Env}}", db],
  ],
  ["unknown private format", ["info", "--format", "PRIVATE_CANARY"]],
  ["unformatted inventory", ["container", "ls", "--all"]],
  [
    "extra flag",
    ["container", "inspect", "--format", statesFormat, db, "--size"],
  ],
] as const) {
  test(`dependency forwarder refuses ${name} before engine passthrough`, () => {
    expect(adoptionDependencyReadAllowed({ ...readScope, args })).toBe(false);
  });
}

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
