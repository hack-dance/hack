import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers/native-compose-command.ts";
import {
  createStorageActivationContext,
  disposition,
  operations,
  storage,
} from "./helpers/native-compose-storage-activation.ts";

const { ownedColdCase } = createStorageActivationContext();

// One proof is root, verify and root-after through three fresh helper carriers.
// Warm up/restart keep the opening and both effect-phase proofs. The warm
// enrollment tail (no new volume) and then the first pre-spawn guard (no build,
// routing or file material) reuse the adjacent effect-entry proof. With no
// route, after hook or file material, finalization keeps one fresh
// post-workload proof. Saved exec keeps its opening proof, reuses it for the
// adjacent pre-spawn check and proves again after the process. A cold up seeds
// once and proves its new volume in full. Consecutive warm ups cost the same.
test(
  "source CLI helper invocations per command keep every non-adjacent proof",
  async () =>
    await ownedColdCase(async (owner) => {
      const root = await fixture("", false, {
        storage,
        noHooks: true,
        cleanupAllowed: owner.cleanupAllowed,
      });
      const eventsFile = join(root, "storage-events");
      const events = async () =>
        (await Bun.file(eventsFile).exists())
          ? (await Bun.file(eventsFile).text()).trim().split("\n")
          : [];
      const counted = async (args: readonly string[]) => {
        const before = (await events()).length;
        const result = await owner.invoke(root, args);
        expect(result.code, await disposition(root, result.code)).toBe(0);
        return (await events()).slice(before);
      };
      const proofs = (count: number) =>
        Array.from({ length: count }, () => ["root", "verify", "root"]).flat();
      expect(await counted(["up", "--detach", "--json"])).toEqual([
        "root",
        "seed",
        ...proofs(3),
        "workload",
        ...proofs(1),
      ]);
      expect(await counted(["up", "--detach", "--json"])).toEqual([
        ...proofs(3),
        "workload",
        ...proofs(1),
      ]);
      expect(await counted(["up", "--detach", "--json"])).toEqual([
        ...proofs(3),
        "workload",
        ...proofs(1),
      ]);
      expect(await counted(["exec", "web", "--", "true"])).toEqual([
        ...proofs(1),
        "exec",
        ...proofs(1),
      ]);
      expect(await counted(["restart", "--json"])).toEqual([
        ...proofs(3),
        "workload",
        ...proofs(1),
      ]);
      expect(
        (await operations(root)).filter((op) => op === "seed")
      ).toHaveLength(1);
      expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
    }),
  390_000
);
