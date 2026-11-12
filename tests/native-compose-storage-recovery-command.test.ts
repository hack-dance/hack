import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers/native-compose-command.ts";
import {
  createStorageActivationContext,
  operations,
  requests,
  saved,
  storage,
} from "./helpers/native-compose-storage-activation.ts";

const { ownedColdCase } = createStorageActivationContext();

test("public down recover completes only removed readonly original work and next up retains the same volume", async () => {
  await ownedColdCase(async (owner) => {
    const root = await fixture("", false, {
      storage,
      noHooks: true,
      cleanupAllowed: owner.cleanupAllowed,
    });
    let passed = false;
    try {
      const initial = await owner.invoke(root, ["up", "--detach", "--json"]);
      if (initial.code !== 0) {
        owner.retain();
      }
      const trace = initial.stderr
        .split("\n")
        .filter((line) => line.includes('"diagnostic":"native-compose-phase"'));
      expect(initial.code, JSON.stringify({ code: initial.code, trace })).toBe(
        0
      );
      const volumes = await Bun.file(join(root, "volumes")).text();
      await Bun.write(join(root, "fault-removed-verify"), "1");
      const interrupted = await owner.invoke(root, ["restart", "--json"]);
      expect(interrupted.code).not.toBe(0);
      expect(
        await Bun.file(join(root, "fault-removed-evidence")).exists()
      ).toBe(true);
      const pending = await saved(root);
      expect(pending.storageWitnessesPending).toBe(true);
      expect(pending.pending).not.toBeNull();
      expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
      const calls = await requests(root),
        attempts = (await operations(root)).length;
      const recovered = await owner.invoke(root, [
        "down",
        "--recover",
        "--json",
      ]);
      expect(recovered.code).toBe(0);
      const after = await saved(root);
      expect(after.pending).toBeNull();
      expect(after.storageWitnessesPending).toBe(false);
      expect(after.storageWitnesses).toEqual(pending.storageWitnesses);
      expect((await operations(root)).length).toBe(attempts);
      expect(
        (await requests(root))
          .slice(calls.length)
          .some((a) => ["create", "start", "rm", "exec"].includes(a[0] ?? ""))
      ).toBe(false);
      expect(await Bun.file(join(root, "volumes")).text()).toBe(volumes);
      expect(
        (await owner.invoke(root, ["up", "--detach", "--json"])).code
      ).toBe(0);
      expect(await Bun.file(join(root, "volumes")).text()).toBe(volumes);
      expect(
        (await operations(root)).filter((op) => op === "seed")
      ).toHaveLength(1);
      passed = true;
    } finally {
      if (!passed) {
        owner.retain();
      }
    }
  });
}, 500_000);
