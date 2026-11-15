import { expect, test } from "bun:test";
import {
  aggregateProjectState,
  earliestStart,
  observeService,
  type ServiceMemberEvidence,
} from "../src/lib/project-state.ts";

const running: ServiceMemberEvidence = {
  state: "running",
  health: null,
  exitCode: null,
  startedAt: null,
};
const exited = { ...running, state: "exited", exitCode: 0 };

test("an ordinary exit zero does not invent a completion role or readiness", () => {
  const service = observeService({
    name: "task",
    available: true,
    members: [exited],
    readiness: null,
  });
  expect(service.state).toBe("stopped");
  expect(service.ready).toBeNull();
  expect(service.completed).toBeNull();
  const job = observeService({
    name: "task",
    available: true,
    members: [exited],
    readiness: "completed",
  });
  expect(job.completed).toBe(true);
  expect(job.ready).toBe(true);
});

test("unavailable evidence cannot turn stale running or exited members into current state", () => {
  const service = observeService({
    name: "api",
    available: false,
    members: [running, exited],
    readiness: "completed",
  });
  expect(service.state).toBe("unknown");
  expect(service.ready).toBeNull();
  expect(service.completed).toBeNull();
  expect(service.exit_code).toBeNull();
});

test("readiness follows current health rather than a historical ready phase", () => {
  const healthy = observeService({
    name: "api",
    available: true,
    members: [{ ...running, health: "healthy" }],
    readiness: "healthy",
  });
  expect(healthy.ready).toBe(true);
  const unhealthy = observeService({
    name: "api",
    available: true,
    members: [{ ...running, health: "unhealthy" }],
    readiness: "healthy",
  });
  expect(unhealthy.ready).toBe(false);
  expect(unhealthy.state).toBe("degraded");
});

test("failure and partial replica sets never become all running or complete", () => {
  const failed = observeService({
    name: "task",
    available: true,
    members: [{ ...exited, exitCode: 2 }],
    readiness: "completed",
  });
  expect(failed.state).toBe("failed");
  expect(failed.completed).toBe(false);
  expect(
    observeService({
      name: "api",
      available: true,
      members: [running, exited],
      readiness: "started",
    }).state
  ).toBe("degraded");
  expect(aggregateProjectState(["running", "unknown"])).toBe("unknown");
  expect(aggregateProjectState([])).toBe("unknown");
});

test("start time uses only valid observed timestamps, never a zero date", () => {
  expect(earliestStart([null, "0001-01-01T00:00:00Z", "invalid"])).toBeNull();
  expect(earliestStart(["2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"])).toBe(
    "2026-01-01T00:00:00Z"
  );
});

test("missing exit or health evidence remains unknown even with a declared role", () => {
  expect(
    observeService({
      name: "task",
      available: true,
      members: [{ ...exited, exitCode: null }],
      readiness: "completed",
    }).completed
  ).toBeNull();
  expect(
    observeService({
      name: "api",
      available: true,
      members: [running],
      readiness: "healthy",
    }).ready
  ).toBeNull();
});
