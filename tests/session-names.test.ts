import { expect, test } from "bun:test";

import {
  buildLegacySessionName,
  buildLifecycleSessionName,
  buildSessionName,
  getNextNumericSessionSuffix,
  parseSessionBase,
} from "../src/mux/session-names.ts";

test("buildSessionName uses double-dash suffixes", () => {
  expect(buildSessionName({ base: "my-project", suffix: "agent-1" })).toBe(
    "my-project--agent-1"
  );
});

test("buildLegacySessionName preserves colon-delimited names", () => {
  expect(
    buildLegacySessionName({ base: "my-project", suffix: "lifecycle" })
  ).toBe("my-project:lifecycle");
});

test("buildLifecycleSessionName uses double-dash lifecycle suffixes", () => {
  expect(
    buildLifecycleSessionName({ projectName: "my-project", branch: null })
  ).toBe("my-project--lifecycle");
  expect(
    buildLifecycleSessionName({
      projectName: "my-project",
      branch: "feature-login",
    })
  ).toBe("my-project--lifecycle-feature-login");
});

test("getNextNumericSessionSuffix skips existing double-dash sessions", () => {
  const suffix = getNextNumericSessionSuffix({
    base: "my-project",
    sessions: [{ name: "my-project" }, { name: "my-project--2" }],
  });

  expect(suffix).toBe(3);
});

test("parseSessionBase supports double-dash and legacy colon session names", () => {
  expect(parseSessionBase({ name: "my-project--agent-1" })).toBe("my-project");
  expect(parseSessionBase({ name: "my-project:agent-1" })).toBe("my-project");
});
