import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { __testOnly } from "../src/control-plane/extensions/tickets/tickets-git-channel.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots.length = 0;
});

test("mergeTicketEventLogs dedupes by event id and preserves chronological order", () => {
  const merged = __testOnly.mergeTicketEventLogs({
    existing: [
      JSON.stringify({
        eventId: "event-2",
        ts: 2,
        ticketId: "T-00002",
        type: "ticket.created",
      }),
      JSON.stringify({
        eventId: "event-3",
        ts: 3,
        ticketId: "T-00003",
        type: "ticket.created",
      }),
      "",
    ].join("\n"),
    incoming: [
      JSON.stringify({
        eventId: "event-1",
        ts: 1,
        ticketId: "T-00001",
        type: "ticket.created",
      }),
      JSON.stringify({
        eventId: "event-2",
        ts: 2,
        ticketId: "T-00002",
        type: "ticket.created",
      }),
      "",
    ].join("\n"),
  });

  const lines = merged
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { readonly eventId: string; readonly ts: number }
    );

  expect(lines.map((line) => line.eventId)).toEqual([
    "event-1",
    "event-2",
    "event-3",
  ]);
  expect(lines.map((line) => line.ts)).toEqual([1, 2, 3]);
});

test("resolvePushRefForCheckoutRef prefers legacy branch when checkout came from legacy tracking ref", () => {
  const pushRef = __testOnly.resolvePushRefForCheckoutRef({
    checkoutRef: "refs/remotes/origin/__legacy__/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(pushRef).toBe("refs/heads/hack/tickets");
});

test("resolvePushRefForCheckoutRef keeps hidden ref when checkout came from hidden tracking ref", () => {
  const pushRef = __testOnly.resolvePushRefForCheckoutRef({
    checkoutRef: "origin/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(pushRef).toBe("refs/hack/tickets");
});

test("mutation lock heartbeat prevents overlapping prepared mutations past stale threshold", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-git-lock-",
  });
  const channel = __testOnly.createGitTicketsChannel({
    projectRoot,
    config: {
      enabled: true,
      branch: "hack/tickets",
      refMode: "hidden",
      remote: "",
    },
    logger: {
      info: (_input: { message: string }) => {},
      warn: (_input: { message: string }) => {},
    },
    testOverrides: {
      mutationLockRetryMs: 5,
      mutationLockStaleMs: 40,
      mutationLockTimeoutMs: 2000,
      mutationLockHeartbeatMs: 10,
    },
  });

  let activeCount = 0;
  let maxActiveCount = 0;

  const firstMutation = channel.appendPreparedEvents({
    prepare: async () => {
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await Bun.sleep(120);
      activeCount -= 1;
      return {
        ok: true,
        events: [
          {
            actor: "creator-1@hack",
            eventId: "event-1",
            payload: { title: "first" },
            ticketId: "T-AAAAAAA111",
            ts: 1,
            tsIso: "2025-11-04T00:00:00.000Z",
            type: "ticket.created",
          },
        ],
        result: "first",
      } as const;
    },
  });

  await Bun.sleep(60);

  const secondMutation = channel.appendPreparedEvents({
    prepare: async () => {
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      activeCount -= 1;
      return {
        ok: true,
        events: [
          {
            actor: "creator-2@hack",
            eventId: "event-2",
            payload: { title: "second" },
            ticketId: "T-BBBBBBB222",
            ts: 2,
            tsIso: "2025-11-04T00:00:01.000Z",
            type: "ticket.created",
          },
        ],
        result: "second",
      } as const;
    },
  });

  const results = await Promise.all([firstMutation, secondMutation]);

  expect(results).toEqual([
    { ok: true, result: "first" },
    { ok: true, result: "second" },
  ]);
  expect(maxActiveCount).toBe(1);
});

async function createTempGitProject(opts: {
  readonly prefix: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), opts.prefix));
  tempRoots.push(root);
  await copyDir({
    from: resolve(import.meta.dir, "../examples/tickets"),
    to: root,
  });
  await run({ cwd: root, cmd: ["git", "init"] });
  await run({ cwd: root, cmd: ["git", "config", "user.email", "tests@hack"] });
  await run({
    cwd: root,
    cmd: ["git", "config", "user.name", "hack-cli-tests"],
  });
  await run({ cwd: root, cmd: ["git", "add", "-A"] });
  await run({ cwd: root, cmd: ["git", "commit", "-m", "init"] });
  return root;
}

async function run(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}) {
  const proc = Bun.spawn([...opts.cmd], {
    cwd: opts.cwd,
    env: process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${opts.cmd.join(" ")}\n${stderr || stdout}`
    );
  }
}

async function copyDir(opts: {
  readonly from: string;
  readonly to: string;
}): Promise<void> {
  await mkdir(opts.to, { recursive: true });
  const entries = await readdir(opts.from, { withFileTypes: true });
  for (const entry of entries) {
    const fromPath = join(opts.from, entry.name);
    const toPath = join(opts.to, entry.name);
    if (entry.isDirectory()) {
      await copyDir({ from: fromPath, to: toPath });
    } else if (entry.isFile()) {
      const data = await readFile(fromPath);
      await writeFile(toPath, data);
    }
  }
}
