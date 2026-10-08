import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeGenerationStore,
  type NativeComposeMaterialBinding,
  openNativeComposeGenerationStore,
} from "../src/lib/native-compose-generation.ts";
import {
  NATIVE_STORAGE_DOCKER_ARTIFACT,
  nativeComposeStorageDockerHelper,
} from "../src/lib/native-compose-storage-witness-docker-artifact.ts";
import { nativeComposeStorageDockerPathsOverlap, observeNativeComposeStorageDockerTarget } from "../src/lib/native-compose-storage-witness-docker-inventory.ts";
import {
  checkNativeComposeStorageDockerCarrier,
  NATIVE_STORAGE_CARRIER_LABEL,
  nativeComposeStorageDockerCarrierPolicy,
  nativeComposeStorageDockerCreateArgs,
} from "../src/lib/native-compose-storage-witness-docker-policy.ts";
import type { NativeComposeStorageXattrInvocation } from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";

const roots: string[] = [], stores: NativeComposeGenerationStore[] = [];
const engineId = "engine-fixture";
const selection = { name: "owned_data", storage: "data" };
const createdAt = "2026-10-08T12:00:00Z";
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function withBinding(run: (value: NativeComposeMaterialBinding) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-storage-docker-")));
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await Bun.write(join(root, ".hack/hack.project.json"), JSON.stringify({ schema_version: 1, name: "storage" }));
  const store = await openNativeComposeGenerationStore({ projectRoot: root, instance: null });
  stores.push(store);
  await store.withMutation(async (mutation) => {
    const reservation = mutation.reserveGeneration();
    const labels = { "io.hack.native-config.version": "1", "io.hack.native-config.owner": store.identity.ownerToken,
      "io.hack.native-config.instance": store.identity.composeProject };
    const generation = await mutation.publish({ reservation, profiles: [], inputRevision: "a".repeat(64), assertFresh: async () => {}, composeJson: JSON.stringify({
      name: store.identity.composeProject,
      services: { app: { image: "synthetic:1", labels: { ...labels, "io.hack.native-config.generation": reservation.generationId, "io.hack.native-config.workload": "service" } } },
      volumes: { data: { name: selection.name, labels: { ...labels, "io.hack.native-config.storage": selection.storage } } },
    }) });
    await mutation.runEffect({ generation, operation: "up", assertOwned: async () => {},
      effect: async () => {
        await run(await assertNativeComposeMaterialAuthority({ authority: mutation.materialAuthority, generation, phase: "effect" }));
        return { outcome: "complete", value: 0 };
      } });
  });
}
function inventory(binding: NativeComposeMaterialBinding) {
  const state = { present: true, drift: false, foreign: false, running: false, mounts: true, version: "1", volumeReads: 0,
    mountType: "volume", mountName: selection.name, mountSource: `/var/lib/docker/volumes/${selection.name}/_data` };
  const id = "c".repeat(64);
  const mutableCalls: string[][] = [];
  const probe = async (args: readonly string[]): Promise<string> => {
    mutableCalls.push([...args]);
    if (args[0] === "info") return JSON.stringify(engineId);
    if (args[0] === "volume" && args[1] === "ls") return state.present ? JSON.stringify(selection.name) : "";
    if (args[0] === "volume" && args[1] === "inspect") {
      state.volumeReads++;
      return JSON.stringify({ ...selection, createdAt: state.drift && state.volumeReads > 1 ? "2026-10-08T13:00:00Z" : createdAt,
        driver: "local", options: null, mountpoint: `/var/lib/docker/volumes/${selection.name}/_data`,
        project: binding.identity.composeProject, instance: binding.identity.composeProject, owner: binding.identity.ownerToken, version: state.version, provision: null });
    }
    if (args[0] === "container" && args[1] === "ls") return state.mounts ? JSON.stringify(id) : "";
    if (args[0] === "container" && args[1] === "inspect") return JSON.stringify({ id, createdAt,
      mounts: [{ Type: state.mountType, Name: state.mountName, Source: state.mountSource, Destination: "/data", RW: true }],
      running: state.running, project: binding.identity.composeProject, instance: binding.identity.composeProject,
      owner: state.foreign ? "f".repeat(32) : binding.identity.ownerToken, version: state.version, generation: binding.generationId,
      carrier: null, carrierOwner: null, carrierGeneration: null });
    throw new Error("Unexpected synthetic Docker request");
  };
  return { state, probe, calls: mutableCalls };
}
test("full holder inventory admits stopped and exact owned running readers and preserves strict sparse reads", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    const target = await observeNativeComposeStorageDockerTarget({ current, engineId, selection, stopped: true, probe: fake.probe });
    expect(target.volume).toEqual({ ...selection, createdAt });
    expect(target.holders).toHaveLength(1);
    fake.state.running = true;
    expect((await observeNativeComposeStorageDockerTarget({ current, engineId, selection, stopped: false, probe: fake.probe })).holders[0]?.running).toBe(true);
    expect(fake.calls.every((args) => !args.includes("create") && !args.includes("start") && !args.includes("rm") && !args.join(" ").includes("Config.Env"))).toBe(true);
  });
});
test.each(["foreign", "running", "drift", "version"] as const)("selected holder or volume %s refuses before any effects", async (failure) => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    if (failure === "version") fake.state.version = "2"; else fake.state[failure] = true;
    await expect(observeNativeComposeStorageDockerTarget({ current, engineId, selection, stopped: true, probe: fake.probe })).rejects.toThrow("values omitted");
    expect(fake.calls.every((args) => !args.includes("create") && !args.includes("start") && !args.includes("rm"))).toBe(true);
  });
});
test("genuinely absent cold storage needs an empty complete holder selection", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current); fake.state.present = false; fake.state.mounts = false;
    expect((await observeNativeComposeStorageDockerTarget({ current, engineId, selection, stopped: true, probe: fake.probe })).volume).toBeNull();
    fake.state.mounts = true;
    await expect(observeNativeComposeStorageDockerTarget({ current, engineId, selection, stopped: true, probe: fake.probe })).rejects.toThrow();
  });
});
test.each([
  "/var/lib/docker/volumes", "/var/lib/docker/volumes/owned_data/", "/var/lib/docker/volumes/owned_data/_data/",
  "/var/lib/docker/volumes/owned_data/_data/child", "/var/lib/docker/volumes/other/../owned_data/_data",
] as const)("foreign overlapping bind %s refuses rather than disappearing from holder selection", async (source) => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    fake.state.foreign = true; fake.state.mountType = "bind"; fake.state.mountName = ""; fake.state.mountSource = source;
    await expect(observeNativeComposeStorageDockerTarget({ current, engineId, selection, stopped: true, probe: fake.probe })).rejects.toThrow("values omitted");
    expect(fake.calls.every((args) => !args.includes("create") && !args.includes("start") && !args.includes("rm"))).toBe(true);
  });
});
test("complete holder inventory keeps a similarly named foreign sibling independent", async () => {
  await withBinding(async (current) => {
    const fake = inventory(current);
    fake.state.foreign = true; fake.state.mountType = "bind"; fake.state.mountName = "";
    fake.state.mountSource = "/var/lib/docker/volumes/owned_data_other/_data";
    expect((await observeNativeComposeStorageDockerTarget({ current, engineId, selection, stopped: true, probe: fake.probe })).holders).toEqual([]);
  });
  expect(nativeComposeStorageDockerPathsOverlap("relative/path", "/var/lib/docker/volumes/owned_data/_data")).toBe(false);
});
function input(): NativeComposeStorageXattrInvocation {
  return { recordCreated: async () => {}, invocationId: "a".repeat(32), artifact: NATIVE_STORAGE_DOCKER_ARTIFACT,
    target: { ...selection, engineId, runtimeIdentity: "owned", ownerToken: "b".repeat(32), volume: { ...selection, createdAt },
      mountpoint: `/var/lib/docker/volumes/${selection.name}/_data`, driver: "local", options: {}, holders: [] },
    readonly: true, uid: 70, gid: 70, request: { kind: "directory-xattr", version: 1, operation: "root" },
    scope: { generationId: "d".repeat(32), currentGenerationId: "d".repeat(32), pendingGenerationId: null, pendingToken: null } };
}
function carrier(input: NativeComposeStorageXattrInvocation) {
  const program = "/private-owned/helper.mjs";
  const mounts = [[program, "/hack-storage-witness-helper.mjs"], [input.target.mountpoint, "/hack-storage-witness"]].map(([source, target]) => ({
    Type: "bind", Source: source, Destination: target, RW: false, Propagation: "rprivate" }));
  const value = { id: "e".repeat(64), createdAt, image: input.artifact.imageId, configImage: input.artifact.imageId,
    user: "70:70", entrypoint: ["/usr/local/bin/bun"], cmd: ["--no-env-file", "/hack-storage-witness-helper.mjs"], openStdin: true, tty: false,
    labels: { [NATIVE_STORAGE_CARRIER_LABEL]: input.invocationId, "io.hack.storage-witness.owner": input.target.ownerToken,
      "io.hack.storage-witness.generation": input.scope.generationId, "io.hack.storage-witness.helper": input.artifact.helperHash },
    host: { Privileged: false, ReadonlyRootfs: true, NetworkMode: "none", Memory: 268_435_456, NanoCpus: 1_000_000_000, PidsLimit: 32,
      CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges:true"], LogConfig: { Type: "none", Config: {} }, RestartPolicy: { Name: "no" },
      Binds: null, Tmpfs: null, Devices: [], DeviceRequests: null, PortBindings: {}, OomKillDisable: false as false | null | true,
      Mounts: mounts.map((mount) => ({ Type: mount.Type, Source: mount.Source, Target: mount.Destination, ReadOnly: true,
        BindOptions: { NonRecursive: true, Propagation: "rprivate", CreateMountpoint: false } })) },
    mounts, state: {}, execIds: null as null | string[] };
  return { program, value };
}
test("helper args require explicit cached dependency/noncreating RO binds and contain no witness token", () => {
  const selected = input(), fake = carrier(selected);
  expect(nativeComposeStorageDockerHelper().length).toBeGreaterThan(1000);
  const args = nativeComposeStorageDockerCreateArgs({ input: selected, program: fake.program });
  expect(args).toContain("never"); expect(args).toContain("none");
  expect(args.filter((value) => value.startsWith("type=bind,")).every((value) => value.includes("readonly,bind-recursive=disabled"))).toBe(true);
  expect(args.some((value) => value.includes("bind-create-src") || value.includes("type=volume"))).toBe(false);
  checkNativeComposeStorageDockerCarrier({ value: fake.value, input: selected, program: fake.program, imageIds: [selected.artifact.imageId] });
});
test.each(["empty", "subset", "duplicate", "writable", "creating", "logging"] as const)("physical/configured projection %s cannot qualify a helper", (failure) => {
  const selected = input(), fake = carrier(selected);
  if (failure === "empty") fake.value.mounts = [];
  if (failure === "subset") fake.value.mounts.pop();
  if (failure === "duplicate") fake.value.mounts[1] = fake.value.mounts[0]!;
  if (failure === "writable") fake.value.mounts[1]!.RW = true;
  if (failure === "creating") fake.value.host.Mounts[1]!.BindOptions.CreateMountpoint = true;
  if (failure === "logging") fake.value.host.LogConfig.Type = "json-file";
  expect(() => checkNativeComposeStorageDockerCarrier({ value: fake.value, input: selected, program: fake.program, imageIds: [selected.artifact.imageId] })).toThrow("values omitted");
});
test("policy comparison preserves all physical fields/duplicates and closes only observed optional defaults", () => {
  const selected = input(), fake = carrier(selected);
  const checked = () => checkNativeComposeStorageDockerCarrier({ value: fake.value, input: selected, program: fake.program, imageIds: [selected.artifact.imageId] });
  const before = nativeComposeStorageDockerCarrierPolicy(checked());
  fake.value.mounts.reverse(); fake.value.host.OomKillDisable = null; fake.value.execIds = [];
  expect(nativeComposeStorageDockerCarrierPolicy(checked())).toBe(before);
  fake.value.host.OomKillDisable = true;
  expect(() => nativeComposeStorageDockerCarrierPolicy(checked())).toThrow();
});
