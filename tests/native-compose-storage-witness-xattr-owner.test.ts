import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NativeComposeGeneration,
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import {
  enrollNativeComposeStorageXattrWitness,
  type NativeComposeStorageWitnessEnrollment,
  prepareNativeComposeStorageXattrWitness,
  verifyNativeComposeStorageXattrWitness,
} from "../src/lib/native-compose-storage-witness.ts";
import {
  nativeComposeStorageWitnessReferenceValid,
  nativeComposeStorageWitnessStatesValid,
} from "../src/lib/native-compose-storage-witness-state.ts";
import {
  captureNativeComposeStorageXattrCarrier,
  type NativeComposeStorageXattrArtifact,
  type NativeComposeStorageXattrInvocation,
  type NativeComposeStorageXattrPorts,
  type NativeComposeStorageXattrTarget,
} from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";
import { encodeNativeComposeStorageXattrResponse } from "../src/lib/native-compose-storage-witness-xattr-codec.ts";
import { runNativeComposeStorageXattrHelper } from "../src/lib/native-compose-storage-witness-xattr-helper.ts";

const engineId = "d".repeat(64);
const volume = {
  name: "owned_data",
  storage: "data",
  createdAt: "2026-10-08T12:00:00Z",
};
const selection = { name: volume.name, storage: volume.storage };
const artifact: NativeComposeStorageXattrArtifact = {
  version: 1,
  imageId: `sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  bunVersion: "1.4.2",
  bunHash: "b".repeat(64),
  libcHash: "c".repeat(64),
  helperHash: "e".repeat(64),
  kernelAbi: 1,
};
const roots: string[] = [];
const stores: NativeComposeGenerationStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-xattr-owner-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(
    join(root, ".hack", "hack.project.json"),
    JSON.stringify({ schema_version: 1, name: "xattr" })
  );
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
  });
  stores.push(store);
  return store;
}
async function publish(mutation: NativeComposeMutation) {
  const reservation = mutation.reserveGeneration();
  const labels = {
    "io.hack.native-config.version": "1",
    "io.hack.native-config.instance": reservation.identity.composeProject,
    "io.hack.native-config.owner": reservation.identity.ownerToken,
  };
  return await mutation.publish({
    reservation,
    profiles: [],
    inputRevision: "a".repeat(64),
    assertFresh: async () => {},
    composeJson: JSON.stringify({
      name: reservation.identity.composeProject,
      services: {
        app: {
          image: "synthetic:1",
          labels: {
            ...labels,
            "io.hack.native-config.generation": reservation.generationId,
            "io.hack.native-config.workload": "service",
          },
        },
      },
      volumes: {
        data: {
          name: volume.name,
          labels: { ...labels, "io.hack.native-config.storage": "data" },
        },
      },
    }),
  });
}
function fake(store: NativeComposeGenerationStore) {
  const calls: string[] = [];
  const attributes = new Map<string, Uint8Array>();
  const state = {
    volume: null as typeof volume | null,
    root: { device: "1", inode: "42", uid: 0, gid: 0 },
    holders: [] as NativeComposeStorageXattrTarget["holders"],
    failure: null as
      | "provision"
      | "seed"
      | "verify"
      | "cleanup"
      | "artifact"
      | "pinned-root"
      | "scope"
      | "readonly"
      | "uid"
      | "replay"
      | null,
    generation: null as NativeComposeGeneration | null,
    afterInvoke: null as
      | ((input: NativeComposeStorageXattrInvocation) => void)
      | null,
  };
  let nextId = 1;
  const ports: NativeComposeStorageXattrPorts = {
    async inspect(selection) {
      calls.push("inspect");
      return {
        engineId,
        runtimeIdentity: store.identity.composeProject,
        ownerToken: store.identity.ownerToken,
        ...selection,
        volume: state.volume,
        mountpoint: state.volume
          ? `/var/lib/docker/volumes/${selection.name}/_data`
          : null,
        driver: state.volume ? "local" : null,
        options: state.volume ? {} : null,
        holders: state.holders,
      };
    },
    async provision() {
      calls.push("provision");
      const saved = await store.loadCurrent();
      expect(saved.storageWitnessesPending).toBe(true);
      expect(saved.storageWitnesses?.[0]).toMatchObject({
        state: "expected",
        carrier: "directory-xattr",
        artifact,
        originalVolume: null,
      });
      expect(saved.pending?.generationId).toBe(state.generation?.generationId);
      if (state.failure === "provision") {
        throw new Error("private create uncertainty");
      }
      state.volume = { ...volume };
    },
    async invoke(input: NativeComposeStorageXattrInvocation) {
      calls.push(input.request.operation);
      if (state.failure === input.request.operation) {
        throw new Error("private child uncertainty");
      }
      const selectedRoot =
        state.failure === "pinned-root" && input.request.operation === "verify"
          ? { ...state.root, inode: "41" }
          : state.root;
      const response = runNativeComposeStorageXattrHelper({
        request: input.request,
        kernel: {
          effectiveUid: () => input.uid,
          effectiveGid: () => input.gid,
          probeRoot: () => selectedRoot,
          openRoot: () => 42,
          statRoot: () => selectedRoot,
          createXattr: (_, name, bytes) => {
            if (input.readonly || attributes.has(name)) {
              throw new Error("EEXIST/EROFS");
            }
            attributes.set(name, new Uint8Array(bytes));
          },
          syncRoot: () => {},
          readXattr: (_, name) => attributes.get(name) ?? new Uint8Array(),
          closeRoot: () => {},
        },
      });
      const carrierId = (state.failure === "replay" ? 1 : nextId++)
        .toString(16)
        .padStart(64, "0");
      state.afterInvoke?.(input);
      return {
        artifact:
          state.failure === "artifact"
            ? { ...artifact, helperHash: "f".repeat(64) }
            : input.artifact,
        carrierId,
        engineId,
        invocationId: input.invocationId,
        readonly:
          state.failure === "readonly" ? !input.readonly : input.readonly,
        uid: state.failure === "uid" ? input.uid + 1 : input.uid,
        gid: input.gid,
        target: input.target,
        scope:
          state.failure === "scope"
            ? { ...input.scope, pendingToken: "f".repeat(32) }
            : input.scope,
        response: encodeNativeComposeStorageXattrResponse(response),
        outcome: "complete",
        exitCode: response.outcome === "refused" ? 1 : 0,
        stopped: { id: carrierId, running: false, pid: 0, exitCode: 0 },
        containersAfterCleanup: state.failure === "cleanup" ? [carrierId] : [],
      };
    },
  };
  const controller = new AbortController();
  const carrier = captureNativeComposeStorageXattrCarrier({
    artifact,
    ports,
    signal: controller.signal,
    deadline: Date.now() + 60_000,
  });
  return { state, ports, carrier, calls, attributes, controller };
}
async function active() {
  const store = await fixture();
  const transport = fake(store);
  const { generation, reference } = await store.withMutation(
    async (mutation) => {
      const published = await publish(mutation);
      transport.state.generation = published;
      const result = await mutation.runEffect({
        generation: published,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => {
          const enrollment = await prepareNativeComposeStorageXattrWitness({
            authority: mutation.materialAuthority,
            generation: published,
            engineId,
            volume: selection,
            admission: "initial-create",
            assertAdmission: async () => {},
            carrier: transport.carrier,
          });
          const enrolled = await enrollNativeComposeStorageXattrWitness({
            enrollment,
          });
          transport.calls.push("workload");
          return { value: enrolled, outcome: "complete" };
        },
      });
      expect(result.outcome).toBe("complete");
      return { generation: published, reference: result.value };
    }
  );
  return { store, transport, generation, reference };
}

test("durable tagged Expected precedes one cold provision/seed and fresh proof before workload", async () => {
  const { store, transport, reference } = await active();
  expect(reference).toMatchObject({
    version: 2,
    kind: "directory-xattr",
    artifact,
    volume,
  });
  expect(transport.calls.filter((call) => call === "provision")).toHaveLength(
    1
  );
  expect(transport.calls.filter((call) => call === "seed")).toHaveLength(1);
  expect(transport.calls.indexOf("provision")).toBeLessThan(
    transport.calls.indexOf("seed")
  );
  expect(transport.calls.indexOf("seed")).toBeLessThan(
    transport.calls.indexOf("verify")
  );
  expect(transport.calls.indexOf("verify")).toBeLessThan(
    transport.calls.indexOf("workload")
  );
  expect((await store.loadCurrent()).storageWitnesses?.[0]?.state).toBe(
    "enrolled"
  );
  expect((await store.loadCurrent()).pending).toBeNull();
  expect(JSON.stringify(await store.loadCurrent())).not.toContain(
    "user.hack.storage."
  );
});

test("required xattr artifact/kind cannot be removed or relabeled as a legacy USTAR reference", async () => {
  const { store, reference } = await active();
  expect(nativeComposeStorageWitnessReferenceValid(reference)).toBe(true);
  if (reference.version !== 2) {
    throw new Error("Missing xattr reference");
  }
  const { artifact: ignoredArtifact, ...missingArtifact } = reference;
  expect(nativeComposeStorageWitnessReferenceValid(missingArtifact)).toBe(
    false
  );
  expect(
    nativeComposeStorageWitnessReferenceValid({
      ...reference,
      kind: "file-ustar",
    })
  ).toBe(false);
  expect(
    nativeComposeStorageWitnessReferenceValid({ ...reference, version: 1 })
  ).toBe(false);
  const states = (await store.loadCurrent()).storageWitnesses;
  expect(nativeComposeStorageWitnessStatesValid(states)).toBe(true);
  const tagged = states?.[0];
  if (!tagged || tagged.carrier !== "directory-xattr") {
    throw new Error("Missing tagged state");
  }
  const {
    carrier: ignoredCarrier,
    artifact: ignoredPins,
    ...downgraded
  } = tagged;
  expect(nativeComposeStorageWitnessStatesValid([downgraded])).toBe(false);
  expect(
    nativeComposeStorageWitnessStatesValid([
      { ...tagged, artifact: { ...artifact, kernelAbi: 2 } },
    ])
  ).toBe(false);
  // Keep the destructuring intentional: these fields are the adversarial deletion.
  expect(ignoredArtifact).toEqual(artifact);
  expect(ignoredCarrier).toBe("directory-xattr");
  expect(ignoredPins).toEqual(artifact);
});

test.each([
  "missing",
  "birth",
  "same-birth-empty",
  "pinned-root",
  "artifact",
  "scope",
  "cleanup",
  "readonly",
  "uid",
  "replay",
] as const)("resume refuses %s before workload and never provisions/seeds", async (change) => {
  const { store, transport, generation } = await active();
  transport.calls.length = 0;
  if (change === "missing") {
    transport.state.volume = null;
  } else if (change === "birth") {
    transport.state.volume = { ...volume, createdAt: "2026-10-08T12:00:01Z" };
  } else if (change === "same-birth-empty") {
    transport.attributes.clear();
  } else {
    transport.state.failure = change;
  }
  let workloads = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        effect: async () => {
          workloads++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toThrow("values omitted");
  });
  expect(workloads).toBe(0);
  expect(transport.calls).not.toContain("provision");
  expect(transport.calls).not.toContain("seed");
  expect((await store.loadCurrent()).storageWitnesses?.[0]?.state).toBe(
    "enrolled"
  );
});

test("fresh readonly proofs tolerate observed UID change and exact owned running holders through run and final fences", async () => {
  const { store, transport, generation, reference } = await active();
  transport.state.root.uid = 70;
  transport.state.root.gid = 70;
  transport.state.holders = [
    {
      id: "f".repeat(64),
      runtimeIdentity: store.identity.composeProject,
      ownerToken: store.identity.ownerToken,
      generationId: generation.generationId,
      running: true,
    },
  ];
  transport.calls.length = 0;
  await store.withMutation(async (mutation) => {
    await verifyNativeComposeStorageXattrWitness({
      authority: mutation.materialAuthority,
      generation,
      engineId,
      reference,
      carrier: transport.carrier,
    });
    await mutation.runEffect({
      generation,
      operation: "run",
      assertOwned: async () => {},
      assertFresh: async () => {},
      storageWitnesses: {
        kind: "directory-xattr",
        engineId,
        carrier: transport.carrier,
      },
      beforeComplete: async () => {
        transport.calls.push("finalizer");
      },
      effect: async () => {
        transport.calls.push("workload");
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(
    transport.calls.filter((call) => call === "verify").length
  ).toBeGreaterThanOrEqual(4);
  expect(transport.calls.indexOf("verify")).toBeLessThan(
    transport.calls.indexOf("workload")
  );
  expect(transport.calls.lastIndexOf("verify")).toBeGreaterThan(
    transport.calls.indexOf("finalizer")
  );
  expect(transport.calls).not.toContain("provision");
  expect(transport.calls).not.toContain("seed");
});

test.each([
  "provision",
  "seed",
  "verify",
  "cleanup",
] as const)("cold %s uncertainty retains required Expected; saved stop never reenrolls", async (failure) => {
  const store = await fixture();
  const transport = fake(store);
  transport.state.failure = failure;
  let enrollment: NativeComposeStorageWitnessEnrollment | null = null;
  const generation = await store.withMutation(async (mutation) => {
    const published = await publish(mutation);
    transport.state.generation = published;
    await expect(
      mutation.runEffect({
        generation: published,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => {
          enrollment = await prepareNativeComposeStorageXattrWitness({
            authority: mutation.materialAuthority,
            generation: published,
            engineId,
            volume: selection,
            admission: "initial-create",
            assertAdmission: async () => {},
            carrier: transport.carrier,
          });
          await enrollNativeComposeStorageXattrWitness({ enrollment });
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    return published;
  });
  expect((await store.loadCurrent()).storageWitnesses?.[0]).toMatchObject({
    state: "expected",
    carrier: "directory-xattr",
    artifact,
  });
  const attempts = transport.calls.filter(
    (call) => call === "seed" || call === "provision"
  );
  await expect(
    enrollNativeComposeStorageXattrWitness({ enrollment: enrollment ?? {} })
  ).rejects.toThrow("values omitted");
  await store.withMutation(async (mutation) => {
    expect(
      await mutation.runEffect({
        generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => ({ value: 0, outcome: "complete" }),
        beforeComplete: async () => {
          throw new Error("Must not retire");
        },
      })
    ).toEqual({ value: 0, outcome: "uncertain" });
  });
  expect(
    transport.calls.filter((call) => call === "seed" || call === "provision")
  ).toEqual(attempts);
  expect((await store.loadCurrent()).storageWitnessesPending).toBe(true);
  expect((await store.loadCurrent()).pending?.generationId).toBe(
    generation.generationId
  );
});

test("post-workload marker loss refuses completion, retaining exact pending generation", async () => {
  const { store, transport, generation } = await active();
  transport.calls.length = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        effect: async () => {
          transport.calls.push("workload");
          transport.attributes.clear();
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(transport.calls).toContain("workload");
  expect((await store.loadCurrent()).pending?.generationId).toBe(
    generation.generationId
  );
  expect((await store.loadCurrent()).storageWitnesses?.[0]?.state).toBe(
    "enrolled"
  );
  expect(transport.calls).not.toContain("seed");
});

test("same-birth root replacement while awaiting the final reader cannot publish ready from its pinned old directory", async () => {
  const { store, transport, generation } = await active();
  let exchanged = false;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        beforeComplete: async () => {
          transport.state.afterInvoke = (input) => {
            if (!exchanged && input.request.operation === "verify") {
              exchanged = true;
              transport.state.root = { ...transport.state.root, inode: "43" };
              transport.attributes.clear();
            }
          };
        },
        effect: async () => ({ value: 0, outcome: "complete" }),
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(exchanged).toBe(true);
  expect(transport.state.volume).toEqual(volume);
  expect((await store.loadCurrent()).pending?.generationId).toBe(
    generation.generationId
  );
  expect((await store.loadCurrent()).storageWitnesses?.[0]?.state).toBe(
    "enrolled"
  );
});

test("captured artifacts/ports cannot be substituted and cancelled lifetime stops before engine callbacks", async () => {
  const store = await fixture();
  const transport = fake(store);
  const originalInspect = transport.ports.inspect;
  let substituted = 0;
  const mutable = {
    artifact: { ...artifact },
    ports: { ...transport.ports },
    signal: transport.controller.signal,
    deadline: Date.now() + 60_000,
  };
  const carrier = captureNativeComposeStorageXattrCarrier(mutable);
  mutable.artifact.helperHash = "f".repeat(64);
  mutable.ports.inspect = async () => {
    substituted++;
    return null;
  };
  mutable.ports.invoke = async () => {
    substituted++;
    return null;
  };
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    transport.state.generation = generation;
    await mutation.runEffect({
      generation,
      operation: "up",
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => {
        const enrollment = await prepareNativeComposeStorageXattrWitness({
          authority: mutation.materialAuthority,
          generation,
          engineId,
          volume: selection,
          admission: "initial-create",
          assertAdmission: async () => {},
          carrier,
        });
        await enrollNativeComposeStorageXattrWitness({ enrollment });
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(substituted).toBe(0);
  expect(transport.ports.inspect).toBe(originalInspect);
  transport.controller.abort();
  transport.calls.length = 0;
  const current = await store.loadCurrent();
  const generation = current.generation;
  if (!generation) {
    throw new Error("Missing generation");
  }
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        storageWitnesses: { kind: "directory-xattr", engineId, carrier },
        effect: async () => ({ value: 0, outcome: "complete" }),
      })
    ).rejects.toThrow("values omitted");
  });
  expect(transport.calls).toEqual([]);
});

test("prepare captures original carrier, selection and admission callback before its first await", async () => {
  const store = await fixture();
  const transport = fake(store);
  let substituted = 0;
  const poison = captureNativeComposeStorageXattrCarrier({
    artifact,
    signal: transport.controller.signal,
    deadline: Date.now() + 60_000,
    ports: {
      inspect: async () => {
        substituted++;
        return null;
      },
      invoke: async () => {
        substituted++;
        return null;
      },
    },
  });
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    transport.state.generation = generation;
    await mutation.runEffect({
      generation,
      operation: "up",
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => {
        const input = {
          authority: mutation.materialAuthority,
          generation,
          engineId,
          volume: { ...selection },
          admission: "initial-create" as const,
          carrier: transport.carrier,
          assertAdmission: async () => {
            input.carrier = poison;
            input.engineId = "wrong-engine";
            input.volume.name = "wrong_name";
            input.assertAdmission = async () => {
              substituted++;
            };
          },
        };
        const enrollment = await prepareNativeComposeStorageXattrWitness(input);
        await enrollNativeComposeStorageXattrWitness({ enrollment });
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(substituted).toBe(0);
  expect((await store.loadCurrent()).storageWitnesses?.[0]).toMatchObject({
    name: volume.name,
    engineId,
    state: "enrolled",
    carrier: "directory-xattr",
  });
});

test("explicit stopped adoption pins the original birth and seeds once without cold provisioning", async () => {
  const store = await fixture();
  const transport = fake(store);
  transport.state.volume = { ...volume };
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    transport.state.generation = generation;
    await mutation.runEffect({
      generation,
      operation: "up",
      assertOwned: async () => {},
      assertFresh: async () => {},
      effect: async () => {
        const enrollment = await prepareNativeComposeStorageXattrWitness({
          authority: mutation.materialAuthority,
          generation,
          engineId,
          volume: selection,
          admission: "explicit-adoption",
          originalVolume: volume,
          assertAdmission: async () => {},
          carrier: transport.carrier,
        });
        await enrollNativeComposeStorageXattrWitness({ enrollment });
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(transport.calls).not.toContain("provision");
  expect(transport.calls.filter((call) => call === "seed")).toHaveLength(1);
  expect((await store.loadCurrent()).storageWitnesses?.[0]).toMatchObject({
    admission: "explicit-adoption",
    originalVolume: volume,
    state: "enrolled",
  });
});

test("initial admission refuses a preexisting volume before required intent, provisioning or seed", async () => {
  const store = await fixture();
  const transport = fake(store);
  transport.state.volume = { ...volume };
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    transport.state.generation = generation;
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        effect: async () => {
          await prepareNativeComposeStorageXattrWitness({
            authority: mutation.materialAuthority,
            generation,
            engineId,
            volume: selection,
            admission: "initial-create",
            assertAdmission: async () => {},
            carrier: transport.carrier,
          });
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
  });
  expect(transport.calls).toEqual(["inspect"]);
  expect((await store.loadCurrent()).storageWitnesses).toBeNull();
});

test.each([
  "generation",
  "owner",
  "runtime",
] as const)("readonly admission refuses a foreign %s holder before helper or workload", async (change) => {
  const { store, transport, generation } = await active();
  const holder = {
    id: "f".repeat(64),
    runtimeIdentity: store.identity.composeProject,
    ownerToken: store.identity.ownerToken,
    generationId: generation.generationId,
    running: true,
  };
  if (change === "generation") {
    holder.generationId = "f".repeat(32);
  }
  if (change === "owner") {
    holder.ownerToken = "f".repeat(32);
  }
  if (change === "runtime") {
    holder.runtimeIdentity = "foreign";
  }
  transport.state.holders = [holder];
  transport.calls.length = 0;
  let workloads = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertOwned: async () => {},
        assertFresh: async () => {},
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        effect: async () => {
          workloads++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toThrow("values omitted");
  });
  expect(workloads).toBe(0);
  expect(transport.calls).toEqual(["inspect"]);
});

test("cancellation during readonly carrier await refuses before workload without seed or repair", async () => {
  const { store, transport, generation } = await active();
  transport.calls.length = 0;
  transport.state.afterInvoke = (input) => {
    if (input.request.operation === "verify") {
      transport.controller.abort();
    }
  };
  let workloads = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "run",
        assertOwned: async () => {},
        assertFresh: async () => {},
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        effect: async () => {
          workloads++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toThrow("values omitted");
  });
  expect(workloads).toBe(0);
  expect(transport.calls.filter((call) => call === "verify")).toHaveLength(1);
  expect(transport.calls).not.toContain("seed");
  expect(transport.calls).not.toContain("provision");
});
