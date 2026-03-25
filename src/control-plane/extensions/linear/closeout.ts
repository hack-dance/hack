import { relative, resolve } from "node:path";

import type { TicketStatus, TicketSummary } from "../tickets/store.ts";
import { resolveLinearProjectArtifactsRoot } from "./project-artifacts.ts";

export type LinearProjectCloseoutScopeEntry = {
  readonly ticketId: string;
  readonly externalId?: string;
  readonly externalKey?: string;
  readonly title: string;
  readonly parentExternalKey?: string;
};

export type LinearProjectCloseoutAuditEntry = {
  readonly ticketId: string;
  readonly externalId?: string;
  readonly externalKey?: string;
  readonly title: string;
  readonly parentExternalKey?: string;
  readonly status: TicketStatus | "missing";
  readonly currentTitle?: string;
  readonly currentUpdatedAt?: string;
};

export type LinearProjectCloseoutAudit = {
  readonly path: string;
  readonly totalItems: number;
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
  readonly entries: readonly LinearProjectCloseoutAuditEntry[];
  readonly latestPublishedPath?: string;
  readonly latestPublishedTitle?: string;
  readonly latestPublishedAt?: string;
  readonly deliveryAuditPath?: string;
  readonly deliveryAuditState: "available" | "missing" | "corrupt";
};

type LinearProjectCloseoutScopeFile = {
  readonly openedAtStart: readonly LinearProjectCloseoutScopeEntry[];
  readonly missionCreated: readonly LinearProjectCloseoutScopeEntry[];
};

export function resolveLinearProjectCloseoutScopePath(input: {
  readonly projectDir: string;
  readonly linearProjectId: string;
}): string {
  return resolve(
    resolveLinearProjectArtifactsRoot({
      projectDir: input.projectDir,
      linearProjectId: input.linearProjectId,
    }),
    "closeout-scope.json"
  );
}

export async function loadLinearProjectCloseoutAudit(input: {
  readonly projectDir: string;
  readonly linearProjectId: string;
  readonly tickets: readonly TicketSummary[];
  readonly latestPublishedPath?: string | null;
  readonly latestPublishedTitle?: string | null;
  readonly latestPublishedAt?: string | null;
  readonly deliveryAuditPath?: string | null;
  readonly deliveryAuditState: LinearProjectCloseoutAudit["deliveryAuditState"];
}): Promise<LinearProjectCloseoutAudit | null> {
  const path = resolveLinearProjectCloseoutScopePath(input);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }

  const scope = parseLinearProjectCloseoutScope({
    value: await file.json().catch(() => null),
  });
  if (!scope) {
    return null;
  }

  const ticketById = new Map<string, TicketSummary>();
  const ticketByExternalKey = new Map<string, TicketSummary>();
  for (const ticket of input.tickets) {
    ticketById.set(ticket.ticketId.toLowerCase(), ticket);
    if (ticket.externalKey) {
      ticketByExternalKey.set(ticket.externalKey.toLowerCase(), ticket);
    }
  }

  const entries = [...scope.openedAtStart, ...scope.missionCreated].map(
    (entry) => {
      const matchedTicket =
        ticketById.get(entry.ticketId.toLowerCase()) ??
        (entry.externalKey
          ? ticketByExternalKey.get(entry.externalKey.toLowerCase())
          : undefined) ??
        null;
      return {
        ...entry,
        status: matchedTicket?.status ?? "missing",
        ...(matchedTicket?.title ? { currentTitle: matchedTicket.title } : {}),
        ...(matchedTicket?.updatedAt
          ? { currentUpdatedAt: matchedTicket.updatedAt }
          : {}),
      } satisfies LinearProjectCloseoutAuditEntry;
    }
  );
  const resolvedCount = entries.filter(
    (entry) => entry.status === "done"
  ).length;

  return {
    path: toRepoRelativePath({
      projectDir: input.projectDir,
      path,
    }),
    totalItems: entries.length,
    resolvedCount,
    unresolvedCount: entries.length - resolvedCount,
    entries,
    ...(input.latestPublishedPath
      ? { latestPublishedPath: input.latestPublishedPath }
      : {}),
    ...(input.latestPublishedTitle
      ? { latestPublishedTitle: input.latestPublishedTitle }
      : {}),
    ...(input.latestPublishedAt
      ? { latestPublishedAt: input.latestPublishedAt }
      : {}),
    ...(input.deliveryAuditPath
      ? { deliveryAuditPath: input.deliveryAuditPath }
      : {}),
    deliveryAuditState: input.deliveryAuditState,
  };
}

function parseLinearProjectCloseoutScope(input: {
  readonly value: unknown;
}): LinearProjectCloseoutScopeFile | null {
  if (!isRecord(input.value)) {
    return null;
  }

  return {
    openedAtStart: parseLinearProjectCloseoutScopeEntries({
      value: input.value.openedAtStart,
    }),
    missionCreated: parseLinearProjectCloseoutScopeEntries({
      value: input.value.missionCreated,
    }),
  };
}

function parseLinearProjectCloseoutScopeEntries(input: {
  readonly value: unknown;
}): readonly LinearProjectCloseoutScopeEntry[] {
  if (!Array.isArray(input.value)) {
    return [];
  }

  return input.value
    .map((entry) => parseLinearProjectCloseoutScopeEntry({ value: entry }))
    .filter(
      (entry): entry is LinearProjectCloseoutScopeEntry => entry !== null
    );
}

function parseLinearProjectCloseoutScopeEntry(input: {
  readonly value: unknown;
}): LinearProjectCloseoutScopeEntry | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const ticketId = readOptionalString(input.value.ticketId);
  const title = readOptionalString(input.value.title);
  if (!(ticketId && title)) {
    return null;
  }

  return {
    ticketId,
    title,
    ...(readOptionalString(input.value.externalId)
      ? { externalId: readOptionalString(input.value.externalId) ?? undefined }
      : {}),
    ...(readOptionalString(input.value.externalKey)
      ? {
          externalKey: readOptionalString(input.value.externalKey) ?? undefined,
        }
      : {}),
    ...(readOptionalString(input.value.parentExternalKey)
      ? {
          parentExternalKey:
            readOptionalString(input.value.parentExternalKey) ?? undefined,
        }
      : {}),
  };
}

function toRepoRelativePath(input: {
  readonly projectDir: string;
  readonly path: string;
}): string {
  const relativePath = relative(resolve(input.projectDir), resolve(input.path));
  return relativePath.length > 0 ? relativePath.replaceAll("\\", "/") : ".";
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
