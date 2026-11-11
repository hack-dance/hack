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
import type { ObservedIdentity } from "../src/lib/background-command/platform.ts";
import {
  loadJournal,
  readCommandEvents,
} from "../src/lib/background-command/reader.ts";
import {
  OWNER_START_GRACE_MS,
  recoverLostOwner,
} from "../src/lib/background-command/recovery.ts";
import {
  parseBackgroundCommandConfig,
  resolveBackgroundSettings,
} from "../src/lib/background-command/settings.ts";
import {
  type AcceptInput,
  acceptCommand,
  CALLER_ACTIVE_LIMIT,
  HOME_ACTIVE_LIMIT,
  pruneExpired,
} from "../src/lib/background-command/store.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

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
