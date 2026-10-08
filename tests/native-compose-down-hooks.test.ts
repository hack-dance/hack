import { expect, test } from "bun:test";
import { readNativeComposeDownHookBinding } from "../src/lib/native-compose-down-hooks.ts";
import type { NativeComposeGeneration } from "../src/lib/native-compose-generation.ts";

const generation: NativeComposeGeneration = {
  identity: {
    checkoutRoot: "/fixture",
    repositoryRoot: "/fixture",
    instance: null,
    instanceId: "a".repeat(64),
    composeProject: "hack-fixture",
    ownerToken: "b".repeat(32),
  },
  generationId: "c".repeat(32),
  composeFile: "/fixture/compose.json",
  profiles: ["dev"],
  inputRevision: "d".repeat(64),
};
const extension = "x-hack-native-down-hooks";
const binding = {
  version: 1 as const,
  inputRevision: generation.inputRevision,
  profiles: ["dev"],
  overlay: null,
};

test("down source binding preserves effective null and original automatic/explicit selection while matching immutable manifest", () => {
  expect(
    readNativeComposeDownHookBinding({ generation, document: {} })
  ).toBeNull();
  expect(
    readNativeComposeDownHookBinding({
      generation,
      document: { [extension]: binding },
    })
  ).toEqual(binding);
  const explicit = { ...binding, explicitOverlay: null };
  const result = readNativeComposeDownHookBinding({
    generation,
    document: { [extension]: explicit },
  });
  expect(result).toEqual(explicit);
  expect(Object.isFrozen(result)).toBe(true);
  expect(
    readNativeComposeDownHookBinding({
      generation,
      document: Object.create({ [extension]: binding }),
    })
  ).toBeNull();
});

test.each([
  { inputRevision: "e".repeat(64) },
  { profiles: [] },
  { profiles: ["dev", "dev"] },
  { overlay: undefined },
  { explicitOverlay: undefined },
  { explicitOverlay: 17 },
  { command: "private-command" },
  { version: 2 },
])("down binding refuses stale/malformed saved extension %j before acquisition", (change) => {
  expect(() =>
    readNativeComposeDownHookBinding({
      generation,
      document: { [extension]: { ...binding, ...change } },
    })
  ).toThrow("Values omitted");
});

test.each([
  "version",
  "inputRevision",
  "profiles",
  "overlay",
] as const)("down binding refuses an inherited required %s", (field) => {
  const own = { ...binding };
  Reflect.deleteProperty(own, field);
  const value = Object.assign(Object.create({ [field]: binding[field] }), own);
  expect(() =>
    readNativeComposeDownHookBinding({
      generation,
      document: { [extension]: value },
    })
  ).toThrow("Values omitted");
});
