import { expect, test } from "bun:test";
import type { NativeComposeOwnershipOptions } from "../src/lib/native-compose-ownership.ts";
import { pinNativeComposeFixtureVolume } from "./e2e/native-compose-owned-fixture.ts";

const selection: NativeComposeOwnershipOptions = {
  composeProject: "hack-down-fixture",
  runtimeIdentity: "hack-down-fixture",
  ownerToken: "a".repeat(32),
  generationIds: ["b".repeat(32)],
  expectedServices: ["app"],
  expectedVolumes: [{ name: "fixture_data", storage: "data" }],
};
const volume = { name: "fixture_data", storage: "data" };
const inspected = {
  ...volume,
  createdAt: "2026-10-08T00:00:00Z",
  composeProject: selection.composeProject,
  runtimeIdentity: selection.runtimeIdentity,
  ownerToken: selection.ownerToken,
  version: "1",
};
const observed = { containers: [], networks: [], volumes: [volume] };

test("fixture cleanup pins singleton creation/storage/owner and observes a same-name replacement", async () => {
  const probe = async (args: readonly string[]) => {
    expect(args.slice(0, 4)).toEqual([
      "volume",
      "inspect",
      volume.name,
      "--format",
    ]);
    return JSON.stringify(inspected);
  };
  const original = await pinNativeComposeFixtureVolume({
    selection,
    observed,
    probe,
  });
  expect(original).toEqual({
    ...volume,
    createdAt: inspected.createdAt,
    composeProject: selection.composeProject,
    runtimeIdentity: selection.runtimeIdentity,
    ownerToken: selection.ownerToken,
  });
  expect(Object.isFrozen(original)).toBe(true);
  const replacement = await pinNativeComposeFixtureVolume({
    selection,
    observed,
    probe: async () =>
      JSON.stringify({ ...inspected, createdAt: "2026-10-08T01:00:00Z" }),
  });
  expect(JSON.stringify(replacement)).not.toBe(JSON.stringify(original));
});

test.each([
  { volumes: [] },
  { volumes: [volume, volume] },
  { volumes: [{ ...volume, storage: "rebound" }] },
])("fixture pin refuses missing/extra/rebound observed volumes before inspect: %j", async ({
  volumes,
}) => {
  let calls = 0;
  await expect(
    pinNativeComposeFixtureVolume({
      selection,
      observed: { ...observed, volumes },
      probe: async () => {
        calls += 1;
        return JSON.stringify(inspected);
      },
    })
  ).rejects.toThrow("original singleton");
  expect(calls).toBe(0);
});

test.each([
  { name: "rebound" },
  { storage: "rebound" },
  { createdAt: "" },
  { ownerToken: "c".repeat(32) },
  { runtimeIdentity: "rebound" },
  { composeProject: "rebound" },
  { version: "2" },
  { extra: true },
])("fixture pin refuses changed immediate engine identity: %j", async (change) => {
  await expect(
    pinNativeComposeFixtureVolume({
      selection,
      observed,
      probe: async () => JSON.stringify({ ...inspected, ...change }),
    })
  ).rejects.toThrow("identity changed");
});
