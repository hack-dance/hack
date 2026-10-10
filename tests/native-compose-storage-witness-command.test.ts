import { expect, test } from "bun:test";
import { join } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { nativeComposeRetainedVolumesValid } from "../src/lib/native-compose-retained-storage.ts";
import {
  enrollNativeComposeStorageWitness,
  enrollNativeComposeStorageXattrWitness,
  prepareNativeComposeStorageWitness,
  prepareNativeComposeStorageXattrWitness,
  verifyNativeComposeStorageXattrWitness,
} from "../src/lib/native-compose-storage-witness.ts";
import { captureNativeComposeStorageXattrCarrier } from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";
import { encodeNativeComposeStorageXattrResponse } from "../src/lib/native-compose-storage-witness-xattr-codec.ts";
import { runNativeComposeStorageXattrHelper } from "../src/lib/native-compose-storage-witness-xattr-helper.ts";
import { invoke } from "./helpers/native-compose-command.ts";
import { legacyStorageFixture } from "./helpers/native-compose-legacy-storage.ts";

async function prepared(enroll: boolean) {
  const root = await legacyStorageFixture();
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  try {
    const current = await store.loadCurrent();
    const generation = current.generation;
    const volume = current.retainedStorage?.[0];
    if (
      !(generation && volume && nativeComposeRetainedVolumesValid([volume]))
    ) {
      throw new Error("Expected public-store retained generation and birth");
    }
    let archive: Uint8Array = new Uint8Array();
    await store.withMutation(async (mutation) => {
      const result = await mutation.runEffect({
        generation,
        operation: "up",
        assertFresh: async () => {},
        assertOwned: async () => {},
        effect: async () => {
          const enrollment = await prepareNativeComposeStorageWitness({
            authority: mutation.materialAuthority,
            generation,
            engineId: "d".repeat(64),
            volume: { name: volume.name, storage: volume.storage },
            admission: "explicit-adoption",
            originalVolume: volume,
            assertAdmission: async () => {},
          });
          if (enroll) {
            await enrollNativeComposeStorageWitness({
              enrollment,
              seed: async (bytes) => {
                archive = bytes;
              },
              observe: async () => ({ volume, archive }),
            });
          }
          return { value: 0, outcome: enroll ? "complete" : "uncertain" };
        },
      });
      expect(result.outcome).toBe(enroll ? "complete" : "uncertain");
    });
    return {
      root,
      witnesses: (await store.loadCurrent()).storageWitnesses,
      generationId: generation.generationId,
    };
  } finally {
    await store.close();
  }
}

async function saved(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    return await store.loadCurrent();
  } finally {
    await store.close();
  }
}

test("source CLI cannot fall back to metadata for enrolled v3 startup, run or exec", async () => {
  const { root, witnesses } = await prepared(true);
  const requests = await Bun.file(join(root, "requests")).text();
  const order = await Bun.file(join(root, "order")).text();
  for (const args of [
    ["up", "--detach", "--json"],
    ["run", "web", "--", "synthetic"],
    ["exec", "web", "--", "synthetic"],
  ]) {
    const result = await invoke(root, args);
    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      ".hack-storage-"
    );
  }
  expect(await Bun.file(join(root, "requests")).text()).toBe(requests);
  expect(await Bun.file(join(root, "order")).text()).toBe(order);
  expect((await saved(root)).storageWitnesses).toEqual(witnesses);
}, 30_000);

test("source-unavailable explicit saved recovery stops engine but retains Expected intent and ownership anchor", async () => {
  const { root, witnesses, generationId } = await prepared(false);
  const requests = await Bun.file(join(root, "requests")).text();
  const compiler = await Bun.file(join(root, "compiler-requests")).text();
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    "malformed authored source"
  );
  await Bun.write(
    join(root, ".hack/hack.env.default.yaml"),
    "malformed private env"
  );
  const normal = await invoke(root, ["down", "--json"]);
  expect(normal.code).toBe(1);
  expect(await Bun.file(join(root, "requests")).text()).toBe(requests);
  const recovery = await invoke(root, ["down", "--recover", "--json"]);
  expect(recovery.code).toBe(1);
  expect(JSON.parse(recovery.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_COMPOSE_FAILED" },
  });
  expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  const current = await saved(root);
  expect(current.storageWitnesses).toEqual(witnesses);
  expect(current.storageWitnessesPending).toBe(true);
  expect(current.pending?.generationId).toBe(generationId);
  expect(current.retainedStorage).toHaveLength(1);
  expect(JSON.stringify(current)).not.toContain(".hack-storage-");
}, 30_000);

test("source CLI reports and explicitly stops saved resources for unknown enrolled preflight helper with no main pending", async () => {
  const root = await legacyStorageFixture();
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "prepare",
  });
  let generationId = "";
  let witnesses: Awaited<
    ReturnType<typeof store.loadCurrent>
  >["storageWitnesses"] = null;
  const marker = new Map<string, Uint8Array>();
  let unknown = false;
  let helperId = 1;
  try {
    const current = await store.loadCurrent();
    const generation = current.generation;
    const volume = current.retainedStorage?.[0];
    if (!(generation && volume)) {
      throw new Error("Missing saved synthetic volume");
    }
    generationId = generation.generationId;
    const carrier = captureNativeComposeStorageXattrCarrier({
      artifact: {
        version: 1,
        imageId: `sha256:${"a".repeat(64)}`,
        platform: "linux/arm64",
        bunVersion: "1.4.2",
        bunHash: "b".repeat(64),
        libcHash: "c".repeat(64),
        helperHash: "e".repeat(64),
        kernelAbi: 1,
      },
      signal: new AbortController().signal,
      deadline: Date.now() + 30_000,
      ports: {
        inspect: async () => ({
          engineId: "d".repeat(64),
          runtimeIdentity: store.identity.composeProject,
          ownerToken: store.identity.ownerToken,
          name: volume.name,
          storage: volume.storage,
          volume,
          mountpoint: `/var/lib/docker/volumes/${volume.name}/_data`,
          driver: "local",
          options: {},
          holders: [],
        }),
        invoke: async (input) => {
          if (unknown) {
            throw new Error(
              "Synthetic create outcome unknown; no actual helper or Docker"
            );
          }
          const id = (helperId++).toString(16).padStart(64, "0");
          await input.recordCreated({ id, createdAt: volume.createdAt });
          const rootFacts = { device: "1", inode: "42", uid: 0, gid: 0 };
          const response = runNativeComposeStorageXattrHelper({
            request: input.request,
            kernel: {
              effectiveUid: () => input.uid,
              effectiveGid: () => input.gid,
              probeRoot: () => rootFacts,
              openRoot: () => 42,
              statRoot: () => rootFacts,
              createXattr: (_, name, bytes) => {
                if (input.readonly || marker.has(name)) {
                  throw new Error("EEXIST/EROFS");
                }
                marker.set(name, new Uint8Array(bytes));
              },
              syncRoot: () => {},
              readXattr: (_, name) => marker.get(name) ?? new Uint8Array(),
              closeRoot: () => {},
            },
          });
          const exitCode = response.outcome === "refused" ? 1 : 0;
          return {
            artifact: input.artifact,
            carrierId: id,
            carrierCreatedAt: volume.createdAt,
            engineId: input.target.engineId,
            invocationId: input.invocationId,
            readonly: input.readonly,
            uid: input.uid,
            gid: input.gid,
            target: input.target,
            scope: input.scope,
            response: encodeNativeComposeStorageXattrResponse(response),
            outcome: "complete",
            exitCode,
            stopped: { id, running: false, pid: 0, exitCode },
            containersAfterCleanup: [],
          };
        },
      },
    });
    await store.withMutation(async (mutation) => {
      expect(
        await mutation.runEffect({
          generation,
          operation: "up",
          assertFresh: async () => {},
          assertOwned: async () => {},
          effect: async () => {
            const enrollment = await prepareNativeComposeStorageXattrWitness({
              authority: mutation.materialAuthority,
              generation,
              engineId: "d".repeat(64),
              volume: { name: volume.name, storage: volume.storage },
              admission: "explicit-adoption",
              originalVolume: volume,
              assertAdmission: async () => {},
              carrier,
            });
            await enrollNativeComposeStorageXattrWitness({ enrollment });
            return { value: 0, outcome: "complete" };
          },
        })
      ).toEqual({ value: 0, outcome: "complete" });
    });
    const enrolled = (await store.loadCurrent()).storageWitnesses?.[0];
    if (
      !enrolled ||
      enrolled.state !== "enrolled" ||
      enrolled.reference.version !== 3
    ) {
      throw new Error("Missing issued xattr enrollment");
    }
    unknown = true;
    await store.withMutation(async (mutation) => {
      await expect(
        verifyNativeComposeStorageXattrWitness({
          authority: mutation.materialAuthority,
          generation,
          engineId: "d".repeat(64),
          reference: enrolled.reference,
          carrier,
        })
      ).rejects.toThrow("values omitted");
    });
    const uncertain = await store.loadCurrent();
    expect(uncertain.pending).toBeNull();
    expect(uncertain.storageWitnessesPending).toBe(true);
    witnesses = uncertain.storageWitnesses;
  } finally {
    await store.close();
  }
  const ps = await invoke(root, ["ps", "--json"]);
  expect(ps.code).toBe(0);
  expect(JSON.parse(ps.stdout)).toMatchObject({
    ok: true,
    data: { pending: true },
  });
  expect(ps.stdout).not.toContain("carrierJournalToken");
  expect(ps.stdout).not.toContain("user.hack.storage.");
  const requests = await Bun.file(join(root, "requests")).text();
  const compiler = await Bun.file(join(root, "compiler-requests")).text();
  await Bun.write(
    join(root, ".hack/hack.project.json"),
    "malformed authored source"
  );
  await Bun.write(
    join(root, ".hack/hack.env.default.yaml"),
    "malformed private env"
  );
  expect((await invoke(root, ["down", "--json"])).code).toBe(1);
  expect(await Bun.file(join(root, "requests")).text()).toBe(requests);
  const recovered = await invoke(root, ["down", "--recover", "--json"]);
  expect(recovered.code).toBe(1);
  expect(JSON.parse(recovered.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_COMPOSE_FAILED" },
  });
  expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  expect(await Bun.file(join(root, "compiler-requests")).text()).toBe(compiler);
  const retained = await saved(root);
  expect(retained.pending?.generationId).toBe(generationId);
  expect(retained.storageWitnesses).toEqual(witnesses);
  expect(retained.storageWitnessesPending).toBe(true);
  expect(retained.retainedStorage).toHaveLength(1);
}, 30_000);
