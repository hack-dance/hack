import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { isRecord } from "../../../lib/guards.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";
import { createGitTicketsChannel } from "./tickets-git-channel.ts";
import {
  formatTicketId,
  normalizeTicketRefs,
  parseTicketNumber,
  unixSeconds,
} from "./util.ts";

export type TicketStatus = "open" | "in_progress" | "blocked" | "done";

export type TicketSummary = {
  readonly ticketId: string;
  readonly title: string;
  readonly body?: string;
  readonly status: TicketStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependsOn: readonly string[];
  readonly blocks: readonly string[];
  readonly owner: string;
  readonly source: string;
  readonly assignee?: string;
  readonly tags: readonly string[];
  readonly externalSystem?: string;
  readonly externalId?: string;
  readonly externalKey?: string;
  readonly externalUrl?: string;
  readonly externalProjectId?: string;
  readonly externalProjectName?: string;
  readonly externalTeamId?: string;
  readonly projectId?: string;
  readonly projectName?: string;
};

export type TicketMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly TicketMetadataValue[]
  | { readonly [key: string]: TicketMetadataValue };

export type TicketComment = {
  readonly commentId: string;
  readonly ticketId: string;
  readonly body: string;
  readonly source: string;
  readonly actor: string;
  readonly createdAt: string;
  readonly externalId?: string;
  readonly externalUrl?: string;
};

export type TicketReviewNote = {
  readonly noteId: string;
  readonly ticketId: string;
  readonly body: string;
  readonly actor: string;
  readonly createdAt: string;
  readonly context?: string;
};

export type TicketSyncCheckpoint = {
  readonly checkpointId: string;
  readonly ticketId: string;
  readonly provider: string;
  readonly profileId?: string;
  readonly direction?: string;
  readonly remoteCursor?: string;
  readonly remoteUpdatedAt?: string;
  readonly localUpdatedAt?: string;
  readonly actor: string;
  readonly createdAt: string;
};

export type TicketSyncConflictResolution =
  | "accept_local"
  | "accept_remote"
  | "merged"
  | "ignore";

export type TicketSyncConflict = {
  readonly conflictId: string;
  readonly ticketId: string;
  readonly provider: string;
  readonly field: string;
  readonly status: "open" | "resolved";
  readonly authority?: string;
  readonly summary?: string;
  readonly localValue?: TicketMetadataValue;
  readonly remoteValue?: TicketMetadataValue;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolution?: TicketSyncConflictResolution;
  readonly resolutionSummary?: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
};

export type TicketEvent = {
  readonly eventId: string;
  readonly ts: number;
  readonly tsIso: string;
  readonly actor: string;
  readonly orderKey?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly ticketId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

export type TicketStoreSnapshot = {
  readonly tickets: readonly TicketSummary[];
  readonly eventsByTicket: ReadonlyMap<string, readonly TicketEvent[]>;
  readonly commentsByTicket: ReadonlyMap<string, readonly TicketComment[]>;
  readonly reviewNotesByTicket: ReadonlyMap<
    string,
    readonly TicketReviewNote[]
  >;
  readonly syncCheckpointsByTicket: ReadonlyMap<
    string,
    readonly TicketSyncCheckpoint[]
  >;
  readonly conflictsByTicket: ReadonlyMap<
    string,
    readonly TicketSyncConflict[]
  >;
};

type CreateTicketResult =
  | { readonly ok: true; readonly ticket: TicketSummary }
  | { readonly ok: false; readonly error: string };

type SyncResult =
  | {
      readonly ok: true;
      readonly branch: string;
      readonly remote?: string;
      readonly didCommit: boolean;
      readonly didPush: boolean;
    }
  | { readonly ok: false; readonly error: string };

type MaterializedTicketState = {
  readonly tickets: Map<string, TicketSummary>;
  readonly commentsByTicket: Map<string, TicketComment[]>;
  readonly reviewNotesByTicket: Map<string, TicketReviewNote[]>;
  readonly syncCheckpointsByTicket: Map<string, TicketSyncCheckpoint[]>;
  readonly conflictsByTicket: Map<string, TicketSyncConflict[]>;
};

export function createTicketsStore(opts: {
  readonly projectRoot: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly logger: {
    info: (input: { message: string }) => void;
    warn: (input: { message: string }) => void;
  };
}): {
  readonly createTicket: (input: {
    readonly title: string;
    readonly body?: string;
    readonly dependsOn?: readonly string[];
    readonly blocks?: readonly string[];
    readonly owner?: string;
    readonly source?: string;
    readonly assignee?: string;
    readonly tags?: readonly string[];
    readonly externalSystem?: string;
    readonly externalId?: string;
    readonly externalKey?: string;
    readonly externalUrl?: string;
    readonly externalProjectId?: string;
    readonly externalProjectName?: string;
    readonly externalTeamId?: string;
    readonly actor?: string;
  }) => Promise<CreateTicketResult>;
  readonly updateTicket: (input: {
    readonly ticketId: string;
    readonly title?: string;
    readonly body?: string;
    readonly dependsOn?: readonly string[];
    readonly blocks?: readonly string[];
    readonly owner?: string;
    readonly source?: string;
    readonly assignee?: string;
    readonly tags?: readonly string[];
    readonly externalSystem?: string;
    readonly externalId?: string;
    readonly externalKey?: string;
    readonly externalUrl?: string;
    readonly externalProjectId?: string;
    readonly externalProjectName?: string;
    readonly externalTeamId?: string;
    readonly actor?: string;
  }) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  >;
  readonly listTickets: () => Promise<readonly TicketSummary[]>;
  readonly getTicket: (input: {
    readonly ticketId: string;
  }) => Promise<TicketSummary | null>;
  readonly listEvents: (input: {
    readonly ticketId: string;
  }) => Promise<readonly TicketEvent[]>;
  readonly getTicketDetail: (input: { readonly ticketId: string }) => Promise<{
    readonly ticket: TicketSummary | null;
    readonly events: readonly TicketEvent[];
    readonly comments: readonly TicketComment[];
    readonly reviewNotes: readonly TicketReviewNote[];
    readonly syncCheckpoints: readonly TicketSyncCheckpoint[];
    readonly conflicts: readonly TicketSyncConflict[];
  }>;
  readonly appendComment: (input: {
    readonly ticketId: string;
    readonly body: string;
    readonly source?: string;
    readonly externalId?: string;
    readonly externalUrl?: string;
    readonly actor?: string;
  }) => Promise<
    | { readonly ok: true; readonly comment: TicketComment }
    | { readonly ok: false; readonly error: string }
  >;
  readonly appendReviewNote: (input: {
    readonly ticketId: string;
    readonly body: string;
    readonly context?: string;
    readonly actor?: string;
  }) => Promise<
    | { readonly ok: true; readonly reviewNote: TicketReviewNote }
    | { readonly ok: false; readonly error: string }
  >;
  readonly linkCommentExternalId: (input: {
    readonly ticketId: string;
    readonly commentId: string;
    readonly externalId: string;
    readonly externalUrl?: string;
    readonly actor?: string;
  }) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  >;
  readonly recordSyncCheckpoint: (input: {
    readonly ticketId: string;
    readonly provider: string;
    readonly profileId?: string;
    readonly direction?: string;
    readonly remoteCursor?: string;
    readonly remoteUpdatedAt?: string;
    readonly localUpdatedAt?: string;
    readonly actor?: string;
  }) => Promise<
    | { readonly ok: true; readonly checkpoint: TicketSyncCheckpoint }
    | { readonly ok: false; readonly error: string }
  >;
  readonly recordSyncConflict: (input: {
    readonly ticketId: string;
    readonly provider: string;
    readonly field: string;
    readonly authority?: string;
    readonly summary?: string;
    readonly localValue?: TicketMetadataValue;
    readonly remoteValue?: TicketMetadataValue;
    readonly actor?: string;
  }) => Promise<
    | { readonly ok: true; readonly conflict: TicketSyncConflict }
    | { readonly ok: false; readonly error: string }
  >;
  readonly resolveSyncConflict: (input: {
    readonly ticketId: string;
    readonly conflictId: string;
    readonly resolution: TicketSyncConflictResolution;
    readonly summary?: string;
    readonly actor?: string;
  }) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  >;
  readonly readSnapshot: () => Promise<TicketStoreSnapshot>;
  readonly setStatus: (input: {
    readonly ticketId: string;
    readonly status: TicketStatus;
    readonly actor?: string;
  }) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  >;
  readonly sync: () => Promise<SyncResult>;
} {
  const git = createGitTicketsChannel({
    projectRoot: opts.projectRoot,
    config: opts.controlPlaneConfig.tickets.git,
    logger: opts.logger,
  });
  let eventSequence = 0;

  const resolveActor = (override?: string): string => {
    const trimmed = (override ?? "").trim();
    if (trimmed) {
      return trimmed;
    }
    const user = (process.env.USER ?? "").trim() || "unknown";
    return `${user}@${hostname()}`;
  };

  const buildEvent = (input: {
    readonly ticketId: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
    readonly actor?: string;
  }): TicketEvent => {
    const ts = unixSeconds();
    const orderKey = `${Date.now()}-${String(eventSequence).padStart(6, "0")}`;
    eventSequence += 1;
    return {
      eventId: randomUUID(),
      ts,
      tsIso: new Date(ts * 1000).toISOString(),
      actor: resolveActor(input.actor),
      orderKey,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.projectName ? { projectName: opts.projectName } : {}),
      ticketId: input.ticketId,
      type: input.type,
      payload: input.payload,
    };
  };

  const readAllEvents = async (): Promise<readonly TicketEvent[]> => {
    const root = await git.ensureCheckedOut();
    const eventsDir = resolve(root, ".hack/tickets/events");

    let entries: string[] = [];
    try {
      entries = (await readdir(eventsDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const events: TicketEvent[] = [];
    for (const filename of entries.sort()) {
      const path = resolve(eventsDir, filename);
      const text = await Bun.file(path)
        .text()
        .catch(() => "");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const parsed = safeJsonParse(trimmed);
        const event = parseEvent(parsed);
        if (event) {
          events.push(event);
        }
      }
    }

    events.sort((a, b) => {
      if (a.ts !== b.ts) {
        return a.ts - b.ts;
      }
      if (a.orderKey && b.orderKey && a.orderKey !== b.orderKey) {
        return a.orderKey.localeCompare(b.orderKey);
      }
      return 0;
    });
    return events;
  };

  const materializeTickets = async (): Promise<Map<string, TicketSummary>> => {
    const events = await readAllEvents();
    return materializeSnapshotFromEvents({ events }).tickets;
  };

  const materializeSnapshotFromEvents = (input: {
    readonly events: readonly TicketEvent[];
  }): MaterializedTicketState => {
    const tickets = new Map<string, TicketSummary>();
    const commentsByTicket = new Map<string, TicketComment[]>();
    const reviewNotesByTicket = new Map<string, TicketReviewNote[]>();
    const syncCheckpointsByTicket = new Map<string, TicketSyncCheckpoint[]>();
    const conflictsByTicket = new Map<string, TicketSyncConflict[]>();

    for (const event of input.events) {
      applyTicketEvent({
        tickets,
        commentsByTicket,
        reviewNotesByTicket,
        syncCheckpointsByTicket,
        conflictsByTicket,
        event,
      });
    }

    return {
      tickets: applyDerivedBlocks(tickets),
      commentsByTicket,
      reviewNotesByTicket,
      syncCheckpointsByTicket,
      conflictsByTicket,
    };
  };

  const groupEventsByTicket = (input: {
    readonly events: readonly TicketEvent[];
  }): Map<string, TicketEvent[]> => {
    const grouped = new Map<string, TicketEvent[]>();
    for (const event of input.events) {
      const list = grouped.get(event.ticketId) ?? [];
      list.push(event);
      grouped.set(event.ticketId, list);
    }
    return grouped;
  };

  const sortTickets = (input: {
    readonly tickets: Iterable<TicketSummary>;
  }): TicketSummary[] => {
    const out = [...input.tickets];
    out.sort(
      (a, b) =>
        (parseTicketNumber(a.ticketId) ?? 0) -
        (parseTicketNumber(b.ticketId) ?? 0)
    );
    return out;
  };

  const computeNextTicketId = async (): Promise<string> => {
    const events = await readAllEvents();
    const snapshot = materializeSnapshotFromEvents({ events });
    let max = 0;
    for (const ticketId of snapshot.tickets.keys()) {
      const n = parseTicketNumber(ticketId);
      if (n !== null && n > max) {
        max = n;
      }
    }
    return formatTicketId(max + 1);
  };

  const setStatus = async (input: {
    readonly ticketId: string;
    readonly status: TicketStatus;
    readonly actor?: string;
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    const tickets = await materializeTickets();
    const current = tickets.get(input.ticketId);
    if (!current) {
      return { ok: false, error: `Ticket not found: ${input.ticketId}` };
    }

    const event = buildEvent({
      ticketId: input.ticketId,
      type: "ticket.status_changed",
      payload: { status: input.status },
      actor: input.actor,
    });

    return await git.appendEvents({ events: [event] });
  };

  return {
    createTicket: async (input) => {
      const ticketId = await computeNextTicketId();
      const dependsOn = normalizeTicketRefs(input.dependsOn ?? []);
      const blocks = normalizeTicketRefs(input.blocks ?? []);
      const owner = normalizeOwnerOrSource({
        value: input.owner,
        fallback: "hack",
      });
      const source = normalizeOwnerOrSource({
        value: input.source,
        fallback: "hack",
      });
      const assignee = normalizeOptionalMetadataString({
        value: input.assignee,
      });
      const tags = normalizeTags(input.tags ?? []);
      const externalSystem = normalizeOptionalMetadataString({
        value: input.externalSystem,
      });
      const externalId = normalizeOptionalMetadataString({
        value: input.externalId,
      });
      const externalKey = normalizeOptionalMetadataString({
        value: input.externalKey,
      });
      const externalUrl = normalizeOptionalMetadataString({
        value: input.externalUrl,
      });
      const externalProjectId = normalizeOptionalMetadataString({
        value: input.externalProjectId,
      });
      const externalProjectName = normalizeOptionalMetadataString({
        value: input.externalProjectName,
      });
      const externalTeamId = normalizeOptionalMetadataString({
        value: input.externalTeamId,
      });
      const event = buildEvent({
        ticketId,
        type: "ticket.created",
        payload: {
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          ...(blocks.length > 0 ? { blocks } : {}),
          owner,
          source,
          ...(assignee ? { assignee } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(externalSystem ? { externalSystem } : {}),
          ...(externalId ? { externalId } : {}),
          ...(externalKey ? { externalKey } : {}),
          ...(externalUrl ? { externalUrl } : {}),
          ...(externalProjectId ? { externalProjectId } : {}),
          ...(externalProjectName ? { externalProjectName } : {}),
          ...(externalTeamId ? { externalTeamId } : {}),
          status: "open",
        },
        actor: input.actor,
      });

      const wrote = await git.appendEvents({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        ticket: {
          ticketId,
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          status: "open",
          createdAt: event.tsIso,
          updatedAt: event.tsIso,
          dependsOn,
          blocks,
          owner,
          source,
          ...(assignee ? { assignee } : {}),
          tags,
          ...(externalSystem ? { externalSystem } : {}),
          ...(externalId ? { externalId } : {}),
          ...(externalKey ? { externalKey } : {}),
          ...(externalUrl ? { externalUrl } : {}),
          ...(externalProjectId ? { externalProjectId } : {}),
          ...(externalProjectName ? { externalProjectName } : {}),
          ...(externalTeamId ? { externalTeamId } : {}),
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          ...(opts.projectName ? { projectName: opts.projectName } : {}),
        },
      };
    },

    updateTicket: async (input) => {
      const tickets = await materializeTickets();
      const current = tickets.get(input.ticketId);
      if (!current) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const payload: Record<string, unknown> = {};
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) {
          return { ok: false, error: "Title cannot be empty." };
        }
        payload.title = title;
      }
      if (input.body !== undefined) {
        payload.body = input.body;
      }
      if (input.dependsOn !== undefined) {
        payload.dependsOn = normalizeTicketRefs(input.dependsOn);
      }
      if (input.blocks !== undefined) {
        payload.blocks = normalizeTicketRefs(input.blocks);
      }
      if (input.owner !== undefined) {
        payload.owner = normalizeOwnerOrSource({
          value: input.owner,
          fallback: "hack",
        });
      }
      if (input.source !== undefined) {
        payload.source = normalizeOwnerOrSource({
          value: input.source,
          fallback: "hack",
        });
      }
      if (input.assignee !== undefined) {
        payload.assignee =
          normalizeOptionalMetadataString({
            value: input.assignee,
          }) ?? null;
      }
      if (input.tags !== undefined) {
        payload.tags = normalizeTags(input.tags);
      }
      if (input.externalSystem !== undefined) {
        payload.externalSystem = normalizeOptionalMetadataString({
          value: input.externalSystem,
        });
      }
      if (input.externalId !== undefined) {
        payload.externalId = normalizeOptionalMetadataString({
          value: input.externalId,
        });
      }
      if (input.externalKey !== undefined) {
        payload.externalKey = normalizeOptionalMetadataString({
          value: input.externalKey,
        });
      }
      if (input.externalUrl !== undefined) {
        payload.externalUrl = normalizeOptionalMetadataString({
          value: input.externalUrl,
        });
      }
      if (input.externalProjectId !== undefined) {
        payload.externalProjectId = normalizeOptionalMetadataString({
          value: input.externalProjectId,
        });
      }
      if (input.externalProjectName !== undefined) {
        payload.externalProjectName = normalizeOptionalMetadataString({
          value: input.externalProjectName,
        });
      }
      if (input.externalTeamId !== undefined) {
        payload.externalTeamId = normalizeOptionalMetadataString({
          value: input.externalTeamId,
        });
      }

      if (Object.keys(payload).length === 0) {
        return { ok: false, error: "No updates provided." };
      }

      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.updated",
        payload,
        actor: input.actor,
      });

      return await git.appendEvents({ events: [event] });
    },

    listTickets: async () => {
      const events = await readAllEvents();
      const snapshot = materializeSnapshotFromEvents({ events });
      return sortTickets({ tickets: snapshot.tickets.values() });
    },

    getTicket: async ({ ticketId }) => {
      const events = await readAllEvents();
      const snapshot = materializeSnapshotFromEvents({ events });
      return snapshot.tickets.get(ticketId) ?? null;
    },

    listEvents: async ({ ticketId }) => {
      const events = await readAllEvents();
      return events.filter((event) => event.ticketId === ticketId);
    },

    getTicketDetail: async ({ ticketId }) => {
      const events = await readAllEvents();
      const snapshot = materializeSnapshotFromEvents({ events });
      return {
        ticket: snapshot.tickets.get(ticketId) ?? null,
        events: events.filter((event) => event.ticketId === ticketId),
        comments: snapshot.commentsByTicket.get(ticketId) ?? [],
        reviewNotes: snapshot.reviewNotesByTicket.get(ticketId) ?? [],
        syncCheckpoints: snapshot.syncCheckpointsByTicket.get(ticketId) ?? [],
        conflicts: snapshot.conflictsByTicket.get(ticketId) ?? [],
      };
    },

    appendComment: async (input) => {
      const tickets = await materializeTickets();
      const current = tickets.get(input.ticketId);
      if (!current) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const body = input.body.trim();
      if (!body) {
        return { ok: false, error: "Comment body cannot be empty." };
      }

      const source = normalizeOwnerOrSource({
        value: input.source,
        fallback: current.source,
      });
      const externalId = normalizeOptionalMetadataString({
        value: input.externalId,
      });
      const externalUrl = normalizeOptionalMetadataString({
        value: input.externalUrl,
      });
      const commentId = randomUUID();
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.comment_appended",
        payload: {
          commentId,
          body,
          source,
          ...(externalId ? { externalId } : {}),
          ...(externalUrl ? { externalUrl } : {}),
        },
        actor: input.actor,
      });

      const wrote = await git.appendEvents({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        comment: {
          commentId,
          ticketId: input.ticketId,
          body,
          source,
          actor: event.actor,
          createdAt: event.tsIso,
          ...(externalId ? { externalId } : {}),
          ...(externalUrl ? { externalUrl } : {}),
        },
      };
    },

    appendReviewNote: async (input) => {
      const tickets = await materializeTickets();
      if (!tickets.has(input.ticketId)) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const body = input.body.trim();
      if (!body) {
        return { ok: false, error: "Review note body cannot be empty." };
      }

      const noteId = randomUUID();
      const context = normalizeOptionalMetadataString({
        value: input.context,
      });
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.review_note_appended",
        payload: {
          noteId,
          body,
          ...(context ? { context } : {}),
        },
        actor: input.actor,
      });

      const wrote = await git.appendEvents({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        reviewNote: {
          noteId,
          ticketId: input.ticketId,
          body,
          actor: event.actor,
          createdAt: event.tsIso,
          ...(context ? { context } : {}),
        },
      };
    },

    linkCommentExternalId: async (input) => {
      const detail = await readAllEvents();
      const snapshot = materializeSnapshotFromEvents({ events: detail });
      const comments = snapshot.commentsByTicket.get(input.ticketId) ?? [];
      const current = comments.find(
        (comment) => comment.commentId === input.commentId
      );
      if (!current) {
        return { ok: false, error: `Comment not found: ${input.commentId}` };
      }

      const externalId = normalizeOptionalMetadataString({
        value: input.externalId,
      });
      if (!externalId) {
        return { ok: false, error: "External comment id is required." };
      }
      const externalUrl = normalizeOptionalMetadataString({
        value: input.externalUrl,
      });
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.comment_linked",
        payload: {
          commentId: input.commentId,
          externalId,
          ...(externalUrl ? { externalUrl } : {}),
        },
        actor: input.actor,
      });

      return await git.appendEvents({ events: [event] });
    },

    recordSyncCheckpoint: async (input) => {
      const tickets = await materializeTickets();
      if (!tickets.has(input.ticketId)) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const provider = normalizeOptionalMetadataString({
        value: input.provider,
      });
      if (!provider) {
        return { ok: false, error: "Provider is required." };
      }

      const checkpointId = randomUUID();
      const profileId = normalizeOptionalMetadataString({
        value: input.profileId,
      });
      const direction = normalizeOptionalMetadataString({
        value: input.direction,
      });
      const remoteCursor = normalizeOptionalMetadataString({
        value: input.remoteCursor,
      });
      const remoteUpdatedAt = normalizeOptionalMetadataString({
        value: input.remoteUpdatedAt,
      });
      const localUpdatedAt = normalizeOptionalMetadataString({
        value: input.localUpdatedAt,
      });
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.sync_checkpoint_recorded",
        payload: {
          checkpointId,
          provider,
          ...(profileId ? { profileId } : {}),
          ...(direction ? { direction } : {}),
          ...(remoteCursor ? { remoteCursor } : {}),
          ...(remoteUpdatedAt ? { remoteUpdatedAt } : {}),
          ...(localUpdatedAt ? { localUpdatedAt } : {}),
        },
        actor: input.actor,
      });

      const wrote = await git.appendEvents({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        checkpoint: {
          checkpointId,
          ticketId: input.ticketId,
          provider,
          ...(profileId ? { profileId } : {}),
          ...(direction ? { direction } : {}),
          ...(remoteCursor ? { remoteCursor } : {}),
          ...(remoteUpdatedAt ? { remoteUpdatedAt } : {}),
          ...(localUpdatedAt ? { localUpdatedAt } : {}),
          actor: event.actor,
          createdAt: event.tsIso,
        },
      };
    },

    recordSyncConflict: async (input) => {
      const tickets = await materializeTickets();
      if (!tickets.has(input.ticketId)) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const provider = normalizeOptionalMetadataString({
        value: input.provider,
      });
      if (!provider) {
        return { ok: false, error: "Provider is required." };
      }
      const field = normalizeOptionalMetadataString({
        value: input.field,
      });
      if (!field) {
        return { ok: false, error: "Field is required." };
      }

      const conflictId = randomUUID();
      const authority = normalizeOptionalMetadataString({
        value: input.authority,
      });
      const summary = normalizeOptionalMetadataString({
        value: input.summary,
      });
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.sync_conflict_recorded",
        payload: {
          conflictId,
          provider,
          field,
          ...(authority ? { authority } : {}),
          ...(summary ? { summary } : {}),
          ...(input.localValue !== undefined
            ? { localValue: input.localValue }
            : {}),
          ...(input.remoteValue !== undefined
            ? { remoteValue: input.remoteValue }
            : {}),
        },
        actor: input.actor,
      });

      const wrote = await git.appendEvents({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        conflict: {
          conflictId,
          ticketId: input.ticketId,
          provider,
          field,
          status: "open",
          ...(authority ? { authority } : {}),
          ...(summary ? { summary } : {}),
          ...(input.localValue !== undefined
            ? { localValue: input.localValue }
            : {}),
          ...(input.remoteValue !== undefined
            ? { remoteValue: input.remoteValue }
            : {}),
          createdAt: event.tsIso,
          updatedAt: event.tsIso,
        },
      };
    },

    resolveSyncConflict: async (input) => {
      const detail = await readAllEvents();
      const snapshot = materializeSnapshotFromEvents({ events: detail });
      const conflicts = snapshot.conflictsByTicket.get(input.ticketId) ?? [];
      const current = conflicts.find(
        (conflict) => conflict.conflictId === input.conflictId
      );
      if (!current) {
        return { ok: false, error: `Conflict not found: ${input.conflictId}` };
      }

      const summary = normalizeOptionalMetadataString({
        value: input.summary,
      });
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.sync_conflict_resolved",
        payload: {
          conflictId: input.conflictId,
          resolution: input.resolution,
          ...(summary ? { summary } : {}),
        },
        actor: input.actor,
      });

      return await git.appendEvents({ events: [event] });
    },

    readSnapshot: async () => {
      const events = await readAllEvents();
      const snapshot = materializeSnapshotFromEvents({ events });
      return {
        tickets: sortTickets({ tickets: snapshot.tickets.values() }),
        eventsByTicket: groupEventsByTicket({ events }),
        commentsByTicket: snapshot.commentsByTicket,
        reviewNotesByTicket: snapshot.reviewNotesByTicket,
        syncCheckpointsByTicket: snapshot.syncCheckpointsByTicket,
        conflictsByTicket: snapshot.conflictsByTicket,
      };
    },

    sync: async () => {
      return await git.sync();
    },

    setStatus,
  };
}

function applyTicketEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly commentsByTicket: Map<string, TicketComment[]>;
  readonly reviewNotesByTicket: Map<string, TicketReviewNote[]>;
  readonly syncCheckpointsByTicket: Map<string, TicketSyncCheckpoint[]>;
  readonly conflictsByTicket: Map<string, TicketSyncConflict[]>;
  readonly event: TicketEvent;
}): void {
  switch (input.event.type) {
    case "ticket.created": {
      applyTicketCreatedEvent({
        tickets: input.tickets,
        event: input.event,
      });
      break;
    }
    case "ticket.status_changed": {
      applyTicketStatusChangedEvent({
        tickets: input.tickets,
        event: input.event,
      });
      break;
    }
    case "ticket.updated": {
      applyTicketUpdatedEvent({
        tickets: input.tickets,
        event: input.event,
      });
      break;
    }
    case "ticket.comment_appended": {
      applyTicketCommentAppendedEvent({
        tickets: input.tickets,
        commentsByTicket: input.commentsByTicket,
        event: input.event,
      });
      break;
    }
    case "ticket.comment_linked": {
      applyTicketCommentLinkedEvent({
        commentsByTicket: input.commentsByTicket,
        event: input.event,
      });
      break;
    }
    case "ticket.review_note_appended": {
      applyTicketReviewNoteAppendedEvent({
        tickets: input.tickets,
        reviewNotesByTicket: input.reviewNotesByTicket,
        event: input.event,
      });
      break;
    }
    case "ticket.sync_checkpoint_recorded": {
      applyTicketSyncCheckpointRecordedEvent({
        tickets: input.tickets,
        syncCheckpointsByTicket: input.syncCheckpointsByTicket,
        event: input.event,
      });
      break;
    }
    case "ticket.sync_conflict_recorded": {
      applyTicketSyncConflictRecordedEvent({
        tickets: input.tickets,
        conflictsByTicket: input.conflictsByTicket,
        event: input.event,
      });
      break;
    }
    case "ticket.sync_conflict_resolved": {
      applyTicketSyncConflictResolvedEvent({
        conflictsByTicket: input.conflictsByTicket,
        event: input.event,
      });
      break;
    }
    default: {
      break;
    }
  }
}

function applyTicketCreatedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly event: TicketEvent;
}): void {
  const title =
    typeof input.event.payload.title === "string"
      ? input.event.payload.title
      : "";
  const body =
    typeof input.event.payload.body === "string"
      ? input.event.payload.body
      : undefined;
  const dependsOn = parseDependencyList({
    value: input.event.payload.dependsOn,
  });
  const blocks = parseDependencyList({
    value: input.event.payload.blocks,
  });
  const owner = normalizeOwnerOrSource({
    value: readOptionalStringPayload({ value: input.event.payload.owner }),
    fallback: "hack",
  });
  const source = normalizeOwnerOrSource({
    value: readOptionalStringPayload({ value: input.event.payload.source }),
    fallback: "hack",
  });
  const assignee = readOptionalStringPayload({
    value: input.event.payload.assignee,
  });
  const tags = parseTags({ value: input.event.payload.tags });
  const externalSystem = readOptionalStringPayload({
    value: input.event.payload.externalSystem,
  });
  const externalId = readOptionalStringPayload({
    value: input.event.payload.externalId,
  });
  const externalKey = readOptionalStringPayload({
    value: input.event.payload.externalKey,
  });
  const externalUrl = readOptionalStringPayload({
    value: input.event.payload.externalUrl,
  });
  const externalProjectId = readOptionalStringPayload({
    value: input.event.payload.externalProjectId,
  });
  const externalProjectName = readOptionalStringPayload({
    value: input.event.payload.externalProjectName,
  });
  const externalTeamId = readOptionalStringPayload({
    value: input.event.payload.externalTeamId,
  });

  input.tickets.set(input.event.ticketId, {
    ticketId: input.event.ticketId,
    title,
    body,
    status: "open",
    createdAt: input.event.tsIso,
    updatedAt: input.event.tsIso,
    dependsOn,
    blocks,
    owner,
    source,
    ...(assignee ? { assignee } : {}),
    tags,
    ...(externalSystem ? { externalSystem } : {}),
    ...(externalId ? { externalId } : {}),
    ...(externalKey ? { externalKey } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(externalProjectId ? { externalProjectId } : {}),
    ...(externalProjectName ? { externalProjectName } : {}),
    ...(externalTeamId ? { externalTeamId } : {}),
    ...(input.event.projectId ? { projectId: input.event.projectId } : {}),
    ...(input.event.projectName
      ? { projectName: input.event.projectName }
      : {}),
  });
}

function applyTicketStatusChangedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly event: TicketEvent;
}): void {
  const current = input.tickets.get(input.event.ticketId);
  if (!current) {
    return;
  }

  const status = parseTicketStatus({ value: input.event.payload.status });
  if (!status) {
    return;
  }

  input.tickets.set(input.event.ticketId, {
    ...current,
    status,
    updatedAt: input.event.tsIso,
  });
}

function applyTicketUpdatedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly event: TicketEvent;
}): void {
  const current = input.tickets.get(input.event.ticketId);
  if (!current) {
    return;
  }

  const title =
    typeof input.event.payload.title === "string"
      ? input.event.payload.title
      : undefined;
  const body =
    typeof input.event.payload.body === "string"
      ? input.event.payload.body
      : undefined;
  const dependsOn = readDependencyUpdate({
    payload: input.event.payload,
    key: "dependsOn",
  });
  const blocks = readDependencyUpdate({
    payload: input.event.payload,
    key: "blocks",
  });
  const owner = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "owner",
  });
  const source = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "source",
  });
  const assignee = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "assignee",
  });
  const tags = readTagsUpdate({
    payload: input.event.payload,
    key: "tags",
  });
  const externalSystem = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "externalSystem",
  });
  const externalId = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "externalId",
  });
  const externalKey = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "externalKey",
  });
  const externalUrl = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "externalUrl",
  });
  const externalProjectId = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "externalProjectId",
  });
  const externalProjectName = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "externalProjectName",
  });
  const externalTeamId = readOptionalStringUpdate({
    payload: input.event.payload,
    key: "externalTeamId",
  });

  input.tickets.set(input.event.ticketId, {
    ...current,
    ...(title ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(dependsOn !== null ? { dependsOn } : {}),
    ...(blocks !== null ? { blocks } : {}),
    ...(owner !== null
      ? {
          owner: normalizeOwnerOrSource({
            value: owner,
            fallback: current.owner,
          }),
        }
      : {}),
    ...(source !== null
      ? {
          source: normalizeOwnerOrSource({
            value: source,
            fallback: current.source,
          }),
        }
      : {}),
    ...(assignee !== null ? { assignee: assignee || undefined } : {}),
    ...(tags !== null ? { tags } : {}),
    ...(externalSystem !== null
      ? { externalSystem: externalSystem || undefined }
      : {}),
    ...(externalId !== null ? { externalId: externalId || undefined } : {}),
    ...(externalKey !== null ? { externalKey: externalKey || undefined } : {}),
    ...(externalUrl !== null ? { externalUrl: externalUrl || undefined } : {}),
    ...(externalProjectId !== null
      ? { externalProjectId: externalProjectId || undefined }
      : {}),
    ...(externalProjectName !== null
      ? { externalProjectName: externalProjectName || undefined }
      : {}),
    ...(externalTeamId !== null
      ? { externalTeamId: externalTeamId || undefined }
      : {}),
    updatedAt: input.event.tsIso,
  });
}

function applyTicketCommentAppendedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly commentsByTicket: Map<string, TicketComment[]>;
  readonly event: TicketEvent;
}): void {
  if (!input.tickets.has(input.event.ticketId)) {
    return;
  }

  const body =
    readOptionalStringPayload({
      value: input.event.payload.body,
    }) ??
    readOptionalStringPayload({
      value: input.event.payload.markdown,
    });
  if (!body) {
    return;
  }

  const source = normalizeOwnerOrSource({
    value: readOptionalStringPayload({ value: input.event.payload.source }),
    fallback: "hack",
  });
  const externalId = readOptionalStringPayload({
    value: input.event.payload.externalId,
  });
  const externalUrl = readOptionalStringPayload({
    value: input.event.payload.externalUrl,
  });

  appendMapValue({
    map: input.commentsByTicket,
    key: input.event.ticketId,
    value: {
      commentId:
        readOptionalStringPayload({ value: input.event.payload.commentId }) ??
        input.event.eventId,
      ticketId: input.event.ticketId,
      body,
      source,
      actor: input.event.actor,
      createdAt: input.event.tsIso,
      ...(externalId ? { externalId } : {}),
      ...(externalUrl ? { externalUrl } : {}),
    },
  });
}

function applyTicketCommentLinkedEvent(input: {
  readonly commentsByTicket: Map<string, TicketComment[]>;
  readonly event: TicketEvent;
}): void {
  const commentId = readOptionalStringPayload({
    value: input.event.payload.commentId,
  });
  const externalId = readOptionalStringPayload({
    value: input.event.payload.externalId,
  });
  if (!(commentId && externalId)) {
    return;
  }
  const comments = input.commentsByTicket.get(input.event.ticketId);
  if (!comments) {
    return;
  }
  const externalUrl = readOptionalStringPayload({
    value: input.event.payload.externalUrl,
  });
  input.commentsByTicket.set(
    input.event.ticketId,
    comments.map((comment) =>
      comment.commentId === commentId
        ? {
            ...comment,
            externalId,
            ...(externalUrl ? { externalUrl } : {}),
          }
        : comment
    )
  );
}

function applyTicketReviewNoteAppendedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly reviewNotesByTicket: Map<string, TicketReviewNote[]>;
  readonly event: TicketEvent;
}): void {
  if (!input.tickets.has(input.event.ticketId)) {
    return;
  }

  const body =
    readOptionalStringPayload({ value: input.event.payload.body }) ??
    readOptionalStringPayload({ value: input.event.payload.markdown });
  if (!body) {
    return;
  }

  const context = readOptionalStringPayload({
    value: input.event.payload.context,
  });

  appendMapValue({
    map: input.reviewNotesByTicket,
    key: input.event.ticketId,
    value: {
      noteId:
        readOptionalStringPayload({ value: input.event.payload.noteId }) ??
        input.event.eventId,
      ticketId: input.event.ticketId,
      body,
      actor: input.event.actor,
      createdAt: input.event.tsIso,
      ...(context ? { context } : {}),
    },
  });
}

function applyTicketSyncCheckpointRecordedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly syncCheckpointsByTicket: Map<string, TicketSyncCheckpoint[]>;
  readonly event: TicketEvent;
}): void {
  if (!input.tickets.has(input.event.ticketId)) {
    return;
  }

  const provider = readOptionalStringPayload({
    value: input.event.payload.provider,
  });
  if (!provider) {
    return;
  }

  const profileId = readOptionalStringPayload({
    value: input.event.payload.profileId,
  });
  const direction = readOptionalStringPayload({
    value: input.event.payload.direction,
  });
  const remoteCursor = readOptionalStringPayload({
    value: input.event.payload.remoteCursor,
  });
  const remoteUpdatedAt = readOptionalStringPayload({
    value: input.event.payload.remoteUpdatedAt,
  });
  const localUpdatedAt = readOptionalStringPayload({
    value: input.event.payload.localUpdatedAt,
  });

  appendMapValue({
    map: input.syncCheckpointsByTicket,
    key: input.event.ticketId,
    value: {
      checkpointId:
        readOptionalStringPayload({
          value: input.event.payload.checkpointId,
        }) ?? input.event.eventId,
      ticketId: input.event.ticketId,
      provider,
      ...(profileId ? { profileId } : {}),
      ...(direction ? { direction } : {}),
      ...(remoteCursor ? { remoteCursor } : {}),
      ...(remoteUpdatedAt ? { remoteUpdatedAt } : {}),
      ...(localUpdatedAt ? { localUpdatedAt } : {}),
      actor: input.event.actor,
      createdAt: input.event.tsIso,
    },
  });
}

function applyTicketSyncConflictRecordedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly conflictsByTicket: Map<string, TicketSyncConflict[]>;
  readonly event: TicketEvent;
}): void {
  if (!input.tickets.has(input.event.ticketId)) {
    return;
  }

  const provider = readOptionalStringPayload({
    value: input.event.payload.provider,
  });
  const field = readOptionalStringPayload({ value: input.event.payload.field });
  if (!(provider && field)) {
    return;
  }

  const authority = readOptionalStringPayload({
    value: input.event.payload.authority,
  });
  const summary = readOptionalStringPayload({
    value: input.event.payload.summary,
  });
  const localValue = parseTicketMetadataValue(input.event.payload.localValue);
  const remoteValue = parseTicketMetadataValue(input.event.payload.remoteValue);

  appendMapValue({
    map: input.conflictsByTicket,
    key: input.event.ticketId,
    value: {
      conflictId:
        readOptionalStringPayload({ value: input.event.payload.conflictId }) ??
        input.event.eventId,
      ticketId: input.event.ticketId,
      provider,
      field,
      status: "open",
      ...(authority ? { authority } : {}),
      ...(summary ? { summary } : {}),
      ...(localValue !== undefined ? { localValue } : {}),
      ...(remoteValue !== undefined ? { remoteValue } : {}),
      createdAt: input.event.tsIso,
      updatedAt: input.event.tsIso,
    },
  });
}

function applyTicketSyncConflictResolvedEvent(input: {
  readonly conflictsByTicket: Map<string, TicketSyncConflict[]>;
  readonly event: TicketEvent;
}): void {
  const conflictId = readOptionalStringPayload({
    value: input.event.payload.conflictId,
  });
  const resolution = parseTicketSyncConflictResolution({
    value: input.event.payload.resolution,
  });
  if (!(conflictId && resolution)) {
    return;
  }

  const conflicts = input.conflictsByTicket.get(input.event.ticketId);
  if (!conflicts) {
    return;
  }

  const summary = readOptionalStringPayload({
    value: input.event.payload.summary,
  });
  input.conflictsByTicket.set(
    input.event.ticketId,
    conflicts.map((conflict) =>
      conflict.conflictId === conflictId
        ? {
            ...conflict,
            status: "resolved" as const,
            resolution,
            ...(summary ? { resolutionSummary: summary } : {}),
            resolvedAt: input.event.tsIso,
            resolvedBy: input.event.actor,
            updatedAt: input.event.tsIso,
          }
        : conflict
    )
  );
}

function parseTicketStatus(input: {
  readonly value: unknown;
}): TicketStatus | null {
  if (
    input.value === "open" ||
    input.value === "in_progress" ||
    input.value === "blocked" ||
    input.value === "done"
  ) {
    return input.value;
  }
  return null;
}

function parseDependencyList(input: { readonly value: unknown }): string[] {
  if (!Array.isArray(input.value)) {
    return [];
  }
  const values = input.value.filter(
    (item): item is string => typeof item === "string"
  );
  return normalizeTicketRefs(values);
}

function parseTags(input: { readonly value: unknown }): string[] {
  if (!Array.isArray(input.value)) {
    return [];
  }
  const tags = input.value.filter(
    (item): item is string => typeof item === "string"
  );
  return normalizeTags(tags);
}

function readDependencyUpdate(input: {
  readonly payload: Record<string, unknown>;
  readonly key: "dependsOn" | "blocks";
}): string[] | null {
  if (!Object.hasOwn(input.payload, input.key)) {
    return null;
  }
  return parseDependencyList({ value: input.payload[input.key] });
}

function readTagsUpdate(input: {
  readonly payload: Record<string, unknown>;
  readonly key: "tags";
}): string[] | null {
  if (!Object.hasOwn(input.payload, input.key)) {
    return null;
  }
  return parseTags({ value: input.payload[input.key] });
}

function readOptionalStringUpdate(input: {
  readonly payload: Record<string, unknown>;
  readonly key:
    | "assignee"
    | "owner"
    | "source"
    | "externalSystem"
    | "externalId"
    | "externalKey"
    | "externalUrl"
    | "externalProjectId"
    | "externalProjectName"
    | "externalTeamId";
}): string | null {
  if (!Object.hasOwn(input.payload, input.key)) {
    return null;
  }
  return readOptionalStringPayload({ value: input.payload[input.key] }) ?? "";
}

function appendMapValue<T>(input: {
  readonly map: Map<string, T[]>;
  readonly key: string;
  readonly value: T;
}): void {
  const current = input.map.get(input.key) ?? [];
  current.push(input.value);
  input.map.set(input.key, current);
}

function parseTicketMetadataValue(
  value: unknown
): TicketMetadataValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const out: TicketMetadataValue[] = [];
    for (const item of value) {
      const parsed = parseTicketMetadataValue(item);
      if (parsed === undefined) {
        return undefined;
      }
      out.push(parsed);
    }
    return out;
  }

  if (isRecord(value)) {
    const out: Record<string, TicketMetadataValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const parsed = parseTicketMetadataValue(item);
      if (parsed === undefined) {
        return undefined;
      }
      out[key] = parsed;
    }
    return out;
  }

  return undefined;
}

function parseTicketSyncConflictResolution(input: {
  readonly value: unknown;
}): TicketSyncConflictResolution | null {
  if (
    input.value === "accept_local" ||
    input.value === "accept_remote" ||
    input.value === "merged" ||
    input.value === "ignore"
  ) {
    return input.value;
  }
  return null;
}

function applyDerivedBlocks(
  tickets: Map<string, TicketSummary>
): Map<string, TicketSummary> {
  const derived = new Map<string, Set<string>>();
  for (const ticket of tickets.values()) {
    for (const dep of ticket.dependsOn) {
      const set = derived.get(dep) ?? new Set<string>();
      set.add(ticket.ticketId);
      derived.set(dep, set);
    }
  }

  for (const [ticketId, blockedBy] of derived) {
    const current = tickets.get(ticketId);
    if (!current) {
      continue;
    }
    const merged = normalizeTicketRefs([...current.blocks, ...blockedBy]);
    tickets.set(ticketId, {
      ...current,
      blocks: merged,
    });
  }

  return tickets;
}

function readOptionalStringPayload(input: {
  readonly value: unknown;
}): string | undefined {
  if (typeof input.value !== "string") {
    return undefined;
  }
  const trimmed = input.value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOwnerOrSource(input: {
  readonly value: string | undefined;
  readonly fallback: string;
}): string {
  const trimmed = (input.value ?? "").trim();
  return trimmed || input.fallback;
}

function normalizeOptionalMetadataString(input: {
  readonly value: string | undefined;
}): string | undefined {
  const trimmed = (input.value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!(trimmed && !seen.has(trimmed))) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  normalized.sort((left, right) => left.localeCompare(right));
  return normalized;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseEvent(value: unknown): TicketEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const eventId = typeof value.eventId === "string" ? value.eventId : "";
  const ts = typeof value.ts === "number" ? value.ts : Number.NaN;
  const actor = typeof value.actor === "string" ? value.actor : "";
  const orderKey =
    typeof value.orderKey === "string" ? value.orderKey : undefined;
  const ticketId = typeof value.ticketId === "string" ? value.ticketId : "";
  const type = typeof value.type === "string" ? value.type : "";
  const payload = isRecord(value.payload)
    ? (value.payload as Record<string, unknown>)
    : null;

  if (
    !(eventId && Number.isFinite(ts) && actor && ticketId && type && payload)
  ) {
    return null;
  }

  const projectId =
    typeof value.projectId === "string" ? value.projectId : undefined;
  const projectName =
    typeof value.projectName === "string" ? value.projectName : undefined;

  return {
    eventId,
    ts,
    tsIso: new Date(ts * 1000).toISOString(),
    actor,
    ...(orderKey ? { orderKey } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ticketId,
    type,
    payload,
  };
}
