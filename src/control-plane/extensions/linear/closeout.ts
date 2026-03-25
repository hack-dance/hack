import { relative, resolve } from "node:path";

import type { TicketStatus, TicketSummary } from "../tickets/store.ts";
import {
  type LocalLinearProjectArtifact,
  loadLocalLinearProjectArtifacts,
  resolveLinearProjectArtifactsRoot,
} from "./project-artifacts.ts";

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
  const publishedEvidence = await resolveCloseoutPublishedEvidence({
    projectDir: input.projectDir,
    linearProjectId: input.linearProjectId,
  });

  return {
    path: toRepoRelativePath({
      projectDir: input.projectDir,
      path,
    }),
    totalItems: entries.length,
    resolvedCount,
    unresolvedCount: entries.length - resolvedCount,
    entries,
    ...(publishedEvidence
      ? {
          latestPublishedPath: publishedEvidence.path,
          latestPublishedTitle: publishedEvidence.title,
          ...(publishedEvidence.at
            ? { latestPublishedAt: publishedEvidence.at }
            : {}),
        }
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

const CLOSEOUT_STATUS_UPDATE_SLUG = "mission-closeout-audit";
const CLOSEOUT_STATUS_UPDATE_TITLE = "mission closeout audit";

async function resolveCloseoutPublishedEvidence(input: {
  readonly projectDir: string;
  readonly linearProjectId: string;
}): Promise<{
  readonly path: string;
  readonly title: string;
  readonly at?: string;
} | null> {
  const closeoutArtifacts = (
    await loadLocalLinearProjectArtifacts({
      projectDir: input.projectDir,
      linearProjectId: input.linearProjectId,
      family: "status-updates",
      ignoreParseErrors: true,
    })
  )
    .filter(
      (
        artifact
      ): artifact is Extract<
        LocalLinearProjectArtifact,
        { readonly kind: "linear-project-status-update" }
      > => artifact.kind === "linear-project-status-update"
    )
    .filter((artifact) =>
      isPublishedStatusUpdateArtifact({ path: artifact.path })
    )
    .filter((artifact) => isCloseoutStatusUpdateArtifact({ artifact }))
    .sort(compareCloseoutArtifacts);
  const artifact = closeoutArtifacts[0] ?? null;
  if (!artifact) {
    return null;
  }
  const publishedEvidenceAt = artifact.publishedAt ?? artifact.updatedAt;

  return {
    path: toRepoRelativePath({
      projectDir: input.projectDir,
      path: artifact.path,
    }),
    title: artifact.title,
    ...(publishedEvidenceAt ? { at: publishedEvidenceAt } : {}),
  };
}

function isPublishedStatusUpdateArtifact(input: {
  readonly path: string;
}): boolean {
  return input.path
    .replaceAll("\\", "/")
    .includes("/status-updates/published/");
}

function isCloseoutStatusUpdateArtifact(input: {
  readonly artifact: Extract<
    LocalLinearProjectArtifact,
    { readonly kind: "linear-project-status-update" }
  >;
}): boolean {
  const normalizedPath = input.artifact.path
    .replaceAll("\\", "/")
    .toLowerCase();
  const normalizedSlug = input.artifact.slug?.trim().toLowerCase();
  const normalizedTitle = input.artifact.title.trim().toLowerCase();

  return (
    normalizedSlug === CLOSEOUT_STATUS_UPDATE_SLUG ||
    normalizedTitle === CLOSEOUT_STATUS_UPDATE_TITLE ||
    normalizedPath.endsWith(`${CLOSEOUT_STATUS_UPDATE_SLUG}.md`)
  );
}

function compareCloseoutArtifacts(
  left: Extract<
    LocalLinearProjectArtifact,
    { readonly kind: "linear-project-status-update" }
  >,
  right: Extract<
    LocalLinearProjectArtifact,
    { readonly kind: "linear-project-status-update" }
  >
): number {
  return (
    compareOptionalTextDesc(
      left.publishedAt ?? left.updatedAt ?? left.date,
      right.publishedAt ?? right.updatedAt ?? right.date
    ) || left.title.localeCompare(right.title)
  );
}

function compareOptionalTextDesc(
  left: string | undefined,
  right: string | undefined
): number {
  if (left && right) {
    return right.localeCompare(left);
  }
  if (right) {
    return 1;
  }
  if (left) {
    return -1;
  }
  return 0;
}
