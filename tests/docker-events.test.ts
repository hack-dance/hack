import { expect, test } from "bun:test";

import { shouldRefreshForDockerEvent } from "../src/daemon/docker-events.ts";

test("docker event filtering ignores actions that cannot change runtime state", () => {
  const ignoredActions = [
    "attach",
    "commit",
    "copy",
    "detach",
    "exec_create: /bin/sh -c curl --fail http://localhost/health",
    "exec_detach",
    "exec_die",
    "exec_start: /bin/sh -c curl --fail http://localhost/health",
    "export",
    "resize",
    "top",
  ];

  for (const Action of ignoredActions) {
    expect(shouldRefreshForDockerEvent({ event: { Action } })).toBe(false);
  }
});

test("docker event filtering refreshes for state changes and unknown actions", () => {
  const relevantActions = [
    "create",
    "destroy",
    "die",
    "health_status: unhealthy",
    "kill",
    "oom",
    "pause",
    "rename",
    "restart",
    "start",
    "stop",
    "unpause",
    "update",
    "future_docker_action",
  ];

  for (const Action of relevantActions) {
    expect(shouldRefreshForDockerEvent({ event: { Action } })).toBe(true);
  }
  expect(shouldRefreshForDockerEvent({ event: {} })).toBe(true);
  expect(shouldRefreshForDockerEvent({ event: { status: "exec_die" } })).toBe(
    false
  );
});
