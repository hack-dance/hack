import { expect, test } from "bun:test";
import { NativeImageBatchError } from "../src/backends/native-image-policy.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import {
  classifyNativeLostProvider,
  type NativeStartPoolEnd,
  nativeForegroundPoolEndMessage,
  nativeLostProviderCode,
  nativeLostVmCauseLine,
  watchNativeStartPool,
} from "../src/backends/native-start-pool-watch.ts";

const owner = "a".repeat(32);
const boot = "12345678-1234-1234-1234-123456789abc";
const record = (fields: Record<string, unknown>) => ({
  token: owner,
  guest_boot_id: boot,
  phase: "running",
  ...fields,
});

/** Run a watch against a scripted sequence of pool records (the last one repeats). */
async function run(
  records: readonly unknown[],
  opts: { readonly stopAfterMs?: number; readonly waitMs?: number } = {}
) {
  let index = 0;
  let ended = 0;
  const stop = watchNativeStartPool({
    home: "/fixture",
    bootId: boot,
    checkMs: 5,
    graceMs: 20,
    read: () => {
      const value = records[Math.min(index, records.length - 1)];
      index += 1;
      return value instanceof Error
        ? Promise.reject(value)
        : Promise.resolve(value);
    },
    onEnded: () => {
      ended += 1;
    },
  });
  if (opts.stopAfterMs !== undefined) {
    await Bun.sleep(opts.stopAfterMs);
    stop();
  }
  await Bun.sleep(opts.waitMs ?? 150);
  stop();
  return ended;
}

test("a start whose pool stopped, crashed into recovery or booted again ends after the grace", async () => {
  for (const ended of [
    record({ phase: "stopped" }),
    record({ phase: "recovered-unclean" }),
    record({ guest_boot_id: "87654321-4321-4321-4321-cba987654321" }),
  ]) {
    expect(await run([record({}), ended])).toBe(1);
  }
});

test("a pool that is only slow never ends the start", async () => {
  for (const slow of [
    record({ phase: "starting" }),
    record({
      phase: "starting",
      guest_boot_id: null,
      previous_guest_boot_id: boot,
    }),
    record({ phase: "stopping" }),
    new Error("unreadable"),
    "not json",
    {},
  ]) {
    expect(await run([record({}), slow])).toBe(0);
  }
});

test("the first poll can prove the admitted boot already stopped", async () => {
  expect(await run([record({ phase: "stopped" })])).toBe(1);
  expect(
    await run([
      record({
        phase: "stopped-before-engine",
        guest_boot_id: null,
        previous_guest_boot_id: boot,
      }),
    ])
  ).toBe(1);
  expect(await run([record({ phase: "stopped", guest_boot_id: null })])).toBe(
    0
  );
});

test("a new pool owner proves loss once a matching boot identified the former owner", async () => {
  const replacement = record({
    phase: "starting",
    token: "b".repeat(32),
    guest_boot_id: null,
  });
  expect(await run([replacement])).toBe(0);
  expect(await run([record({}), replacement])).toBe(1);
});

test("a start that finishes on its own within the grace is not ended", async () => {
  expect(
    await run([record({}), record({ phase: "stopped" })], { stopAfterMs: 12 })
  ).toBe(0);
});

test("a start whose provider process vanished while the record still says running ends after the grace", async () => {
  // HACK-2579: a killed or crashed provider leaves the record `running`; only its
  // pid tells. A reused pid reads as alive, so only a gone pid ends the start.
  const running = record({ process: { pid: 4242 } });
  for (const [gone, expected] of [
    [true, 1],
    [false, 0],
  ] as const) {
    let ended = 0;
    const asked: number[] = [];
    const stop = watchNativeStartPool({
      home: "/fixture",
      bootId: boot,
      checkMs: 5,
      graceMs: 10,
      read: () => Promise.resolve(running),
      gone: (pid) => {
        asked.push(pid);
        return gone;
      },
      onEnded: () => {
        ended += 1;
      },
    });
    await Bun.sleep(80);
    stop();
    expect(ended).toBe(expected);
    expect(new Set(asked)).toEqual(new Set([4242]));
  }
  // A record that names another provider (a new boot) is the existing rule's case,
  // never this one: no pid of it is asked about.
});

test("a successor boot retires the attempt without probing the successor's PID", async () => {
  const pids: number[] = [];
  const retired = Promise.withResolvers<void>();
  const stop = watchNativeStartPool({
    home: "/fixture",
    bootId: boot,
    graceMs: 0,
    read: async () =>
      record({
        guest_boot_id: "87654321-4321-4321-4321-cba987654321",
        process: { pid: 5151 },
      }),
    gone: (pid) => {
      pids.push(pid);
      return true;
    },
    onEnded: () => retired.resolve(),
  });
  try {
    expect(
      await Promise.race([
        retired.promise,
        Bun.sleep(100).then(() => "timeout"),
      ])
    ).toBeUndefined();
    expect(pids).toEqual([]);
  } finally {
    stop();
  }
});

test("a ready start ends at the first check that sees its boot ended; one still starting keeps the grace", async () => {
  // HACK-2535 real-VM run: the stopped run's ready owner outlived the pool by the
  // grace, and a later `up` waited for it to be proven gone.
  for (const [ready, expected] of [
    [true, 1],
    [false, 0],
  ] as const) {
    let index = 0;
    let ended = 0;
    let readAt = -1;
    const records = [record({}), record({ phase: "stopped" })];
    const stop = watchNativeStartPool({
      home: "/fixture",
      bootId: boot,
      checkMs: 5,
      graceMs: () => {
        readAt = index;
        return ready ? 0 : 10_000;
      },
      read: () => {
        const value = records[Math.min(index, records.length - 1)];
        index += 1;
        return Promise.resolve(value);
      },
      onEnded: () => {
        ended += 1;
      },
    });
    await Bun.sleep(60);
    stop();
    expect(ended).toBe(expected);
    // The grace is chosen when the ended boot is seen, not when the watch starts.
    expect(readAt).toBeGreaterThan(1);
  }
});

test("the end carries its evidence: the gone provider pid, or none for an ended boot", async () => {
  // HACK-2096: a foreground start names the lost VM from this evidence.
  for (const [records, gone, expected] of [
    [
      [record({ process: { pid: 4242 } })],
      true,
      { bootId: boot, providerPid: 4242 },
    ],
    [[record({}), record({ phase: "stopped" })], false, { bootId: boot }],
  ] as const) {
    const ends: NativeStartPoolEnd[] = [];
    let index = 0;
    const stop = watchNativeStartPool({
      home: "/fixture",
      bootId: boot,
      checkMs: 5,
      graceMs: 0,
      read: () => {
        const value = records[Math.min(index, records.length - 1)];
        index += 1;
        return Promise.resolve(value);
      },
      gone: () => gone,
      onEnded: (end) => {
        ends.push(end);
      },
    });
    await Bun.sleep(60);
    stop();
    expect(ends).toEqual([expected]);
  }
});

test("a run lost after its graph was ready names down --recover, then hack up", () => {
  const exited = nativeForegroundPoolEndMessage(
    { bootId: boot, providerPid: 4242 },
    { stage: "ready" }
  );
  expect(exited).toContain("pid 4242");
  expect(exited).toContain(boot);
  expect(exited).toContain("exit code 1");
  const stopped = nativeForegroundPoolEndMessage(
    { bootId: boot },
    { stage: "ready" }
  );
  expect(stopped).toContain(boot);
  expect(stopped).not.toContain("pid");
  for (const message of [exited, stopped]) {
    // One retire command, named once; no fresh-home detour. A restart's
    // replacement gets the same sequence: down --recover also retires its
    // pending restart (HACK-2096), and `hack restart` would then refuse a
    // stopped run with no restart pending.
    expect(message.match(/hack down --recover/g)).toHaveLength(1);
    expect(message).not.toContain("fresh");
    expect(message).toContain("then hack up to start it again");
    expect(message).not.toContain("hack restart");
  }
});

test("a run lost after its services were requested and before ready names no command that refuses it", () => {
  // HACK-2714: neither `hack down --recover` nor `hack up` can retire a run
  // whose VM was lost after its services were requested and before it was
  // ready and mapped, so the message sends the user to neither, and says to
  // keep the home for inspection.
  const message = nativeForegroundPoolEndMessage(
    { bootId: boot, providerPid: 4242 },
    { stage: "requested" }
  );
  expect(message).toContain("pid 4242");
  expect(message).toContain("exit code 1");
  expect(message).not.toContain("hack down");
  expect(message).not.toContain("hack up");
  expect(message).not.toContain("hack restart");
  expect(message).toContain("Keep this native home unchanged");
  expect(message).toContain("hack ps --json");
});

test("a run lost before any service was requested names the commands that work", () => {
  // Resolve, review, image builds and pulls, restore selection: nothing of
  // this attempt was requested yet. A resumed retained run (or a restart's old
  // run) is still the stopped retained run, which down --recover retires with
  // any pending restart, so hack up works after it.
  const recorded = nativeForegroundPoolEndMessage(
    { bootId: boot, providerPid: 4242 },
    { stage: "preparing", recorded: true }
  );
  expect(recorded).toContain("pid 4242");
  expect(recorded).toContain("exit code 1");
  expect(recorded).toContain("the run's data is kept");
  expect(recorded.match(/hack down --recover/g)).toHaveLength(1);
  expect(recorded).toContain("then hack up to start it again");
  expect(recorded.indexOf("hack down --recover")).toBeLessThan(
    recorded.indexOf("hack up")
  );
  expect(recorded).not.toContain("hack restart");
  expect(recorded).not.toContain("Keep this native home unchanged");
  // A fresh up has no run record: down --recover would only say not_started,
  // so the message names hack up alone.
  const fresh = nativeForegroundPoolEndMessage(
    { bootId: boot },
    { stage: "preparing", recorded: false }
  );
  expect(fresh).toContain(boot);
  expect(fresh).toContain("exit code 1");
  expect(fresh).not.toContain("hack down");
  expect(fresh).not.toContain("data is kept");
  expect(fresh).not.toContain("hack restart");
  expect(fresh.split("\n").at(-1)).toBe("Run hack up to start it again.");
});

test("a lost-provider code is found wherever a native client puts one", () => {
  const request = (nativeCode: string) =>
    new NativeRuntimeRequestError({
      message: `Native runtime request failed (${nativeCode}); inspect owned state before retrying.`,
      nativeCode,
    });
  expect(nativeLostProviderCode(request("process_identity_unavailable"))).toBe(
    true
  );
  expect(nativeLostProviderCode(request("pool_process_exited"))).toBe(true);
  expect(
    nativeLostProviderCode(
      new NativeImageBatchError([
        {
          reference: "docker.io/library/python:3.10-alpine",
          code: "process_identity_unavailable",
          reason: "Cannot establish native provider process identity",
          recovery: "Inspect hack doctor, then retry hack up.",
          services: ["web"],
        },
      ])
    )
  ).toBe(true);
  // The foreground unwind quotes the code in its closed diagnostic text.
  expect(
    nativeLostProviderCode(
      new Error(
        "Native foreground exit cleanup is unconfirmed; runtime and bridge state may be retained. Startup diagnostic: Native graph startup failed (process_identity_unavailable)."
      )
    )
  ).toBe(true);
  expect(
    nativeLostProviderCode(
      new Error("wrapped", { cause: request("process_identity_unavailable") })
    )
  ).toBe(true);
  for (const other of [
    request("provider_busy"),
    request("runtime_changed"),
    new Error("synthetic failure"),
    undefined,
  ]) {
    expect(nativeLostProviderCode(other)).toBe(false);
  }
});

test("a failed start is classified as lost from the same pool reading as the watch", async () => {
  const read = async () => record({ process: { pid: 4242 } });
  // The watched boot's provider pid is gone: lost, whatever the error says.
  expect(
    await classifyNativeLostProvider({
      error: new Error("synthetic failure"),
      home: "/unused",
      bootId: boot,
      read,
      gone: (pid) => pid === 4242,
    })
  ).toEqual({ bootId: boot, providerPid: 4242 });
  // The boot was replaced.
  expect(
    await classifyNativeLostProvider({
      error: new Error("synthetic failure"),
      home: "/unused",
      bootId: boot,
      read: async () =>
        record({ guest_boot_id: "87654321-4321-4321-4321-cba987654321" }),
      gone: () => false,
    })
  ).toEqual({ bootId: boot });
  // An unreadable record, but a lost-provider code in the error.
  expect(
    await classifyNativeLostProvider({
      error: new NativeRuntimeRequestError({
        message:
          "Native runtime request failed (process_identity_unavailable).",
        nativeCode: "process_identity_unavailable",
      }),
      home: "/unused",
      bootId: boot,
      read: () => Promise.reject(new Error("unreadable")),
      gone: () => false,
    })
  ).toEqual({ bootId: boot });
  // A live provider and an ordinary error: not a lost VM.
  expect(
    await classifyNativeLostProvider({
      error: new Error("synthetic failure"),
      home: "/unused",
      bootId: boot,
      read,
      gone: () => false,
    })
  ).toBeUndefined();
});

test("a live provider on the watched boot vetoes a lost-provider code", async () => {
  // Round-4 review: the runtime reports `process_identity_unavailable` for
  // failures on a healthy VM too (an image build's context snapshot, an
  // incarnation read, a helper scan, engine verification).
  const coded = new NativeRuntimeRequestError({
    message: "Native runtime request failed (process_identity_unavailable).",
    nativeCode: "process_identity_unavailable",
  });
  const classify = (record: unknown) =>
    classifyNativeLostProvider({
      error: coded,
      home: "/unused",
      bootId: boot,
      read: async () => record,
      gone: () => false,
    });
  expect(await classify(record({ process: { pid: 4242 } }))).toBeUndefined();
  // Still recorded, mid-transition: not proven ended, so not lost either.
  expect(await classify(record({ phase: "starting" }))).toBeUndefined();
  // A record naming no boot at all leaves the code to decide.
  expect(await classify({ token: owner, phase: "running" })).toEqual({
    bootId: boot,
  });
});

test("the cause line keeps the start's own message, bounded to one line", () => {
  expect(
    nativeLostVmCauseLine(new Error("Image preparation failed.\n- web (x): y"))
  ).toBe("(cause: Image preparation failed. - web (x): y)");
  expect(nativeLostVmCauseLine(" \n ")).toBeUndefined();
  expect(nativeLostVmCauseLine(undefined)).toBeUndefined();
  const long = nativeLostVmCauseLine(new Error("x".repeat(1000)));
  expect(long?.length).toBeLessThan(420);
  expect(long?.endsWith("…)")).toBe(true);
});
