import { expect, test } from "bun:test";
import {
  type NativeStartPoolEnd,
  nativeForegroundPoolEndMessage,
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

test("the foreground message names the lost VM and the one recovery command", () => {
  const exited = nativeForegroundPoolEndMessage({
    bootId: boot,
    providerPid: 4242,
  });
  expect(exited).toContain("pid 4242");
  expect(exited).toContain(boot);
  expect(exited).toContain("exit code 1");
  const stopped = nativeForegroundPoolEndMessage({ bootId: boot });
  expect(stopped).toContain(boot);
  expect(stopped).not.toContain("pid");
  for (const message of [exited, stopped]) {
    // One retire command, named once; no fresh-home detour.
    expect(message.match(/hack down --recover/g)).toHaveLength(1);
    expect(message).not.toContain("fresh");
  }
});
