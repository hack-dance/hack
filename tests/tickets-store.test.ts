import { afterEach, beforeEach, expect, test } from "bun:test";
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
import {
  createNormalizedTicket,
  projectNormalizedTicketSummary,
} from "../src/control-plane/extensions/tickets/domain.ts";
import { createTicketsStore } from "../src/control-plane/extensions/tickets/store.ts";
import { readControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const logger = {
  info: (_input: { message: string }) => {},
  warn: (_input: { message: string }) => {},
};

let tempGlobalConfigPath: string | null = null;
let tempRoots: string[] = [];

beforeEach(() => {
  tempGlobalConfigPath = join(
    tmpdir(),
    `hack-global-config-${Date.now()}-${Math.random()}.json`
  );
  process.env.HACK_GLOBAL_CONFIG_PATH = tempGlobalConfigPath;
});

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots = [];

  if (tempGlobalConfigPath) {
    await rm(tempGlobalConfigPath, { force: true });
    tempGlobalConfigPath = null;
  }

  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
});

test("tickets store materializes assignee, review notes, comments, checkpoints, and conflicts", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-store-",
  });
  const store = await createStore({ projectRoot });

  const created = await store.createTicket({
    title: "Sync metadata ticket",
    owner: "hack",
    source: "hack",
    actor: "creator@hack",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error);
  }

  const ticketId = created.ticket.ticketId;

  const updated = await store.updateTicket({
    ticketId,
    assignee: "alice@hack",
    actor: "router@hack",
  });
  expect(updated.ok).toBe(true);

  const firstComment = await store.appendComment({
    ticketId,
    body: "Imported from Linear.",
    source: "linear",
    externalId: "comment-1",
    actor: "linear@app",
  });
  expect(firstComment.ok).toBe(true);
  if (!firstComment.ok) {
    throw new Error(firstComment.error);
  }

  const secondComment = await store.appendComment({
    ticketId,
    body: "Local follow-up.",
    source: "hack",
    actor: "alice@hack",
  });
  expect(secondComment.ok).toBe(true);
  if (!secondComment.ok) {
    throw new Error(secondComment.error);
  }

  const reviewNote = await store.appendReviewNote({
    ticketId,
    body: "Investigate assignee before the next pull.",
    context: "conflict_review",
    actor: "alice@hack",
  });
  expect(reviewNote.ok).toBe(true);
  if (!reviewNote.ok) {
    throw new Error(reviewNote.error);
  }

  const linkedComment = await store.linkCommentExternalId({
    ticketId,
    commentId: secondComment.comment.commentId,
    externalId: "linear-comment-2",
    externalUrl: "https://linear.app/issue/HACK-1#comment-2",
    actor: "sync@app",
  });
  expect(linkedComment.ok).toBe(true);

  const checkpoint = await store.recordSyncCheckpoint({
    ticketId,
    provider: "linear",
    profileId: "default",
    direction: "pull",
    remoteCursor: "issue/LIN-123#v2",
    remoteUpdatedAt: "2026-03-05T18:15:00.000Z",
    actor: "sync@app",
  });
  expect(checkpoint.ok).toBe(true);
  if (!checkpoint.ok) {
    throw new Error(checkpoint.error);
  }

  const conflict = await store.recordSyncConflict({
    ticketId,
    provider: "linear",
    field: "assignee",
    localValue: "alice@hack",
    remoteValue: "bob@linear",
    authority: "origin",
    summary: "Assignee diverged during pull.",
    actor: "sync@app",
  });
  expect(conflict.ok).toBe(true);
  if (!conflict.ok) {
    throw new Error(conflict.error);
  }

  const resolved = await store.resolveSyncConflict({
    ticketId,
    conflictId: conflict.conflict.conflictId,
    resolution: "accept_remote",
    summary: "Linear remains source of truth for this field.",
    actor: "alice@hack",
  });
  expect(resolved.ok).toBe(true);

  const snapshot = await store.readSnapshot();
  const ticket = snapshot.tickets.find((item) => item.ticketId === ticketId);
  expect(ticket?.assignee).toBe("alice@hack");

  const comments = snapshot.commentsByTicket.get(ticketId) ?? [];
  expect(comments).toHaveLength(2);
  expect(comments.map((item) => item.body)).toEqual([
    "Imported from Linear.",
    "Local follow-up.",
  ]);
  expect(comments[0]).toMatchObject({
    source: "linear",
    externalId: "comment-1",
    actor: "linear@app",
  });
  expect(comments[1]).toMatchObject({
    source: "hack",
    externalId: "linear-comment-2",
    externalUrl: "https://linear.app/issue/HACK-1#comment-2",
  });

  const reviewNotes = snapshot.reviewNotesByTicket.get(ticketId) ?? [];
  expect(reviewNotes).toHaveLength(1);
  expect(reviewNotes[0]).toMatchObject({
    actor: "alice@hack",
    body: "Investigate assignee before the next pull.",
    context: "conflict_review",
  });

  const checkpoints = snapshot.syncCheckpointsByTicket.get(ticketId) ?? [];
  expect(checkpoints).toHaveLength(1);
  expect(checkpoints[0]).toMatchObject({
    provider: "linear",
    profileId: "default",
    direction: "pull",
    remoteCursor: "issue/LIN-123#v2",
    remoteUpdatedAt: "2026-03-05T18:15:00.000Z",
  });

  const conflicts = snapshot.conflictsByTicket.get(ticketId) ?? [];
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({
    provider: "linear",
    field: "assignee",
    status: "resolved",
    authority: "origin",
    localValue: "alice@hack",
    remoteValue: "bob@linear",
    resolution: "accept_remote",
    resolutionSummary: "Linear remains source of truth for this field.",
  });

  const events = await store.listEvents({ ticketId });
  expect(events.map((item) => item.type)).toEqual([
    "ticket.created",
    "ticket.updated",
    "ticket.comment_appended",
    "ticket.comment_appended",
    "ticket.review_note_appended",
    "ticket.comment_linked",
    "ticket.sync_checkpoint_recorded",
    "ticket.sync_conflict_recorded",
    "ticket.sync_conflict_resolved",
  ]);
  expect(events[0]).toMatchObject({
    schemaVersion: 1,
    eventType: "ticket.created",
    occurredAt: events[0]?.tsIso,
    recordedAt: events[0]?.tsIso,
    sourceSystem: "hack",
    sourceOperation: "local_command",
  });
  expect(events[0]?.idempotencyKey).toBe(events[0]?.eventId);
}, 20_000);

test("tickets show json includes materialized sync metadata", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-show-",
  });
  const store = await createStore({ projectRoot });

  const created = await store.createTicket({
    title: "Show metadata ticket",
    owner: "hack",
    source: "hack",
    actor: "creator@hack",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error);
  }

  const ticketId = created.ticket.ticketId;
  const updated = await store.updateTicket({
    ticketId,
    assignee: "alice@hack",
    actor: "router@hack",
  });
  expect(updated.ok).toBe(true);

  const comment = await store.appendComment({
    ticketId,
    body: "Needs review.",
    source: "linear",
    actor: "linear@app",
  });
  expect(comment.ok).toBe(true);

  const reviewNote = await store.appendReviewNote({
    ticketId,
    body: "Shared review note.",
    actor: "alice@hack",
  });
  expect(reviewNote.ok).toBe(true);

  const checkpoint = await store.recordSyncCheckpoint({
    ticketId,
    provider: "linear",
    profileId: "default",
    direction: "pull",
    remoteCursor: "issue/LIN-321#v3",
    actor: "sync@app",
  });
  expect(checkpoint.ok).toBe(true);

  const conflict = await store.recordSyncConflict({
    ticketId,
    provider: "linear",
    field: "status",
    localValue: "in_progress",
    remoteValue: "done",
    authority: "origin",
    summary: "Status diverged during sync.",
    actor: "sync@app",
  });
  expect(conflict.ok).toBe(true);

  const shown = await runHack({
    cwd: projectRoot,
    args: ["tickets", "show", ticketId, "--json"],
  });
  expect(shown.exitCode).toBe(0);

  const payload = JSON.parse(shown.stdout) as {
    ticket: { ticketId: string; assignee?: string };
    comments: { body: string }[];
    reviewNotes: { body: string }[];
    syncCheckpoints: { provider: string; remoteCursor?: string }[];
    conflicts: { field: string; status: string }[];
    events: { type: string }[];
  };

  expect(payload.ticket.ticketId).toBe(ticketId);
  expect(payload.ticket.assignee).toBe("alice@hack");
  expect(payload.comments).toHaveLength(1);
  expect(payload.comments[0]?.body).toBe("Needs review.");
  expect(payload.reviewNotes).toHaveLength(1);
  expect(payload.reviewNotes[0]?.body).toBe("Shared review note.");
  expect(payload.syncCheckpoints[0]).toMatchObject({
    provider: "linear",
    remoteCursor: "issue/LIN-321#v3",
  });
  expect(payload.conflicts[0]).toMatchObject({
    field: "status",
    status: "open",
  });
  expect(
    payload.events.some((event) => event.type === "ticket.comment_appended")
  ).toBe(true);
}, 20_000);

test("tickets store recovers from a stale tickets bare repo index.lock", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-stale-lock-",
  });
  const store = await createStore({ projectRoot });

  const created = await store.createTicket({
    title: "Stale lock ticket",
    owner: "hack",
    source: "hack",
    actor: "creator@hack",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error);
  }

  const lockPath = join(projectRoot, ".hack/tickets/git/bare.git/index.lock");
  await writeFile(lockPath, "stale lock\n");

  const tickets = await store.listTickets();
  expect(tickets.map((ticket) => ticket.title)).toContain("Stale lock ticket");
}, 20_000);

test("tickets store writes normalized journal envelope metadata and ignores duplicate idempotency keys", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-envelope-",
  });
  const store = await createStore({ projectRoot });

  const created = await store.createTicket({
    title: "Envelope ticket",
    owner: "hack",
    source: "hack",
    actor: "creator@hack",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error);
  }

  const eventsDir = join(
    projectRoot,
    ".hack/tickets/git/worktree/.hack/tickets/events"
  );
  const [eventsFile] = (await readdir(eventsDir)).filter((entry) =>
    entry.endsWith(".jsonl")
  );
  expect(eventsFile).toBeString();
  if (!eventsFile) {
    throw new Error("Missing tickets event log");
  }

  const eventsPath = join(eventsDir, eventsFile);
  const rawLines = (await readFile(eventsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(rawLines[0]).toMatchObject({
    schemaVersion: 1,
    ticketId: created.ticket.ticketId,
    occurredAt: created.ticket.createdAt,
    recordedAt: created.ticket.createdAt,
    sourceSystem: "hack",
    sourceOperation: "local_command",
  });
  expect(rawLines[0]?.idempotencyKey).toBe(rawLines[0]?.eventId);
  const baseTs = Number(rawLines[0]?.ts ?? 0) + 1;

  const duplicateBaseEvent = {
    schemaVersion: 1,
    ticketId: created.ticket.ticketId,
    type: "ticket.comment_appended",
    payload: {
      commentId: "comment-1",
      body: "Imported from Linear.",
      source: "linear",
    },
    actor: "linear@app",
    sourceSystem: "linear",
    sourceOperation: "webhook_pull",
    idempotencyKey: "linear:comment:1",
    occurredAt: "2026-03-13T11:00:00.000Z",
    recordedAt: "2026-03-13T11:00:01.000Z",
  };

  await writeFile(
    eventsPath,
    [
      await readFile(eventsPath, "utf8"),
      JSON.stringify({
        ...duplicateBaseEvent,
        eventId: "event-comment-1",
        ts: baseTs,
        orderKey: `${baseTs}-000000`,
      }),
      JSON.stringify({
        ...duplicateBaseEvent,
        eventId: "event-comment-2",
        ts: baseTs + 1,
        orderKey: `${baseTs + 1}-000000`,
      }),
      "",
    ].join("\n")
  );

  const snapshot = await store.readSnapshot();
  const comments = snapshot.commentsByTicket.get(created.ticket.ticketId) ?? [];
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({
    commentId: "comment-1",
    body: "Imported from Linear.",
    source: "linear",
  });
}, 20_000);

test("normalized ticket adapter preserves compatibility while exposing provenance and documents", () => {
  const summary = {
    ticketId: "T-00042",
    title: "Normalize ticket metadata",
    body: "## Context\nDocument-backed description",
    status: "in_progress" as const,
    createdAt: "2026-03-13T10:00:00.000Z",
    updatedAt: "2026-03-13T11:00:00.000Z",
    dependsOn: ["T-00001"],
    blocks: ["T-00009"],
    owner: "hack",
    source: "linear",
    assignee: "alice@hack",
    tags: ["core", "tickets"],
    externalSystem: "linear",
    externalId: "lin_123",
    externalKey: "HACK-431",
    externalUrl: "https://linear.app/hack/issue/HACK-431",
    externalProjectId: "project-1",
    externalProjectName: "Hack App",
    externalTeamId: "team-1",
    projectId: "hack-cli",
    projectName: "hack-cli",
  };

  const normalized = createNormalizedTicket({
    ticket: summary,
    syncCheckpoints: [
      {
        checkpointId: "checkpoint-1",
        ticketId: summary.ticketId,
        provider: "linear",
        profileId: "default",
        direction: "pull",
        remoteCursor: "issue/lin_123#v2",
        remoteUpdatedAt: "2026-03-13T10:59:00.000Z",
        localUpdatedAt: "2026-03-13T11:00:00.000Z",
        actor: "sync@app",
        createdAt: "2026-03-13T11:00:00.000Z",
      },
    ],
    conflicts: [
      {
        conflictId: "conflict-1",
        ticketId: summary.ticketId,
        provider: "linear",
        field: "title",
        status: "open",
        authority: "review_required",
        summary: "Local title drifted from Linear.",
        localValue: summary.title,
        remoteValue: "Normalize work model",
        createdAt: "2026-03-13T11:00:00.000Z",
        updatedAt: "2026-03-13T11:00:00.000Z",
      },
    ],
  });

  expect(normalized.identity).toEqual({
    ticketId: "T-00042",
    projectId: "hack-cli",
    projectName: "hack-cli",
  });
  expect(normalized.provenance.origin).toEqual({
    owner: "hack",
    source: "linear",
    system: "linear",
  });
  expect(normalized.provenance.remotes).toEqual([
    expect.objectContaining({
      provider: "linear",
      remoteId: "lin_123",
      remoteKey: "HACK-431",
      remoteUrl: "https://linear.app/hack/issue/HACK-431",
      projectId: "project-1",
      projectName: "Hack App",
      teamId: "team-1",
    }),
  ]);
  expect(normalized.documents).toEqual([
    expect.objectContaining({
      kind: "description",
      role: "description",
      content: "## Context\nDocument-backed description",
    }),
  ]);
  expect(normalized.fieldStates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "title",
        authority: "review_required",
        conflictIds: ["conflict-1"],
      }),
    ])
  );
  expect(projectNormalizedTicketSummary({ ticket: normalized })).toEqual(
    summary
  );
});

async function createStore(opts: { readonly projectRoot: string }) {
  const configResult = await readControlPlaneConfig({
    projectDir: join(opts.projectRoot, ".hack"),
  });
  return createTicketsStore({
    projectRoot: opts.projectRoot,
    controlPlaneConfig: configResult.config,
    logger,
  });
}

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

type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

async function run(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<RunResult> {
  const result = await runAllowFail(opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${opts.cmd.join(" ")}\n${result.stderr || result.stdout}`
    );
  }
  return result;
}

async function runAllowFail(opts: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<RunResult> {
  const proc = Bun.spawn([...opts.cmd], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function runHack(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<RunResult> {
  return await runAllowFail({
    cwd: opts.cwd,
    cmd: ["bun", resolve(import.meta.dir, "../index.ts"), ...opts.args],
  });
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
