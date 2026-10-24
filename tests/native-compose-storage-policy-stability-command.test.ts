import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture, invoke } from "./helpers/native-compose-command.ts";

const storage = { data: { kind: "persistent", scope: "worktree" } } as const;

// The first `up` enrolls cold storage through real helper carriers on the
// synthetic daemon. Its first carrier is policy-inspected after creation (1),
// before start (2), at start admission (3), after it stopped (4), once more
// (5) and at removal admission (6). The chosen inspection observes a replaced
// carrier: a new creation time under the same ID. That mismatch has its own
// observed reason, so even a refusal caught after the carrier deadline cannot
// be reported as the storage budget.
test.each([
  ["before its start", 2],
  ["at its start admission", 3],
  ["after it stopped", 4],
  ["on its repeated stopped inspection", 5],
  ["at its removal admission", 6],
] as const)(
  "a helper carrier replaced %s refuses with its policy stability reason",
  async (_, inspection) => {
    const root = await fixture("", false, { storage, noHooks: true });
    await Bun.write(join(root, "fault-carrier-replaced"), String(inspection));
    const result = await invoke(
      root,
      ["up", "--detach", "--json"],
      30_000,
      120_000
    );
    expect(
      Number(await Bun.file(join(root, "carrier-policy-inspects")).text())
    ).toBe(inspection);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        detail: {
          native_compose_effect_refusal: {
            stage: "storage-helper-policy",
            reason: "helper-policy-stability",
          },
        },
      },
    });
    // No workload started.
    expect(await Bun.file(join(root, "engine")).exists()).toBe(false);
  },
  150_000
);
