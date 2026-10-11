import { expect, test } from "bun:test";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { fixture, invoke, state } from "./helpers/native-compose-command.ts";

// The source CLI now performs finite witness proofs as well as the workload
// transaction. Keep the same proof/wrapper budgets as its activation controls.
function command(root: string, args = ["up", "--detach", "--json"]) {
  return invoke(root, args, 30_000, 120_000);
}

type Volume = {
  readonly id: string;
  readonly name: string;
  readonly project: string;
  readonly version: string;
  readonly instance: string;
  readonly owner: string;
  readonly storage: string;
  readonly createdAt: string;
};

/** These are synthetic engine facts, never a fabricated managed receipt. */
async function retainedVolume(root: string): Promise<Volume> {
  const volumes: unknown = await Bun.file(join(root, "volumes")).json();
  expect(Array.isArray(volumes)).toBe(true);
  if (!Array.isArray(volumes) || volumes.length !== 1) {
    throw new Error("Expected one persistent fixture volume");
  }
  const volume: unknown = volumes[0];
  if (
    !isRecord(volume) ||
    typeof volume.id !== "string" ||
    typeof volume.name !== "string" ||
    typeof volume.project !== "string" ||
    typeof volume.version !== "string" ||
    typeof volume.instance !== "string" ||
    typeof volume.owner !== "string" ||
    typeof volume.storage !== "string" ||
    typeof volume.createdAt !== "string"
  ) {
    throw new Error("Expected complete synthetic volume facts");
  }
  expect(volume.id).toBe(volume.name);
  expect(volume.storage).toBe("data");
  expect(Number.isFinite(Date.parse(volume.createdAt))).toBe(true);
  return {
    id: volume.id,
    name: volume.name,
    project: volume.project,
    version: volume.version,
    instance: volume.instance,
    owner: volume.owner,
    storage: volume.storage,
    createdAt: volume.createdAt,
  };
}

async function savedState(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const current = await store.loadCurrent();
    return {
      generationId: current.generation?.generationId,
      stopped: current.stopped,
      pending: current.pending,
      retainedStorage: current.retainedStorage,
    };
  } finally {
    await store.close();
  }
}

async function composeStarts(root: string) {
  return (await Bun.file(join(root, "requests")).text())
    .split("\n")
    .filter((line) => {
      if (!line) {
        return false;
      }
      const args: unknown = JSON.parse(line);
      return (
        Array.isArray(args) && args[0] === "compose" && args.includes("up")
      );
    });
}

async function storageFixture() {
  return await fixture("", false, {
    noHooks: true,
    storage: { data: { kind: "persistent", scope: "worktree" } },
  });
}

async function startAndStop() {
  const root = await storageFixture();
  expect((await command(root)).code).toBe(0);
  const volume = await retainedVolume(root);
  expect((await command(root, ["down", "--json"])).code).toBe(0);
  expect(await state(root)).toMatchObject({ stopped: true, pending: false });
  expect(await retainedVolume(root)).toEqual(volume);
  expect(await composeStarts(root)).toHaveLength(1);
  return { root, volume };
}

test("genuinely cold source CLI startup may create its first persistent volume", async () => {
  const root = await storageFixture();
  expect(await Bun.file(join(root, "volumes")).exists()).toBe(false);
  const result = await command(root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { status: "ready" },
  });
  await retainedVolume(root);
  expect(await composeStarts(root)).toHaveLength(1);
}, 120_000);

test("source CLI down/up restores the unchanged physical volume birth", async () => {
  const { root, volume } = await startAndStop();
  const result = await command(root);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
    data: { status: "ready" },
  });
  expect(await retainedVolume(root)).toEqual(volume);
  expect(await composeStarts(root)).toHaveLength(2);
  expect(await state(root)).toMatchObject({ stopped: false, pending: false });
}, 120_000);

test.each([
  "missing",
  "replaced",
] as const)("source CLI refuses a %s retained volume before Compose can create or start", async (change) => {
  const { root, volume } = await startAndStop();
  const before = await savedState(root);
  const original: unknown = await Bun.file(join(root, "volumes")).json();
  if (
    !Array.isArray(original) ||
    original.length !== 1 ||
    !isRecord(original[0])
  ) {
    throw new Error("Expected the retained synthetic volume row");
  }
  const changed =
    change === "missing"
      ? []
      : [
          {
            // Preserve provision/root/witness backing facts so only birth drifts.
            ...original[0],
            createdAt: new Date(
              Date.parse(volume.createdAt) - 1000
            ).toISOString(),
          },
        ];
  await Bun.write(join(root, "volumes"), JSON.stringify(changed));
  const result = await command(root);
  // The effect count is the safety oracle even if a later readiness check fails.
  expect(await composeStarts(root)).toHaveLength(1);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  expect(await Bun.file(join(root, "volumes")).json()).toEqual(changed);
  expect(await savedState(root)).toEqual(before);
}, 120_000);

test("incomplete cold readiness retains observed storage and refuses data-loss recovery", async () => {
  const root = await storageFixture();
  await Bun.write(join(root, "unready"), "true");
  const started = await command(root);
  expect(started.code).toBe(1);
  const volume = await retainedVolume(root);
  const before = await savedState(root);
  expect(before.generationId).toBeUndefined();
  expect(before.pending).not.toBeNull();
  expect(before.retainedStorage).toEqual([
    { name: volume.name, storage: volume.storage, createdAt: volume.createdAt },
  ]);
  await Bun.write(join(root, "volumes"), "[]");
  const recovered = await command(root, ["down", "--recover", "--json"]);
  expect(recovered.code).toBe(1);
  const requests: string[][] = (await Bun.file(join(root, "requests")).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    requests.filter((args) => args[0] === "compose" && args.includes("down"))
  ).toHaveLength(0);
  expect(await savedState(root)).toEqual(before);
  expect(await Bun.file(join(root, "volumes")).json()).toEqual([]);
}, 120_000);
