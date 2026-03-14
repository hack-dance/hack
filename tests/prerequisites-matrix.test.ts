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

test("command coverage includes the major first-run and integration paths", () => {
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
    "x github status",
    "x github profiles",
    "x github use",
    "x github oauth-connect",
    "x github pr-upsert",
    "linear status",
    "linear profiles",
    "linear use",
    "linear connect",
    "linear oauth-connect",
    "linear connections",
    "linear seed-local-access",
    "linear deliveries",
    "linear apply-delivery",
    "linear subscriptions",
    "linear set-subscription",
    "linear remove-subscription",
    "linear projects",
    "linear sync-issue",
    "linear sync-project",
    "linear project-bind",
    "linear project-link",
    "linear run-autosync",
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

test("status-style auth commands warn instead of intercepting missing auth", () => {
  const [githubStatus] = getCommandPrerequisiteContracts({
    command: "x github status",
  });
  const [linearStatus] = getCommandPrerequisiteContracts({
    command: "linear status",
  });

  expect(githubStatus?.rules.every((rule) => rule.onMissing === "warn")).toBe(
    true
  );
  expect(linearStatus?.rules.every((rule) => rule.onMissing === "warn")).toBe(
    true
  );
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

test("x linear aliases resolve to the shared Linear prerequisite contracts", () => {
  const [linearStatus] = getCommandPrerequisiteContracts({
    command: "linear status",
  });
  const [xLinearStatus] = getCommandPrerequisiteContracts({
    command: "x linear status",
  });
  const [linearSyncIssue] = getCommandPrerequisiteContracts({
    command: "linear sync-issue",
  });
  const [xLinearSyncIssue] = getCommandPrerequisiteContracts({
    command: "x linear sync-issue",
  });

  expect(xLinearStatus).toEqual(linearStatus);
  expect(xLinearSyncIssue).toEqual(linearSyncIssue);
});

test("action commands escalate to guidance for missing integration auth", () => {
  const [githubAction] = getCommandPrerequisiteContracts({
    command: "x github pr-upsert",
  });
  const [linearAction] = getCommandPrerequisiteContracts({
    command: "linear sync-issue",
  });

  expect(githubAction?.rules.map((rule) => rule.onMissing)).toEqual([
    "guide",
    "guide",
  ]);
  expect(linearAction?.rules.map((rule) => rule.onMissing)).toEqual([
    "guide",
    "guide",
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

test("cleanup and local-config commands stay out of shared prerequisite interception", () => {
  expect(
    getCommandPrerequisiteContracts({ command: "x github disconnect" })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({ command: "linear disconnect" })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({ command: "linear assignee-mappings" })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({ command: "linear set-assignee-mapping" })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({
      command: "linear remove-assignee-mapping",
    })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({ command: "linear project-unlink" })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({ command: "x linear disconnect" })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({
      command: "x linear set-assignee-mapping",
    })
  ).toEqual([]);
  expect(
    getCommandPrerequisiteContracts({
      command: "x linear remove-assignee-mapping",
    })
  ).toEqual([]);
});

test("major setup commands can be explicitly excluded from shared interception", () => {
  expect(
    COMMANDS_WITH_LOCAL_PREREQUISITE_HANDLING.map((entry) => entry.command)
  ).toEqual([
    "x github connect",
    "linear setup",
    "x github disconnect",
    "linear disconnect",
    "linear assignee-mappings",
    "linear set-assignee-mapping",
    "linear remove-assignee-mapping",
    "linear project-unlink",
  ]);

  expect(
    getLocalPrerequisiteHandling({ command: "x github connect" })?.reason
  ).toContain("primary repair/bootstrap path");
  expect(
    getLocalPrerequisiteHandling({ command: "linear setup" })?.reason
  ).toContain("local project wiring command");
  expect(
    getLocalPrerequisiteHandling({ command: "x linear setup" })?.reason
  ).toContain("local project wiring command");
});

test("broker-backed linear commands guide through Hack auth", () => {
  const [connections] = getCommandPrerequisiteContracts({
    command: "linear connections",
  });
  const [deliveries] = getCommandPrerequisiteContracts({
    command: "linear deliveries",
  });

  expect(connections?.rules.map((rule) => rule.checkId)).toEqual([
    "linear_broker_auth",
  ]);
  expect(deliveries?.rules.map((rule) => rule.checkId)).toEqual([
    "linear_broker_auth",
  ]);
  expect(connections?.rules.map((rule) => rule.onMissing)).toEqual(["guide"]);
  expect(deliveries?.rules.map((rule) => rule.onMissing)).toEqual(["guide"]);
});

test("conditional linear project binding rules only apply to remote lookup paths", () => {
  const [projectBind] = getCommandPrerequisiteContracts({
    command: "linear project-bind",
  });
  const [projectLink] = getCommandPrerequisiteContracts({
    command: "linear project-link",
  });

  expect(projectBind?.rules.map((rule) => rule.checkId)).toEqual([
    "linear_profile",
    "linear_token",
  ]);
  expect(projectLink?.rules.map((rule) => rule.checkId)).toEqual([
    "linear_profile",
    "linear_token",
  ]);
  expect(projectBind?.rules.every((rule) => rule.when)).toBe(true);
  expect(projectLink?.rules.every((rule) => rule.when)).toBe(true);
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
