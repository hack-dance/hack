import { expect, spyOn, test } from "bun:test";
import { createNativeAuthoredStartHarness } from "./helpers/native-authored-start-fixture.ts";

const { groupEnded } = createNativeAuthoredStartHarness();

test("native cancellation fixture waits through EPERM until the group is reaped", async () => {
  let probes = 0;
  const probe = spyOn(process, "kill").mockImplementation((pid, signal) => {
    expect(pid).toBe(-42);
    expect(signal).toBe(0);
    probes += 1;
    throw Object.assign(new Error("fixture probe"), {
      code: probes === 1 ? "EPERM" : "ESRCH",
    });
  });
  try {
    expect(await groupEnded(42)).toBe(true);
    expect(probes).toBe(2);
  } finally {
    probe.mockRestore();
  }
});

test("native cancellation fixture retains unexpected probe failures", async () => {
  const probe = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("fixture probe"), { code: "EINVAL" });
  });
  try {
    await expect(groupEnded(42)).rejects.toThrow("fixture probe");
  } finally {
    probe.mockRestore();
  }
});
