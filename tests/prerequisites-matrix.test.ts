import { expect, test } from "bun:test";

import {
  COMMAND_PREREQUISITE_CONTRACTS,
  COMMANDS_THAT_INVOKE_PREREQUISITE_CHECKS,
  COMMANDS_WITH_LOCAL_PREREQUISITE_HANDLING,
  getCommandPrerequisiteContracts,
  getLocalPrerequisiteHandling,
  PREREQUISITE_CHECKS,
} from "../src/cli/prerequisites.ts";

test("every prerequisite check is referenced by at least one command contract", () => {
  const referencedChecks = new Set(
    COMMAND_PREREQUISITE_CONTRACTS.flatMap((contract) =>
      contract.rules.map((rule) => rule.checkId)
    )
  );

  for (const check of PREREQUISITE_CHECKS) {
    expect(referencedChecks.has(check.id)).toBe(true);
  }
});

test("command coverage stays focused on the local-first runtime surface", () => {
  expect(COMMANDS_THAT_INVOKE_PREREQUISITE_CHECKS).toEqual([
    "global install",
    "global up",
    "global status",
    "global logs",
    "global logs-reset",
    "global down",
    "global ca",
    "global trust",
    "up",
    "down",
    "restart",
    "ps",
    "run",
    "tui",
    "projects prune",
    "status",
    "projects",
    "open",
    "logs",
    "logs --loki",
    "logs --query",
    "logs --compose",
    "session",
    "session list",
    "session start",
    "session attach",
    "session exec",
    "session stop",
    "ssh",
    "session panes",
    "session capture",
    "session tail",
    "setup tmux",
  ]);
});

test("global install guides Docker problems but only warns on mux availability", () => {
  const [contract] = getCommandPrerequisiteContracts({
    command: "global install",
  });
  expect(contract).toBeDefined();

  const rulesByCheck = new Map(
    contract?.rules.map((rule) => [rule.checkId, rule.onMissing])
  );

  expect(rulesByCheck.get("docker_cli")).toBe("guide");
  expect(rulesByCheck.get("docker_daemon")).toBe("guide");
  expect(rulesByCheck.get("mux_backend")).toBe("warn");
});

test("runtime inventory diagnostics warn instead of intercepting Docker availability", () => {
  const [status] = getCommandPrerequisiteContracts({
    command: "status",
  });
  const [projects] = getCommandPrerequisiteContracts({
    command: "projects",
  });

  expect(status?.rules.every((rule) => rule.onMissing === "warn")).toBe(true);
  expect(projects?.rules.every((rule) => rule.onMissing === "warn")).toBe(true);
  expect(status?.rules.map((rule) => rule.checkId)).toEqual([
    "docker_cli",
    "docker_daemon",
  ]);
  expect(projects?.rules.map((rule) => rule.checkId)).toEqual([
    "docker_cli",
    "docker_daemon",
  ]);
});

test("compose-only operational commands guide Docker availability", () => {
  const [projectsPrune] = getCommandPrerequisiteContracts({
    command: "projects prune",
  });
  const [logsCompose] = getCommandPrerequisiteContracts({
    command: "logs --compose",
  });

  expect(projectsPrune?.rules.map((rule) => rule.checkId)).toEqual([
    "docker_cli",
    "docker_daemon",
  ]);
  expect(projectsPrune?.rules.map((rule) => rule.onMissing)).toEqual([
    "guide",
    "guide",
  ]);
  expect(logsCompose?.rules.map((rule) => rule.checkId)).toEqual([
    "docker_cli",
    "docker_daemon",
  ]);
  expect(logsCompose?.rules.map((rule) => rule.onMissing)).toEqual([
    "guide",
    "guide",
  ]);
});

test("session commands require tmux instead of only resolving a mux backend", () => {
  const [sessionStart] = getCommandPrerequisiteContracts({
    command: "session start",
  });

  expect(sessionStart?.rules.map((rule) => rule.checkId)).toEqual([
    "tmux_binary",
  ]);
});

test("there are no retired hosted flows left in local prerequisite handling", () => {
  expect(COMMANDS_WITH_LOCAL_PREREQUISITE_HANDLING).toEqual([]);
  expect(getLocalPrerequisiteHandling({ command: "x github connect" })).toBe(
    null
  );
  expect(getLocalPrerequisiteHandling({ command: "linear setup" })).toBe(null);
});

test("conditional overlays remain addressable through multi-contract lookup", () => {
  const upContracts = getCommandPrerequisiteContracts({ command: "up" });
  const restartContracts = getCommandPrerequisiteContracts({
    command: "restart",
  });

  expect(upContracts.length).toBe(2);
  expect(restartContracts.length).toBe(2);
  expect(
    upContracts.flatMap((contract) =>
      contract.rules.map((rule) => rule.checkId)
    )
  ).toEqual(["docker_cli", "docker_daemon", "mux_backend"]);
  expect(
    restartContracts.flatMap((contract) =>
      contract.rules.map((rule) => rule.checkId)
    )
  ).toEqual(["docker_cli", "docker_daemon", "mux_backend"]);
});
