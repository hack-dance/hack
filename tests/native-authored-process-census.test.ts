import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  readNativeAuthoredProcessCensus,
  requireNativeAuthoredProcessQuiescent,
} from "../src/backends/native-authored-process-incarnation.ts";
import * as sessions from "../src/lib/tty-process-group.ts";

let active = 0;
let unknown = false;
beforeEach(() => {
  if (unknown) {
    throw new Error("Census control lifetime unknown; mocks retained.");
  }
});
afterEach(() => {
  if (active !== 0) {
    unknown = true;
  }
});
const raw = (pid: number, group = pid, birth = "Fri Oct 9 12:00:00 2026") =>
  ` ${pid} 45 ${group} 0 501 S ${birth} /bin/sleep\n`;
const original = {
  pid: 123,
  parent: 45,
  group: 123,
  session: "123",
  state: "live" as const,
  uid: 501,
  birth: "Fri Oct 9 12:00:00 2026",
  executable: "/bin/sleep",
  platform: "darwin" as const,
  boot: "12345678-abcd-abcd-abcd-123456789abc",
  image: { path: "/bin/sleep", dev: "1", ino: "2" },
  selected: { path: "/bin/sleep", dev: "1", ino: "2" },
};

/** Real finite printf children supply synthetic census bytes. The shipping
 * reader owns exit/EOF settlement; this control observes original exits without
 * waiting afterward to supply missing settlement. No process membership is real. */
async function standin(
  options: {
    readonly frames: readonly string[];
    readonly expiry?:
      | "before-first-child"
      | "after-disappearance"
      | "after-final-pair"
      | "churn";
    readonly foreignSession?: boolean;
  },
  body: (calls: () => number) => Promise<void>
) {
  const frames = [...options.frames];
  const expiry = options.expiry;
  const foreignSession = options.foreignSession === true;
  let calls = 0;
  let inspectors = 0;
  let offset = 0;
  const exits: Array<{ phase: "pending" | "settled" | "rejected" }> = [];
  const spawn = Bun.spawn;
  const now = performance.now.bind(performance);
  const clock = spyOn(performance, "now").mockImplementation(
    () => now() + offset
  );
  const session = spyOn(
    sessions,
    "openProcessSessionInspector"
  ).mockImplementation(() => {
    const selected = ++inspectors;
    let failed = false;
    return {
      session: (pid: number) => {
        if (pid !== process.pid && [88, 89, 90].includes(pid)) {
          failed = true;
          return null;
        }
        return foreignSession && pid === 77 ? 123 : pid;
      },
      close: () => {
        if (
          (expiry === "before-first-child" && selected === 1) ||
          (expiry === "after-disappearance" && failed) ||
          (expiry === "after-final-pair" && selected === 4)
        ) {
          offset = 4000;
        } else if (expiry === "churn" && failed) {
          offset += 1000;
        }
      },
    };
  });
  const child = spyOn(Bun, "spawn").mockImplementation(() => {
    const text = frames[calls++];
    if (text === undefined) {
      throw new Error("Unexpected census child admission; values omitted.");
    }
    const captured = spawn(["/usr/bin/printf", "%s", text], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const observed: (typeof exits)[number] = { phase: "pending" };
    exits.push(observed);
    void captured.exited.then(
      (code) => {
        observed.phase = code === 0 ? "settled" : "rejected";
      },
      () => {
        observed.phase = "rejected";
      }
    );
    return captured;
  });
  active++;
  try {
    await body(() => calls);
  } finally {
    active--;
    if (exits.some((exit) => exit.phase !== "settled")) {
      unknown = true;
    }
    if (!unknown) {
      child.mockRestore();
      session.mockRestore();
      clock.mockRestore();
    }
  }
}

const censusTest = test.skipIf(process.platform !== "darwin");
censusTest(
  "proven disappearance discards the entire attempt and requires two fresh complete censuses",
  async () => {
    await standin(
      { frames: [raw(88), raw(77), raw(77), raw(77)] },
      async (calls) => {
        const result = await readNativeAuthoredProcessCensus();
        expect(result.map((row) => row.pid)).toEqual([77]);
        expect(calls()).toBe(4);
        expect(() =>
          requireNativeAuthoredProcessQuiescent(original, result)
        ).not.toThrow();
      }
    );
  }
);
censusTest(
  "two positively disappeared rows require a wholly fresh stable successor pair",
  async () => {
    await standin(
      { frames: [raw(88), raw(77), raw(89), raw(77), raw(77), raw(77)] },
      async (calls) => {
        const result = await readNativeAuthoredProcessCensus();
        expect(result.map((row) => row.pid)).toEqual([77]);
        expect(calls()).toBe(6);
        expect(() =>
          requireNativeAuthoredProcessQuiescent(original, result)
        ).not.toThrow();
      }
    );
  }
);
censusTest(
  "fresh successor foreign group, session and original PID still veto recovery",
  async () => {
    for (const [current, foreignSession] of [
      [raw(77, 123), false],
      [raw(77), true],
      [raw(123), false],
    ] as const) {
      await standin(
        { frames: [raw(88), raw(77), current, current], foreignSession },
        async (calls) => {
          const result = await readNativeAuthoredProcessCensus();
          expect(calls()).toBe(4);
          expect(() =>
            requireNativeAuthoredProcessQuiescent(original, result)
          ).toThrow();
        }
      );
    }
  }
);
censusTest.each([
  {
    name: "reappeared PID",
    frames: [raw(88), raw(77), raw(88)],
    reason: "PID reappeared",
  },
  {
    name: "same live unavailable",
    frames: [raw(88), raw(88)],
    reason: "same-live-SID-unavailable",
  },
  {
    name: "reused identity",
    frames: [raw(88), raw(88, 88, "Thu Oct 8 12:00:00 2026")],
    reason: "changed",
  },
  {
    name: "live to zombie",
    frames: [raw(88), raw(88).replace(" S ", " Z ")],
    reason: "changed",
  },
  {
    name: "malformed diagnostic",
    frames: [raw(88), "garbage\n"],
    reason: "unknown",
  },
  {
    name: "unknown after disappearance",
    frames: [raw(88), raw(77), raw(89), raw(89)],
    reason: "same-live-SID-unavailable",
  },
  {
    name: "changed after disappearance",
    frames: [raw(88), raw(77), raw(89), raw(89).replace(" S ", " Z ")],
    reason: "changed",
  },
  {
    name: "reappeared PID in diagnostic",
    frames: [raw(88), raw(77), raw(89), raw(88)],
    reason: "unknown",
  },
])(
  "$name cannot restart or discard unknown membership",
  async ({ frames, reason }) => {
    await standin({ frames }, async (calls) => {
      await expect(readNativeAuthoredProcessCensus()).rejects.toThrow(reason);
      expect(calls()).toBe(frames.length);
    });
  }
);
censusTest(
  "expiry after proven disappearance admits no successor child",
  async () => {
    await standin(
      { frames: [raw(88), raw(77)], expiry: "after-disappearance" },
      async (calls) => {
        await expect(readNativeAuthoredProcessCensus()).rejects.toThrow(
          "(disappeared)"
        );
        expect(calls()).toBe(2);
      }
    );
  }
);
censusTest(
  "expired admission and late complete pair cannot confer successful census",
  async () => {
    for (const [expiry, frames] of [
      ["before-first-child", []],
      ["after-final-pair", [raw(77), raw(77)]],
      ["churn", [raw(88), raw(77), raw(89), raw(77), raw(90), raw(77)]],
    ] as const) {
      await standin({ frames, expiry }, async (calls) => {
        await expect(readNativeAuthoredProcessCensus()).rejects.toThrow();
        expect(calls()).toBe(frames.length);
      });
    }
  }
);
