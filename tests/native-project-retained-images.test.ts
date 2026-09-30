import { expect, test } from "bun:test";
import { selectNativeRetainedImages } from "../src/backends/native-project-retained-images.ts";

const saved = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
};
const image = `sha256:${"e".repeat(64)}`;
const originalSha256 = "f".repeat(64);
const options = {
  runtime: { binary: "/not-invoked", home: "/fixture" },
  projectRoot: "/fixture/project",
  originalSha256,
  restore: saved,
};
function observation() {
  return {
    journal_incomplete: false,
    receipt: {
      run: saved.run,
      owner: saved.owner,
      namespace: saved.namespace,
      plan_id: saved.planId,
      phase: "stopped-data-retained",
      normalized_input: {
        namespace: saved.namespace,
        original_compose_sha256: originalSha256,
        normalized_compose_sha256: "1".repeat(64),
      },
      resources: {
        "container:web": { kind: "container", key: "web", image },
        "volume:data": { kind: "volume", key: "data" },
      },
    },
    observations: {
      "container:web": { state: "absent" },
      "volume:data": { state: "present" },
    },
  };
}
test("unchanged retained input selects verified content IDs without resolving tags", async () => {
  const calls: string[][] = [];
  const selected = await selectNativeRetainedImages({
    ...options,
    invoke: async ({ args }) => {
      calls.push([...args]);
      return observation();
    },
  });
  expect([...selected]).toEqual([["web", image]]);
  expect(calls).toEqual([
    ["graph", "inspect", "--run-id", saved.run, "--json"],
  ]);
});
test("fresh input never observes retained state", async () => {
  expect(
    (
      await selectNativeRetainedImages({
        ...options,
        restore: undefined,
        invoke: async () => {
          throw new Error("unexpected access");
        },
      })
    ).size
  ).toBe(0);
});
test("edited original input and legacy absence keep ordinary resolution", async () => {
  expect(
    (
      await selectNativeRetainedImages({
        ...options,
        originalSha256: "2".repeat(64),
        invoke: async () => observation(),
      })
    ).size
  ).toBe(0);
  const { normalized_input: _normalized, ...legacy } = observation().receipt;
  expect(
    (
      await selectNativeRetainedImages({
        ...options,
        invoke: async () => ({ ...observation(), receipt: legacy }),
      })
    ).size
  ).toBe(0);
});
test("stale ownership and uncertain compute or data refuse image reuse", async () => {
  const baseline = observation();
  for (const changed of [
    { ...baseline, journal_incomplete: true },
    ...["run", "owner", "namespace", "plan_id", "phase"].map((key) => ({
      ...baseline,
      receipt: { ...baseline.receipt, [key]: "changed" },
    })),
    {
      ...baseline,
      observations: {
        ...baseline.observations,
        "container:web": { state: "running" },
      },
    },
    {
      ...baseline,
      observations: {
        ...baseline.observations,
        "volume:data": { state: "absent" },
      },
    },
  ]) {
    await expect(
      selectNativeRetainedImages({ ...options, invoke: async () => changed })
    ).rejects.toThrow("image selection changed");
  }
});
test("malformed provenance or image and mismatched resource keys refuse reuse", async () => {
  const baseline = observation();
  for (const field of [
    "namespace",
    "original_compose_sha256",
    "normalized_compose_sha256",
  ]) {
    await expect(
      selectNativeRetainedImages({
        ...options,
        invoke: async () => ({
          ...baseline,
          receipt: {
            ...baseline.receipt,
            normalized_input: {
              ...baseline.receipt.normalized_input,
              [field]: "invalid",
            },
          },
        }),
      })
    ).rejects.toThrow("provenance is invalid");
  }
  for (const resource of [
    { ...baseline.receipt.resources["container:web"], image: "redis:latest" },
    { ...baseline.receipt.resources["container:web"], key: "worker" },
  ]) {
    await expect(
      selectNativeRetainedImages({
        ...options,
        invoke: async () => ({
          ...baseline,
          receipt: {
            ...baseline.receipt,
            resources: {
              ...baseline.receipt.resources,
              "container:web": resource,
            },
          },
        }),
      })
    ).rejects.toThrow(
      resource.key === "web"
        ? "image identity is invalid"
        : "image selection changed"
    );
  }
});
