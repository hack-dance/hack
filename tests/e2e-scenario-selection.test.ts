import { expect, test } from "bun:test";
import { runScenarios, type Scenario, selectScenarios } from "./e2e/harness.ts";
import { domainMigrationScenario } from "./e2e/scenarios/domain-migration.ts";

const scenarios: readonly Scenario[] = [
  { name: "local", tier: "local", summary: "fixture", run: async () => {} },
  { name: "docker", tier: "docker", summary: "fixture", run: async () => {} },
  domainMigrationScenario,
];

test("default selection retains every portable scenario and excludes host ingress", () => {
  expect(selectScenarios({ scenarios }).map((entry) => entry.name)).toEqual([
    "local",
    "docker",
  ]);
  expect(selectScenarios({ scenarios, only: [] })).toHaveLength(2);
  expect(domainMigrationScenario.tier).toBe("host-ingress");
});

test("explicit selection includes host ingress without unrelated scenarios", () => {
  expect(selectScenarios({ scenarios, only: ["domain-migration"] })).toEqual([
    domainMigrationScenario,
  ]);
});

test("portable Docker skips remain visible for required-Docker enforcement", async () => {
  const outcomes = await runScenarios({
    scenarios,
    dockerEnabled: false,
    only: ["docker"],
  });
  expect(outcomes.map(({ tier, status }) => ({ tier, status }))).toEqual([
    { tier: "docker", status: "skip" },
  ]);
});

test("explicit host ingress fails before running when Docker is disabled", async () => {
  const outcomes = await runScenarios({
    scenarios: [domainMigrationScenario],
    dockerEnabled: false,
    only: ["domain-migration"],
  });
  expect(outcomes[0]?.status).toBe("fail");
  expect(outcomes[0]?.reason).toContain("HACK_E2E_DOCKER=1");
});

test("selected host ingress cannot turn a missing prerequisite into a skip", async () => {
  const outcomes = await runScenarios({
    scenarios: [
      {
        name: "native-fixture",
        tier: "host-ingress",
        summary: "fixture",
        run: async (ctx) => ctx.skip("missing fixture prerequisite"),
      },
    ],
    dockerEnabled: true,
    only: ["native-fixture"],
  });
  expect(outcomes[0]?.status).toBe("fail");
  expect(outcomes[0]?.reason).toBe("missing fixture prerequisite");
});

test("domain qualification refuses absent routing opt-in before host commands", async () => {
  const previous = process.env.HACK_E2E_DOMAIN_ROUTING;
  Reflect.deleteProperty(process.env, "HACK_E2E_DOMAIN_ROUTING");
  try {
    const outcomes = await runScenarios({
      scenarios: [domainMigrationScenario],
      dockerEnabled: true,
      only: ["domain-migration"],
    });
    expect(outcomes[0]?.status).toBe("fail");
    expect(outcomes[0]?.reason).toContain("HACK_E2E_DOMAIN_ROUTING=1");
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "HACK_E2E_DOMAIN_ROUTING");
    } else {
      process.env.HACK_E2E_DOMAIN_ROUTING = previous;
    }
  }
});
