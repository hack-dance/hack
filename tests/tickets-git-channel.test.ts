import { afterEach, expect, test } from "bun:test";
import {
  chmod,
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
        schemaVersion: 1,
        ts: 2,
        occurredAt: "2026-03-13T00:00:02.000Z",
        recordedAt: "2026-03-13T00:00:02.000Z",
        sourceSystem: "hack",
        sourceOperation: "ticket.created",
        idempotencyKey: "event-2",
        ticketId: "T-00002",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      JSON.stringify({
        eventId: "event-3",
        schemaVersion: 1,
        ts: 3,
        occurredAt: "2026-03-13T00:00:03.000Z",
        recordedAt: "2026-03-13T00:00:03.000Z",
        sourceSystem: "hack",
        sourceOperation: "ticket.created",
        idempotencyKey: "event-3",
        ticketId: "T-00003",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      "",
    ].join("\n"),
    incoming: [
      JSON.stringify({
        eventId: "event-1",
        schemaVersion: 1,
        ts: 1,
        occurredAt: "2026-03-13T00:00:01.000Z",
        recordedAt: "2026-03-13T00:00:01.000Z",
        sourceSystem: "linear",
        sourceOperation: "issue.import",
        idempotencyKey: "linear:issue:1",
        ticketId: "T-00001",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      JSON.stringify({
        eventId: "event-2",
        schemaVersion: 1,
        ts: 2,
        occurredAt: "2026-03-13T00:00:02.000Z",
        recordedAt: "2026-03-13T00:00:02.000Z",
        sourceSystem: "hack",
        sourceOperation: "ticket.created",
        idempotencyKey: "event-2",
        ticketId: "T-00002",
        eventType: "ticket.created",
        type: "ticket.created",
        payload: {},
      }),
      "",
    ].join("\n"),
  });

  const lines = merged
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly eventId: string;
          readonly ts: number;
          readonly schemaVersion: number;
          readonly sourceSystem: string;
          readonly sourceOperation: string;
          readonly idempotencyKey: string;
          readonly eventType: string;
        }
    );

  expect(lines.map((line) => line.eventId)).toEqual([
    "event-1",
    "event-2",
    "event-3",
  ]);
  expect(lines.map((line) => line.ts)).toEqual([1, 2, 3]);
  expect(lines[0]).toMatchObject({
    schemaVersion: 1,
    sourceSystem: "linear",
    sourceOperation: "issue.import",
    idempotencyKey: "linear:issue:1",
    eventType: "ticket.created",
  });
});

test("mergeTicketEventLogs preserves normalized journal envelope fields", () => {
  const merged = __testOnly.mergeTicketEventLogs({
    existing: [
      JSON.stringify({
        eventId: "event-2",
        schemaVersion: 1,
        ts: 2,
        occurredAt: "2026-03-13T10:00:02.000Z",
        recordedAt: "2026-03-13T10:00:03.000Z",
        ticketId: "T-00002",
        type: "ticket.created",
        sourceSystem: "linear",
        sourceOperation: "webhook_pull",
        idempotencyKey: "linear:event-2",
      }),
      "",
    ].join("\n"),
    incoming: [
      JSON.stringify({
        eventId: "event-1",
        schemaVersion: 1,
        ts: 1,
        occurredAt: "2026-03-13T10:00:01.000Z",
        recordedAt: "2026-03-13T10:00:01.500Z",
        ticketId: "T-00001",
        type: "ticket.created",
        sourceSystem: "hack",
        sourceOperation: "local_command",
        idempotencyKey: "hack:event-1",
      }),
      "",
    ].join("\n"),
  });

  const lines = merged
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(lines).toEqual([
    expect.objectContaining({
      eventId: "event-1",
      schemaVersion: 1,
      sourceSystem: "hack",
      sourceOperation: "local_command",
      idempotencyKey: "hack:event-1",
    }),
    expect.objectContaining({
      eventId: "event-2",
      schemaVersion: 1,
      sourceSystem: "linear",
      sourceOperation: "webhook_pull",
      idempotencyKey: "linear:event-2",
    }),
  ]);
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
      forceBareClone: false,
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

test("resolveLocalCheckoutFallback blocks stale local fallback when fetch failure must be surfaced", () => {
  const result = __testOnly.resolveLocalCheckoutFallback({
    fetchFailure: "git fetch failed: origin unavailable",
    allowFetchFailureFallback: false,
    preferredTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(result).toEqual({
    ok: false,
    error: "git fetch failed: origin unavailable",
  });
});

test("resolveLocalCheckoutFallback preserves the legacy push ref when local fallback is allowed", () => {
  const result = __testOnly.resolveLocalCheckoutFallback({
    fetchFailure: "git fetch failed: origin unavailable",
    allowFetchFailureFallback: true,
    preferredTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    remoteRef: "refs/hack/tickets",
    legacyTrackingRef: "refs/remotes/origin/__legacy__/hack/tickets",
    legacyRemoteRef: "refs/heads/hack/tickets",
  });

  expect(result).toEqual({
    ok: true,
    pushRef: "refs/heads/hack/tickets",
  });
});

test("resolveLegacyImportFetchResult surfaces non-missing legacy fetch failures", () => {
  const result = __testOnly.resolveLegacyImportFetchResult({
    missing: false,
    error: "fatal: remote transport failed",
  });

  expect(result).toEqual({
    ok: false,
    error: "git fetch failed: fatal: remote transport failed",
  });
});

test("resolveLegacyImportFetchResult ignores missing legacy refs", () => {
  const result = __testOnly.resolveLegacyImportFetchResult({
    missing: true,
    error: "fatal: couldn't find remote ref refs/heads/hack/tickets",
  });

  expect(result).toEqual({
    ok: true,
    imported: false,
  });
});

test("formatTicketsGitRemoteError adds actionable SSH guidance", () => {
  const message = __testOnly.formatTicketsGitRemoteError({
    message:
      'sign_and_send_pubkey: signing failed for ED25519 "/Users/hack/.ssh/id_ed25519" from agent: agent refused operation\nPermission denied (publickey).',
    operation: "fetch",
  });

  expect(message).toContain("Unlock your SSH agent or 1Password");
  expect(message).toContain("ssh -T git@github.com");
  expect(__testOnly.isTicketsGitRemoteConnectivityError(message)).toBe(true);
});

test("sync returns actionable SSH guidance when git remote auth fails", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-git-auth-failure-",
  });
  const remoteScriptPath = join(projectRoot, "fake-ssh.sh");
  await writeFile(
    remoteScriptPath,
    [
      "#!/bin/sh",
      "echo 'sign_and_send_pubkey: signing failed for ED25519 \"/Users/hack/.ssh/id_ed25519\" from agent: agent refused operation' >&2",
      'echo "git@github.com: Permission denied (publickey)." >&2',
      "exit 255",
      "",
    ].join("\n")
  );
  await chmod(remoteScriptPath, 0o755);
  await run({
    cwd: projectRoot,
    cmd: [
      "git",
      "remote",
      "add",
      "origin",
      "ssh://git@example.invalid/does-not-exist",
    ],
  });

  const originalGitSshCommand = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = remoteScriptPath;
  try {
    const channel = __testOnly.createGitTicketsChannel({
      projectRoot,
      config: {
        enabled: true,
        branch: "hack/tickets",
        refMode: "hidden",
        remote: "origin",
        forceBareClone: false,
      },
      logger: {
        info: (_input: { message: string }) => {},
        warn: (_input: { message: string }) => {},
      },
    });

    const synced = await channel.sync();
    expect(synced.ok).toBe(false);
    if (synced.ok) {
      throw new Error("Expected sync to fail");
    }
    expect(synced.error).toContain("Unlock your SSH agent or 1Password");
    expect(synced.error).toContain("ssh -T git@github.com");
  } finally {
    if (originalGitSshCommand === undefined) {
      process.env.GIT_SSH_COMMAND = undefined;
    } else {
      process.env.GIT_SSH_COMMAND = originalGitSshCommand;
    }
  }
});

test("sync timeout kills remote git subprocess groups", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-git-timeout-",
  });
  const remoteScriptPath = join(projectRoot, "fake-ssh-timeout.sh");
  await writeFile(
    remoteScriptPath,
    [
      "#!/bin/sh",
      "sleep 30 &",
      "child=$!",
      "trap 'kill \"$child\" 2>/dev/null; exit 0' TERM INT",
      'wait "$child"',
      "",
    ].join("\n")
  );
  await chmod(remoteScriptPath, 0o755);
  await run({
    cwd: projectRoot,
    cmd: [
      "git",
      "remote",
      "add",
      "origin",
      "ssh://git@example.invalid/does-not-exist",
    ],
  });

  const originalGitSshCommand = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = remoteScriptPath;
  try {
    const channel = __testOnly.createGitTicketsChannel({
      projectRoot,
      config: {
        enabled: true,
        branch: "hack/tickets",
        refMode: "hidden",
        remote: "origin",
        forceBareClone: false,
      },
      logger: {
        info: (_input: { message: string }) => {},
        warn: (_input: { message: string }) => {},
      },
      testOverrides: {
        remoteGitTimeoutMs: 200,
      },
    });

    const startedAt = Date.now();
    const synced = await channel.sync();
    const elapsedMs = Date.now() - startedAt;
    expect(synced.ok).toBe(false);
    if (synced.ok) {
      throw new Error("Expected sync to fail");
    }
    expect(synced.error).toContain("timed out after");
    expect(elapsedMs).toBeLessThan(5000);
  } finally {
    if (originalGitSshCommand === undefined) {
      process.env.GIT_SSH_COMMAND = undefined;
    } else {
      process.env.GIT_SSH_COMMAND = originalGitSshCommand;
    }
  }
}, 10_000);

test("repair reapplies cleanup after a non-fast-forward push retry", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-git-repair-",
  });
  const remoteRoot = await mkdtemp(join(tmpdir(), "hack-cli-tickets-remote-"));
  tempRoots.push(remoteRoot);
  await run({ cwd: remoteRoot, cmd: ["git", "init", "--bare"] });
  await run({
    cwd: projectRoot,
    cmd: ["git", "remote", "add", "origin", remoteRoot],
  });

  const remoteClone = await createTempGitProject({
    prefix: "hack-cli-tickets-remote-clone-",
  });
  await run({
    cwd: remoteClone,
    cmd: ["git", "remote", "add", "origin", remoteRoot],
  });

  const channelWriter = __testOnly.createGitTicketsChannel({
    projectRoot,
    config: {
      enabled: true,
      branch: "hack/tickets",
      refMode: "hidden",
      remote: "origin",
      forceBareClone: false,
    },
    logger: {
      info: (_input: { message: string }) => {},
      warn: (_input: { message: string }) => {},
    },
  });
  const remoteWriter = __testOnly.createGitTicketsChannel({
    projectRoot: remoteClone,
    config: {
      enabled: true,
      branch: "hack/tickets",
      refMode: "hidden",
      remote: "origin",
      forceBareClone: false,
    },
    logger: {
      info: (_input: { message: string }) => {},
      warn: (_input: { message: string }) => {},
    },
  });

  const appendResult = await channelWriter.appendEvents({
    events: [
      createTicketEvent({
        eventId: "event-1",
        ticketId: "T-AAAAAAA111",
        ts: 1,
      }),
    ],
  });
  expect(appendResult).toEqual({ ok: true });

  const worktree = await channelWriter.ensureCheckedOut();
  await writeFile(resolve(worktree, ".hack/notes.txt"), "legacy noise\n");

  let remoteAdvanced = false;
  const repairingChannel = __testOnly.createGitTicketsChannel({
    projectRoot,
    config: {
      enabled: true,
      branch: "hack/tickets",
      refMode: "hidden",
      remote: "origin",
      forceBareClone: false,
    },
    logger: {
      info: (_input: { message: string }) => {},
      warn: (_input: { message: string }) => {},
    },
    testOverrides: {
      beforePushAttempt: async ({ attempt }) => {
        if (attempt !== 1 || remoteAdvanced) {
          return;
        }
        remoteAdvanced = true;
        const result = await remoteWriter.appendEvents({
          events: [
            createTicketEvent({
              eventId: "event-2",
              ticketId: "T-BBBBBBB222",
              ts: 2,
            }),
          ],
        });
        expect(result).toEqual({ ok: true });
      },
    },
  });

  const repaired = await repairingChannel.repair({
    pruneLegacyRef: false,
  });
  expect(repaired).toMatchObject({
    ok: true,
    didPush: true,
  });

  const listed = await runCapture({
    cwd: remoteRoot,
    cmd: ["git", "ls-tree", "-r", "--name-only", "refs/hack/tickets"],
  });
  expect(listed.stdout).toContain(".hack/tickets/README.md");
  expect(listed.stdout).toContain(".hack/tickets/events/events-1970-01.jsonl");
  expect(listed.stdout).not.toContain(".hack/notes.txt");

  const eventsText = await runCapture({
    cwd: remoteRoot,
    cmd: [
      "git",
      "show",
      "refs/hack/tickets:.hack/tickets/events/events-1970-01.jsonl",
    ],
  });
  expect(eventsText.stdout).toContain('"eventId":"event-1"');
  expect(eventsText.stdout).toContain('"eventId":"event-2"');
});

test("ensureCheckedOut can reuse the local tickets branch without refreshing remotes", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-git-local-checkout-",
  });

  const channel = __testOnly.createGitTicketsChannel({
    projectRoot,
    config: {
      enabled: true,
      branch: "hack/tickets",
      refMode: "hidden",
      remote: "origin",
      forceBareClone: false,
    },
    logger: {
      info: (_input: { message: string }) => {},
      warn: (_input: { message: string }) => {},
    },
  });

  const initialWorktree = await channel.ensureCheckedOut({
    refreshRemote: false,
  });
  expect(
    await Bun.file(resolve(initialWorktree, ".hack/tickets/README.md")).text()
  ).toContain("Tickets ref for hack-cli");

  await run({
    cwd: projectRoot,
    cmd: ["git", "remote", "add", "origin", "ssh://127.0.0.1:1/does-not-exist"],
  });

  const worktree = await channel.ensureCheckedOut({ refreshRemote: false });

  expect(
    await Bun.file(resolve(worktree, ".hack/tickets/README.md")).text()
  ).toContain("Tickets ref for hack-cli");
});

test("ensureCheckedOut does not poison a fresh clone after an unreachable first remote", async () => {
  const remoteRoot = await mkdtemp(join(tmpdir(), "hack-cli-tickets-remote-"));
  tempRoots.push(remoteRoot);
  await run({ cwd: remoteRoot, cmd: ["git", "init", "--bare"] });

  const writerRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-git-writer-recovery-",
  });
  await run({
    cwd: writerRoot,
    cmd: ["git", "remote", "add", "origin", remoteRoot],
  });

  const writerChannel = __testOnly.createGitTicketsChannel({
    projectRoot: writerRoot,
    config: {
      enabled: true,
      branch: "hack/tickets",
      refMode: "hidden",
      remote: "origin",
      forceBareClone: false,
    },
    logger: {
      info: (_input: { message: string }) => {},
      warn: (_input: { message: string }) => {},
    },
  });
  expect(
    await writerChannel.appendEvents({
      events: [
        createTicketEvent({
          eventId: "event-1",
          ticketId: "T-AAAAAAA111",
          ts: 1,
        }),
      ],
    })
  ).toEqual({ ok: true });

  const readerRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-git-reader-recovery-",
  });
  await run({
    cwd: readerRoot,
    cmd: ["git", "remote", "add", "origin", "ssh://127.0.0.1:1/does-not-exist"],
  });

  const readerChannel = __testOnly.createGitTicketsChannel({
    projectRoot: readerRoot,
    config: {
      enabled: true,
      branch: "hack/tickets",
      refMode: "hidden",
      remote: "origin",
      forceBareClone: false,
    },
    logger: {
      info: (_input: { message: string }) => {},
      warn: (_input: { message: string }) => {},
    },
  });

  await expect(readerChannel.ensureCheckedOut()).rejects.toThrow();

  await run({
    cwd: readerRoot,
    cmd: ["git", "remote", "set-url", "origin", remoteRoot],
  });

  const worktree = await readerChannel.ensureCheckedOut();
  expect(
    await Bun.file(
      resolve(worktree, ".hack/tickets/events/events-1970-01.jsonl")
    ).text()
  ).toContain('"eventId":"event-1"');
});

async function createTempGitProject(input: {
  readonly prefix: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), input.prefix));
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

async function run(input: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}) {
  const { exitCode, stderr, stdout } = await runCapture(input);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${input.cmd.join(" ")}\n${stderr || stdout}`
    );
  }
}

async function runCapture(input: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn([...input.cmd], {
    cwd: input.cwd,
    env: process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function createTicketEvent(input: {
  readonly eventId: string;
  readonly ticketId: string;
  readonly ts: number;
}): Record<string, unknown> {
  const iso = new Date(input.ts * 1000).toISOString();
  return {
    actor: "tests@hack",
    eventId: input.eventId,
    idempotencyKey: input.eventId,
    occurredAt: iso,
    payload: { title: input.eventId },
    recordedAt: iso,
    schemaVersion: 1,
    sourceOperation: "test",
    sourceSystem: "hack",
    ticketId: input.ticketId,
    ts: input.ts,
    type: "ticket.created",
  };
}

async function copyDir(input: {
  readonly from: string;
  readonly to: string;
}): Promise<void> {
  await mkdir(input.to, { recursive: true });
  const entries = await readdir(input.from, { withFileTypes: true });
  for (const entry of entries) {
    const fromPath = join(input.from, entry.name);
    const toPath = join(input.to, entry.name);
    if (entry.isDirectory()) {
      await copyDir({ from: fromPath, to: toPath });
    } else if (entry.isFile()) {
      const data = await readFile(fromPath);
      await writeFile(toPath, data);
    }
  }
}
