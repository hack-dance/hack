import { expect, test } from "bun:test";
import {
  adoptionFixtureBranchArgs,
  assertBranchPsReport,
  nativeComposeAdoptionBranchWorktreesScenario,
} from "./e2e/scenarios/native-compose-adoption-worktrees.ts";

test("branch fixture selects the saved owner before command positionals", () => {
  expect(
    adoptionFixtureBranchArgs(
      ["config", "adopt", "--recover", "--stop", "--json"],
      "adoption-alpha"
    )
  ).toEqual([
    "config",
    "adopt",
    "--branch",
    "adoption-alpha",
    "--recover",
    "--stop",
    "--json",
  ]);
  expect(
    adoptionFixtureBranchArgs(
      ["exec", "db", "--", "psql", "-At"],
      "adoption-alpha"
    )
  ).toEqual(["exec", "--branch", "adoption-alpha", "db", "--", "psql", "-At"]);
  expect(adoptionFixtureBranchArgs(["ps", "--json"])).toEqual(["ps", "--json"]);
  expect(() => adoptionFixtureBranchArgs(["ps", "--json"], "")).toThrow(
    "values omitted"
  );
  expect(nativeComposeAdoptionBranchWorktreesScenario.tier).toBe("docker");
  expect(
    nativeComposeAdoptionBranchWorktreesScenario.preserveFixtureOnFailure
  ).toBe(true);
});

test("saved branch convergence requires the real complete legacy service set", () => {
  const running = {
    owner: "legacy-compose",
    services: [
      { service: "db", status: "running" },
      { service: "worker", status: "running" },
    ],
  };
  expect(() => assertBranchPsReport(running)).not.toThrow();
  for (const wrong of [
    { ...running, owner: "native" },
    { ...running, services: [] },
    { ...running, services: [running.services[0], running.services[0]] },
    {
      ...running,
      services: [running.services[0], { service: "worker", status: "exited" }],
    },
  ]) {
    expect(() => assertBranchPsReport(wrong)).toThrow("values omitted");
  }
});
