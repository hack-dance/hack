import { expect, test } from "bun:test";
import { composeServiceReadiness } from "../src/lib/compose-service-readiness.ts";

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
