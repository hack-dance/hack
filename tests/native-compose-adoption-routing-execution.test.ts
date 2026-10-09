import { afterEach, expect, spyOn, test } from "bun:test";
import type { LegacyComposeVerifiedBinding } from "../src/lib/native-compose-adoption-binding.ts";
import {
  consumeLegacyComposeRoutingCompletion,
  runLegacyComposeRetainedRoutingOperation,
} from "../src/lib/native-compose-adoption-routing-execution.ts";
import * as shell from "../src/lib/shell.ts";

const ID = "a".repeat(64),
  OTHER = "b".repeat(64),
  GROUP = 987_654;
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});
function input(assertFresh: () => Promise<void> = async () => {}) {
  // Transport-only boundary: the generation tests separately issue this binding.
  const binding = {
    binding_version: 14,
    projectRoot: "/synthetic/retained-routing",
    containers: [{ id: ID }, { id: OTHER }],
  } as unknown as LegacyComposeVerifiedBinding;
  return { binding, assertFresh, assertActive: () => {} };
}
function missing(): never {
  throw Object.assign(new Error("absent"), { code: "ESRCH" });
}
function owner(code = 0, afterAdmission?: () => void) {
  const calls: { argv: readonly string[]; options: shell.RunOptions }[] = [];
  spies.push(
    spyOn(shell, "run").mockImplementation(async (argv, options = {}) => {
      options.beforeSpawn?.();
      afterAdmission?.();
      calls.push({ argv: [...argv], options });
      await options.onSpawn?.({
        pid: GROUP,
        ownsProcessGroup: true,
        processGroupId: GROUP,
      });
      return code;
    })
  );
  return calls;
}
test("known child return plus ESRCH issues only a one-use completion for the original callback", async () => {
  const calls = owner(17),
    probes: number[] = [];
  spies.push(
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      probes.push(pid);
      expect(signal).toBe(0);
      return missing();
    })
  );
  const selected = input(),
    deadline = Date.now() + 1000;
  const outcome = await runLegacyComposeRetainedRoutingOperation({
    input: selected,
    operation: "start",
    deadline,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.argv).toEqual(["docker", "container", "start", ID, OTHER]);
  expect(calls[0]?.options).toMatchObject({
    cwd: selected.binding.projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(calls[0]?.options.forwardSignals).toBeUndefined();
  expect(probes).toEqual([-GROUP]);
  for (const invalid of [17, {}, { ...outcome }]) {
    expect(() =>
      consumeLegacyComposeRoutingCompletion({
        outcome: invalid,
        input: selected,
        operation: "start",
        deadline,
      })
    ).toThrow(/uncertain/);
  }
  expect(() =>
    consumeLegacyComposeRoutingCompletion({
      outcome,
      input: { ...selected },
      operation: "start",
      deadline,
    })
  ).toThrow(/uncertain/);
  expect(() =>
    consumeLegacyComposeRoutingCompletion({
      outcome,
      input: selected,
      operation: "stop",
      deadline,
    })
  ).toThrow(/uncertain/);
  expect(
    consumeLegacyComposeRoutingCompletion({
      outcome,
      input: selected,
      operation: "start",
      deadline,
    })
  ).toBe(17);
  expect(() =>
    consumeLegacyComposeRoutingCompletion({
      outcome,
      input: selected,
      operation: "start",
      deadline,
    })
  ).toThrow(/uncertain/);
});
test("wrapper return does not prove peer absence; bounded observation accepts only later ESRCH", async () => {
  owner();
  let reads = 0;
  spies.push(
    spyOn(process, "kill").mockImplementation(() => {
      if (++reads < 3) {
        return true;
      }
      return missing();
    })
  );
  const selected = input(),
    deadline = Date.now() + 1000;
  const outcome = await runLegacyComposeRetainedRoutingOperation({
    input: selected,
    operation: "stop",
    deadline,
  });
  expect(reads).toBe(3);
  expect(
    consumeLegacyComposeRoutingCompletion({
      outcome,
      input: selected,
      operation: "stop",
      deadline,
    })
  ).toBe(0);
});
for (const code of ["EPERM", "EIO"]) {
  test(`group ${code} remains unknown and cannot issue a completion`, async () => {
    owner();
    spies.push(
      spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("private"), { code });
      })
    );
    await expect(
      runLegacyComposeRetainedRoutingOperation({
        input: input(),
        operation: "stop",
        deadline: Date.now() + 1000,
      })
    ).rejects.toThrow(/uncertain/);
  });
}
test("retained peer at the captured deadline refuses without sending any signal", async () => {
  const calls = owner();
  const probes: unknown[] = [];
  spies.push(
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      probes.push([pid, signal]);
      return true;
    })
  );
  await expect(
    runLegacyComposeRetainedRoutingOperation({
      input: input(),
      operation: "stop",
      deadline: Date.now() + 80,
    })
  ).rejects.toThrow(/uncertain/);
  expect(calls).toHaveLength(1);
  expect(probes.length).toBeGreaterThan(0);
  expect(
    probes.every(
      (value) => JSON.stringify(value) === JSON.stringify([-GROUP, 0])
    )
  ).toBe(true);
});
test("cancellation during final source admission has zero child effects", async () => {
  const calls = owner(),
    controller = new AbortController();
  await expect(
    runLegacyComposeRetainedRoutingOperation({
      input: input(async () => {
        controller.abort();
      }),
      operation: "start",
      deadline: Date.now() + 1000,
      signal: controller.signal,
    })
  ).rejects.toThrow(/uncertain/);
  expect(calls).toEqual([]);
});
test("child IDs and working directory are captured before the final source await", async () => {
  const selected = input(async () => {
    Reflect.set(selected.binding, "projectRoot", "/foreign");
    Reflect.set(selected.binding, "containers", [{ id: "c".repeat(64) }]);
  });
  const calls = owner();
  spies.push(spyOn(process, "kill").mockImplementation(missing));
  await runLegacyComposeRetainedRoutingOperation({
    input: selected,
    operation: "start",
    deadline: Date.now() + 1000,
  });
  expect(calls[0]?.argv).toEqual(["docker", "container", "start", ID, OTHER]);
  expect(calls[0]?.options.cwd).toBe("/synthetic/retained-routing");
});
test("the synchronous spawn fence refuses a callback revoked after fresh admission", async () => {
  const selected = input();
  let active = true;
  let child = 0;
  selected.assertActive = () => {
    if (!active) {
      throw new Error("revoked; values omitted");
    }
  };
  spies.push(
    spyOn(shell, "run").mockImplementation(async (_argv, options = {}) => {
      await Promise.resolve();
      active = false;
      options.beforeSpawn?.();
      child++;
      return 0;
    })
  );
  await expect(
    runLegacyComposeRetainedRoutingOperation({
      input: selected,
      operation: "start",
      deadline: Date.now() + 1000,
    })
  ).rejects.toThrow("revoked");
  expect(child).toBe(0);
});
