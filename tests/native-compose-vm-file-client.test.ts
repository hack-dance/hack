import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeComposeVmFileClient } from "../src/lib/native-compose-vm-file-client.ts";
import { VM_ENGINE, vmFileFixture } from "./helpers/native-compose-vm-files.ts";

function absent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return true;
    }
    throw error;
  }
}
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Owned child did not reach its expected lifetime boundary."
      );
    }
    await Bun.sleep(10);
  }
}
async function pid(root: string, name: string): Promise<number> {
  const row: unknown = JSON.parse(
    await readFile(join(root, `${name}.json`), "utf8")
  );
  if (
    typeof row !== "object" ||
    row === null ||
    !("pid" in row) ||
    typeof row.pid !== "number" ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 1
  ) {
    throw new Error("Invalid private child identity.");
  }
  return row.pid;
}
test("normal complete VM child and post-completion source refusal never signal a former group", async () => {
  const fixture = await vmFileFixture();
  let fresh = 0;
  const kill = spyOn(process, "kill");
  try {
    const client = createNativeComposeVmFileClient({
      engineId: VM_ENGINE,
      signal: new AbortController().signal,
      deadline: Date.now() + 2000,
      assertFresh: async () => {
        if (++fresh === 2) {
          throw new Error("Synthetic source drift.");
        }
      },
    });
    await expect(
      client.call(["synthetic-lifetime", "complete"])
    ).rejects.toThrow("Synthetic source drift.");
    const leader = await pid(fixture.root, "leader");
    expect(absent(leader)).toBe(true);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  } finally {
    kill.mockRestore();
  }
}, 5000);

test("cancellation retains group cleanup after the leader exits with an inherited pipe keeper", async () => {
  const fixture = await vmFileFixture();
  const abort = new AbortController();
  const kill = spyOn(process, "kill");
  try {
    const client = createNativeComposeVmFileClient({
      engineId: VM_ENGINE,
      signal: abort.signal,
      deadline: Date.now() + 2000,
      assertFresh: async () => {},
    });
    const outcome = client.call(["synthetic-lifetime", "held-pipe"]).then(
      () => true,
      () => false
    );
    await until(
      async () => await Bun.file(join(fixture.root, "keeper.json")).exists()
    );
    const leader = await pid(fixture.root, "leader"),
      keeper = await pid(fixture.root, "keeper");
    await until(async () => absent(leader));
    expect(absent(keeper)).toBe(false);
    abort.abort();
    expect(await outcome).toBe(false);
    await until(async () => absent(keeper));
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-leader, "SIGKILL"],
    ]);
  } finally {
    abort.abort();
    kill.mockRestore();
  }
}, 5000);

test.each([
  "overflow",
  "hold",
] as const)("VM %s refuses finitely and reaps its owned leader", async (mode) => {
  const fixture = await vmFileFixture();
  const kill = spyOn(process, "kill");
  const started = Date.now();
  try {
    const client = createNativeComposeVmFileClient({
      engineId: VM_ENGINE,
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      assertFresh: async () => {},
    });
    await expect(client.call(["synthetic-lifetime", mode])).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
    const leader = await pid(fixture.root, "leader");
    expect(absent(leader)).toBe(true);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-leader, "SIGKILL"],
    ]);
    const before = await fixture.commands();
    await expect(
      client.call(["synthetic-lifetime", "complete"])
    ).rejects.toThrow();
    expect(await fixture.commands()).toEqual(before);
  } finally {
    kill.mockRestore();
  }
}, 5000);

test("a surviving closed-pipe descendant permanently refuses the client without former-group signals", async () => {
  const fixture = await vmFileFixture();
  const kill = spyOn(process, "kill");
  try {
    const client = createNativeComposeVmFileClient({
      engineId: VM_ENGINE,
      signal: new AbortController().signal,
      deadline: Date.now() + 3000,
      assertFresh: async () => {},
    });
    await expect(
      client.call(["synthetic-lifetime", "closed-pipe"])
    ).rejects.toThrow();
    const leader = await pid(fixture.root, "leader"),
      keeper = await pid(fixture.root, "keeper");
    expect(absent(leader)).toBe(true);
    expect(absent(keeper)).toBe(false);
    const before = await fixture.commands();
    await expect(
      client.call(["synthetic-lifetime", "complete"])
    ).rejects.toThrow();
    expect(await fixture.commands()).toEqual(before);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    // The fixture's known finite keeper exits itself; the client has disarmed
    // signal authority after leader and both pipes completed.
    await until(async () => absent(keeper));
  } finally {
    kill.mockRestore();
  }
}, 5000);
