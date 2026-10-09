import { expect, test } from "bun:test";
import { join } from "node:path";
import { openNativeComposeGenerationStore } from "../src/lib/native-compose-generation.ts";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

const storage = { data: { kind: "persistent", scope: "worktree" } } as const;
// Each synthetic carrier has the ordinary finite 30s proof budget. The wrapper
// accommodates several real source-CLI transactions, not an unbounded helper.
function command(root: string, args = ["up", "--detach", "--json"]) {
  return invoke(root, args, 30_000, 60_000);
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
async function requests(root: string): Promise<string[][]> {
  return (await Bun.file(join(root, "requests")).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function operations(root: string) {
  return (await Bun.file(join(root, "storage-operations")).text())
    .trim()
    .split("\n");
}

test("source CLI cold enrollment precedes workload and down/up only verifies retained content", async () => {
  const root = await fixture("", false, { storage, noHooks: true });
  const up = await command(root);
  expect(up.code).toBe(0);
  expect(JSON.parse(up.stdout)).toMatchObject({
    ok: true,
    data: { status: "ready" },
  });
  const first = await saved(root);
  expect(first.storageWitnesses?.[0]).toMatchObject({
    state: "enrolled",
    reference: { version: 3, carrier: "directory-xattr" },
  });
  expect(first.pending).toBeNull();
  expect(first.storageWitnessesPending).toBe(false);
  expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
  const before = await Bun.file(join(root, "volumes")).text();
  const calls = await requests(root);
  const create = calls.findIndex((args) => args[0] === "volume" && args[1] === "create");
  const helper = calls.findIndex((args) => args[0] === "start");
  const workload = calls.findIndex((args) => args[0] === "compose" && args.includes("up"));
  expect(create).toBeGreaterThanOrEqual(0);
  expect(helper).toBeGreaterThan(create);
  expect(workload).toBeGreaterThan(helper);
  expect((await operations(root)).filter((op) => op === "seed")).toHaveLength(1);
  expect((await command(root, ["down", "--json"])).code).toBe(0);
  expect((await command(root)).code).toBe(0);
  expect(await Bun.file(join(root, "volumes")).text()).toBe(before);
  expect((await saved(root)).storageWitnesses).toEqual(first.storageWitnesses);
  expect((await operations(root)).filter((op) => op === "seed")).toHaveLength(1);
  expect((await requests(root)).filter((args) => args[0] === "volume" && args[1] === "create")).toHaveLength(1);
  expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
}, 120_000);

test("source CLI refuses SAME-birth empty replacement before hooks or another workload start", async () => {
  const root = await fixture("", false, { storage, noHooks: true });
  expect((await command(root)).code).toBe(0);
  expect((await command(root, ["down", "--json"])).code).toBe(0);
  const before = await saved(root);
  const volumes = await Bun.file(join(root, "volumes")).json();
  expect(volumes).toHaveLength(1);
  // Keep all metadata, birth and root facts; only content continuity disappears.
  volumes[0].attributes = {};
  await Bun.write(join(root, "volumes"), JSON.stringify(volumes));
  const result = await command(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("user.hack.storage.");
  expect((await requests(root)).filter((args) => args[0] === "compose" && args.includes("up"))).toHaveLength(1);
  expect((await operations(root)).filter((op) => op === "seed")).toHaveLength(1);
  expect(await Bun.file(join(root, "volumes")).json()).toEqual(volumes);
  expect((await saved(root)).storageWitnesses).toEqual(before.storageWitnesses);
  expect((await saved(root)).pending).toBeNull();
  expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
}, 120_000);

test.each(["helper-unavailable", "helper-wrong-platform"])("source CLI %s refuses before hooks, Expected or volume effects", async (missing) => {
  const root = await fixture('await Bun.write("after-ran","yes")', false, { storage });
  await Bun.write(join(root, missing), "true");
  const result = await command(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  expect(await Bun.file(join(root, "order")).exists()).toBe(false);
  expect(await Bun.file(join(root, "volumes")).exists()).toBe(false);
  expect(await Bun.file(join(root, "carriers")).exists()).toBe(false);
  const current = await saved(root);
  expect(current.pending).toBeNull();
  expect(current.storageWitnesses).toBeNull();
  expect((await requests(root)).some((args) => ["create", "start", "compose"].includes(args[0] ?? "") || (args[0] === "volume" && args[1] === "create"))).toBe(false);
}, 30_000);
