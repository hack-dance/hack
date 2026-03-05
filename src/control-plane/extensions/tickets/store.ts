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

export type TicketEvent = {
  readonly eventId: string;
  readonly ts: number;
  readonly tsIso: string;
  readonly actor: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly ticketId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
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
  readonly readSnapshot: () => Promise<{
    readonly tickets: readonly TicketSummary[];
    readonly eventsByTicket: ReadonlyMap<string, readonly TicketEvent[]>;
  }>;
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
    return {
      eventId: randomUUID(),
      ts,
      tsIso: new Date(ts * 1000).toISOString(),
      actor: resolveActor(input.actor),
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
      return a.eventId.localeCompare(b.eventId);
    });
    return events;
  };

  const materializeTickets = async (): Promise<Map<string, TicketSummary>> => {
    const events = await readAllEvents();
    return materializeTicketsFromEvents({ events });
  };

  const materializeTicketsFromEvents = (opts: {
    readonly events: readonly TicketEvent[];
  }): Map<string, TicketSummary> => {
    const tickets = new Map<string, TicketSummary>();

    for (const event of opts.events) {
      applyTicketEvent({ tickets, event });
    }

    return applyDerivedBlocks(tickets);
  };

  const groupEventsByTicket = (opts: {
    readonly events: readonly TicketEvent[];
  }): Map<string, TicketEvent[]> => {
    const grouped = new Map<string, TicketEvent[]>();
    for (const event of opts.events) {
      const list = grouped.get(event.ticketId) ?? [];
      list.push(event);
      grouped.set(event.ticketId, list);
    }
    return grouped;
  };

  const sortTickets = (opts: {
    readonly tickets: Iterable<TicketSummary>;
  }): TicketSummary[] => {
    const out = [...opts.tickets];
    out.sort(
      (a, b) =>
        (parseTicketNumber(a.ticketId) ?? 0) -
        (parseTicketNumber(b.ticketId) ?? 0)
    );
    return out;
  };

  const computeNextTicketId = async (): Promise<string> => {
    const events = await readAllEvents();
    const tickets = materializeTicketsFromEvents({ events });
    let max = 0;
    for (const ticketId of tickets.keys()) {
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
      const tickets = materializeTicketsFromEvents({ events });
      return sortTickets({ tickets: tickets.values() });
    },

    getTicket: async ({ ticketId }) => {
      const events = await readAllEvents();
      const tickets = materializeTicketsFromEvents({ events });
      return tickets.get(ticketId) ?? null;
    },

    listEvents: async ({ ticketId }) => {
      const events = await readAllEvents();
      return events.filter((e) => e.ticketId === ticketId);
    },

    readSnapshot: async () => {
      const events = await readAllEvents();
      const tickets = materializeTicketsFromEvents({ events });
      const eventsByTicket = groupEventsByTicket({ events });
      return {
        tickets: sortTickets({ tickets: tickets.values() }),
        eventsByTicket,
      };
    },

    sync: async () => {
      return await git.sync();
    },

    setStatus,
  };
}

function applyTicketEvent(opts: {
  readonly tickets: Map<string, TicketSummary>;
  readonly event: TicketEvent;
}): void {
  switch (opts.event.type) {
    case "ticket.created": {
      applyTicketCreatedEvent({
        tickets: opts.tickets,
        event: opts.event,
      });
      break;
    }
    case "ticket.status_changed": {
      applyTicketStatusChangedEvent({
        tickets: opts.tickets,
        event: opts.event,
      });
      break;
    }
    case "ticket.updated": {
      applyTicketUpdatedEvent({
        tickets: opts.tickets,
        event: opts.event,
      });
      break;
    }
    default: {
      break;
    }
  }
}

function applyTicketCreatedEvent(opts: {
  readonly tickets: Map<string, TicketSummary>;
  readonly event: TicketEvent;
}): void {
  const title =
    typeof opts.event.payload.title === "string"
      ? opts.event.payload.title
      : "";
  const body =
    typeof opts.event.payload.body === "string"
      ? opts.event.payload.body
      : undefined;
  const dependsOn = parseDependencyList({
    value: opts.event.payload.dependsOn,
  });
  const blocks = parseDependencyList({
    value: opts.event.payload.blocks,
  });
  const owner = normalizeOwnerOrSource({
    value: readOptionalStringPayload({ value: opts.event.payload.owner }),
    fallback: "hack",
  });
  const source = normalizeOwnerOrSource({
    value: readOptionalStringPayload({ value: opts.event.payload.source }),
    fallback: "hack",
  });
  const tags = parseTags({ value: opts.event.payload.tags });
  const externalSystem = readOptionalStringPayload({
    value: opts.event.payload.externalSystem,
  });
  const externalId = readOptionalStringPayload({
    value: opts.event.payload.externalId,
  });
  const externalKey = readOptionalStringPayload({
    value: opts.event.payload.externalKey,
  });
  const externalUrl = readOptionalStringPayload({
    value: opts.event.payload.externalUrl,
  });
  const externalProjectId = readOptionalStringPayload({
    value: opts.event.payload.externalProjectId,
  });
  const externalProjectName = readOptionalStringPayload({
    value: opts.event.payload.externalProjectName,
  });
  const externalTeamId = readOptionalStringPayload({
    value: opts.event.payload.externalTeamId,
  });

  opts.tickets.set(opts.event.ticketId, {
    ticketId: opts.event.ticketId,
    title,
    body,
    status: "open",
    createdAt: opts.event.tsIso,
    updatedAt: opts.event.tsIso,
    dependsOn,
    blocks,
    owner,
    source,
    tags,
    ...(externalSystem ? { externalSystem } : {}),
    ...(externalId ? { externalId } : {}),
    ...(externalKey ? { externalKey } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    ...(externalProjectId ? { externalProjectId } : {}),
    ...(externalProjectName ? { externalProjectName } : {}),
    ...(externalTeamId ? { externalTeamId } : {}),
    ...(opts.event.projectId ? { projectId: opts.event.projectId } : {}),
    ...(opts.event.projectName ? { projectName: opts.event.projectName } : {}),
  });
}

function applyTicketStatusChangedEvent(opts: {
  readonly tickets: Map<string, TicketSummary>;
  readonly event: TicketEvent;
}): void {
  const current = opts.tickets.get(opts.event.ticketId);
  if (!current) {
    return;
  }

  const status = parseTicketStatus({ value: opts.event.payload.status });
  if (!status) {
    return;
  }

  opts.tickets.set(opts.event.ticketId, {
    ...current,
    status,
    updatedAt: opts.event.tsIso,
  });
}

function applyTicketUpdatedEvent(opts: {
  readonly tickets: Map<string, TicketSummary>;
  readonly event: TicketEvent;
}): void {
  const current = opts.tickets.get(opts.event.ticketId);
  if (!current) {
    return;
  }

  const title =
    typeof opts.event.payload.title === "string"
      ? opts.event.payload.title
      : undefined;
  const body =
    typeof opts.event.payload.body === "string"
      ? opts.event.payload.body
      : undefined;
  const dependsOn = readDependencyUpdate({
    payload: opts.event.payload,
    key: "dependsOn",
  });
  const blocks = readDependencyUpdate({
    payload: opts.event.payload,
    key: "blocks",
  });
  const owner = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "owner",
  });
  const source = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "source",
  });
  const tags = readTagsUpdate({
    payload: opts.event.payload,
    key: "tags",
  });
  const externalSystem = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "externalSystem",
  });
  const externalId = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "externalId",
  });
  const externalKey = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "externalKey",
  });
  const externalUrl = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "externalUrl",
  });
  const externalProjectId = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "externalProjectId",
  });
  const externalProjectName = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "externalProjectName",
  });
  const externalTeamId = readOptionalStringUpdate({
    payload: opts.event.payload,
    key: "externalTeamId",
  });

  opts.tickets.set(opts.event.ticketId, {
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
    updatedAt: opts.event.tsIso,
  });
}

function parseTicketStatus(opts: {
  readonly value: unknown;
}): TicketStatus | null {
  if (
    opts.value === "open" ||
    opts.value === "in_progress" ||
    opts.value === "blocked" ||
    opts.value === "done"
  ) {
    return opts.value;
  }
  return null;
}

function parseDependencyList(opts: { readonly value: unknown }): string[] {
  if (!Array.isArray(opts.value)) {
    return [];
  }
  const values = opts.value.filter(
    (item): item is string => typeof item === "string"
  );
  return normalizeTicketRefs(values);
}

function parseTags(opts: { readonly value: unknown }): string[] {
  if (!Array.isArray(opts.value)) {
    return [];
  }
  const tags = opts.value.filter(
    (item): item is string => typeof item === "string"
  );
  return normalizeTags(tags);
}

function readDependencyUpdate(opts: {
  readonly payload: Record<string, unknown>;
  readonly key: "dependsOn" | "blocks";
}): string[] | null {
  if (!Object.hasOwn(opts.payload, opts.key)) {
    return null;
  }
  return parseDependencyList({ value: opts.payload[opts.key] });
}

function readTagsUpdate(opts: {
  readonly payload: Record<string, unknown>;
  readonly key: "tags";
}): string[] | null {
  if (!Object.hasOwn(opts.payload, opts.key)) {
    return null;
  }
  return parseTags({ value: opts.payload[opts.key] });
}

function readOptionalStringUpdate(opts: {
  readonly payload: Record<string, unknown>;
  readonly key:
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
  if (!Object.hasOwn(opts.payload, opts.key)) {
    return null;
  }
  return readOptionalStringPayload({ value: opts.payload[opts.key] }) ?? "";
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

function readOptionalStringPayload(opts: {
  readonly value: unknown;
}): string | undefined {
  if (typeof opts.value !== "string") {
    return undefined;
  }
  const trimmed = opts.value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOwnerOrSource(opts: {
  readonly value: string | undefined;
  readonly fallback: string;
}): string {
  const trimmed = (opts.value ?? "").trim();
  return trimmed || opts.fallback;
}

function normalizeOptionalMetadataString(opts: {
  readonly value: string | undefined;
}): string | undefined {
  const trimmed = (opts.value ?? "").trim();
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
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ticketId,
    type,
    payload,
  };
}
