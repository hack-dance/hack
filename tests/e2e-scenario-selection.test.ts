import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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

test.each([
  {
    name: "failed opted-in fixture",
    optedIn: true,
    fail: true,
    keep: false,
    retained: true,
  },
  {
    name: "ordinary failed fixture",
    optedIn: false,
    fail: true,
    keep: false,
    retained: false,
  },
  {
    name: "successful opted-in fixture",
    optedIn: true,
    fail: false,
    keep: false,
    retained: false,
  },
  {
    name: "global KEEP after failure",
    optedIn: false,
    fail: true,
    keep: true,
    retained: true,
  },
  {
    name: "global KEEP after success",
    optedIn: false,
    fail: false,
    keep: true,
    retained: true,
  },
])("fixture evidence policy preserves $name", async (policy) => {
  let paths: { tempRoot: string; hackHome: string } | undefined;
  try {
    const outcomes = await runScenarios({
      keepTempDirs: policy.keep,
      scenarios: [
        {
          name: "owned-evidence-control",
          tier: "local",
          summary: "synthetic evidence policy control",
          preserveFixtureOnFailure: policy.optedIn,
          run: async (ctx) => {
            paths = { tempRoot: ctx.tempRoot, hackHome: ctx.hackHome };
            await Bun.write(
              join(ctx.tempRoot, "source-evidence"),
              "synthetic source"
            );
            await Bun.write(
              join(ctx.hackHome, "home-evidence"),
              "synthetic home"
            );
            if (policy.fail) {
              throw new Error("Synthetic fixture refusal; values omitted.");
            }
          },
        },
      ],
    });
    if (!paths) {
      throw new Error("Expected isolated evidence paths");
    }
    expect(outcomes[0]?.status).toBe(policy.fail ? "fail" : "pass");
    expect(
      await Bun.file(join(paths.tempRoot, "source-evidence")).exists()
    ).toBe(policy.retained);
    expect(await Bun.file(join(paths.hackHome, "home-evidence")).exists()).toBe(
      policy.retained
    );
  } finally {
    if (paths) {
      await rm(paths.tempRoot, { recursive: true, force: true });
      await rm(paths.hackHome, { recursive: true, force: true });
    }
  }
});
