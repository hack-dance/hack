import { expect, test } from "bun:test";

import {
  buildStartupIncompleteMessage,
  classifyComposeStartupState,
} from "../src/lib/compose-startup-state.ts";

test("startup accepts running services and successful one-shot services", () => {
  expect(
    classifyComposeStartupState(
      [
        { service: "api", state: "running", exitCode: 0 },
        { service: "migrate", state: "exited", exitCode: 0 },
      ],
      {
        successfulCompletionServices: new Set(["migrate"]),
      }
    )
  ).toEqual({
    running: ["api"],
    completed: ["migrate"],
    failed: [],
  });
});

test("startup rejects an unmarked long-running service that exited zero", () => {
  expect(
    classifyComposeStartupState([
      { service: "api", state: "exited", exitCode: 0 },
    ])
  ).toEqual({ running: [], completed: [], failed: ["api"] });
});

test("startup rejects containers left created even when compose returned success", () => {
  expect(
    classifyComposeStartupState([
      { service: "api", state: "created", exitCode: 0 },
      { service: "worker", state: "created", exitCode: null },
    ])
  ).toEqual({
    running: [],
    completed: [],
    failed: ["api", "worker"],
  });
});

test("startup rejects non-zero exits and unstable runtime states", () => {
  expect(
    classifyComposeStartupState([
      { service: "api", state: "exited", exitCode: 1 },
      { service: "worker", state: "restarting", exitCode: null },
      { service: "cache", state: "dead", exitCode: null },
    ])
  ).toEqual({
    running: [],
    completed: [],
    failed: ["api", "worker", "cache"],
  });
});

test("an empty post-start snapshot is incomplete", () => {
  expect(
    buildStartupIncompleteMessage({ composeProject: "demo", failed: [] })
  ).toBe(
    "Startup incomplete for demo: Compose reported no services after startup"
  );
});
