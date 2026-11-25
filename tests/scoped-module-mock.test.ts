import { afterAll, expect, spyOn, test } from "bun:test";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

/**
 * HACK-2650. An object export (such as `logger`) that one test file mocks with
 * `registerScopedModuleMock` must still accept `spyOn` from any other file in
 * the same `bun test` process. The wrapper used to be a Proxy, which Bun's
 * `spyOn` leaves unchanged: `spyOn(logger, "warn")` then recorded no calls, and
 * `tests/global-command.macos.test.ts` failed whenever it shared a process with
 * a file that mocked the logger.
 */

const overrideCalls: string[] = [];
const mocked = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "./fixtures/scoped-mock-target.ts",
  overrides: {
    recorder: {
      label: "override",
      record: (message: string) => {
        overrideCalls.push(message);
        return `override:${message}`;
      },
    },
  },
});
const target = await import("./fixtures/scoped-mock-target.ts");

afterAll(() => {
  mocked.deactivate();
});

test("while inactive, calls reach the real export and a spy records them", () => {
  const before = target.recorder.record;
  const spy = spyOn(target.recorder, "record");
  try {
    expect(target.recordThroughImport("one")).toBe("real:one");
    expect(spy).toHaveBeenCalledWith("one");
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
  // Restored: the forwarding method is back and calls still reach the real export.
  expect(target.recorder.record).toBe(before);
  expect(target.recordThroughImport("two")).toBe("real:two");
  expect(target.recorder.label).toBe("real");
});

test("while active, calls reach the override, and a spy still records them", () => {
  mocked.activate();
  try {
    const spy = spyOn(target.recorder, "record");
    try {
      expect(target.recordThroughImport("three")).toBe("override:three");
      expect(spy).toHaveBeenCalledWith("three");
    } finally {
      spy.mockRestore();
    }
    expect(overrideCalls).toEqual(["three"]);
    expect(target.recorder.label).toBe("override");
  } finally {
    mocked.deactivate();
  }
  expect(target.recordThroughImport("four")).toBe("real:four");
  expect(overrideCalls).toEqual(["three"]);
});
