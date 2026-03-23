import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { isRecord } from "../../../lib/guards.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";
import {
  buildLegacyDescriptionDocument,
  buildTicketDocument,
  getActiveTicketDescription,
  isTicketDocumentKind,
  isTicketDocumentRole,
  type TicketDocument,
  type TicketDocumentKind,
  type TicketDocumentRole,
} from "./documents.ts";
import {
  createNormalizedTicket,
  projectNormalizedTicketSummary,
} from "./domain.ts";
import { createTicketsSqliteProjection } from "./sqlite-projection.ts";
import { createGitTicketsChannel } from "./tickets-git-channel.ts";
import {
  compareTicketIds,
  generateTicketId,
  normalizeTicketRefs,
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
  readonly schemaVersion: number;
  readonly ts: number;
  readonly tsIso: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: string;
  readonly sourceSystem: string;
  readonly sourceOperation: string;
  readonly idempotencyKey: string;
  readonly causationId?: string;
  readonly correlationId?: string;
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
  readonly documentsByTicket: ReadonlyMap<string, readonly TicketDocument[]>;
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
  readonly documentsByTicket: Map<string, TicketDocument[]>;
  readonly commentsByTicket: Map<string, TicketComment[]>;
  readonly reviewNotesByTicket: Map<string, TicketReviewNote[]>;
  readonly syncCheckpointsByTicket: Map<string, TicketSyncCheckpoint[]>;
  readonly conflictsByTicket: Map<string, TicketSyncConflict[]>;
};

type TicketStoreContext = {
  readonly events: readonly TicketEvent[];
  readonly snapshot: TicketStoreSnapshot;
};

type NormalizedTicketMetadata = {
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
};

type TicketUpdatePayloadResult =
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
      readonly documentContent?: string;
    }
  | { readonly ok: false; readonly error: string };

type SyncCheckpointBuildResult =
  | {
      readonly ok: true;
      readonly checkpointId: string;
      readonly provider: string;
      readonly payload: Record<string, unknown>;
      readonly checkpoint: TicketSyncCheckpoint;
    }
  | { readonly ok: false; readonly error: string };

type SyncConflictBuildResult =
  | {
      readonly ok: true;
      readonly conflictId: string;
      readonly provider: string;
      readonly field: string;
      readonly payload: Record<string, unknown>;
      readonly conflict: Omit<TicketSyncConflict, "createdAt" | "updatedAt">;
    }
  | { readonly ok: false; readonly error: string };

const MAX_TICKET_ID_ALLOCATION_ATTEMPTS = 32;

function normalizeTicketSummaryCompatibility(input: {
  readonly ticket: TicketSummary;
}): TicketSummary {
  return projectNormalizedTicketSummary({
    ticket: createNormalizedTicket({
      ticket: input.ticket,
    }),
  });
}

export function createTicketsStore(opts: {
  readonly projectRoot: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly generateTicketId?: () => string;
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
    readonly documents: readonly TicketDocument[];
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
  readonly appendDocument: (input: {
    readonly ticketId: string;
    readonly kind: TicketDocumentKind;
    readonly role?: TicketDocumentRole;
    readonly content: string;
    readonly actor?: string;
  }) => Promise<
    | { readonly ok: true; readonly document: TicketDocument }
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
    readonly idempotencyKey?: string;
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
    readonly idempotencyKey?: string;
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
  const projection = createTicketsSqliteProjection({
    projectRoot: opts.projectRoot,
  });
  const allocateTicketId = opts.generateTicketId ?? generateTicketId;
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
    readonly occurredAt?: string;
    readonly sourceSystem?: string;
    readonly sourceOperation?: string;
    readonly idempotencyKey?: string;
    readonly causationId?: string;
    readonly correlationId?: string;
  }): TicketEvent => {
    const ts = unixSeconds();
    const recordedAt = new Date(ts * 1000).toISOString();
    const eventId = randomUUID();
    const orderKey = `${Date.now()}-${String(eventSequence).padStart(6, "0")}`;
    eventSequence += 1;
    return {
      eventId,
      schemaVersion: 1,
      ts,
      tsIso: recordedAt,
      eventType: input.type,
      occurredAt: input.occurredAt ?? recordedAt,
      recordedAt,
      actor: resolveActor(input.actor),
      sourceSystem: input.sourceSystem ?? "hack",
      sourceOperation: input.sourceOperation ?? "local_command",
      idempotencyKey: input.idempotencyKey ?? eventId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      orderKey,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.projectName ? { projectName: opts.projectName } : {}),
      ticketId: input.ticketId,
      type: input.type,
      payload: input.payload,
    };
  };

  const readAllEventsFromRoot = async (input: {
    readonly root: string;
  }): Promise<readonly TicketEvent[]> => {
    const eventsDir = resolve(input.root, ".hack/tickets/events");

    let entries: string[] = [];
    try {
      entries = (await readdir(eventsDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }

    const events: TicketEvent[] = [];
    const seenEventIds = new Set<string>();
    const seenIdempotencyKeys = new Set<string>();
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
        if (!event || seenEventIds.has(event.eventId)) {
          continue;
        }
        if (seenIdempotencyKeys.has(event.idempotencyKey)) {
          continue;
        }
        seenEventIds.add(event.eventId);
        seenIdempotencyKeys.add(event.idempotencyKey);
        events.push(event);
      }
    }

    events.sort((a, b) => {
      if (a.ticketId === b.ticketId && a.type !== b.type) {
        if (a.type === "ticket.created") {
          return -1;
        }
        if (b.type === "ticket.created") {
          return 1;
        }
      }
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

  const materializeSnapshotFromEvents = (input: {
    readonly events: readonly TicketEvent[];
  }): MaterializedTicketState => {
    const tickets = new Map<string, TicketSummary>();
    const documentsByTicket = new Map<string, TicketDocument[]>();
    const commentsByTicket = new Map<string, TicketComment[]>();
    const reviewNotesByTicket = new Map<string, TicketReviewNote[]>();
    const syncCheckpointsByTicket = new Map<string, TicketSyncCheckpoint[]>();
    const conflictsByTicket = new Map<string, TicketSyncConflict[]>();

    for (const event of input.events) {
      applyTicketEvent({
        tickets,
        documentsByTicket,
        commentsByTicket,
        reviewNotesByTicket,
        syncCheckpointsByTicket,
        conflictsByTicket,
        event,
      });
    }

    return {
      tickets: applyDerivedBlocks(tickets),
      documentsByTicket,
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
    out.sort((left, right) => {
      const createdAt = left.createdAt.localeCompare(right.createdAt);
      if (createdAt !== 0) {
        return createdAt;
      }
      return compareTicketIds(left.ticketId, right.ticketId);
    });
    return out;
  };

  const buildStoreSnapshot = (input: {
    readonly events: readonly TicketEvent[];
    readonly materialized: MaterializedTicketState;
  }): TicketStoreSnapshot => {
    return {
      tickets: sortTickets({ tickets: input.materialized.tickets.values() }),
      eventsByTicket: groupEventsByTicket({ events: input.events }),
      documentsByTicket: input.materialized.documentsByTicket,
      commentsByTicket: input.materialized.commentsByTicket,
      reviewNotesByTicket: input.materialized.reviewNotesByTicket,
      syncCheckpointsByTicket: input.materialized.syncCheckpointsByTicket,
      conflictsByTicket: input.materialized.conflictsByTicket,
    };
  };

  const rebuildProjectionFromJournal = async (): Promise<
    | { readonly ok: true; readonly context: TicketStoreContext }
    | {
        readonly ok: false;
        readonly error: string;
      }
  > => {
    try {
      const root = await git.ensureCheckedOut();
      const events = await readAllEventsFromRoot({ root });
      const materialized = materializeSnapshotFromEvents({ events });
      const snapshot = buildStoreSnapshot({ events, materialized });
      const journalSignature = await projection.computeJournalSignature({
        ticketsRoot: root,
      });
      await projection.replaceSnapshot({
        journalSignature,
        snapshot,
      });
      return {
        ok: true,
        context: {
          events,
          snapshot,
        },
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to rebuild tickets sqlite projection";
      return {
        ok: false,
        error: message,
      };
    }
  };

  const loadStoreContext = async (): Promise<TicketStoreContext> => {
    const root = await git.ensureCheckedOut();
    const journalSignature = await projection.computeJournalSignature({
      ticketsRoot: root,
    });
    const persisted = await projection.readSnapshot({
      journalSignature,
    });
    if (persisted) {
      const events = [...persisted.eventsByTicket.values()].flat();
      return {
        events,
        snapshot: persisted,
      };
    }

    const rebuilt = await rebuildProjectionFromJournal();
    if (rebuilt.ok) {
      return rebuilt.context;
    }

    const events = await readAllEventsFromRoot({ root });
    const materialized = materializeSnapshotFromEvents({ events });
    return {
      events,
      snapshot: buildStoreSnapshot({ events, materialized }),
    };
  };

  const materializeTickets = async (): Promise<Map<string, TicketSummary>> => {
    const context = await loadStoreContext();
    return new Map(
      context.snapshot.tickets.map(
        (ticket) => [ticket.ticketId, ticket] as const
      )
    );
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

    const wrote = await git.appendEvents({ events: [event] });
    if (!wrote.ok) {
      return wrote;
    }

    const rebuilt = await rebuildProjectionFromJournal();
    if (!rebuilt.ok) {
      return rebuilt;
    }

    return { ok: true };
  };

  const appendEventsAndRefresh = async (input: {
    readonly events: readonly TicketEvent[];
  }): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: string }
  > => {
    const context = await loadStoreContext();
    const seenIdempotencyKeys = new Set(
      context.events.map((event) => event.idempotencyKey)
    );
    const pendingEvents = input.events.filter((event) => {
      if (seenIdempotencyKeys.has(event.idempotencyKey)) {
        return false;
      }
      seenIdempotencyKeys.add(event.idempotencyKey);
      return true;
    });
    if (pendingEvents.length === 0) {
      return { ok: true };
    }

    const wrote = await git.appendEvents({ events: pendingEvents });
    if (!wrote.ok) {
      return wrote;
    }

    const rebuilt = await rebuildProjectionFromJournal();
    if (!rebuilt.ok) {
      return rebuilt;
    }

    return { ok: true };
  };

  return {
    createTicket: async (input) => {
      const metadata = normalizeTicketMetadata({
        dependsOn: input.dependsOn,
        blocks: input.blocks,
        owner: input.owner,
        source: input.source,
        assignee: input.assignee,
        tags: input.tags,
        externalSystem: input.externalSystem,
        externalId: input.externalId,
        externalKey: input.externalKey,
        externalUrl: input.externalUrl,
        externalProjectId: input.externalProjectId,
        externalProjectName: input.externalProjectName,
        externalTeamId: input.externalTeamId,
        ownerFallback: "hack",
        sourceFallback: "hack",
      });
      const payload: Record<string, unknown> = {
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        status: "open",
      };
      appendTicketMetadataPayload({
        payload,
        metadata,
      });
      const wrote = await git.appendPreparedEvents({
        prepare: async (root) => {
          const events = await readAllEventsFromRoot({ root });
          const snapshot = materializeSnapshotFromEvents({ events });

          let ticketId: string | null = null;
          for (
            let attempt = 0;
            attempt < MAX_TICKET_ID_ALLOCATION_ATTEMPTS;
            attempt += 1
          ) {
            const candidate = allocateTicketId();
            if (!snapshot.tickets.has(candidate)) {
              ticketId = candidate;
              break;
            }
          }

          if (!ticketId) {
            return {
              ok: false,
              error: "Failed to allocate a unique ticket id.",
            };
          }

          const event = buildEvent({
            ticketId,
            type: "ticket.created",
            payload,
            actor: input.actor,
          });

          return {
            ok: true,
            events: [event],
            result: {
              event,
              ticketId,
            },
          } as const;
        },
      });
      if (!wrote.ok) {
        return wrote;
      }

      const rebuilt = await rebuildProjectionFromJournal();
      if (!rebuilt.ok) {
        return rebuilt;
      }

      return {
        ok: true,
        ticket: buildTicketSummary({
          ticketId: wrote.result.ticketId,
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          status: "open",
          createdAt: wrote.result.event.tsIso,
          updatedAt: wrote.result.event.tsIso,
          metadata,
          projectId: opts.projectId,
          projectName: opts.projectName,
        }),
      };
    },

    updateTicket: async (input) => {
      const tickets = await materializeTickets();
      if (!tickets.has(input.ticketId)) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const updatePayload = buildTicketUpdatePayload(input);
      if (!updatePayload.ok) {
        return updatePayload;
      }

      const events: TicketEvent[] = [];
      if (updatePayload.documentContent) {
        events.push(
          buildDocumentRecordedEvent({
            buildEvent,
            ticketId: input.ticketId,
            actor: input.actor,
            documentId: randomUUID(),
            kind: "description",
            content: updatePayload.documentContent,
          })
        );
      }

      if (Object.keys(updatePayload.payload).length > 0) {
        events.push(
          buildEvent({
            ticketId: input.ticketId,
            type: "ticket.updated",
            payload: updatePayload.payload,
            actor: input.actor,
          })
        );
      }

      if (events.length === 0) {
        return { ok: false, error: "No updates provided." };
      }

      return await appendEventsAndRefresh({ events });
    },

    listTickets: async () => {
      const { snapshot } = await loadStoreContext();
      return snapshot.tickets;
    },

    getTicket: async ({ ticketId }) => {
      const { snapshot } = await loadStoreContext();
      return (
        snapshot.tickets.find((ticket) => ticket.ticketId === ticketId) ?? null
      );
    },

    listEvents: async ({ ticketId }) => {
      const { snapshot } = await loadStoreContext();
      return snapshot.eventsByTicket.get(ticketId) ?? [];
    },

    getTicketDetail: async ({ ticketId }) => {
      const { snapshot } = await loadStoreContext();
      return {
        ticket:
          snapshot.tickets.find((ticket) => ticket.ticketId === ticketId) ??
          null,
        events: snapshot.eventsByTicket.get(ticketId) ?? [],
        documents: snapshot.documentsByTicket.get(ticketId) ?? [],
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

      const wrote = await appendEventsAndRefresh({ events: [event] });
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

      const wrote = await appendEventsAndRefresh({ events: [event] });
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

    appendDocument: async (input) => {
      const tickets = await materializeTickets();
      if (!tickets.has(input.ticketId)) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const content = input.content.trimEnd();
      if (!content.trim()) {
        return { ok: false, error: "Document content cannot be empty." };
      }

      const documentId = randomUUID();
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.document_recorded",
        payload: {
          documentId,
          kind: input.kind,
          ...(input.role ? { role: input.role } : {}),
          content,
        },
        actor: input.actor,
      });

      const wrote = await appendEventsAndRefresh({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        document: buildTicketDocument({
          documentId,
          ticketId: input.ticketId,
          kind: input.kind,
          ...(input.role ? { role: input.role } : {}),
          content,
          createdAt: event.tsIso,
          updatedAt: event.tsIso,
        }),
      };
    },

    linkCommentExternalId: async (input) => {
      const { snapshot } = await loadStoreContext();
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

      return await appendEventsAndRefresh({ events: [event] });
    },

    recordSyncCheckpoint: async (input) => {
      const tickets = await materializeTickets();
      if (!tickets.has(input.ticketId)) {
        return { ok: false, error: `Ticket not found: ${input.ticketId}` };
      }

      const checkpoint = buildSyncCheckpointResult(input);
      if (!checkpoint.ok) {
        return checkpoint;
      }
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.sync_checkpoint_recorded",
        payload: checkpoint.payload,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        actor: input.actor,
      });

      const wrote = await appendEventsAndRefresh({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        checkpoint: {
          ...checkpoint.checkpoint,
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

      const conflict = buildSyncConflictResult(input);
      if (!conflict.ok) {
        return conflict;
      }
      const event = buildEvent({
        ticketId: input.ticketId,
        type: "ticket.sync_conflict_recorded",
        payload: conflict.payload,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
        actor: input.actor,
      });

      const wrote = await appendEventsAndRefresh({ events: [event] });
      if (!wrote.ok) {
        return wrote;
      }

      return {
        ok: true,
        conflict: {
          ...conflict.conflict,
          createdAt: event.tsIso,
          updatedAt: event.tsIso,
        },
      };
    },

    resolveSyncConflict: async (input) => {
      const { snapshot } = await loadStoreContext();
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

      return await appendEventsAndRefresh({ events: [event] });
    },

    readSnapshot: async () => {
      const { snapshot } = await loadStoreContext();
      return snapshot;
    },

    sync: async () => {
      return await git.sync();
    },

    setStatus,
  };
}

function applyTicketEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly documentsByTicket: Map<string, TicketDocument[]>;
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
        documentsByTicket: input.documentsByTicket,
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
        documentsByTicket: input.documentsByTicket,
        event: input.event,
      });
      break;
    }
    case "ticket.document_recorded": {
      applyTicketDocumentRecordedEvent({
        tickets: input.tickets,
        documentsByTicket: input.documentsByTicket,
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
  readonly documentsByTicket: Map<string, TicketDocument[]>;
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

  input.tickets.set(
    input.event.ticketId,
    normalizeTicketSummaryCompatibility({
      ticket: {
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
      },
    })
  );

  if (body) {
    appendMapValue({
      map: input.documentsByTicket,
      key: input.event.ticketId,
      value: buildLegacyDescriptionDocument({
        eventId: input.event.eventId,
        ticketId: input.event.ticketId,
        content: body,
        createdAt: input.event.tsIso,
        updatedAt: input.event.tsIso,
      }),
    });
  }
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

  input.tickets.set(
    input.event.ticketId,
    normalizeTicketSummaryCompatibility({
      ticket: {
        ...current,
        status,
        updatedAt: input.event.tsIso,
      },
    })
  );
}

function applyTicketUpdatedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly documentsByTicket: Map<string, TicketDocument[]>;
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
  const next = {
    ...current,
    updatedAt: input.event.tsIso,
  };

  applyUpdateValue(title, (value) => {
    next.title = value;
  });
  applyUpdateValue(body, (value) => {
    next.body = value;
  });
  applyUpdateValue(dependsOn, (value) => {
    next.dependsOn = value;
  });
  applyUpdateValue(blocks, (value) => {
    next.blocks = value;
  });
  applyOptionalMetadataUpdate(owner, (value) => {
    next.owner = normalizeOwnerOrSource({
      value,
      fallback: current.owner,
    });
  });
  applyOptionalMetadataUpdate(source, (value) => {
    next.source = normalizeOwnerOrSource({
      value,
      fallback: current.source,
    });
  });
  applyOptionalMetadataUpdate(assignee, (value) => {
    next.assignee = value;
  });
  applyUpdateValue(tags, (value) => {
    next.tags = value;
  });
  applyOptionalMetadataUpdate(externalSystem, (value) => {
    next.externalSystem = value;
  });
  applyOptionalMetadataUpdate(externalId, (value) => {
    next.externalId = value;
  });
  applyOptionalMetadataUpdate(externalKey, (value) => {
    next.externalKey = value;
  });
  applyOptionalMetadataUpdate(externalUrl, (value) => {
    next.externalUrl = value;
  });
  applyOptionalMetadataUpdate(externalProjectId, (value) => {
    next.externalProjectId = value;
  });
  applyOptionalMetadataUpdate(externalProjectName, (value) => {
    next.externalProjectName = value;
  });
  applyOptionalMetadataUpdate(externalTeamId, (value) => {
    next.externalTeamId = value;
  });

  input.tickets.set(
    input.event.ticketId,
    normalizeTicketSummaryCompatibility({
      ticket: next,
    })
  );

  if (body !== undefined) {
    appendMapValue({
      map: input.documentsByTicket,
      key: input.event.ticketId,
      value: buildLegacyDescriptionDocument({
        eventId: input.event.eventId,
        ticketId: input.event.ticketId,
        content: body,
        createdAt: input.event.tsIso,
        updatedAt: input.event.tsIso,
      }),
    });
  }
}

function applyTicketDocumentRecordedEvent(input: {
  readonly tickets: Map<string, TicketSummary>;
  readonly documentsByTicket: Map<string, TicketDocument[]>;
  readonly event: TicketEvent;
}): void {
  const current = input.tickets.get(input.event.ticketId);
  if (!current) {
    return;
  }

  const kindValue = readOptionalStringPayload({
    value: input.event.payload.kind,
  });
  const content = readOptionalTextPayload({
    value: input.event.payload.content,
  });
  if (!(kindValue && content && isTicketDocumentKind(kindValue))) {
    return;
  }

  const roleValue = readOptionalStringPayload({
    value: input.event.payload.role,
  });
  const role =
    roleValue && isTicketDocumentRole(roleValue) ? roleValue : undefined;

  const document = buildTicketDocument({
    documentId:
      readOptionalStringPayload({ value: input.event.payload.documentId }) ??
      input.event.eventId,
    ticketId: input.event.ticketId,
    kind: kindValue,
    ...(role ? { role } : {}),
    content,
    createdAt: input.event.tsIso,
    updatedAt: input.event.tsIso,
  });

  appendMapValue({
    map: input.documentsByTicket,
    key: input.event.ticketId,
    value: document,
  });

  const documents = input.documentsByTicket.get(input.event.ticketId) ?? [];
  const activeDescription = getActiveTicketDescription({ documents });
  input.tickets.set(
    input.event.ticketId,
    normalizeTicketSummaryCompatibility({
      ticket: {
        ...current,
        ...(activeDescription ? { body: activeDescription.content } : {}),
        updatedAt: input.event.tsIso,
      },
    })
  );
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
    readOptionalTextPayload({
      value: input.event.payload.body,
    }) ??
    readOptionalTextPayload({
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
    readOptionalTextPayload({ value: input.event.payload.body }) ??
    readOptionalTextPayload({ value: input.event.payload.markdown });
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

function readOptionalTextPayload(input: {
  readonly value: unknown;
}): string | undefined {
  if (typeof input.value !== "string") {
    return undefined;
  }
  return input.value.trim().length > 0 ? input.value : undefined;
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

function normalizeTicketMetadata(input: {
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
  readonly ownerFallback: string;
  readonly sourceFallback: string;
}): NormalizedTicketMetadata {
  const assignee = normalizeOptionalMetadataString({
    value: input.assignee,
  });
  return {
    dependsOn: normalizeTicketRefs(input.dependsOn ?? []),
    blocks: normalizeTicketRefs(input.blocks ?? []),
    owner: normalizeOwnerOrSource({
      value: input.owner,
      fallback: input.ownerFallback,
    }),
    source: normalizeOwnerOrSource({
      value: input.source,
      fallback: input.sourceFallback,
    }),
    ...(assignee ? { assignee } : {}),
    tags: normalizeTags(input.tags ?? []),
    ...readOptionalMetadataFields(input),
  };
}

function readOptionalMetadataFields(input: {
  readonly externalSystem?: string;
  readonly externalId?: string;
  readonly externalKey?: string;
  readonly externalUrl?: string;
  readonly externalProjectId?: string;
  readonly externalProjectName?: string;
  readonly externalTeamId?: string;
}): Partial<NormalizedTicketMetadata> {
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

  return {
    ...(externalSystem ? { externalSystem } : {}),
    ...(externalId ? { externalId } : {}),
    ...(externalKey ? { externalKey } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(externalProjectId ? { externalProjectId } : {}),
    ...(externalProjectName ? { externalProjectName } : {}),
    ...(externalTeamId ? { externalTeamId } : {}),
  };
}

function buildTicketSummary(input: {
  readonly ticketId: string;
  readonly title: string;
  readonly body?: string;
  readonly status: TicketStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: NormalizedTicketMetadata;
  readonly projectId?: string;
  readonly projectName?: string;
}): TicketSummary {
  return normalizeTicketSummaryCompatibility({
    ticket: {
      ticketId: input.ticketId,
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      dependsOn: input.metadata.dependsOn,
      blocks: input.metadata.blocks,
      owner: input.metadata.owner,
      source: input.metadata.source,
      ...(input.metadata.assignee ? { assignee: input.metadata.assignee } : {}),
      tags: input.metadata.tags,
      ...(input.metadata.externalSystem
        ? { externalSystem: input.metadata.externalSystem }
        : {}),
      ...(input.metadata.externalId
        ? { externalId: input.metadata.externalId }
        : {}),
      ...(input.metadata.externalKey
        ? { externalKey: input.metadata.externalKey }
        : {}),
      ...(input.metadata.externalUrl
        ? { externalUrl: input.metadata.externalUrl }
        : {}),
      ...(input.metadata.externalProjectId
        ? { externalProjectId: input.metadata.externalProjectId }
        : {}),
      ...(input.metadata.externalProjectName
        ? { externalProjectName: input.metadata.externalProjectName }
        : {}),
      ...(input.metadata.externalTeamId
        ? { externalTeamId: input.metadata.externalTeamId }
        : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.projectName ? { projectName: input.projectName } : {}),
    },
  });
}

function appendTicketMetadataPayload(input: {
  readonly payload: Record<string, unknown>;
  readonly metadata: NormalizedTicketMetadata;
}): void {
  if (input.metadata.dependsOn.length > 0) {
    input.payload.dependsOn = input.metadata.dependsOn;
  }
  if (input.metadata.blocks.length > 0) {
    input.payload.blocks = input.metadata.blocks;
  }
  input.payload.owner = input.metadata.owner;
  input.payload.source = input.metadata.source;
  if (input.metadata.assignee) {
    input.payload.assignee = input.metadata.assignee;
  }
  if (input.metadata.tags.length > 0) {
    input.payload.tags = input.metadata.tags;
  }
  appendOptionalStringFields({
    target: input.payload,
    entries: [
      ["externalSystem", input.metadata.externalSystem],
      ["externalId", input.metadata.externalId],
      ["externalKey", input.metadata.externalKey],
      ["externalUrl", input.metadata.externalUrl],
      ["externalProjectId", input.metadata.externalProjectId],
      ["externalProjectName", input.metadata.externalProjectName],
      ["externalTeamId", input.metadata.externalTeamId],
    ],
  });
}

function appendOptionalStringFields(input: {
  readonly target: Record<string, unknown>;
  readonly entries: readonly (readonly [string, string | undefined])[];
}): void {
  for (const [key, value] of input.entries) {
    if (value) {
      input.target[key] = value;
    }
  }
}

function buildTicketUpdatePayload(input: {
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
}): TicketUpdatePayloadResult {
  const payload: Record<string, unknown> = {};
  let documentContent: string | undefined;

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) {
      return { ok: false, error: "Title cannot be empty." };
    }
    payload.title = title;
  }

  if (input.body !== undefined) {
    documentContent = input.body.trimEnd();
    if (!documentContent) {
      return { ok: false, error: "Body cannot be empty." };
    }
  }

  appendUpdateField(payload, "dependsOn", () =>
    input.dependsOn === undefined
      ? undefined
      : normalizeTicketRefs(input.dependsOn)
  );
  appendUpdateField(payload, "blocks", () =>
    input.blocks === undefined ? undefined : normalizeTicketRefs(input.blocks)
  );
  appendUpdateField(payload, "owner", () =>
    input.owner === undefined
      ? undefined
      : normalizeOwnerOrSource({
          value: input.owner,
          fallback: "hack",
        })
  );
  appendUpdateField(payload, "source", () =>
    input.source === undefined
      ? undefined
      : normalizeOwnerOrSource({
          value: input.source,
          fallback: "hack",
        })
  );
  appendUpdateField(payload, "assignee", () =>
    input.assignee === undefined
      ? undefined
      : (normalizeOptionalMetadataString({
          value: input.assignee,
        }) ?? null)
  );
  appendUpdateField(payload, "tags", () =>
    input.tags === undefined ? undefined : normalizeTags(input.tags)
  );

  for (const key of [
    "externalSystem",
    "externalId",
    "externalKey",
    "externalUrl",
    "externalProjectId",
    "externalProjectName",
    "externalTeamId",
  ] as const) {
    appendUpdateField(payload, key, () => {
      const value = input[key];
      if (value === undefined) {
        return undefined;
      }
      return normalizeOptionalMetadataString({
        value,
      });
    });
  }

  return { ok: true, payload, ...(documentContent ? { documentContent } : {}) };
}

function appendUpdateField(
  payload: Record<string, unknown>,
  key: string,
  resolveValue: () => unknown
): void {
  const value = resolveValue();
  if (value !== undefined) {
    payload[key] = value;
  }
}

function readStringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readOptionalStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function applyUpdateValue<T>(
  value: T | null | undefined,
  apply: (value: T) => void
): void {
  if (value !== null && value !== undefined) {
    apply(value);
  }
}

function applyOptionalMetadataUpdate(
  value: string | null,
  apply: (value: string | undefined) => void
): void {
  if (value !== null) {
    apply(value || undefined);
  }
}

function buildDocumentRecordedEvent(input: {
  readonly buildEvent: (input: {
    readonly ticketId: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
    readonly actor?: string;
    readonly occurredAt?: string;
    readonly sourceSystem?: string;
    readonly sourceOperation?: string;
    readonly idempotencyKey?: string;
    readonly causationId?: string;
    readonly correlationId?: string;
  }) => TicketEvent;
  readonly ticketId: string;
  readonly actor?: string;
  readonly documentId: string;
  readonly kind: TicketDocumentKind;
  readonly role?: TicketDocumentRole;
  readonly content: string;
}): TicketEvent {
  return input.buildEvent({
    ticketId: input.ticketId,
    type: "ticket.document_recorded",
    payload: {
      documentId: input.documentId,
      kind: input.kind,
      ...(input.role ? { role: input.role } : {}),
      content: input.content,
    },
    actor: input.actor,
  });
}

function buildSyncCheckpointResult(input: {
  readonly ticketId: string;
  readonly provider: string;
  readonly profileId?: string;
  readonly direction?: string;
  readonly remoteCursor?: string;
  readonly remoteUpdatedAt?: string;
  readonly localUpdatedAt?: string;
}): SyncCheckpointBuildResult {
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
  const payload: Record<string, unknown> = {
    checkpointId,
    provider,
  };
  appendOptionalStringFields({
    target: payload,
    entries: [
      ["profileId", profileId],
      ["direction", direction],
      ["remoteCursor", remoteCursor],
      ["remoteUpdatedAt", remoteUpdatedAt],
      ["localUpdatedAt", localUpdatedAt],
    ],
  });

  return {
    ok: true,
    checkpointId,
    provider,
    payload,
    checkpoint: {
      checkpointId,
      ticketId: input.ticketId,
      provider,
      ...(profileId ? { profileId } : {}),
      ...(direction ? { direction } : {}),
      ...(remoteCursor ? { remoteCursor } : {}),
      ...(remoteUpdatedAt ? { remoteUpdatedAt } : {}),
      ...(localUpdatedAt ? { localUpdatedAt } : {}),
      actor: "",
      createdAt: "",
    },
  };
}

function buildSyncConflictResult(input: {
  readonly ticketId: string;
  readonly provider: string;
  readonly field: string;
  readonly authority?: string;
  readonly summary?: string;
  readonly localValue?: TicketMetadataValue;
  readonly remoteValue?: TicketMetadataValue;
}): SyncConflictBuildResult {
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
  const payload: Record<string, unknown> = {
    conflictId,
    provider,
    field,
  };
  appendOptionalStringFields({
    target: payload,
    entries: [
      ["authority", authority],
      ["summary", summary],
    ],
  });
  if (input.localValue !== undefined) {
    payload.localValue = input.localValue;
  }
  if (input.remoteValue !== undefined) {
    payload.remoteValue = input.remoteValue;
  }

  return {
    ok: true,
    conflictId,
    provider,
    field,
    payload,
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
    },
  };
}

function parseEvent(value: unknown): TicketEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const eventId = readStringField(value.eventId);
  const schemaVersion =
    typeof value.schemaVersion === "number" ? value.schemaVersion : 0;
  const ts = typeof value.ts === "number" ? value.ts : Number.NaN;
  const tsIso = new Date(ts * 1000).toISOString();
  const actor = readStringField(value.actor);
  const eventTypeCandidate = readOptionalStringField(value.eventType);
  const typeCandidate = readOptionalStringField(value.type);
  const eventType = eventTypeCandidate ?? typeCandidate ?? "";
  const occurredAt = readOptionalStringField(value.occurredAt) ?? tsIso;
  const recordedAt = readOptionalStringField(value.recordedAt) ?? tsIso;
  const orderKey = readOptionalStringField(value.orderKey);
  const sourceSystem = readOptionalStringField(value.sourceSystem) ?? "hack";
  const sourceOperation =
    readOptionalStringField(value.sourceOperation) ?? eventType;
  const idempotencyKey =
    readOptionalStringField(value.idempotencyKey) ?? eventId;
  const causationId = readOptionalStringField(value.causationId);
  const correlationId = readOptionalStringField(value.correlationId);
  const ticketId = readStringField(value.ticketId);
  const type = typeCandidate ?? eventType;
  const payload = isRecord(value.payload)
    ? (value.payload as Record<string, unknown>)
    : null;

  if (
    !(eventId && Number.isFinite(ts) && actor && ticketId && type && payload)
  ) {
    return null;
  }

  const projectId = readOptionalStringField(value.projectId);
  const projectName = readOptionalStringField(value.projectName);

  return {
    eventId,
    schemaVersion,
    ts,
    tsIso,
    eventType,
    occurredAt,
    recordedAt,
    actor,
    sourceSystem,
    sourceOperation,
    idempotencyKey,
    ...(causationId ? { causationId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(orderKey ? { orderKey } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ticketId,
    type,
    payload,
  };
}
