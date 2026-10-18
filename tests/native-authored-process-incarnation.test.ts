import { expect, spyOn, test } from "bun:test";
import {
  assertNativeAuthoredOriginalGroupAbsent,
  assertNativeAuthoredProcessQuiescent,
  captureNativeAuthoredProcessIncarnation,
  classifyNativeAuthoredSessionFailure,
  isCapturedNativeAuthoredProcess,
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
test("transient '?' census rows are admitted, vetoed like live rows and never owners", () => {
  const live = " 123 45 123 123 501 S Fri Oct 9 12:00:00 2026 /bin/sleep\n";
  const transient =
    " 456 1 456 456 501 ?N Fri Oct 9 12:00:00 2026 /private-transient-canary\n";
  const zombie = " 789 1 789 789 501 Z Fri Oct 9 12:00:00 2026 /bin/sleep\n";
  const rows = parseNativeAuthoredProcessCensus(live + transient + zombie);
  expect(rows.map((item) => item.state)).toEqual([
    "live",
    "transient",
    "zombie",
  ]);
  const [, observed] = rows;
  if (observed === undefined) {
    throw new Error("Transient census row was not observed.");
  }
  for (const token of ["?", "?N", "?E", "?Ns", "?<"]) {
    expect(
      parseNativeAuthoredProcessCensus(
        transient.replace(" ?N ", ` ${token} `)
      )[0]?.state
    ).toBe("transient");
  }
  for (const token of ["N?", "??", "?Z", "?x", "-"]) {
    expect(() =>
      parseNativeAuthoredProcessCensus(transient.replace(" ?N ", ` ${token} `))
    ).toThrow();
  }
  let failure: unknown;
  try {
    parseNativeAuthoredProcessIncarnation({ ...original, ...observed });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain("transient-canary");
  expect(String(failure)).not.toContain("456");
  const value = parseNativeAuthoredProcessIncarnation(original);
  expect(() =>
    requireNativeAuthoredProcessQuiescent(value, [observed])
  ).not.toThrow();
  for (const attack of [
    { ...observed, pid: value.pid },
    { ...observed, group: value.group },
    { ...observed, session: value.session },
    { ...observed, session: null },
  ]) {
    expect(() =>
      requireNativeAuthoredProcessQuiescent(value, [attack])
    ).toThrow();
  }
  expect(mergeNativeAuthoredProcessCensuses([observed], [observed])).toEqual([
    observed,
  ]);
  for (const after of [
    [{ ...observed, state: "live" as const }],
    [{ ...observed, state: "zombie" as const, session: null }],
  ]) {
    expect(() =>
      mergeNativeAuthoredProcessCensuses([observed], after)
    ).toThrow();
  }
  expect(() =>
    mergeNativeAuthoredProcessCensuses(
      [{ ...observed, session: null }],
      [{ ...observed, session: null }]
    )
  ).toThrow();
  expect(
    classifyNativeAuthoredSessionFailure({ ...observed, state: "live" }, [
      observed,
    ])
  ).toBe("changed");
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

/** Synthetic host-wide listings for a real detached child. Only the `ps -Aww`
 * census child is replaced by a finite printf; boot, image and SID observations
 * stay real. Each consumed frame may advance the monotonic clock by `settleMs`. */
async function withCensusFrames(
  options: { readonly frames: readonly string[]; readonly settleMs?: number },
  body: (calls: () => number) => Promise<void>
): Promise<void> {
  const frames = [...options.frames];
  const settleMs = options.settleMs ?? 0;
  const spawn = Bun.spawn;
  const now = performance.now.bind(performance);
  let offset = 0;
  let calls = 0;
  const clock = spyOn(performance, "now").mockImplementation(
    () => now() + offset
  );
  const child = spyOn(Bun, "spawn").mockImplementation(
    (command: unknown, options?: unknown) => {
      if (
        !(
          Array.isArray(command) &&
          command[0] === "/bin/ps" &&
          command[1] === "-Aww"
        )
      ) {
        return spawn(
          command as string[],
          options as Bun.SpawnOptions.OptionsObject<"ignore", "pipe", "ignore">
        );
      }
      const text = frames[calls++];
      if (text === undefined) {
        throw new Error("Unexpected census child admission; values omitted.");
      }
      const captured = spawn(["/usr/bin/printf", "%s", text], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      void captured.exited.then(
        () => {
          offset += settleMs;
        },
        () => undefined
      );
      return captured;
    }
  );
  try {
    await body(() => calls);
  } finally {
    child.mockRestore();
    clock.mockRestore();
  }
}
const FOREIGN_TRANSIENT =
  " 9 1 9 0 0 ?N Fri Oct 9 12:00:00 2026 /private-transient-canary\n";
function listing(pid: number, state: string, foreign = ""): string {
  const uid = process.getuid?.() ?? 0;
  return `${foreign} ${pid} ${process.pid} ${pid} 0 ${uid} ${state} Fri Oct 9 12:00:00 2026 /bin/sleep\n`;
}
const macTest = test.skipIf(process.platform !== "darwin");
macTest(
  "original capture re-observes a transient row of interest and ignores foreign transient rows",
  async () => {
    const child = Bun.spawn(["/bin/sleep", "30"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await withCensusFrames(
        {
          frames: [
            listing(child.pid, "?N"),
            listing(child.pid, "?", FOREIGN_TRANSIENT),
            listing(child.pid, "S", FOREIGN_TRANSIENT),
            listing(child.pid, "S", FOREIGN_TRANSIENT),
          ],
        },
        async (calls) => {
          const value = await captureNativeAuthoredProcessIncarnation({
            pid: child.pid,
            selected: "/bin/sleep",
          });
          expect(calls()).toBe(4);
          expect(isCapturedNativeAuthoredProcess(value)).toBe(true);
          expect(value.pid).toBe(child.pid);
          expect(value.state).toBe("live");
        }
      );
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  },
  10_000
);
macTest(
  "original capture refuses a persistently transient or absent row of interest",
  async () => {
    const child = Bun.spawn(["/bin/sleep", "30"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await withCensusFrames(
        {
          frames: [
            listing(child.pid, "?N"),
            listing(child.pid, "?N"),
            listing(child.pid, "S"),
          ],
          settleMs: 1500,
        },
        async (calls) => {
          let failure: unknown;
          try {
            await captureNativeAuthoredProcessIncarnation({
              pid: child.pid,
              selected: "/bin/sleep",
            });
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(Error);
          expect(String(failure)).not.toContain(String(child.pid));
          expect(calls()).toBe(2);
        }
      );
      await withCensusFrames(
        { frames: [FOREIGN_TRANSIENT, listing(child.pid, "S")] },
        async (calls) => {
          await expect(
            captureNativeAuthoredProcessIncarnation({
              pid: child.pid,
              selected: "/bin/sleep",
            })
          ).rejects.toThrow();
          expect(calls()).toBe(1);
        }
      );
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  },
  10_000
);

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

test("PGID-only drift in an unrelated row still refuses a complete census", () => {
  const unrelated = { ...row, pid: 77, group: 77, session: "77" };
  expect(mergeNativeAuthoredProcessCensuses([unrelated], [unrelated])).toEqual([
    unrelated,
  ]);
  for (const group of [78, original.group]) {
    expect(() =>
      mergeNativeAuthoredProcessCensuses([unrelated], [{ ...unrelated, group }])
    ).toThrow("identity changed");
  }
});
