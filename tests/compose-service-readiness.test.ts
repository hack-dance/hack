import { expect, test } from "bun:test";
import { composeServiceReadiness } from "../src/lib/compose-service-readiness.ts";
import { observeService } from "../src/lib/project-state.ts";

test("completion is declared by a dependency, never inferred from a stopped service", () => {
  expect(
    composeServiceReadiness({
      services: {
        api: {
          depends_on: {
            migrate: { condition: "service_completed_successfully" },
            db: { condition: "service_healthy" },
          },
        },
        migrate: {},
        db: {},
        idle: {},
        checked: { healthcheck: { test: ["CMD", "true"] } },
        disabled: { healthcheck: { disable: true } },
      },
    })
  ).toEqual({
    api: "started",
    migrate: "completed",
    db: "healthy",
    idle: "started",
    checked: "healthy",
    disabled: "started",
  });
  expect(composeServiceReadiness(null)).toEqual({});
});

test("NONE disables the health requirement while explicit dependency roles still apply", () => {
  const roles = composeServiceReadiness({
    services: {
      plain: { healthcheck: { test: ["NONE"] } },
      dependency: { healthcheck: { test: ["NONE"] } },
      consumer: {
        depends_on: { dependency: { condition: "service_healthy" } },
      },
    },
  });
  expect(roles.plain).toBe("started");
  expect(roles.dependency).toBe("healthy");
  expect(
    observeService({
      name: "plain",
      available: true,
      readiness: roles.plain ?? null,
      members: [
        { state: "running", health: null, exitCode: null, startedAt: null },
      ],
    }).ready
  ).toBe(true);
});
