import { expect, test } from "bun:test";
import { join } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { nativeComposeRetainedVolumesValid } from "../src/lib/native-compose-retained-storage.ts";
import {
  enrollNativeComposeStorageWitness,
  prepareNativeComposeStorageWitness,
} from "../src/lib/native-compose-storage-witness.ts";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

async function prepared(enroll: boolean) {
  const root = await fixture("", false, {
    noHooks: true,
    storage: { data: { kind: "persistent", scope: "worktree" } },
  });
  expect((await invoke(root)).code).toBe(0);
  expect((await invoke(root, ["down", "--json"])).code).toBe(0);
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
    expect(`${result.stdout}\n${result.stderr}`).toContain("E_CONFIG_INVALID");
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
