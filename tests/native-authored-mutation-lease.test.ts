import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeComposePrivateMutationLock } from "../src/lib/native-compose-private-state.ts";

test("native admission borrows the active material lease and cannot retain its guard", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-admission-lease-"))
  );
  try {
    const lock = createNativeComposePrivateMutationLock({
      lockPath: join(root, "mutation.lock"),
      recoveryPath: join(root, "mutation.recovery"),
      parent: undefined,
      check: () => Promise.resolve(),
    });
    let retained: (() => Promise<void>) | undefined;
    const result = await lock.withHeldLock(async (assertHeld) => {
      retained = assertHeld;
      await assertHeld();
      return "admitted";
    });
    expect(result).toBe("admitted");
    expect(await readdir(root)).toEqual([]);
    expect(retained).toBeDefined();
    if (!retained) {
      throw new Error("Expected the live admission guard");
    }
    await expect(retained()).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_STATE",
    });
    await lock.withLock(async (lease) => {
      await lease.assertHeld();
      expect(Object.isFrozen(lease)).toBe(true);
      await expect(retained?.()).rejects.toMatchObject({
        code: "E_NATIVE_COMPOSE_STATE",
      });
    });
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
