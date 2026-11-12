import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers/native-compose-command.ts";
import {
  COMMAND_CAPTURE_TIMEOUT_MS,
  createStorageActivationContext,
  disposition,
  STORAGE_PROOF_TIMEOUT_MS,
  storage,
} from "./helpers/native-compose-storage-activation.ts";

const { ownedColdCase } = createStorageActivationContext();

// Negative control for the single finalization pass: an after hook is a host
// effect between readiness and the ready receipt, so its effect phases keep
// their proofs and finalization keeps its second fresh proof after the
// completion step. The eight post-workload proofs equal the count before
// proof reuse; only the warm enrollment tail drops (six to five before the
// workload).
test(
  "source CLI warm up with an after hook keeps both finalization proofs",
  async () =>
    await ownedColdCase(
      async (owner) => {
        const root = await fixture("", false, {
          storage,
          hooks: {
            up: {
              after: [
                {
                  name: "after",
                  command: { exec: [process.execPath, "-e", "0"] },
                },
              ],
            },
          },
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
          Array.from({ length: count }, () => [
            "root",
            "verify",
            "root",
          ]).flat();
        expect(await counted(["up", "--detach", "--json"])).toEqual([
          "root",
          "seed",
          ...proofs(3),
          "workload",
          ...proofs(8),
        ]);
        expect(await counted(["up", "--detach", "--json"])).toEqual([
          ...proofs(5),
          "workload",
          ...proofs(8),
        ]);
        expect(await Bun.file(join(root, "carriers")).json()).toEqual([]);
      },
      {
        // The after-hook finalization adds another bounded witness proof. The
        // capture must cover it without changing the per-proof deadline/counts.
        commandCaptureTimeoutMs:
          COMMAND_CAPTURE_TIMEOUT_MS + STORAGE_PROOF_TIMEOUT_MS,
      }
    ),
  390_000
);
