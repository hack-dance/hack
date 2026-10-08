import { expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
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

test("incomplete fixture cleanup retains receipts and data while still failing", async () => {
  const retained: string[] = [];
  try {
    const outcomes = await runScenarios({
      dockerEnabled: false,
      scenarios: [
        {
          name: "incomplete-owned-cleanup",
          tier: "local",
          summary: "retention fixture",
          run: async (ctx) => {
            retained.push(ctx.tempRoot, ctx.hackHome);
            await Bun.write(join(ctx.tempRoot, "owned-data"), "fixture data");
            await Bun.write(
              join(ctx.hackHome, "owned-receipt"),
              "fixture identity"
            );
            ctx.retainFixtures("Exact owned teardown is incomplete");
            throw new Error("Owned cleanup refused");
          },
        },
      ],
    });
    expect(outcomes[0]?.status).toBe("fail");
    expect(outcomes[0]?.reason).toBe("Owned cleanup refused");
    expect(await Bun.file(join(retained[0] ?? "", "owned-data")).text()).toBe(
      "fixture data"
    );
    expect(
      await Bun.file(join(retained[1] ?? "", "owned-receipt")).text()
    ).toBe("fixture identity");
  } finally {
    await Promise.all(
      retained.map((path) => rm(path, { recursive: true, force: true }))
    );
  }
});

test("retained incomplete cleanup cannot silently become pass or skip", async () => {
  const retained: string[] = [];
  try {
    for (const skip of [false, true]) {
      const outcomes = await runScenarios({
        dockerEnabled: false,
        scenarios: [
          {
            name: "retained-no-success",
            tier: "local",
            summary: "retention fixture",
            run: async (ctx) => {
              retained.push(ctx.tempRoot, ctx.hackHome);
              ctx.retainFixtures("Owned cleanup remains incomplete");
              if (skip) {
                ctx.skip("missing prerequisite after retained cleanup");
              }
            },
          },
        ],
      });
      expect(outcomes[0]?.status).toBe("fail");
    }
  } finally {
    await Promise.all(
      retained.map((path) => rm(path, { recursive: true, force: true }))
    );
  }
});

test("ordinary passing and failing scenarios still remove both temporary roots", async () => {
  for (const fail of [false, true]) {
    const paths: string[] = [];
    const outcomes = await runScenarios({
      dockerEnabled: false,
      scenarios: [
        {
          name: "ordinary-fixture-cleanup",
          tier: "local",
          summary: "default cleanup fixture",
          run: async (ctx) => {
            paths.push(ctx.tempRoot, ctx.hackHome);
            expect(await realpath(ctx.tempRoot)).toBe(ctx.tempRoot);
            expect(await realpath(ctx.hackHome)).toBe(ctx.hackHome);
            await Bun.write(join(ctx.tempRoot, "marker"), "synthetic data");
            await Bun.write(join(ctx.hackHome, "marker"), "synthetic receipt");
            if (fail) {
              throw new Error(
                "Earlier assertion failure after complete cleanup"
              );
            }
          },
        },
      ],
    });
    expect(outcomes[0]?.status).toBe(fail ? "fail" : "pass");
    for (const path of paths) {
      expect(await Bun.file(join(path, "marker")).exists()).toBe(false);
    }
  }
});
