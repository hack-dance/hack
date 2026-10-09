import { expect, test } from "bun:test";
import {
  assertNativeAuthoredOriginalGroupAbsent,
  assertNativeAuthoredProcessQuiescent,
  captureNativeAuthoredProcessIncarnation,
  classifyNativeAuthoredSessionFailure,
  mergeNativeAuthoredProcessCensuses,
  parseNativeAuthoredProcessCensus,
  parseNativeAuthoredProcessIncarnation,
  requireNativeAuthoredProcessQuiescent,
} from "../src/backends/native-authored-process-incarnation.ts";

const row = {
  pid: 123,
  parent: 45,
  group: 123,
  session: "123",
  state: "live" as const,
  uid: 501,
  birth: "Fri Oct 9 12:00:00 2026",
  executable: "/bin/sleep",
};
const original = {
  ...row,
  platform: "darwin" as const,
  boot: "12345678-abcd-abcd-abcd-123456789abc",
  image: { path: "/bin/sleep", dev: "1", ino: "2" },
  selected: { path: "/bin/sleep", dev: "1", ino: "2" },
};
test("unavailable live SID diagnostic distinguishes disappearance from reuse and refuses to infer membership", () => {
  expect(classifyNativeAuthoredSessionFailure(row, [])).toBe("disappeared");
  expect(classifyNativeAuthoredSessionFailure(row, [row])).toBe(
    "same-live-SID-unavailable"
  );
  for (const changed of [
    { ...row, birth: "Thu Oct 8 12:00:00 2026" },
    { ...row, parent: 46 },
    { ...row, group: 124 },
    { ...row, uid: 502 },
    { ...row, executable: "/private-canary" },
    { ...row, state: "zombie" as const },
  ]) {
    expect(classifyNativeAuthoredSessionFailure(row, [changed])).toBe(
      "changed"
    );
  }
});
test("strict complete process census refuses malformed, duplicate, truncated and missing observations", () => {
  const text = " 123 45 123 123 501 S Fri Oct 9 12:00:00 2026 /bin/sleep\n";
  expect(parseNativeAuthoredProcessCensus(text)).toEqual([row]);
  expect(
    parseNativeAuthoredProcessCensus(text.replace(" 501 ", " -2 "))[0]?.uid
  ).toBe(-2);
  for (const value of [
    "",
    text.trimEnd(),
    text + text,
    "garbage\n",
    text.replace(" S ", " Zunknown "),
    text.replace("123 45", "NaN 45"),
  ]) {
    expect(() => parseNativeAuthoredProcessCensus(value)).toThrow();
  }
});
test("any reused original PID, foreign group or same session vetoes absence", () => {
  const value = parseNativeAuthoredProcessIncarnation(original);
  const unrelated = { ...row, pid: 77, group: 77, session: "77" };
  expect(() =>
    requireNativeAuthoredProcessQuiescent(value, [unrelated])
  ).not.toThrow();
  for (const attack of [
    { ...unrelated, pid: value.pid, birth: "Thu Oct 8 12:00:00 2026" },
    { ...unrelated, group: value.group },
    { ...unrelated, session: value.session },
  ]) {
    expect(() =>
      requireNativeAuthoredProcessQuiescent(value, [attack])
    ).toThrow();
  }
});
test("incarnation qualifier is closed and canonical", () => {
  expect(parseNativeAuthoredProcessIncarnation(original)).toEqual(original);
  for (const value of [
    { ...original, extra: true },
    { ...original, boot: `${original.boot}\n` },
    { ...original, birth: `${original.birth}\n` },
    { ...original, selected: { ...original.selected, path: "/bin/sleep\n" } },
    { ...original, image: { ...original.image, ino: "2\n" } },
    { ...original, group: 124 },
    { ...original, session: "0" },
    { ...original, platform: "unknown" },
  ]) {
    expect(() => parseNativeAuthoredProcessIncarnation(value)).toThrow();
  }
});
test("original capture uses its live session and group-only settlement does not claim complete recovery census", async () => {
  const child = Bun.spawn(["/bin/sleep", "30"], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const value = await captureNativeAuthoredProcessIncarnation({
      pid: child.pid,
      selected: "/bin/sleep",
    });
    await expect(
      assertNativeAuthoredProcessQuiescent(value, () => 3000)
    ).rejects.toThrow();
    child.kill("SIGKILL");
    expect(await child.exited).toBeGreaterThan(0);
    await assertNativeAuthoredOriginalGroupAbsent(value);
    const observation = await assertNativeAuthoredProcessQuiescent(
      value,
      () => 3000
    );
    expect(observation.kind).toBe("no-live-members");
    expect(observation.unresolvedZombies).toBeGreaterThanOrEqual(0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
}, 10_000);

test("zombie SID uncertainty is explicit and requires stable identity across both observations", () => {
  const zombie = {
    ...row,
    pid: 77,
    group: 77,
    state: "zombie" as const,
    session: null,
  };
  const value = parseNativeAuthoredProcessIncarnation(original);
  expect(mergeNativeAuthoredProcessCensuses([zombie], [zombie])).toEqual([
    zombie,
  ]);
  expect(() =>
    requireNativeAuthoredProcessQuiescent(value, [zombie])
  ).not.toThrow();
  for (const after of [
    [],
    [{ ...zombie, state: "live" as const }],
    [{ ...zombie, birth: "Thu Oct 8 12:00:00 2026" }],
    [{ ...zombie, uid: 502 }],
  ]) {
    expect(() => mergeNativeAuthoredProcessCensuses([zombie], after)).toThrow();
  }
  expect(() => mergeNativeAuthoredProcessCensuses([], [zombie])).toThrow();
  expect(() =>
    requireNativeAuthoredProcessQuiescent(value, [
      { ...zombie, pid: value.pid },
    ])
  ).toThrow();
  expect(() =>
    requireNativeAuthoredProcessQuiescent(value, [
      { ...zombie, state: "live", session: null },
    ])
  ).toThrow();
});
