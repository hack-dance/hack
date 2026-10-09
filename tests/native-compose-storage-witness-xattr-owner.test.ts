import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeEffectOwned,
  runOneOff,
} from "../src/lib/native-compose-command.ts";
import {
  nativeComposeDocumentStorage,
  prepareNativeComposeCommandStorage,
  runNativeComposeStorageVerifiedExec,
} from "../src/lib/native-compose-command-storage.ts";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGeneration,
  NativeComposeGenerationError,
  type NativeComposeGenerationStore,
  type NativeComposeMutation,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import * as carrierJournal from "../src/lib/native-compose-storage-carrier-journal.ts";
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
const witnessRefusal =
  "Native storage witness is missing, unsafe or changed; values omitted. No storage repair was attempted.";
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
async function publish(
  mutation: NativeComposeMutation,
  options: { readonly build?: boolean } = {}
) {
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
          ...(options.build ? { build: { context: "." } } : {}),
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
      | "no-created"
      | "changed-created"
      | "created-uncertain"
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
      const carrierId = (state.failure === "replay" ? 1 : nextId++)
        .toString(16)
        .padStart(64, "0");
      expect((await store.loadCurrent()).storageWitnessesPending).toBe(true);
      if (state.failure !== "no-created") {
        await input.recordCreated({
          id: carrierId,
          createdAt: volume.createdAt,
        });
      }
      if (state.failure === "created-uncertain") {
        throw new Error(
          "private start uncertainty after exact create publication"
        );
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
      state.afterInvoke?.(input);
      return {
        artifact:
          state.failure === "artifact"
            ? { ...artifact, helperHash: "f".repeat(64) }
            : input.artifact,
        carrierId,
        carrierCreatedAt:
          state.failure === "changed-created"
            ? "2026-10-08T12:01:00Z"
            : volume.createdAt,
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
        stopped: {
          id: carrierId,
          running: false,
          pid: 0,
          exitCode: response.outcome === "refused" ? 1 : 0,
        },
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

function commandPorts(transport: ReturnType<typeof fake>) {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      engine: async (opts: { readonly expected?: string } = {}) => {
        calls.push("engine");
        expect(opts.expected === undefined || opts.expected === engineId).toBe(
          true
        );
        return engineId;
      },
      carrier: async (opts: {
        readonly signal: AbortSignal;
        readonly deadline: number;
      }) => {
        calls.push("prerequisite");
        return captureNativeComposeStorageXattrCarrier({
          artifact,
          ports: transport.ports,
          signal: opts.signal,
          deadline: opts.deadline,
        });
      },
      volumeNames: async () => {
        calls.push("inventory");
        return transport.state.volume ? [transport.state.volume.name] : [];
      },
    },
  };
}

async function rememberedActive() {
  const selected = await active();
  const { store, generation, transport } = selected;
  await store.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation,
      operation: "run",
      assertOwned: async () => {},
      assertFresh: async () => {},
      captureStorage: () => [volume],
      storageWitnesses: {
        kind: "directory-xattr",
        engineId,
        carrier: transport.carrier,
      },
      effect: async () => ({ value: 0, outcome: "complete" }),
    });
  });
  transport.calls.length = 0;
  return selected;
}

function helperOperations(transport: ReturnType<typeof fake>) {
  return transport.calls.filter((call) => call === "root" || call === "verify");
}

test.each([
  "up",
  "restart",
] as const)("warm no-op %s keeps opening, two closing and all later witness proofs", async (operation) => {
  const { store, transport } = await rememberedActive();
  const command = commandPorts(transport);
  let finalizers = 0;
  await store.withMutation(async (mutation) => {
    const storage = await prepareNativeComposeCommandStorage({
      store,
      mutation,
      operation,
      selected: [selection],
      signal: transport.controller.signal,
      ports: command.ports,
    });
    if (!storage) {
      throw new Error("Expected retained storage");
    }
    expect(helperOperations(transport)).toEqual(["root", "verify", "root"]);
    const generation = await publish(mutation);
    transport.state.generation = generation;
    const document = await store.readGenerationDocument(generation);
    let owned = 0;
    const result = await mutation.runEffect({
      generation,
      operation,
      assertFresh: async () => {},
      assertOwned: async () => {
        owned++;
      },
      captureStorage: () => [volume],
      storageWitnesses: storage.effectWitnesses,
      beforeComplete: async () => {
        finalizers++;
        expect(
          transport.calls.filter((call) => call === "verify")
        ).toHaveLength(6);
      },
      effect: async () => {
        expect(owned).toBe(2);
        expect(helperOperations(transport)).toEqual(
          Array.from(
            { length: 3 },
            () => ["root", "verify", "root"] as const
          ).flat()
        );
        expect((await store.loadCurrent()).pending?.generationId).toBe(
          generation.generationId
        );
        await storage.enroll(generation, document);
        await storage.verify(generation);
        transport.calls.push("workload");
        return { value: 0, outcome: "complete" };
      },
    });
    expect(result).toEqual({ value: 0, outcome: "complete" });
  });
  expect(finalizers).toBe(1);
  expect(transport.calls.filter((call) => call === "verify")).toHaveLength(7);
  expect(transport.calls).not.toContain("seed");
  expect(transport.calls).not.toContain("provision");
  expect((await store.loadCurrent()).pending).toBeNull();
}, 30_000);

test.each(
  (["prepublication", "effect-entry"] as const).flatMap((phase) =>
    (["ownership", "source-await"] as const).map((boundary) => ({
      phase,
      boundary,
    }))
  )
)("warm proof refuses xattr drift at $phase $boundary before further publication/effect", async ({
  phase,
  boundary,
}) => {
  const { store, generation, transport } = await rememberedActive();
  let owned = 0;
  let armed = false;
  let changed = false;
  let effects = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        captureStorage: () => [volume],
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        assertOwned: async () => {
          owned++;
          if (owned === (phase === "prepublication" ? 1 : 2)) {
            armed = true;
            if (boundary === "ownership") {
              transport.attributes.clear();
              changed = true;
            }
          }
        },
        assertFresh: async () => {
          if (armed && !changed && boundary === "source-await") {
            await Promise.resolve();
            transport.attributes.clear();
            changed = true;
          }
        },
        effect: async () => {
          effects++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject(
      phase === "prepublication"
        ? { message: witnessRefusal }
        : { code: "E_NATIVE_COMPOSE_UNCERTAIN" }
    );
  });
  expect(changed).toBe(true);
  expect(effects).toBe(0);
  expect((await store.loadCurrent()).pending === null).toBe(
    phase === "prepublication"
  );
  expect(transport.calls).not.toContain("seed");
}, 30_000);

test("warm closing proof observes xattr drift during the preceding receipt await", async () => {
  const { store, generation, transport } = await rememberedActive();
  const receiptPath = join(
    store.identity.checkoutRoot,
    ".hack",
    ".internal",
    "native-compose",
    store.identity.instanceId,
    "receipt.json"
  );
  const originalOpen = fs.open;
  let armed = false;
  let changed = false;
  let effects = 0;
  const reading = spyOn(fs, "open").mockImplementation(
    async (path, flags, mode) => {
      if (armed && !changed && String(path) === receiptPath) {
        await Promise.resolve();
        transport.attributes.clear();
        changed = true;
      }
      return await originalOpen(path, flags, mode);
    }
  );
  try {
    await store.withMutation(async (mutation) => {
      await expect(
        mutation.runEffect({
          generation,
          operation: "up",
          captureStorage: () => [volume],
          storageWitnesses: {
            kind: "directory-xattr",
            engineId,
            carrier: transport.carrier,
          },
          assertFresh: async () => {},
          assertOwned: async () => {
            armed = true;
          },
          effect: async () => {
            effects++;
            return { value: 0, outcome: "complete" };
          },
        })
      ).rejects.toMatchObject({ message: witnessRefusal });
    });
  } finally {
    reading.mockRestore();
  }
  expect(changed).toBe(true);
  expect(effects).toBe(0);
  expect((await store.loadCurrent()).pending).toBeNull();
}, 30_000);

test.each([
  "incarnation",
  "reference",
  "source",
] as const)("closing witness proof cannot cover a later changed %s fence", async (change) => {
  const { store, generation, transport, reference } = await rememberedActive();
  const path = join(
    store.identity.checkoutRoot,
    ".hack",
    ".internal",
    "native-compose",
    store.identity.instanceId,
    "receipt.json"
  );
  let changed = false;
  let effects = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        captureStorage: () => [volume],
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        assertOwned: async () => {},
        assertFresh: async () => {
          if (!changed && transport.calls.includes("verify")) {
            changed = true;
            if (change === "source") {
              throw new Error("synthetic source replacement");
            }
            // Adversarial substitution in this owned synthetic store only.
            const bytes = await readFile(path, "utf8");
            const replacement =
              change === "incarnation"
                ? bytes
                : bytes.replace(
                    JSON.stringify(reference.completion),
                    JSON.stringify({
                      ...reference.completion,
                      hash: "f".repeat(64),
                    })
                  );
            expect(replacement === bytes).toBe(change === "incarnation");
            await writeFile(`${path}.substitution`, replacement, {
              mode: 0o600,
              flag: "wx",
            });
            await rename(`${path}.substitution`, path);
          }
        },
        effect: async () => {
          effects++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({
      code:
        change === "source"
          ? "E_NATIVE_COMPOSE_STALE"
          : "E_NATIVE_COMPOSE_STATE",
    });
  });
  expect(changed).toBe(true);
  expect(effects).toBe(0);
  expect(transport.calls.filter((call) => call === "verify")).toHaveLength(1);
}, 30_000);

test("a newly observed retained birth uses the original leading proof and writing path", async () => {
  const { store, generation, transport } = await active();
  const newlyObserved = {
    ...volume,
    name: "owned_archive",
    storage: "archive",
  };
  const observed = [newlyObserved, volume];
  expect((await store.loadCurrent()).retainedStorage).toEqual([volume]);
  transport.calls.length = 0;
  let owned = 0;
  await store.withMutation(async (mutation) => {
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {
        owned++;
        if (owned <= 2) {
          expect((await store.loadCurrent()).retainedStorage).toEqual([volume]);
          expect(
            transport.calls.filter((call) => call === "verify")
          ).toHaveLength(owned - 1);
        }
      },
      captureStorage: () => observed,
      storageWitnesses: {
        kind: "directory-xattr",
        engineId,
        carrier: transport.carrier,
      },
      effect: async () => {
        expect(owned).toBe(3);
        expect((await store.loadCurrent()).retainedStorage).toEqual(observed);
        expect(
          transport.calls.filter((call) => call === "verify")
        ).toHaveLength(3);
        return { value: 0, outcome: "complete" };
      },
    });
  });
  expect(transport.calls).not.toContain("seed");
}, 30_000);

test.each([
  "run",
  "build",
  "after-hook",
] as const)("warm %s stays on both original leading/closing phase proofs", async (excluded) => {
  const {
    store,
    transport,
    generation: currentGeneration,
  } = await rememberedActive();
  await store.withMutation(async (mutation) => {
    const generation =
      excluded === "run"
        ? currentGeneration
        : await publish(mutation, { build: excluded === "build" });
    transport.state.generation = generation;
    await mutation.runEffect({
      generation,
      operation: excluded === "run" ? "run" : "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      captureStorage: () => [volume],
      storageWitnesses: {
        kind: "directory-xattr",
        engineId,
        carrier: transport.carrier,
      },
      ...(excluded === "after-hook"
        ? {
            afterHooks: {
              prepare: async () => async () => ({
                value: 0,
                outcome: "complete" as const,
                ready: true,
              }),
            },
          }
        : {}),
      effect: async () => {
        expect(
          transport.calls.filter((call) => call === "verify")
        ).toHaveLength(4);
        return { value: 0, outcome: "uncertain" };
      },
    });
  });
}, 30_000);

test.each([
  "arbitrary",
  "typed",
] as const)("speculative ownership preserves the original %s error contract", async (kind) => {
  const { store, transport, generation } = await rememberedActive();
  const original =
    kind === "typed"
      ? new NativeComposeGenerationError("E_NATIVE_COMPOSE_STALE")
      : new Error("synthetic-private-ownership-canary");
  let caught: unknown;
  let effects = 0;
  await store.withMutation(async (mutation) => {
    try {
      await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {
          throw original;
        },
        captureStorage: () => [volume],
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        effect: async () => {
          effects++;
          return { value: 0, outcome: "complete" };
        },
      });
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(NativeComposeGenerationError);
  expect(caught).toMatchObject({
    code:
      kind === "typed" ? "E_NATIVE_COMPOSE_STALE" : "E_NATIVE_COMPOSE_STATE",
  });
  if (kind === "typed") {
    expect(caught).toBe(original);
  }
  expect(caught instanceof Error ? caught.message : "").not.toContain(
    "synthetic-private-ownership-canary"
  );
  expect(effects).toBe(0);
  expect((await store.loadCurrent()).pending).toBeNull();
}, 30_000);

test.each([
  "up",
  "restart",
  "run",
] as const)("command storage cold %s seeds once under Expected, then retains read-only restart proofs", async (operation) => {
  const store = await fixture();
  const transport = fake(store);
  const command = commandPorts(transport);
  await store.withMutation(async (mutation) => {
    const storage = await prepareNativeComposeCommandStorage({
      store,
      mutation,
      operation,
      selected: [selection],
      signal: transport.controller.signal,
      ports: command.ports,
    });
    if (!storage) {
      throw new Error("Expected storage admission");
    }
    expect(transport.calls).toEqual([]);
    const generation = await publish(mutation);
    transport.state.generation = generation;
    const document = await store.readGenerationDocument(generation);
    const result = await mutation.runEffect({
      generation,
      operation,
      assertFresh: async () => {},
      assertOwned: async () => {},
      storageWitnesses: storage.effectWitnesses,
      effect: async () => {
        await storage.enroll(generation, document);
        expect(
          transport.calls.filter((call) => call === "verify")
        ).toHaveLength(operation === "run" ? 2 : 3);
        transport.calls.push("workload");
        return { value: 0, outcome: "complete" };
      },
    });
    expect(result.outcome).toBe("complete");
  });
  expect(transport.calls.filter((call) => call === "provision")).toHaveLength(
    1
  );
  expect(transport.calls.filter((call) => call === "seed")).toHaveLength(1);
  expect(transport.calls.indexOf("seed")).toBeLessThan(
    transport.calls.indexOf("workload")
  );
  transport.calls.length = 0;
  await store.withMutation(async (mutation) => {
    const storage = await prepareNativeComposeCommandStorage({
      store,
      mutation,
      operation: "restart",
      selected: [selection],
      signal: transport.controller.signal,
      ports: command.ports,
    });
    if (!storage) {
      throw new Error("Expected retained admission");
    }
    const generation = await publish(mutation);
    transport.state.generation = generation;
    const result = await mutation.runEffect({
      generation,
      operation: "restart",
      assertFresh: async () => {},
      assertOwned: async () => {},
      storageWitnesses: storage.effectWitnesses,
      effect: async () => {
        await storage.enroll(
          generation,
          await store.readGenerationDocument(generation)
        );
        transport.calls.push("workload");
        return { value: 0, outcome: "complete" };
      },
    });
    expect(result.outcome).toBe("complete");
  });
  expect(transport.calls).not.toContain("provision");
  expect(transport.calls).not.toContain("seed");
  expect(transport.calls).toContain("verify");
  expect((await store.loadCurrent()).pending).toBeNull();
}, 30_000);

test.each([
  "up",
  "restart",
  "run",
] as const)("cold %s refuses changed xattr after enrollment before workload spawn", async (operation) => {
  const store = await fixture();
  const transport = fake(store);
  const command = commandPorts(transport);
  let verified = 0;
  let spawned = false;
  transport.state.afterInvoke = (input) => {
    if (input.request.operation === "verify") {
      verified += 1;
      if (verified === 2) {
        // The enrollment publication has read the marker. Change the real
        // fake-kernel xattr before the next delivery-boundary proof.
        transport.attributes.clear();
      }
    }
  };
  await store.withMutation(async (mutation) => {
    const storage = await prepareNativeComposeCommandStorage({
      store,
      mutation,
      operation,
      selected: [selection],
      signal: transport.controller.signal,
      ports: command.ports,
    });
    if (!storage) {
      throw new Error("Expected storage admission");
    }
    const generation = await publish(mutation);
    transport.state.generation = generation;
    const document = await store.readGenerationDocument(generation);
    await expect(
      mutation.runEffect({
        generation,
        operation,
        assertFresh: async () => {},
        assertOwned: async () => {},
        storageWitnesses: storage.effectWitnesses,
        effect: async () => {
          await storage.enroll(generation, document);
          if (operation !== "run") {
            spawned = true;
            return { value: 0, outcome: "complete" };
          }
          return await runOneOff({
            options: {
              cwd: generation.identity.checkoutRoot,
              operation: "run",
              service: "app",
            },
            generation,
            document,
            selection: {
              composeProject: generation.identity.composeProject,
              runtimeIdentity: generation.identity.composeProject,
              ownerToken: generation.identity.ownerToken,
              generationIds: [generation.generationId],
              expectedServices: ["app"],
              expectedVolumes: [selection],
            },
            base: {
              composeFiles: [generation.composeFile],
              composeProject: generation.identity.composeProject,
              cwd: generation.identity.checkoutRoot,
              env: { PATH: "/no-task-docker" },
            },
            signal: transport.controller.signal,
            beforeSpawn: () => {
              spawned = true;
              throw new Error("Run child intercepted before spawn");
            },
            assertFresh: async () => {},
            assertOwned: () =>
              assertNativeComposeEffectOwned({
                assertFresh: async () => {},
                assertOwned: async () => {},
                verifyStorage: () => storage.verify(generation),
              }),
            observeStorage: () => {},
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    const retained = await store.loadCurrent();
    expect(retained.pending?.operation).toBe(operation);
    expect(retained.storageWitnesses?.[0]?.state).toBe("enrolled");
  });
  expect(verified).toBeGreaterThanOrEqual(3);
  expect(spawned).toBe(false);
  expect(transport.calls).toContain("seed");
}, 30_000);

test("cold run reaches the real pre-spawn guard with exactly eleven helper calls", async () => {
  const store = await fixture();
  const transport = fake(store);
  const command = commandPorts(transport);
  let boundaries = 0;
  let boundaryCalls: readonly string[] = [];
  await store.withMutation(async (mutation) => {
    const storage = await prepareNativeComposeCommandStorage({
      store,
      mutation,
      operation: "run",
      selected: [selection],
      signal: transport.controller.signal,
      ports: command.ports,
    });
    if (!storage) {
      throw new Error("Expected storage admission");
    }
    const generation = await publish(mutation);
    transport.state.generation = generation;
    const document = await store.readGenerationDocument(generation);
    await expect(
      mutation.runEffect({
        generation,
        operation: "run",
        assertFresh: async () => {},
        assertOwned: async () => {},
        storageWitnesses: storage.effectWitnesses,
        effect: async () => {
          await storage.enroll(generation, document);
          return await runOneOff({
            options: {
              cwd: generation.identity.checkoutRoot,
              operation: "run",
              service: "app",
            },
            generation,
            document,
            selection: {
              composeProject: generation.identity.composeProject,
              runtimeIdentity: generation.identity.composeProject,
              ownerToken: generation.identity.ownerToken,
              generationIds: [generation.generationId],
              expectedServices: ["app"],
              expectedVolumes: [selection],
            },
            base: {
              composeFiles: [generation.composeFile],
              composeProject: generation.identity.composeProject,
              cwd: generation.identity.checkoutRoot,
              env: { PATH: "/no-task-docker" },
            },
            signal: transport.controller.signal,
            beforeSpawn: () => {
              boundaries++;
              boundaryCalls = transport.calls.slice();
              throw new Error("Run child intercepted before spawn");
            },
            assertFresh: async () => {},
            assertOwned: () =>
              assertNativeComposeEffectOwned({
                assertFresh: async () => {},
                assertOwned: async () => {},
                verifyStorage: () => storage.verify(generation),
              }),
            observeStorage: () => {},
          });
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect((await store.loadCurrent()).pending?.operation).toBe("run");
  });
  expect(boundaries).toBe(1);
  expect(
    boundaryCalls.filter((call) => ["root", "seed", "verify"].includes(call))
  ).toHaveLength(11);
  expect(boundaryCalls.filter((call) => call === "verify")).toHaveLength(3);
  expect(transport.calls.filter((call) => call === "seed")).toHaveLength(1);
  expect(transport.calls.filter((call) => call === "provision")).toHaveLength(
    1
  );
}, 30_000);

test("original cold run storage authority cannot grant general effects, adoption or another generation", async () => {
  const store = await fixture();
  const transport = fake(store);
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    const foreign = await publish(mutation);
    transport.state.generation = generation;
    const result = await mutation.runEffect({
      generation,
      operation: "run",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        const binding = await assertNativeComposeMaterialAuthority({
          authority: mutation.materialAuthority,
          generation,
          phase: "storage-create",
        });
        expect(binding.currentGenerationId).toBeNull();
        expect(binding.pendingGenerationId).toBe(generation.generationId);
        const pending = (await store.loadCurrent()).pending;
        if (!pending) {
          throw new Error("Expected original cold-run pending token");
        }
        expect(binding.pendingToken).toBe(pending.token);
        for (const phase of ["effect", "stop", "retire"] as const) {
          await expect(
            assertNativeComposeMaterialAuthority({
              authority: mutation.materialAuthority,
              generation,
              phase,
            })
          ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        }
        await expect(
          assertNativeComposeMaterialAuthority({
            authority: mutation.materialAuthority,
            generation: foreign,
            phase: "storage-create",
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        await expect(
          assertNativeComposeMaterialAuthority({
            authority: { ...mutation.materialAuthority },
            generation,
            phase: "storage-create",
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        await expect(
          prepareNativeComposeStorageXattrWitness({
            authority: mutation.materialAuthority,
            generation,
            engineId,
            volume: selection,
            admission: "explicit-adoption",
            originalVolume: volume,
            assertAdmission: async () => {},
            carrier: transport.carrier,
          })
        ).rejects.toThrow("values omitted");
        expect(transport.calls).toEqual([]);
        expect((await store.loadCurrent()).storageWitnesses).toBeNull();
        return { value: 0, outcome: "complete" };
      },
    });
    expect(result.outcome).toBe("complete");
    await expect(
      assertNativeComposeMaterialAuthority({
        authority: mutation.materialAuthority,
        generation,
        phase: "storage-create",
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
  });
});

test.each([
  "warm",
  "stopped",
] as const)("enrolled %s run remains verify-only and refuses newly selected storage", async (mode) => {
  const { store, transport, generation } = await active();
  if (mode === "stopped") {
    await store.withMutation(async (mutation) => {
      await mutation.runEffect({
        generation,
        operation: "down",
        assertOwned: async () => {},
        effect: async () => ({ value: 0, outcome: "complete" }),
      });
    });
    expect((await store.loadCurrent()).stopped).toBe(true);
  }
  transport.calls.length = 0;
  const command = commandPorts(transport);
  await store.withMutation(async (mutation) => {
    await expect(
      prepareNativeComposeCommandStorage({
        store,
        mutation,
        operation: "run",
        selected: [selection, { name: "owned_new", storage: "new" }],
        signal: transport.controller.signal,
        ports: command.ports,
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_PROJECT_UNSUPPORTED" });
    expect(transport.calls).toEqual([]);
    const storage = await prepareNativeComposeCommandStorage({
      store,
      mutation,
      operation: "run",
      selected: [selection],
      signal: transport.controller.signal,
      ports: command.ports,
    });
    if (!storage) {
      throw new Error("Expected enrolled storage");
    }
    const result = await mutation.runEffect({
      generation,
      operation: "run",
      assertFresh: async () => {},
      assertOwned: async () => {},
      storageWitnesses: storage.effectWitnesses,
      effect: async () => {
        await expect(
          assertNativeComposeMaterialAuthority({
            authority: mutation.materialAuthority,
            generation,
            phase: "storage-create",
          })
        ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
        await storage.enroll(
          generation,
          await store.readGenerationDocument(generation)
        );
        transport.calls.push("workload");
        return { value: 0, outcome: "complete" };
      },
    });
    expect(result.outcome).toBe("complete");
  });
  expect(transport.calls).not.toContain("provision");
  expect(transport.calls).not.toContain("seed");
  expect(transport.calls.indexOf("verify")).toBeLessThan(
    transport.calls.indexOf("workload")
  );
  expect(transport.calls.lastIndexOf("verify")).toBeGreaterThan(
    transport.calls.indexOf("workload")
  );
  expect((await store.loadCurrent()).pending).toBeNull();
}, 30_000);

test("cold run enrollment authority expires when its original effect returns before seed", async () => {
  const store = await fixture();
  const transport = fake(store);
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    transport.state.generation = generation;
    let enrollment: NativeComposeStorageWitnessEnrollment | null = null;
    const result = await mutation.runEffect({
      generation,
      operation: "run",
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        enrollment = await prepareNativeComposeStorageXattrWitness({
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
    });
    expect(result.outcome).toBe("uncertain");
    const pending = (await store.loadCurrent()).pending;
    await expect(
      enrollNativeComposeStorageXattrWitness({
        enrollment: enrollment ?? {},
      })
    ).rejects.toThrow("values omitted");
    await expect(
      mutation.runEffect({
        generation,
        operation: "run",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          throw new Error("Pending run must not replay");
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    expect((await store.loadCurrent()).pending).toEqual(pending);
    expect((await store.loadCurrent()).storageWitnesses?.[0]?.state).toBe(
      "expected"
    );
  });
  expect(transport.calls).toEqual(["inspect"]);
  expect(transport.calls).not.toContain("provision");
  expect(transport.calls).not.toContain("seed");
});

test.each([
  "up",
  "run",
  "exec",
] as const)("command %s refuses same-birth empty replacement before hooks or workload", async (operation) => {
  const { store, transport } = await active();
  transport.attributes.clear();
  transport.calls.length = 0;
  const before = await store.loadCurrent();
  await store.withMutation(async (mutation) => {
    await expect(
      prepareNativeComposeCommandStorage({
        store,
        mutation,
        operation,
        selected: [selection],
        signal: transport.controller.signal,
        ports: commandPorts(transport).ports,
      })
    ).rejects.toThrow("values omitted");
  });
  expect(transport.calls).not.toContain("seed");
  expect(transport.calls).not.toContain("provision");
  expect(transport.calls).not.toContain("workload");
  expect((await store.loadCurrent()).storageWitnesses).toEqual(
    before.storageWitnesses
  );
  expect(transport.state.volume).toEqual(volume);
});

test("command legacy storage refuses before credential/helper acquisition even when the retained volume is missing", async () => {
  const store = await fixture();
  const transport = fake(store);
  const command = commandPorts(transport);
  await store.withMutation(async (mutation) => {
    const generation = await publish(mutation);
    await mutation.runEffect({
      generation,
      operation: "up",
      assertFresh: async () => {},
      assertOwned: async () => {},
      captureStorage: () => [volume],
      effect: async () => ({ value: 0, outcome: "complete" }),
    });
  });
  await store.withMutation(async (mutation) => {
    await expect(
      prepareNativeComposeCommandStorage({
        store,
        mutation,
        operation: "up",
        selected: [selection],
        signal: transport.controller.signal,
        ports: command.ports,
      })
    ).rejects.toThrow("never enrolled or repaired");
  });
  expect(command.calls).toEqual([]);
  expect(transport.calls).toEqual([]);
});

test("command prerequisite failure precedes Expected, provisioning and any authored effect", async () => {
  const store = await fixture();
  const transport = fake(store);
  const command = commandPorts(transport);
  command.ports.carrier = async () => {
    throw new Error("missing fixed dependency");
  };
  await store.withMutation(async (mutation) => {
    await expect(
      prepareNativeComposeCommandStorage({
        store,
        mutation,
        operation: "up",
        selected: [selection],
        signal: transport.controller.signal,
        ports: command.ports,
      })
    ).rejects.toThrow("missing fixed dependency");
  });
  expect((await store.loadCurrent()).storageWitnesses).toBeNull();
  expect((await store.loadCurrent()).pending).toBeNull();
  expect(transport.calls).toEqual([]);
});

test("command document storage projection never passes private fields to a carrier selection", () => {
  expect(
    nativeComposeDocumentStorage({
      volumes: { data: { name: volume.name, labels: { private: "omitted" } } },
    })
  ).toEqual([selection]);
});

test.each([
  130, 143,
])("cancelled saved exec preserves exit%s and launches zero late proofs or helpers", async (code) => {
  const controller = new AbortController();
  let proofs = 0;
  const result = await runNativeComposeStorageVerifiedExec({
    signal: controller.signal,
    assertSaved: async () => {
      proofs++;
    },
    run: async () => {
      controller.abort();
      return code;
    },
  });
  expect(result).toBe(code);
  expect(proofs).toBe(1);
});

test("unknown saved exec return preserves its refusal without a late proof", async () => {
  let proofs = 0;
  await expect(
    runNativeComposeStorageVerifiedExec({
      signal: new AbortController().signal,
      assertSaved: async () => {
        proofs++;
      },
      run: async () => {
        throw new Error("unknown command disposition");
      },
    })
  ).rejects.toThrow("unknown command disposition");
  expect(proofs).toBe(1);
});

test("runEffect captures the original fresh carrier factory across a long phase and final proofs", async () => {
  const { store, transport, generation } = await active();
  const start = Date.now();
  let clock = start;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  let original = 0;
  let substituted = 0;
  const storageWitnesses = {
    kind: "directory-xattr" as const,
    engineId,
    carrier: async () => {
      original++;
      return captureNativeComposeStorageXattrCarrier({
        artifact,
        ports: transport.ports,
        signal: transport.controller.signal,
        deadline: clock + 60_000,
      });
    },
  };
  try {
    await store.withMutation(async (mutation) => {
      const result = await mutation.runEffect({
        generation,
        operation: "run",
        storageWitnesses,
        assertFresh: async () => {},
        assertOwned: async () => {
          storageWitnesses.carrier = async () => {
            substituted++;
            return transport.carrier;
          };
        },
        effect: async () => {
          clock = start + 120_000;
          return { value: 17, outcome: "complete" };
        },
      });
      expect(result).toEqual({ value: 17, outcome: "complete" });
    });
    expect(original).toBeGreaterThan(1);
    expect(substituted).toBe(0);
    expect((await store.loadCurrent()).pending).toBeNull();
  } finally {
    now.mockRestore();
  }
});

test("durable tagged Expected precedes one cold provision/seed and fresh proof before workload", async () => {
  const { store, transport, reference } = await active();
  expect(reference).toMatchObject({
    version: 3,
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
  if (reference.version !== 3) {
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
  expect(
    nativeComposeStorageWitnessReferenceValid({ ...reference, version: 2 })
  ).toBe(false);
  const { carrierJournalToken: ignoredJournal, ...missingJournal } = reference;
  expect(nativeComposeStorageWitnessReferenceValid(missingJournal)).toBe(false);
  expect(ignoredJournal).toMatch(/^[a-f0-9]{32}$/);
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
}, 30_000);

test.each(
  (["up", "run"] as const).flatMap((operation) =>
    (["provision", "seed", "verify", "cleanup"] as const).map(
      (failure) => [operation, failure] as const
    )
  )
)("cold %s %s uncertainty retains required Expected; saved stop never reenrolls", async (operation, failure) => {
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
        operation,
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

test("known finite refused marker read clears only its proven absent helper intent and never repairs the witness", async () => {
  const { store, transport, generation, reference } = await active();
  transport.attributes.clear();
  transport.calls.length = 0;
  let workload = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        effect: async () => {
          workload++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toThrow("values omitted");
  });
  expect(workload).toBe(0);
  expect(transport.attributes.size).toBe(0);
  expect(transport.calls).not.toContain("seed");
  expect(transport.calls).not.toContain("provision");
  const failed = await store.loadCurrent();
  expect(failed.storageWitnessesPending).toBe(false);
  expect(failed.pending).toBeNull();
  expect(failed.storageWitnesses?.[0]).toMatchObject({
    state: "enrolled",
    reference,
  });
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "down",
        recoverPending: true,
        assertOwned: async () => {},
        effect: async () => {
          workload++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    expect(
      await mutation.runEffect({
        generation,
        operation: "down",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => ({ value: 0, outcome: "complete" }),
      })
    ).toEqual({ value: 0, outcome: "complete" });
  });
  const stopped = await store.loadCurrent();
  expect(stopped.stopped).toBe(true);
  expect(stopped.pending).toBeNull();
  expect(stopped.storageWitnesses?.[0]).toMatchObject({
    state: "enrolled",
    reference,
  });
});

test.each([
  "no-created",
  "changed-created",
  "created-uncertain",
  "cleanup",
] as const)("unknown enrolled helper %s blocks replay and saved retirement without changing the main material receipt", async (failure) => {
  const { store, transport, generation, reference } = await active();
  transport.state.failure = failure;
  transport.calls.length = 0;
  let workload = 0;
  await store.withMutation(async (mutation) => {
    await expect(
      mutation.runEffect({
        generation,
        operation: "run",
        assertFresh: async () => {},
        assertOwned: async () => {},
        storageWitnesses: {
          kind: "directory-xattr",
          engineId,
          carrier: transport.carrier,
        },
        effect: async () => {
          workload++;
          return { value: 0, outcome: "complete" };
        },
      })
    ).rejects.toThrow("values omitted");
  });
  expect(workload).toBe(0);
  const unknown = await store.loadCurrent();
  expect(unknown.generation?.generationId).toBe(generation.generationId);
  expect(unknown.pending).toBeNull();
  expect(unknown.storageWitnessesPending).toBe(true);
  expect(unknown.storageWitnesses?.[0]).toMatchObject({
    state: "enrolled",
    reference,
  });
  const observed = [...transport.calls];
  await store.withMutation(async (mutation) => {
    if (failure === "no-created") {
      const foreignGeneration = await publish(mutation);
      await expect(
        mutation.runEffect({
          generation: foreignGeneration,
          operation: "down",
          recoverPending: true,
          assertOwned: async () => {},
          effect: async () => {
            workload++;
            return { value: 0, outcome: "complete" };
          },
        })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    }
    for (const operation of ["up", "down"] as const) {
      await expect(
        mutation.runEffect({
          generation,
          operation,
          assertFresh: async () => {},
          assertOwned: async () => {},
          effect: async () => {
            workload++;
            return { value: 0, outcome: "complete" };
          },
        })
      ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_UNCERTAIN" });
    }
    const stopped = await mutation.runEffect({
      generation,
      operation: "down",
      recoverPending: true,
      assertFresh: async () => {},
      assertOwned: async () => {},
      effect: async () => {
        workload++;
        return { value: 0, outcome: "complete" };
      },
      beforeComplete: async () => {
        throw new Error("Unknown helper cannot retire claims");
      },
    });
    expect(stopped).toEqual({ value: 0, outcome: "uncertain" });
  });
  expect(workload).toBe(1);
  expect(transport.calls).toEqual(observed);
  const retained = await store.loadCurrent();
  expect(retained.pending?.generationId).toBe(generation.generationId);
  expect(retained.storageWitnessesPending).toBe(true);
  expect(retained.storageWitnesses?.[0]).toMatchObject({
    state: "enrolled",
    reference,
  });
});

test("retirement rereads the original receipt after its final carrier-journal await", async () => {
  const { store, generation } = await active();
  const original = carrierJournal.nativeComposeStorageCarriersPending;
  let pause = false;
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = spyOn(
    carrierJournal,
    "nativeComposeStorageCarriersPending"
  ).mockImplementation(async (opts) => {
    if (pause) {
      pause = false;
      enter();
      await resumed;
    }
    return await original(opts);
  });
  try {
    await store.withMutation(async (mutation) => {
      expect(
        await mutation.runEffect({
          generation,
          operation: "down",
          assertOwned: async () => {},
          effect: async () => {
            pause = true;
            const retirement = assertNativeComposeMaterialAuthority({
              authority: mutation.materialAuthority,
              generation,
              phase: "retire",
            });
            await entered;
            // Adversarial substitution only in this isolated synthetic store: same
            // complete bytes, different inode while the final journal probe awaits.
            const path = join(
              store.identity.checkoutRoot,
              ".hack",
              ".internal",
              "native-compose",
              store.identity.instanceId,
              "receipt.json"
            );
            const bytes = await readFile(path);
            await writeFile(`${path}.replacement`, bytes, {
              mode: 0o600,
              flag: "wx",
            });
            await rename(`${path}.replacement`, path);
            release();
            await expect(retirement).rejects.toMatchObject({
              code: "E_NATIVE_COMPOSE_STATE",
            });
            return { value: 0, outcome: "uncertain" };
          },
        })
      ).toEqual({ value: 0, outcome: "uncertain" });
    });
  } finally {
    release();
    probe.mockRestore();
  }
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
