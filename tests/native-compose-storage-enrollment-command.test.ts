import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers/native-compose-command.ts";
import {
  createStorageActivationContext,
  disposition,
  operations,
  requests,
  saved,
  storage,
} from "./helpers/native-compose-storage-activation.ts";

const { ownedColdCase } = createStorageActivationContext();

test(
  "source CLI cold enrollment precedes workload and down/up only verifies retained content",
  async () =>
    await ownedColdCase(async (owner) => {
      const root = await fixture("", false, {
        storage,
        noHooks: true,
        cleanupAllowed: owner.cleanupAllowed,
      });
      const up = await owner.invoke(root, ["up", "--detach", "--json"]);
      expect(up.code, await disposition(root, up.code)).toBe(0);
      expect(JSON.parse(up.stdout)).toMatchObject({
        ok: true,
        data: { status: "ready" },
      });
      const first = await saved(root);
      expect(first.storageWitnesses?.[0]).toMatchObject({
        state: "enrolled",
        reference: { version: 3, kind: "directory-xattr" },
      });
      expect(first.pending).toBeNull();
      expect(first.storageWitnessesPending).toBe(false);
      expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
      const before = await Bun.file(join(root, "volumes")).text();
      const calls = await requests(root);
      const create = calls.findIndex(
        (args) => args[0] === "volume" && args[1] === "create"
      );
      const helper = calls.findIndex((args) => args[0] === "start");
      const workload = calls.findIndex(
        (args) => args[0] === "compose" && args.includes("up")
      );
      expect(create).toBeGreaterThanOrEqual(0);
      expect(helper).toBeGreaterThan(create);
      expect(workload).toBeGreaterThan(helper);
      const events = (await Bun.file(join(root, "storage-events")).text())
        .trim()
        .split("\n");
      expect(events.indexOf("seed")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("workload")).toBeGreaterThan(
        events.indexOf("seed")
      );
      expect(
        (await operations(root)).filter((op) => op === "seed")
      ).toHaveLength(1);
      expect((await owner.invoke(root, ["down", "--json"])).code).toBe(0);
      expect(
        (await owner.invoke(root, ["up", "--detach", "--json"])).code
      ).toBe(0);
      expect(await Bun.file(join(root, "volumes")).text()).toBe(before);
      expect((await saved(root)).storageWitnesses).toEqual(
        first.storageWitnesses
      );
      expect(
        (await operations(root)).filter((op) => op === "seed")
      ).toHaveLength(1);
      expect(
        (await requests(root)).filter(
          (args) => args[0] === "volume" && args[1] === "create"
        )
      ).toHaveLength(1);
      expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
    }),
  390_000
);
