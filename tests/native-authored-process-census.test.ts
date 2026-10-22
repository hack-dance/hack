import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { lstat, realpath } from "node:fs/promises";
import {
  assertNativeAuthoredProcessQuiescent,
  parseNativeAuthoredProcessIncarnation,
  readNativeAuthoredProcessCensus,
  requireNativeAuthoredProcessQuiescent,
} from "../src/backends/native-authored-process-incarnation.ts";
import { createNativeProcessCensusDiagnostics } from "../src/backends/native-process-census-diagnostics.ts";
import { readNativeComposeHostBootId } from "../src/lib/native-compose-private-state.ts";
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

censusTest(
  "opt-in phase diagnostics retain only bounded value-free counts and timings",
  async () => {
    const diagnostics = createNativeProcessCensusDiagnostics();
    await standin({ frames: [raw(77), raw(77)] }, async () => {
      const rows = await readNativeAuthoredProcessCensus(3000, { diagnostics });
      expect(rows.map((row) => row.pid)).toEqual([77]);
    });
    const report = diagnostics.snapshot();
    expect(report.samples.map((sample) => sample.phase)).toEqual([
      "metadata",
      "sessions",
      "metadata",
      "sessions",
      "merge",
      "census",
    ]);
    expect(
      report.samples.every(
        (sample) => sample.outcome === "complete" && sample.rowCount === 1
      )
    ).toBe(true);
    expect(
      report.samples.every(
        (sample) => Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0
      )
    ).toBe(true);
    for (const sample of report.samples) {
      expect(Object.keys(sample).sort()).toEqual([
        "elapsedMs",
        "outcome",
        "phase",
        "rowCount",
      ]);
      expect(Object.isFrozen(sample)).toBe(true);
    }
    expect(JSON.stringify(report)).not.toContain("/bin/sleep");
    expect(JSON.stringify(report)).not.toContain("Fri Oct");
    expect(report.dropped).toBe(0);
  }
);

censusTest(
  "phase diagnostics preserve changed-identity refusal without retaining identity or error text",
  async () => {
    const diagnostics = createNativeProcessCensusDiagnostics();
    await standin({ frames: [raw(77), raw(77, 78)] }, async () => {
      await expect(
        readNativeAuthoredProcessCensus(3000, { diagnostics })
      ).rejects.toThrow("identity changed");
    });
    expect(
      diagnostics
        .snapshot()
        .samples.slice(-2)
        .map((sample) => [sample.phase, sample.outcome])
    ).toEqual([
      ["merge", "refused"],
      ["census", "refused"],
    ]);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(
      "identity changed"
    );
  }
);

censusTest(
  "diagnostics do not reset the original budget or admit an expired pair",
  async () => {
    const diagnostics = createNativeProcessCensusDiagnostics();
    await standin(
      { frames: [raw(77), raw(77)], expiry: "after-final-pair" },
      async (calls) => {
        await expect(
          readNativeAuthoredProcessCensus(3000, { diagnostics })
        ).rejects.toThrow();
        expect(calls()).toBe(2);
      }
    );
    expect(diagnostics.snapshot().samples.at(-1)?.outcome).toBe("refused");
    expect(
      diagnostics.snapshot().samples.some((sample) => sample.phase === "merge")
    ).toBe(false);
  }
);

/** Rows of interest carry the original PID (123), PGID (123) or SID (123);
 * every other row is foreign. Real `ps` output on a loaded host shows foreign
 * exec, reparent, PGID and live/transient drift between the two bracketing
 * observations in most pairs. */
const execImage = (text: string) => text.replace("/bin/sleep", "/bin/cat");
const transient = (text: string) => text.replace(" S ", " ?N ");
const zombie = (text: string) => text.replace(" S ", " Z ");
const reborn = "Thu Oct 8 12:00:00 2026";
censusTest.each([
  { name: "exec", after: execImage(raw(77)) },
  { name: "live to transient", after: transient(raw(77)) },
  { name: "reparent", after: raw(77).replace(" 45 ", " 1 ") },
  { name: "PGID", after: raw(77, 78) },
])(
  "foreign $name drift between bracketing observations cannot refuse quiescence",
  async ({ after }) => {
    await standin({ frames: [raw(77), after] }, async (calls) => {
      const rows = await readNativeAuthoredProcessCensus(3000, {
        interest: original,
      });
      expect(calls()).toBe(2);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.pid).toBe(77);
      expect(() =>
        requireNativeAuthoredProcessQuiescent(original, rows)
      ).not.toThrow();
    });
    await standin({ frames: [raw(77), after] }, async (calls) => {
      await expect(readNativeAuthoredProcessCensus()).rejects.toThrow(
        "identity changed"
      );
      expect(calls()).toBe(2);
    });
  }
);
censusTest.each([
  { name: "PID reuse", churn: raw(77, 77, reborn) },
  { name: "live to zombie", churn: zombie(raw(77)) },
  { name: "new zombie", churn: raw(77) + zombie(raw(79)) },
])(
  "foreign $name supersedes the whole pair and needs a fresh stable pair",
  async ({ churn }) => {
    await standin(
      { frames: [raw(77), churn, raw(77), raw(77)] },
      async (calls) => {
        const rows = await readNativeAuthoredProcessCensus(3000, {
          interest: original,
        });
        expect(calls()).toBe(4);
        expect(rows.map((row) => row.pid)).toEqual([77]);
      }
    );
    // Expiry after the superseded pair admits no successor child.
    await standin(
      { frames: [raw(77), churn], expiry: "after-final-pair" },
      async (calls) => {
        await expect(
          readNativeAuthoredProcessCensus(3000, { interest: original })
        ).rejects.toThrow();
        expect(calls()).toBe(2);
      }
    );
  }
);
censusTest.each([
  { name: "original PID exec", frames: [raw(123), execImage(raw(123))] },
  {
    name: "group member exec",
    frames: [raw(77, 123), execImage(raw(77, 123))],
  },
  {
    name: "group member transient",
    frames: [raw(77, 123), transient(raw(77, 123))],
  },
  { name: "PGID drift into the group", frames: [raw(77), raw(77, 123)] },
  { name: "PGID drift out of the group", frames: [raw(77, 123), raw(77)] },
  {
    name: "group member PID reuse",
    frames: [raw(77, 123), raw(77, 123, reborn)],
  },
  { name: "original PID reuse", frames: [raw(123), raw(123, 123, reborn)] },
  {
    name: "group member to zombie",
    frames: [raw(77, 123), zombie(raw(77, 123))],
  },
])(
  "row of interest $name still refuses as a changed identity",
  async ({ frames }) => {
    await standin({ frames }, async (calls) => {
      await expect(
        readNativeAuthoredProcessCensus(3000, { interest: original })
      ).rejects.toThrow("identity changed");
      expect(calls()).toBe(2);
    });
  }
);
censusTest(
  "session member drift and unstable zombies of interest still refuse",
  async () => {
    await standin(
      { frames: [raw(77), execImage(raw(77))], foreignSession: true },
      async (calls) => {
        await expect(
          readNativeAuthoredProcessCensus(3000, { interest: original })
        ).rejects.toThrow("identity changed");
        expect(calls()).toBe(2);
      }
    );
    for (const frames of [
      [raw(77), raw(77) + zombie(raw(123))],
      [raw(77) + zombie(raw(79, 123)), raw(77)],
      [raw(77) + zombie(raw(79, 123)), raw(77, 77, reborn)],
    ]) {
      await standin({ frames }, async (calls) => {
        await expect(
          readNativeAuthoredProcessCensus(3000, { interest: original })
        ).rejects.toThrow("unknown or occupied");
        expect(calls()).toBe(2);
      });
    }
  }
);
censusTest(
  "recovery quiescence bounds its census to the original's rows of interest",
  async () => {
    // Real read-only boot and image facts; the census itself is synthetic.
    const boot = await readNativeComposeHostBootId();
    const path = await realpath("/bin/sleep");
    const stat = await lstat(path, { bigint: true });
    const image = { path, dev: String(stat.dev), ino: String(stat.ino) };
    const value = parseNativeAuthoredProcessIncarnation({
      ...original,
      uid: process.getuid?.(),
      executable: path,
      boot,
      image,
      selected: image,
    });
    await standin(
      { frames: [`${boot}\n`, raw(77), execImage(raw(77))] },
      async (calls) => {
        const observation = await assertNativeAuthoredProcessQuiescent(
          value,
          () => 3000
        );
        expect(observation).toEqual({
          kind: "no-live-members",
          unresolvedZombies: 0,
        });
        expect(calls()).toBe(3);
      }
    );
    await standin(
      { frames: [`${boot}\n`, raw(77, 123), execImage(raw(77, 123))] },
      async (calls) => {
        await expect(
          assertNativeAuthoredProcessQuiescent(value, () => 3000)
        ).rejects.toThrow("identity changed");
        expect(calls()).toBe(3);
      }
    );
  }
);
