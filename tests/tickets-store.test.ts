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
