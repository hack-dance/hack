import { expect, test } from "bun:test";
import {
  selectNativeActiveImages,
  selectNativeRetainedImages,
} from "../src/backends/native-project-retained-images.ts";
import { verifyNativeActiveReview } from "../src/backends/native-project-review.ts";

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

function activeObservation() {
  const baseline = observation();
  return {
    ...baseline,
    receipt: {
      ...baseline.receipt,
      phase: "ready-observed",
      resources: {
        ...baseline.receipt.resources,
        "container:web": {
          ...baseline.receipt.resources["container:web"],
          id: "2".repeat(64),
        },
      },
    },
    observations: {
      ...baseline.observations,
      // Native run-selection verifies completed initializers too.
      "container:web": { state: "completed" },
    },
  };
}
function activeSelection() {
  return {
    ok: true,
    run: saved.run,
    owner: saved.owner,
    namespace: saved.namespace,
    plan: saved.planId,
    service: "web",
    container: "2".repeat(64),
    boot: "owned-boot",
    generation: "3".repeat(64),
  };
}
test("active images use fresh native authority, including completed initializers", async () => {
  const calls: string[] = [];
  const invoke: NonNullable<
    Parameters<typeof selectNativeActiveImages>[0]["invoke"]
  > = async ({ args }) => {
    calls.push(args[1] ?? "unknown");
    return args[1] === "inspect" ? activeObservation() : activeSelection();
  };
  const selected = await selectNativeActiveImages({ ...options, invoke });
  expect([...selected.images]).toEqual([["web", image]]);
  await verifyNativeActiveReview({
    ...options,
    retained: saved,
    proof: selected.proof,
    invoke,
  });
  expect(calls).toEqual([
    "inspect",
    "run-selection",
    "inspect",
    "run-selection",
  ]);
});
test("active edited or legacy input receives no old image pins", async () => {
  const legacy = activeObservation();
  const { normalized_input: _normalized, ...receipt } = legacy.receipt;
  for (const selection of [
    { originalSha256: "4".repeat(64), observed: activeObservation() },
    { originalSha256, observed: { ...legacy, receipt } },
  ]) {
    const selected = await selectNativeActiveImages({
      ...options,
      originalSha256: selection.originalSha256,
      invoke: async ({ args }) =>
        args[1] === "inspect" ? selection.observed : activeSelection(),
    });
    expect(selected.images.size).toBe(0);
  }
});
test("active image reads refuse stale ownership, incomplete journals and malformed images", async () => {
  const baseline = activeObservation();
  const changes = [
    { ...baseline, journal_incomplete: true },
    ...["run", "owner", "namespace", "plan_id", "phase"].map((key) => ({
      ...baseline,
      receipt: { ...baseline.receipt, [key]: "changed" },
    })),
    {
      ...baseline,
      receipt: {
        ...baseline.receipt,
        normalized_input: {
          ...baseline.receipt.normalized_input,
          normalized_compose_sha256: "invalid",
        },
      },
    },
    {
      ...baseline,
      receipt: {
        ...baseline.receipt,
        resources: {
          ...baseline.receipt.resources,
          "container:web": {
            ...baseline.receipt.resources["container:web"],
            image: "web:latest",
          },
        },
      },
    },
    {
      ...baseline,
      receipt: {
        ...baseline.receipt,
        resources: {
          ...baseline.receipt.resources,
          "container:web": {
            ...baseline.receipt.resources["container:web"],
            key: "other",
          },
        },
      },
    },
  ];
  for (const changed of changes) {
    await expect(
      selectNativeActiveImages({
        ...options,
        invoke: async ({ args }) =>
          args[1] === "inspect" ? changed : activeSelection(),
      })
    ).rejects.toThrow();
  }
});
test("active native selection and a substituted fresh receipt cannot authenticate image reuse", async () => {
  for (const field of [
    "run",
    "owner",
    "namespace",
    "plan",
    "service",
    "container",
    "boot",
    "generation",
  ]) {
    await expect(
      selectNativeActiveImages({
        ...options,
        invoke: async ({ args }) =>
          args[1] === "inspect"
            ? activeObservation()
            : {
                ...activeSelection(),
                [field]: field === "boot" ? "invalid\n" : "invalid",
              },
      })
    ).rejects.toThrow();
  }
  let inspections = 0;
  await expect(
    selectNativeActiveImages({
      ...options,
      invoke: async ({ args }) => {
        if (args[1] !== "inspect") {
          return activeSelection();
        }
        inspections += 1;
        const baseline = activeObservation();
        return inspections === 1
          ? baseline
          : {
              ...baseline,
              receipt: {
                ...baseline.receipt,
                resources: {
                  ...baseline.receipt.resources,
                  "container:web": {
                    ...baseline.receipt.resources["container:web"],
                    id: "4".repeat(64),
                  },
                },
              },
            };
      },
    })
  ).rejects.toThrow("active image identity changed");
});
test("native generation, container and boot are rechecked after image selection", async () => {
  const selected = await selectNativeActiveImages({
    ...options,
    invoke: async ({ args }) =>
      args[1] === "inspect" ? activeObservation() : activeSelection(),
  });
  for (const field of ["generation", "container", "boot"]) {
    await expect(
      verifyNativeActiveReview({
        ...options,
        retained: saved,
        proof: selected.proof,
        invoke: async () => ({
          ...activeSelection(),
          [field]: field === "boot" ? "new-boot" : "4".repeat(64),
        }),
      })
    ).rejects.toThrow("active review identity changed");
  }
});
test("image drift between inspections refuses even when the mocked native proof is unchanged", async () => {
  let inspections = 0;
  await expect(
    selectNativeActiveImages({
      ...options,
      invoke: async ({ args }) => {
        if (args[1] !== "inspect") {
          return activeSelection();
        }
        inspections += 1;
        const baseline = activeObservation();
        return inspections === 1
          ? baseline
          : {
              ...baseline,
              receipt: {
                ...baseline.receipt,
                resources: {
                  ...baseline.receipt.resources,
                  "container:web": {
                    ...baseline.receipt.resources["container:web"],
                    image: `sha256:${"4".repeat(64)}`,
                  },
                },
              },
            };
      },
    })
  ).rejects.toThrow("active image selection changed");
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
