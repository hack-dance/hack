import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers/native-compose-command.ts";
import {
  command,
  createStorageActivationContext,
  disposition,
  operations,
  requests,
  saved,
  storage,
} from "./helpers/native-compose-storage-activation.ts";

const { ownedColdCase } = createStorageActivationContext();

test("source CLI refuses SAME-birth empty replacement before hooks or another workload start", async () => {
  const root = await fixture("", false, {
    storage,
    hooks: {
      up: {
        before: [
          { name: "before", command: { shell: 'printf "before\\n" >> order' } },
        ],
      },
    },
  });
  const initial = await command(root);
  expect(initial.code, await disposition(root, initial.code)).toBe(0);
  expect((await command(root, ["down", "--json"])).code).toBe(0);
  const before = await saved(root);
  const order = await Bun.file(join(root, "order")).text();
  const volumes = await Bun.file(join(root, "volumes")).json();
  expect(volumes).toHaveLength(1);
  // Keep all metadata, birth and root facts; only content continuity disappears.
  volumes[0].attributes = {};
  await Bun.write(join(root, "volumes"), JSON.stringify(volumes));
  const result = await command(root);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(
    "user.hack.storage."
  );
  expect(
    (await requests(root)).filter(
      (args) => args[0] === "compose" && args.includes("up")
    )
  ).toHaveLength(1);
  expect((await operations(root)).filter((op) => op === "seed")).toHaveLength(
    1
  );
  expect(await Bun.file(join(root, "volumes")).json()).toEqual(volumes);
  expect((await saved(root)).storageWitnesses).toEqual(before.storageWitnesses);
  expect((await saved(root)).pending).toBeNull();
  expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  expect(await Bun.file(join(root, "order")).text()).toBe(order);
  expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
}, 120_000);

test("AMD daemon reaches its image guard and refuses a mismatched ARM image", async () => {
  await ownedColdCase(async (owner) => {
    const root = await fixture("", false, {
      storage,
      cleanupAllowed: owner.cleanupAllowed,
    });
    // This synthetic daemon reports amd64 but returns the existing ARM image.
    await Bun.write(join(root, "helper-wrong-platform"), "true");
    const result = await owner.invoke(root, ["up", "--detach", "--json"]);
    const calls = await requests(root);
    const current = await saved(root);
    const imageInspections = calls.filter(
      (args) => args[0] === "image" && args[1] === "inspect"
    );
    const effects = calls.filter(
      (args) =>
        ["create", "start", "compose"].includes(args[0] ?? "") ||
        (args[0] === "volume" && args[1] === "create")
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "E_COMPOSE_FAILED" },
    });
    expect(effects).toHaveLength(0);
    expect(current.pending).toBeNull();
    expect(current.storageWitnesses).toBeNull();
    expect(await Bun.file(join(root, "order")).exists()).toBe(false);
    expect(
      calls.some(
        (args) => args[0] === "info" && args[2]?.includes(".Architecture")
      )
    ).toBe(true);
    // A qualified AMD catalog must pass platform selection and reach this image guard.
    expect(imageInspections).toHaveLength(1);
  });
}, 120_000);

test.each([
  "helper-unavailable",
  "helper-wrong-platform",
])("source CLI %s refuses before hooks, Expected or volume effects", async (missing) => {
  const root = await fixture('await Bun.write("after-ran","yes")', false, {
    storage,
  });
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
  expect(
    (await requests(root)).some(
      (args) =>
        ["create", "start", "compose"].includes(args[0] ?? "") ||
        (args[0] === "volume" && args[1] === "create")
    )
  ).toBe(false);
}, 30_000);
