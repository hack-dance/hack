import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refuseDetachedCacheBootstrap,
  refuseDetachForAuthoredProject,
} from "../src/commands/background-command-start.ts";
import { cancelCommand } from "../src/lib/background-command/cancel.ts";
import {
  buildEnvelope,
  type CommandMeta,
  formatCursor,
  JOURNAL_FORMAT_VERSION,
  JournalWriter,
  journalPaths,
  parseCursor,
  parseEventLines,
  readEvents,
  readMeta,
} from "../src/lib/background-command/journal.ts";
import {
  type ObservedIdentity,
  observeIdentities,
} from "../src/lib/background-command/platform.ts";
import {
  loadJournal,
  readCommandEvents,
} from "../src/lib/background-command/reader.ts";
import {
  OWNER_START_GRACE_MS,
  recoverLostOwner,
  withJournalLock,
} from "../src/lib/background-command/recovery.ts";
import {
  parseBackgroundCommandConfig,
  resolveBackgroundSettings,
} from "../src/lib/background-command/settings.ts";
import { StallTracker } from "../src/lib/background-command/stall.ts";
import {
  type AcceptInput,
  acceptCommand,
  CALLER_ACTIVE_LIMIT,
  HOME_ACTIVE_LIMIT,
  pruneExpired,
} from "../src/lib/background-command/store.ts";
import {
  endedPayload,
  OutputCapture,
} from "../src/lib/background-command/supervisor.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { restoreEnv } from "./helpers/env.ts";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-bg-journal-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** ps stand-in: nothing in `alive` means "every recorded process is gone". */
function fakeObserve(alive: readonly ObservedIdentity[] = []) {
  return async (pids: readonly number[]) =>
    new Map(
      alive.filter((row) => pids.includes(row.pid)).map((row) => [row.pid, row])
    );
}

function input(overrides: Partial<AcceptInput> = {}): AcceptInput {
  return {
    requestKey: null,
    operation: "exec",
    backend: "compose",
    projectId: "demo",
    projectRoot: "/fixture/demo",
    instanceId: "@base",
    service: "api",
    argv: ["echo", "hi"],
    workdir: null,
    caller: "test:a",
    timeoutMs: 60_000,
    stallAfterMs: 120_000,
    capture: "full",
    retentionMs: 60_000,
    liveOutput: "available",
    stallDetection: "available",
    redaction: { values: 0 },
    fingerprintInputs: { argv: ["echo", "hi"], service: "api" },
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(HackCliError);
  expect((error as HackCliError).code).toBe(code as HackCliError["code"]);
}

describe("journal events and cursors", () => {
  test("accepted is persisted first; writers keep seq dense and strictly increasing", async () => {
    const { paths, meta } = await acceptCommand({ input: input(), root });
    expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.meta)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.events)).mode & 0o777).toBe(0o600);
    const writer = new JournalWriter(paths, meta, 1);
    await writer.write("command.started", { pid: 1 });
    await writer.write("command.output", {
      stream: "stdout",
      offset: 0,
      length: 3,
    });
    await writer.write("command.ended", { outcome: "succeeded", exitCode: 0 });
    const events = await readEvents(paths);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events[0]?.type).toBe("command.accepted");
    expect(events[3]?.cursor).toBe(
      formatCursor({
        commandId: meta.commandId,
        generation: meta.generation,
        seq: 4,
      })
    );
    expect(JSON.stringify(meta)).not.toContain("env");
  });

  test("an unterminated final line is a write in progress, not an event", () => {
    const line = JSON.stringify({ v: 1 });
    expect(parseEventLines(`${line}`)).toEqual([]);
  });

  test("cursor parsing rejects other shapes", () => {
    expect(parseCursor("cmd_aaaaaaaaaaaaaaaaaaaaaaaaaa:abcdefgh:12")).toEqual({
      commandId: "cmd_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      generation: "abcdefgh",
      seq: 12,
    });
    expect(parseCursor("cmd_x:abcdefgh:1")).toBeNull();
    expect(
      parseCursor("cmd_aaaaaaaaaaaaaaaaaaaaaaaaaa:abcdefgh:-1")
    ).toBeNull();
  });

  test("a cursor from another generation or past the end is a gap with the earliest cursor", async () => {
    const { meta } = await acceptCommand({ input: input(), root });
    const journal = await loadJournal({ commandId: meta.commandId, root });
    const stale = formatCursor({
      commandId: meta.commandId,
      generation: "zzzzzzzz",
      seq: 1,
    });
    const observe = fakeObserve();
    const gap = await readCommandEvents({
      journal,
      after: stale,
      waitMs: 0,
      maxBytes: 32_768,
      observe,
    });
    expect(gap.gap).toBe(true);
    expect(gap.events[0]?.type).toBe("gap");
    expect(gap.events[0]?.payload).toEqual({
      reason: "E_CURSOR_EXPIRED",
      earliestCursor: formatCursor({
        commandId: meta.commandId,
        generation: meta.generation,
        seq: 0,
      }),
    });
    const future = await readCommandEvents({
      journal,
      after: formatCursor({
        commandId: meta.commandId,
        generation: meta.generation,
        seq: 99,
      }),
      waitMs: 0,
      maxBytes: 32_768,
      observe,
    });
    expect(future.gap).toBe(true);
  });

  test("a read projects output ranges, withholds non-UTF-8 and stops at the byte budget", async () => {
    const { paths, meta } = await acceptCommand({ input: input(), root });
    await writeFile(paths.owner, "");
    const big = "a".repeat(16_000);
    await writeFile(
      paths.stdout,
      Buffer.concat([
        Buffer.from(big),
        Buffer.from(big),
        Buffer.from([0xff, 0xfe]),
      ]),
      { mode: 0o600 }
    );
    const writer = new JournalWriter(paths, meta, 1);
    await writer.write("command.started", { pid: 1 });
    await writer.write("command.output", {
      stream: "stdout",
      offset: 0,
      length: 16_000,
    });
    await writer.write("command.output", {
      stream: "stdout",
      offset: 16_000,
      length: 16_000,
    });
    await writer.write("command.output", {
      stream: "stdout",
      offset: 32_000,
      length: 2,
    });
    await writer.write("command.ended", { outcome: "failed", exitCode: 3 });
    const journal = await loadJournal({ commandId: meta.commandId, root });
    const first = await readCommandEvents({
      journal,
      waitMs: 0,
      maxBytes: 16_384,
      observe: fakeObserve(),
    });
    expect(first.endReason).toBe("budget");
    expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(first.events[2]?.payload.text).toBe(big);
    const rest = await readCommandEvents({
      journal,
      after: first.nextCursor,
      waitMs: 0,
      maxBytes: 32_768,
      observe: fakeObserve(),
    });
    expect(rest.events.map((event) => event.seq)).toEqual([4, 5, 6]);
    expect(rest.events[1]?.payload.withheld).toBe("not_utf8");
    expect(rest.events[1]?.payload.text).toBeUndefined();
    expect(rest.ended).toBe(true);
    expect(rest.outcome).toBe("failed");
    expect(rest.exitCode).toBe(3);
  });

  test("a reader waits, then reports wait elapsed without end", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    await writeFile(paths.owner, "{}");
    const journal = await loadJournal({ commandId: meta.commandId, root });
    let clock = 0;
    const result = await readCommandEvents({
      journal,
      after: formatCursor({
        commandId: meta.commandId,
        generation: meta.generation,
        seq: 1,
      }),
      waitMs: 1000,
      maxBytes: 32_768,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      // The owner record is malformed, so the assessment says "starting".
      observe: fakeObserve(),
    });
    expect(result.timedOut).toBe(true);
    expect(result.events).toEqual([]);
    expect(clock).toBeGreaterThanOrEqual(1000);
  });

  test("a reader refuses a journal written by a newer format", async () => {
    const { paths, meta } = await acceptCommand({ input: input(), root });
    const newer: CommandMeta & { formatVersion: number } = {
      ...meta,
      formatVersion: JOURNAL_FORMAT_VERSION + 1,
      writerVersion: "99.0.0",
    };
    await rm(paths.meta);
    await writeFile(paths.meta, JSON.stringify(newer), { mode: 0o600 });
    await expectCode(readMeta(paths), "E_JOURNAL_VERSION");
  });

  test("the final record is written from reserved space when the disk is full", async () => {
    const { paths, meta } = await acceptCommand({ input: input(), root });
    expect((await stat(paths.reserve)).size).toBeGreaterThan(0);
    let failures = 0;
    const writer = new JournalWriter(paths, meta, 1, async (path, line) => {
      if (await lstat(paths.reserve).catch(() => null)) {
        failures += 1;
        throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      }
      await writeFile(path, line, { flag: "a" });
    });
    await expect(writer.write("command.output", {})).rejects.toThrow(
      "no space"
    );
    await writer.write("command.ended", { outcome: "succeeded" });
    expect(failures).toBe(2);
    expect(await lstat(paths.reserve).catch(() => null)).toBeNull();
    const events = await readEvents(paths);
    expect(events.at(-1)?.type).toBe("command.ended");
  });
});

describe("request keys and admission", () => {
  test("the same key and inputs return the existing command; different inputs conflict", async () => {
    const first = await acceptCommand({
      input: input({ requestKey: "k1" }),
      root,
    });
    const again = await acceptCommand({
      input: input({ requestKey: "k1" }),
      root,
    });
    expect(again.reused).toBe(true);
    expect(again.meta.commandId).toBe(first.meta.commandId);
    expect((await readEvents(first.paths)).length).toBe(1);
    await expectCode(
      acceptCommand({
        input: input({
          requestKey: "k1",
          fingerprintInputs: { argv: ["rm", "-rf", "x"], service: "api" },
        }),
        root,
      }),
      "E_REQUEST_CONFLICT"
    );
    const otherProject = await acceptCommand({
      input: input({ requestKey: "k1", projectRoot: "/fixture/other" }),
      root,
    });
    expect(otherProject.reused).toBe(false);
  });

  test("admission limits are per caller session and per Hack home", async () => {
    const now = new Date();
    // A live supervisor for every journal: the ps stand-in reports the pid alive.
    const alive: ObservedIdentity[] = [];
    const observe = fakeObserve(alive);
    const startOne = async (caller: string) => {
      const accepted = await acceptCommand({
        input: input({ caller }),
        root,
        now,
        observe,
      });
      const pid = 100_000 + alive.length;
      alive.push({ pid, birth: "b", processGroupId: pid });
      await writeFile(
        accepted.paths.owner,
        JSON.stringify({
          pid,
          birth: "b",
          processGroupId: pid,
          sessionId: pid,
          newSession: true,
        }),
        { mode: 0o600 }
      );
      return accepted;
    };
    for (let index = 0; index < CALLER_ACTIVE_LIMIT; index += 1) {
      await startOne("session-a");
    }
    await expectCode(startOne("session-a"), "E_ADMISSION_LIMIT");
    for (
      let index = CALLER_ACTIVE_LIMIT;
      index < HOME_ACTIVE_LIMIT;
      index += 1
    ) {
      await startOne(`session-${index}`);
    }
    await expectCode(startOne("session-new"), "E_ADMISSION_LIMIT");
    // A supervisor that died frees its slot: it is finalized as unknown.
    alive.splice(0, 1);
    await startOne("session-new");
  });
});

describe("lost owner", () => {
  test("a supervisor that never recorded itself is finalized as unknown after the grace period", async () => {
    const accepted = new Date(Date.now() - OWNER_START_GRACE_MS - 1);
    const { meta, paths } = await acceptCommand({
      input: input(),
      root,
      now: accepted,
    });
    const events = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
    });
    expect(events.at(-1)?.type).toBe("command.ended");
    expect(events.at(-1)?.payload).toMatchObject({
      outcome: "unknown",
      reason: "supervisor_never_started",
    });
    // A second recovery writes nothing more.
    const again = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
    });
    expect(again.length).toBe(events.length);
  });

  test("while the child lives, a reader announces its output unsupervised; when it is gone, one unknown end", async () => {
    const { meta, paths } = await acceptCommand({
      input: input({ redaction: { values: 1 } }),
      root,
    });
    const owner = {
      pid: 200_001,
      birth: "o",
      processGroupId: 200_001,
      sessionId: 200_001,
      newSession: true,
    };
    const child = { pid: 200_002, birth: "c", processGroupId: 200_002 };
    await writeFile(paths.owner, JSON.stringify(owner), { mode: 0o600 });
    await writeFile(paths.child, JSON.stringify(child), { mode: 0o600 });
    await writeFile(paths.stdout, "landed after the supervisor died\n", {
      mode: 0o600,
    });
    const childOnly = fakeObserve([child]);
    const running = await recoverLostOwner({ paths, meta, observe: childOnly });
    expect(running.some((event) => event.type === "command.ended")).toBe(false);
    const output = running.find((event) => event.type === "command.output");
    expect(output?.payload).toMatchObject({
      stream: "stdout",
      offset: 0,
      unsupervised: true,
    });
    const journal = await loadJournal({ commandId: meta.commandId, root });
    const read = await readCommandEvents({
      journal,
      waitMs: 0,
      maxBytes: 32_768,
      observe: childOnly,
    });
    const projected = read.events.find(
      (event) => event.type === "command.output"
    );
    // Redaction values existed but are not available to a reader: withheld.
    expect(projected?.payload.withheld).toBe("redaction_unavailable");
    const ended = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
    });
    const finals = ended.filter((event) => event.type === "command.ended");
    expect(finals).toHaveLength(1);
    expect(finals[0]?.payload).toMatchObject({
      outcome: "unknown",
      reason: "supervisor_lost",
    });
  });

  test("a live supervisor is never taken over", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    const owner = {
      pid: 300_001,
      birth: "o",
      processGroupId: 300_001,
      sessionId: 1,
      newSession: false,
    };
    await writeFile(paths.owner, JSON.stringify(owner), { mode: 0o600 });
    await writeFile(paths.stdout, "x", { mode: 0o600 });
    const events = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve([owner]),
    });
    expect(events.map((event) => event.type)).toEqual(["command.accepted"]);
  });

  test("ps unavailable is not evidence of loss", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    await writeFile(
      paths.owner,
      JSON.stringify({
        pid: 1,
        birth: "o",
        processGroupId: 1,
        sessionId: 1,
        newSession: false,
      }),
      { mode: 0o600 }
    );
    const events = await recoverLostOwner({
      paths,
      meta,
      observe: async () => null,
    });
    expect(events.map((event) => event.type)).toEqual(["command.accepted"]);
  });
});

describe("retention", () => {
  test("ended output expires after retention, leaving a tombstone; running commands are kept", async () => {
    const start = Date.now();
    const ended = await acceptCommand({
      input: input({ retentionMs: 1000 }),
      root,
    });
    const running = await acceptCommand({
      input: input({ retentionMs: 0 }),
      root,
    });
    await writeFile(ended.paths.stdout, "secret-ish output", { mode: 0o600 });
    await new JournalWriter(ended.paths, ended.meta, 1).write("command.ended", {
      outcome: "succeeded",
    });
    await pruneExpired({ root, now: start + 500 });
    expect(await readFile(ended.paths.stdout, "utf8")).toBe(
      "secret-ish output"
    );
    await pruneExpired({ root, now: Date.now() + 2000 });
    expect(await lstat(ended.paths.stdout).catch(() => null)).toBeNull();
    expect(await lstat(ended.paths.events).catch(() => null)).toBeNull();
    await expectCode(
      loadJournal({ commandId: ended.meta.commandId, root }),
      "E_RESULT_EXPIRED"
    );
    expect(
      (await loadJournal({ commandId: running.meta.commandId, root })).meta
        .commandId
    ).toBe(running.meta.commandId);
    await expectCode(
      loadJournal({ commandId: "cmd_aaaaaaaaaaaaaaaaaaaaaaaaaa", root }),
      "E_COMMAND_NOT_FOUND"
    );
  });

  test("a request key for an expired command is never run again", async () => {
    const first = await acceptCommand({
      input: input({ requestKey: "k", retentionMs: 0 }),
      root,
    });
    await new JournalWriter(first.paths, first.meta, 1).write("command.ended", {
      outcome: "succeeded",
    });
    await pruneExpired({ root, now: Date.now() + 10 });
    await expectCode(
      acceptCommand({
        input: input({ requestKey: "k", retentionMs: 0 }),
        root,
      }),
      "E_RESULT_EXPIRED"
    );
  });

  test("journal paths stay under the Hack home", () => {
    const paths = journalPaths({
      root,
      commandId: "cmd_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(paths.dir.startsWith(root)).toBe(true);
    expect(() => journalPaths({ root, commandId: "../escape" })).toThrow();
  });
});

describe("settings", () => {
  test("per call, then project, then global; a 24 hour hard ceiling", () => {
    const resolved = resolveBackgroundSettings({
      request: {},
      project: {
        capture: "metadata",
        retentionHours: 48 as number,
        stallAfterMs: 0,
      },
      global: {},
    });
    expect(resolved).toEqual({
      capture: "metadata",
      timeoutMs: 30 * 60 * 1000,
      stallAfterMs: 0,
      retentionMs: 24 * 60 * 60 * 1000,
    });
    expect(
      resolveBackgroundSettings({
        request: { capture: "full", stallAfterMs: 5000 },
        project: { capture: "metadata", retentionHours: 12 },
        global: { retentionHours: 2 },
      })
    ).toMatchObject({
      capture: "full",
      stallAfterMs: 5000,
      retentionMs: 2 * 60 * 60 * 1000,
    });
  });

  test("the global off switch stores no output and refuses an explicit full capture", () => {
    expect(
      resolveBackgroundSettings({
        request: {},
        project: { capture: "full" },
        global: { capture: "off" },
      }).capture
    ).toBe("metadata");
    expect(() =>
      resolveBackgroundSettings({
        request: { capture: "full" },
        project: {},
        global: { capture: "off" },
      })
    ).toThrow(HackCliError);
  });

  test("timeouts and config values are bounded", () => {
    expect(() =>
      resolveBackgroundSettings({
        request: { timeoutMs: 6 * 60 * 60 * 1000 + 1 },
        project: {},
        global: {},
      })
    ).toThrow(HackCliError);
    expect(() =>
      parseBackgroundCommandConfig({
        value: { retentionHours: 25 },
        scope: "project",
      })
    ).toThrow(HackCliError);
    expect(() =>
      parseBackgroundCommandConfig({
        value: { capture: "off" },
        scope: "project",
      })
    ).toThrow(HackCliError);
  });
});

describe("review regressions", () => {
  test("process identity does not depend on the caller's time zone", async () => {
    const sleeper = Bun.spawn(["sleep", "5"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const saved = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      const tokyo = (await observeIdentities([sleeper.pid]))?.get(sleeper.pid);
      process.env.TZ = "America/Los_Angeles";
      const losAngeles = (await observeIdentities([sleeper.pid]))?.get(
        sleeper.pid
      );
      expect(tokyo?.birth).toBeTruthy();
      expect(losAngeles?.birth).toBe(tokyo?.birth as string);
      // Negative control: plain `ps` follows TZ, which is what broke identity.
      const plain = (tz: string) =>
        Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(sleeper.pid)], {
          env: { PATH: process.env.PATH ?? "", LC_ALL: "C", TZ: tz },
        })
          .stdout.toString()
          .trim();
      expect(plain("Asia/Tokyo")).not.toBe(plain("America/Los_Angeles"));
    } finally {
      restoreEnv("TZ", saved);
      sleeper.kill("SIGKILL");
      await sleeper.exited;
    }
  });

  test("an empty ps answer for dead pids means gone, not unknown", async () => {
    const done = Bun.spawn(["true"]);
    await done.exited;
    const snapshot = await observeIdentities([done.pid]);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.has(done.pid)).toBe(false);
  });

  test("a torn line from a crash cannot swallow the next event", async () => {
    const { paths, meta } = await acceptCommand({ input: input(), root });
    await writeFile(paths.events, '{"v":1,"torn', { flag: "a" });
    await new JournalWriter(paths, meta, 1).write("command.started", {
      pid: 1,
    });
    expect((await readEvents(paths)).map((event) => event.type)).toEqual([
      "command.accepted",
      "command.started",
    ]);
  });

  test("cancel writes no final record while the child cannot be confirmed gone", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    const child = { pid: 400_002, birth: "c", processGroupId: 400_002 };
    await writeFile(paths.child, JSON.stringify(child), { mode: 0o600 });
    const signals: string[] = [];
    const journal = await loadJournal({ commandId: meta.commandId, root });
    const result = await cancelCommand({
      journal,
      root,
      observe: fakeObserve([child]),
      signaller: {
        process: () => false,
        group: (pgid, signal) => {
          signals.push(`${pgid}:${signal}`);
          return true;
        },
      },
    });
    expect(signals).toEqual(["400002:SIGTERM", "400002:SIGKILL"]);
    expect(result.outcome).toBe("unconfirmed");
    expect(result.confirmed.childExited).toBe(false);
    // No final record: the command keeps its admission slot and its files.
    expect(
      (await readEvents(paths)).some((event) => event.type === "command.ended")
    ).toBe(false);
  });

  test("admission stops an overdue orphaned child it can verify, then records timed_out; reads never do", async () => {
    const accepted = new Date(Date.now() - 120_000);
    const { meta, paths } = await acceptCommand({
      input: input({ timeoutMs: 60_000 }),
      root,
      now: accepted,
    });
    const owner = {
      pid: 500_001,
      birth: "o",
      processGroupId: 500_001,
      sessionId: 1,
      newSession: true,
    };
    const child = { pid: 500_002, birth: "c", processGroupId: 500_002 };
    await writeFile(paths.owner, JSON.stringify(owner), { mode: 0o600 });
    await writeFile(paths.child, JSON.stringify(child), { mode: 0o600 });
    const alive: ObservedIdentity[] = [child];
    const killed: number[] = [];
    // A read never signals.
    const readOnly = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(alive),
      signalGroup: () => {
        throw new Error("a read must not signal");
      },
    });
    expect(readOnly.some((event) => event.type === "command.ended")).toBe(
      false
    );
    const events = await recoverLostOwner({
      paths,
      meta,
      enforceTimeout: true,
      observe: fakeObserve(alive),
      signalGroup: (pgid) => {
        killed.push(pgid);
        alive.splice(0);
        return true;
      },
    });
    expect(killed).toEqual([500_002]);
    expect(events.at(-1)?.payload).toMatchObject({
      outcome: "timed_out",
      reason: "orphan_timeout",
    });
  });

  test("expiry drops argv from the tombstone, and scope is checked before expiry is reported", async () => {
    const { paths, meta } = await acceptCommand({
      input: input({ retentionMs: 0, argv: ["deploy", "--token=literal"] }),
      root,
    });
    await new JournalWriter(paths, meta, 1).write("command.ended", {
      outcome: "succeeded",
    });
    await pruneExpired({ root, now: Date.now() + 10 });
    expect(await readFile(paths.meta, "utf8")).not.toContain("literal");
    await expectCode(
      loadJournal({ commandId: meta.commandId, root, inScope: () => false }),
      "E_COMMAND_NOT_FOUND"
    );
    await expectCode(
      loadJournal({ commandId: meta.commandId, root, inScope: () => true }),
      "E_RESULT_EXPIRED"
    );
  });
});

describe("--detach on authored and adopted projects", () => {
  test("is refused instead of running in the foreground", async () => {
    await expectCode(
      refuseDetachForAuthoredProject({
        cwd: root,
        selectAuthored: async () => ({ kind: "native", projectRoot: root }),
        selectAdopted: async () => null,
      }),
      "E_USAGE"
    );
    await expectCode(
      refuseDetachForAuthoredProject({
        cwd: root,
        selectAuthored: async () => null,
        selectAdopted: async () => root,
      }),
      "E_USAGE"
    );
    // A legacy project (neither) proceeds; the real selectors find nothing here.
    await refuseDetachForAuthoredProject({ cwd: root });
  });
});

describe("a full disk while recording events", () => {
  test("stops capture, cuts files back to announced output and never throws", async () => {
    const { paths, meta } = await acceptCommand({ input: input(), root });
    let appends = 0;
    const writer = new JournalWriter(paths, meta, 1, async (path, line) => {
      appends += 1;
      if (appends > 1) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      await writeFile(path, line, { flag: "a" });
    });
    await writeFile(paths.stdout, "first chunk\n", { mode: 0o600 });
    const capture = new OutputCapture({
      paths,
      writer,
      full: true,
      secrets: [],
      stall: new StallTracker(0, 0),
    });
    await capture.poll(false);
    await writeFile(paths.stdout, "second chunk that cannot be announced\n", {
      flag: "a",
    });
    // The child keeps writing; capture must not throw.
    await capture.poll(false);
    await capture.poll(true);
    expect(capture.noSpace).toBe(true);
    expect(capture.truncated).toBe(true);
    expect(await readFile(paths.stdout, "utf8")).toBe("first chunk\n");
    const output = (await readEvents(paths)).filter(
      (event) => event.type === "command.output"
    );
    expect(output.map((event) => event.payload.length)).toEqual([12]);
    expect(
      endedPayload({
        stopping: null,
        exitCode: 0,
        signal: null,
        truncated: true,
        suppressed: false,
        backend: "compose",
        noSpace: true,
      })
    ).toMatchObject({ outcome: "succeeded", captureStopped: "no_space" });
  });
});

describe("retention on access", () => {
  test("an ended command past retention expires when read, with no later start", async () => {
    const { paths, meta } = await acceptCommand({
      input: input({ retentionMs: 0 }),
      root,
    });
    await writeFile(paths.stdout, "kept output", { mode: 0o600 });
    await new JournalWriter(paths, meta, 1).write("command.ended", {
      outcome: "succeeded",
    });
    await expectCode(
      loadJournal({ commandId: meta.commandId, root }),
      "E_RESULT_EXPIRED"
    );
    expect(await lstat(paths.stdout).catch(() => null)).toBeNull();
    expect(await readFile(paths.meta, "utf8")).not.toContain("echo");
  });
});

describe("second-review blockers", () => {
  const deadOwner = {
    pid: 600_001,
    birth: "o",
    processGroupId: 600_001,
    sessionId: 600_001,
    newSession: true,
  };
  const noReboot = async () => 0;

  test("a child that may exist without a recorded identity is ownership unknown, never absence", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    await writeFile(paths.owner, JSON.stringify(deadOwner), { mode: 0o600 });
    // The supervisor died between writing the spawn marker and the child record.
    await writeFile(paths.spawning, "{}", { mode: 0o600 });
    await writeFile(paths.stdout, "still being written\n", { mode: 0o600 });
    const events = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
      readBootTime: noReboot,
    });
    expect(events.some((event) => event.type === "command.ended")).toBe(false);
    // Retention cannot remove a command that has no final record.
    await pruneExpired({ root, now: Date.now() + 365 * 24 * 3_600_000 });
    expect(await readFile(paths.stdout, "utf8")).toBe("still being written\n");
    // An unobserved birth is unknown too.
    await writeFile(
      paths.child,
      JSON.stringify({
        pid: 600_002,
        birth: "unobserved",
        processGroupId: 600_002,
      }),
      { mode: 0o600 }
    );
    const still = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
      readBootTime: noReboot,
    });
    expect(still.some((event) => event.type === "command.ended")).toBe(false);
    const journal = await loadJournal({ commandId: meta.commandId, root });
    const cancel = await cancelCommand({
      journal,
      root,
      observe: fakeObserve(),
      readBootTime: noReboot,
      signaller: { process: () => false, group: () => false },
    });
    expect(cancel.confirmed.childExited).toBe(false);
    expect(cancel.outcome).toBe("unconfirmed");
    // A reboot after acceptance proves the child gone: one unknown end.
    const after = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
      readBootTime: async () => Date.now() + 1000,
    });
    expect(
      after.filter((event) => event.type === "command.ended")
    ).toHaveLength(1);
  });

  test("a complete record without its newline is committed once, never duplicated", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    await writeFile(paths.owner, JSON.stringify(deadOwner), { mode: 0o600 });
    const ended = buildEnvelope({
      meta,
      seq: 2,
      type: "command.ended",
      payload: { outcome: "succeeded", exitCode: 0 },
    });
    // The crash came after the JSON and before its newline.
    await writeFile(paths.events, JSON.stringify(ended), { flag: "a" });
    const events = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
      readBootTime: noReboot,
    });
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(
      events.filter((event) => event.type === "command.ended")
    ).toHaveLength(1);
    expect(events.at(-1)?.payload.outcome).toBe("succeeded");
    // A fragment that is not the next record is cut, not committed.
    const second = await acceptCommand({ input: input(), root });
    await writeFile(second.paths.owner, JSON.stringify(deadOwner), {
      mode: 0o600,
    });
    await writeFile(second.paths.events, '{"v":1,"seq":9', { flag: "a" });
    const cut = await recoverLostOwner({
      paths: second.paths,
      meta: second.meta,
      observe: fakeObserve(),
      readBootTime: noReboot,
    });
    expect(cut.map((event) => event.seq)).toEqual([1, 2]);
    expect(cut.at(-1)?.type).toBe("command.ended");
    expect(await readFile(second.paths.events, "utf8")).not.toContain(
      '"seq":9'
    );
  });

  test("a full disk during recovery cannot block the final record", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    await writeFile(paths.owner, JSON.stringify(deadOwner), { mode: 0o600 });
    await writeFile(paths.stdout, "output that cannot be announced\n", {
      mode: 0o600,
    });
    const noSpace = () =>
      Object.assign(new Error("disk full"), { code: "ENOSPC" });
    let lockAttempts = 0;
    const events = await recoverLostOwner({
      paths,
      meta,
      observe: fakeObserve(),
      readBootTime: noReboot,
      // The lock's owner file is the first write in the recovery path.
      lock: async (lockPaths, run) => {
        lockAttempts += 1;
        if (lockAttempts === 1) {
          throw noSpace();
        }
        return await withJournalLock(lockPaths, run);
      },
      // Then every append fails except the final record's, which the
      // released reserve makes room for.
      append: async (path, line) => {
        if (!line.includes('"command.ended"')) {
          throw noSpace();
        }
        await writeFile(path, line, { flag: "a" });
      },
    });
    expect(lockAttempts).toBe(2);
    expect(await lstat(paths.reserve).catch(() => null)).toBeNull();
    const ended = events.filter((event) => event.type === "command.ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toMatchObject({
      outcome: "unknown",
      truncated: true,
    });
  });
});

describe("read bounds and run refusals", () => {
  test("a read is bounded by event count and envelope bytes, and always moves the cursor", async () => {
    const { meta, paths } = await acceptCommand({ input: input(), root });
    await writeFile(paths.owner, "{}", { mode: 0o600 });
    // 1500 one-byte invalid UTF-8 ranges: withheld, so they carry no text.
    await writeFile(paths.stdout, Buffer.alloc(1500, 0xff), { mode: 0o600 });
    const writer = new JournalWriter(paths, meta, 1);
    for (let offset = 0; offset < 1500; offset += 1) {
      await writer.write("command.output", {
        stream: "stdout",
        offset,
        length: 1,
      });
    }
    const journal = await loadJournal({ commandId: meta.commandId, root });
    const first = await readCommandEvents({
      journal,
      waitMs: 0,
      maxBytes: 16_384,
      observe: fakeObserve(),
    });
    expect(first.endReason).toBe("budget");
    expect(first.events.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(first.events).length).toBeLessThanOrEqual(
      16_384 * 4 + 1024
    );
    const second = await readCommandEvents({
      journal,
      after: first.nextCursor,
      waitMs: 0,
      maxBytes: 16_384,
      observe: fakeObserve(),
    });
    expect(second.events[0]?.seq).toBe((first.events.at(-1)?.seq ?? 0) + 1);
  });

  test("run --detach is refused when a dependency-cache installer would run first", () => {
    const background = { requestKey: null, json: true };
    expect(() =>
      refuseDetachedCacheBootstrap({ background, services: ["installer"] })
    ).toThrow(HackCliError);
    expect(() =>
      refuseDetachedCacheBootstrap({ background, services: [] })
    ).not.toThrow();
    expect(() =>
      refuseDetachedCacheBootstrap({
        background: null,
        services: ["installer"],
      })
    ).not.toThrow();
  });
});
