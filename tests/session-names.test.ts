import { expect, test } from "bun:test";

import {
  buildSessionName,
  getNextNumericSessionSuffix,
  parseSessionBase,
} from "../src/mux/session-names.ts";

test("buildSessionName joins base and suffix with double dash", () => {
  expect(buildSessionName({ base: "alpha", suffix: "agent-1" })).toBe(
    "alpha--agent-1"
  );
});

test("parseSessionBase strips double dash suffix", () => {
  expect(parseSessionBase({ name: "alpha--agent-1" })).toBe("alpha");
});

test("getNextNumericSessionSuffix skips existing double dash names", () => {
  expect(
    getNextNumericSessionSuffix({
      base: "alpha",
      sessions: [{ name: "alpha" }, { name: "alpha--2" }, { name: "alpha--3" }],
    })
  ).toBe(4);
});
