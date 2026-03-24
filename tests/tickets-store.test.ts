import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createNormalizedTicket,
  projectNormalizedTicketSummary,
} from "../src/control-plane/extensions/tickets/domain.ts";
import {
  buildTicketProvenance,
  findTicketRemoteLink,
} from "../src/control-plane/extensions/tickets/provenance.ts";
import { createTicketsStore } from "../src/control-plane/extensions/tickets/store.ts";
import { createGitTicketsChannel } from "../src/control-plane/extensions/tickets/tickets-git-channel.ts";
import { createDefaultControlPlaneConfig } from "../src/control-plane/sdk/config.ts";

const logger = {
  info: (_input: { message: string }) => {},
  warn: (_input: { message: string }) => {},
};

let tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
  tempRoots = [];
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
}, 60_000);

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
}, 60_000);

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

test("tickets store creates non-sequential ids and keeps them unique under concurrent creates", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-concurrent-create-",
  });
  const store = await createStore({ projectRoot });

  const results = await Promise.all(
    Array.from({ length: 16 }, (_value, index) =>
      store.createTicket({
        title: `Concurrent ticket ${index + 1}`,
        owner: "hack",
        source: "hack",
        actor: `creator-${index}@hack`,
      })
    )
  );

  if (!results.every((result) => result.ok)) {
    throw new Error(JSON.stringify(results, null, 2));
  }

  const ticketIds = results.flatMap((result) =>
    result.ok ? [result.ticket.ticketId] : []
  );
  expect(ticketIds).toHaveLength(16);
  expect(new Set(ticketIds).size).toBe(ticketIds.length);

  for (const ticketId of ticketIds) {
    expect(ticketId).toMatch(/^T-[0-9A-Z]{10}$/);
    expect(ticketId).not.toMatch(/^T-\d{5}$/);
  }
}, 20_000);

test("tickets store continues to read and update legacy sequential ids", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-legacy-id-",
  });
  const store = await createStore({ projectRoot });
  const git = createGitTicketsChannel({
    projectRoot,
    config: createDefaultControlPlaneConfig().tickets.git,
    logger,
  });

  const legacyEvent = {
    actor: "creator@hack",
    eventId: "legacy-ticket-created",
    payload: {
      owner: "hack",
      source: "hack",
      title: "Legacy sequential ticket",
    },
    ticketId: "T-00001",
    ts: 1_762_000_000,
    tsIso: "2025-11-04T00:00:00.000Z",
    type: "ticket.created",
  };
  const appended = await git.appendEvents({ events: [legacyEvent] });
  expect(appended.ok).toBe(true);

  const ticket = await store.getTicket({ ticketId: "T-00001" });
  expect(ticket?.title).toBe("Legacy sequential ticket");

  const updated = await store.updateTicket({
    ticketId: "T-00001",
    title: "Legacy sequential ticket updated",
    actor: "updater@hack",
  });
  expect(updated.ok).toBe(true);

  const updatedTicket = await store.getTicket({ ticketId: "T-00001" });
  expect(updatedTicket?.title).toBe("Legacy sequential ticket updated");
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

test("tickets store ignores duplicate sync checkpoints with the same idempotency key", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-checkpoint-idempotency-",
  });
  const store = await createStore({ projectRoot });

  const created = await store.createTicket({
    title: "Checkpoint idempotency",
    owner: "hack",
    source: "linear",
    actor: "creator@hack",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error);
  }

  const first = await store.recordSyncCheckpoint({
    ticketId: created.ticket.ticketId,
    provider: "linear",
    profileId: "default",
    direction: "hack_to_linear",
    remoteCursor: "ENG-321",
    idempotencyKey: "linear:checkpoint:T-00001:ENG-321",
    actor: "sync@app",
  });
  expect(first.ok).toBe(true);
  if (!first.ok) {
    throw new Error(first.error);
  }
  expect(first.recorded).toBe(true);

  const second = await store.recordSyncCheckpoint({
    ticketId: created.ticket.ticketId,
    provider: "linear",
    profileId: "default",
    direction: "hack_to_linear",
    remoteCursor: "ENG-321",
    idempotencyKey: "linear:checkpoint:T-00001:ENG-321",
    actor: "sync@app",
  });
  expect(second.ok).toBe(true);
  if (!second.ok) {
    throw new Error(second.error);
  }
  expect(second.recorded).toBe(false);

  const detail = await store.getTicketDetail({
    ticketId: created.ticket.ticketId,
  });
  expect(detail.syncCheckpoints).toHaveLength(1);
  expect(
    detail.events.filter(
      (event) => event.type === "ticket.sync_checkpoint_recorded"
    )
  ).toHaveLength(1);
}, 20_000);

test("tickets store records immutable documents and projects body from the active description", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-documents-",
  });
  const store = await createStore({ projectRoot });

  const created = await store.createTicket({
    title: "Document-backed ticket",
    body: "## Context\nInitial description",
    owner: "hack",
    source: "hack",
    actor: "creator@hack",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error);
  }

  const spec = await store.appendDocument({
    ticketId: created.ticket.ticketId,
    kind: "spec",
    content: "\n## Goals\n- Ship immutable ticket documents",
    actor: "author@hack",
  });
  expect(spec.ok).toBe(true);
  if (!spec.ok) {
    throw new Error(spec.error);
  }

  const description = await store.appendDocument({
    ticketId: created.ticket.ticketId,
    kind: "description",
    content: "## Context\nUpdated description",
    actor: "author@hack",
  });
  expect(description.ok).toBe(true);
  if (!description.ok) {
    throw new Error(description.error);
  }

  const detail = await store.getTicketDetail({
    ticketId: created.ticket.ticketId,
  });

  expect(detail.ticket?.body).toBe("## Context\nUpdated description");
  expect(detail.documents).toEqual([
    expect.objectContaining({
      kind: "description",
      role: "description",
      content: "## Context\nInitial description",
    }),
    expect.objectContaining({
      kind: "spec",
      role: "spec",
      content: "\n## Goals\n- Ship immutable ticket documents",
    }),
    expect.objectContaining({
      kind: "description",
      role: "description",
      content: "## Context\nUpdated description",
    }),
  ]);
  expect(
    detail.events.filter((event) => event.type === "ticket.document_recorded")
  ).toHaveLength(2);
}, 20_000);

test("tickets store persists a sqlite projection and rebuilds it when deleted", async () => {
  const projectRoot = await createTempGitProject({
    prefix: "hack-cli-tickets-projection-",
  });
  const projectionPath = join(projectRoot, ".hack/tickets/projection.sqlite");

  const firstStore = await createStore({ projectRoot });
  const created = await firstStore.createTicket({
    title: "Projection ticket",
    body: "Persisted through sqlite projection.",
    owner: "hack",
    source: "hack",
    actor: "creator@hack",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) {
    throw new Error(created.error);
  }

  const initialTickets = await firstStore.listTickets();
  expect(initialTickets.map((ticket) => ticket.title)).toContain(
    "Projection ticket"
  );
  expect(await Bun.file(projectionPath).exists()).toBe(true);

  const secondStore = await createStore({ projectRoot });
  const persistedTickets = await secondStore.listTickets();
  expect(persistedTickets.map((ticket) => ticket.title)).toContain(
    "Projection ticket"
  );

  await rm(projectionPath, { force: true });
  expect(await Bun.file(projectionPath).exists()).toBe(false);

  const rebuiltStore = await createStore({ projectRoot });
  const rebuiltTickets = await rebuiltStore.listTickets();
  expect(rebuiltTickets.map((ticket) => ticket.title)).toContain(
    "Projection ticket"
  );
  expect(await Bun.file(projectionPath).exists()).toBe(true);
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
  expect(normalized.provenance.remotes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "linear",
        remoteId: "lin_123",
        remoteKey: "HACK-431",
        remoteUrl: "https://linear.app/hack/issue/HACK-431",
        projectId: "project-1",
        projectName: "Hack App",
        teamId: "team-1",
      }),
      expect.objectContaining({
        provider: "linear",
        profileId: "default",
        remoteCursor: "issue/lin_123#v2",
      }),
    ])
  );
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

test("normalized ticket provenance captures multiple remotes, field authority, and field versions", () => {
  const normalized = createNormalizedTicket({
    ticket: {
      ticketId: "T-00077",
      title: "Normalize provenance",
      body: "Track provenance explicitly.",
      status: "open",
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T12:00:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "hack",
      source: "linear",
      assignee: "alice@hack",
      tags: ["normalization"],
      externalSystem: "linear",
      externalId: "lin-77",
      externalKey: "HACK-77",
      externalUrl: "https://linear.app/hack/issue/HACK-77",
      externalProjectId: "proj-77",
      externalProjectName: "Hack App",
      externalTeamId: "team-77",
      projectId: "hack-cli",
      projectName: "hack-cli",
    },
    syncCheckpoints: [
      {
        checkpointId: "checkpoint-linear",
        ticketId: "T-00077",
        provider: "linear",
        profileId: "default",
        direction: "pull",
        remoteCursor: "issue/lin-77#v3",
        remoteUpdatedAt: "2026-03-13T11:59:00.000Z",
        actor: "sync@app",
        createdAt: "2026-03-13T12:00:00.000Z",
      },
      {
        checkpointId: "checkpoint-github",
        ticketId: "T-00077",
        provider: "github",
        profileId: "mirror",
        direction: "push",
        remoteCursor: "issue/gh-77#v1",
        remoteUpdatedAt: "2026-03-13T11:45:00.000Z",
        actor: "sync@app",
        createdAt: "2026-03-13T12:00:00.000Z",
      },
    ],
    conflicts: [
      {
        conflictId: "conflict-title",
        ticketId: "T-00077",
        provider: "linear",
        field: "title",
        status: "open",
        authority: "review_required",
        summary: "Title changed in both places.",
        localValue: "Normalize provenance",
        remoteValue: "Normalize explicit provenance",
        createdAt: "2026-03-13T12:00:00.000Z",
        updatedAt: "2026-03-13T12:00:00.000Z",
      },
    ],
  });

  expect(normalized.provenance.remotes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: "linear",
        remoteId: "lin-77",
        remoteKey: "HACK-77",
      }),
      expect.objectContaining({
        provider: "github",
        profileId: "mirror",
        remoteCursor: "issue/gh-77#v1",
      }),
    ])
  );
  expect(normalized.provenance.fieldAuthorities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "title",
        authority: "review_required",
      }),
      expect.objectContaining({
        field: "comment",
        authority: "append_only",
      }),
    ])
  );
  expect(normalized.provenance.fieldVersions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "title",
        source: "local",
        recordedAt: "2026-03-13T12:00:00.000Z",
      }),
      expect.objectContaining({
        field: "title",
        source: "remote",
        provider: "linear",
        value: "Normalize explicit provenance",
      }),
    ])
  );
});

test("projectNormalizedTicketSummary uses the latest description document", () => {
  const normalized = createNormalizedTicket({
    ticket: {
      ticketId: "T-00089",
      title: "Prefer the latest description",
      body: "Legacy body",
      status: "open",
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T12:00:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "hack",
      source: "hack",
      tags: [],
    },
    documents: [
      {
        documentId: "T-00089:description:created",
        ticketId: "T-00089",
        kind: "description",
        role: "description",
        content: "Original description",
        contentSha256: "sha-original",
        createdAt: "2026-03-13T09:00:00.000Z",
        updatedAt: "2026-03-13T09:00:00.000Z",
      },
      {
        documentId: "T-00089:description:updated",
        ticketId: "T-00089",
        kind: "description",
        role: "description",
        content: "Latest description",
        contentSha256: "sha-latest",
        createdAt: "2026-03-13T11:00:00.000Z",
        updatedAt: "2026-03-13T12:00:00.000Z",
      },
    ],
  });

  expect(projectNormalizedTicketSummary({ ticket: normalized }).body).toBe(
    "Latest description"
  );
});

test("normalized ticket field states map legacy body conflicts to description", () => {
  const normalized = createNormalizedTicket({
    ticket: {
      ticketId: "T-00090",
      title: "Normalize body conflicts",
      body: "Local body",
      status: "open",
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T12:00:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "hack",
      source: "linear",
      tags: [],
    },
    conflicts: [
      {
        conflictId: "conflict-description",
        ticketId: "T-00090",
        provider: "linear",
        field: "body",
        status: "open",
        authority: "review_required",
        localValue: "Local body",
        remoteValue: "Remote body",
        createdAt: "2026-03-13T12:00:00.000Z",
        updatedAt: "2026-03-13T12:00:00.000Z",
      },
    ],
  });

  expect(normalized.fieldStates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "description",
        authority: "review_required",
        conflictIds: ["conflict-description"],
      }),
    ])
  );
});

test("ticket provenance infers a remote provider from source metadata when externalSystem is absent", () => {
  const ticket = {
    ticketId: "T-00088",
    title: "Infer remote provider",
    body: "Link a remote without an explicit external system field.",
    status: "open" as const,
    createdAt: "2026-03-13T09:00:00.000Z",
    updatedAt: "2026-03-13T12:00:00.000Z",
    dependsOn: [],
    blocks: [],
    owner: "hack",
    source: "linear",
    tags: ["normalization"],
    externalId: "lin-88",
    externalKey: "HACK-88",
    externalUrl: "https://linear.app/hack/issue/HACK-88",
    externalProjectId: "proj-88",
    externalProjectName: "Hack App",
    externalTeamId: "team-88",
  };

  const provenance = buildTicketProvenance({
    ticket,
    syncCheckpoints: [
      {
        checkpointId: "checkpoint-linear",
        ticketId: "T-00088",
        provider: "linear",
        direction: "pull",
        remoteCursor: "issue/lin-88#v1",
        remoteUpdatedAt: "2026-03-13T11:59:00.000Z",
        actor: "sync@app",
        createdAt: "2026-03-13T12:00:00.000Z",
      },
    ],
  });

  expect(findTicketRemoteLink({ ticket, provider: "linear" })).toEqual(
    expect.objectContaining({
      provider: "linear",
      remoteId: "lin-88",
      remoteKey: "HACK-88",
      remoteUrl: "https://linear.app/hack/issue/HACK-88",
    })
  );
  expect(provenance.fieldAuthorities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "title",
        authority: "remote",
      }),
      expect.objectContaining({
        field: "comment",
        authority: "append_only",
      }),
    ])
  );
});

async function createStore(opts: { readonly projectRoot: string }) {
  return createTicketsStore({
    projectRoot: opts.projectRoot,
    controlPlaneConfig: createDefaultControlPlaneConfig(),
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
    env: {
      ...process.env,
      HOME: homedir(),
    },
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
