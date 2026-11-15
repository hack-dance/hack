import { expect, test } from "bun:test";
import { readContainerState } from "../src/lib/runtime-service-state.ts";

test("inspect state exposes exit codes only for terminated containers", () => {
  expect(
    readContainerState({
      Status: "running",
      ExitCode: 0,
      Health: { Status: "healthy" },
      StartedAt: "2026-01-01T00:00:00Z",
    })
  ).toEqual({
    state: "running",
    health: "healthy",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00Z",
  });
  expect(readContainerState({ Status: "exited", ExitCode: 2 })?.exitCode).toBe(
    2
  );
});

test("missing or invalid metadata stays unknown instead of successful or epoch-started", () => {
  expect(readContainerState(undefined)).toBeNull();
  expect(readContainerState({})).toBeNull();
  expect(
    readContainerState({
      Status: "exited",
      ExitCode: "0",
      StartedAt: "0001-01-01T00:00:00Z",
    })
  ).toEqual({ state: "exited", health: null, exitCode: null, startedAt: null });
  expect(
    readContainerState({
      Status: "exited",
      ExitCode: Number.NaN,
      StartedAt: "invalid",
    })?.exitCode
  ).toBeNull();
});
