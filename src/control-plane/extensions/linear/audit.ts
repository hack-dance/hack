import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  type LocalLinearProjectArtifact,
  loadLocalLinearProjectArtifacts,
  resolveLinearProjectArtifactsRoot,
} from "./project-artifacts.ts";

export type LinearProjectStatusUpdateAuditEntry = {
  readonly title: string;
  readonly path: string;
  readonly state: "draft" | "published";
  readonly linearId?: string;
  readonly date?: string;
  readonly publishedAt?: string;
  readonly updatedAt?: string;
  readonly health?: string;
};

export type LinearProjectDeliveryAuditOutcome = {
  readonly deliveryId: string;
  readonly profileId: string;
  readonly mode: "issue" | "project";
  readonly status: "applied" | "failed" | "skipped";
  readonly projectId?: string;
  readonly teamId?: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
  readonly ticketId?: string;
  readonly reason?: string;
};

export type LinearProjectDeliveryAuditRecord = {
  readonly projectId: string;
  readonly projectIds: readonly string[];
  readonly profileId: string;
  readonly updatedAt: string;
  readonly processedDeliveries: number;
  readonly appliedDeliveries: number;
  readonly failedDeliveries: number;
  readonly skippedDeliveries: number;
  readonly created: number;
  readonly updated: number;
  readonly commentsPulled: number;
  readonly conflictsRecorded: number;
  readonly checkpointsRecorded: number;
  readonly deliveries: readonly LinearProjectDeliveryAuditOutcome[];
};

export type LinearProjectDeliveryAudit = LinearProjectDeliveryAuditRecord & {
  readonly path: string;
};

export type LinearProjectDeliveryAuditCorruption = {
  readonly path: string;
  readonly message: string;
  readonly recovery: string;
};

export type LinearProjectStatusUpdateAudit = {
  readonly draftCount: number;
  readonly publishedCount: number;
  readonly drafts: readonly LinearProjectStatusUpdateAuditEntry[];
  readonly latestPublished: LinearProjectStatusUpdateAuditEntry | null;
};

export type LinearProjectAuditState = {
  readonly statusUpdates: LinearProjectStatusUpdateAudit;
  readonly delivery: LinearProjectDeliveryAudit | null;
  readonly deliveryCorruption: LinearProjectDeliveryAuditCorruption | null;
};

export async function loadLinearProjectAuditState(input: {
  readonly projectDir: string;
  readonly linearProjectId: string;
}): Promise<LinearProjectAuditState> {
  const delivery = await readLinearProjectDeliveryAudit(input);
  return {
    statusUpdates: await loadLinearProjectStatusUpdateAudit(input),
    delivery: delivery.audit,
    deliveryCorruption: delivery.corruption,
  };
}

export function resolveLinearProjectDeliveryAuditPath(input: {
  readonly projectDir: string;
  readonly linearProjectId: string;
}): string {
  return resolve(
    resolveLinearProjectArtifactsRoot({
      projectDir: input.projectDir,
      linearProjectId: input.linearProjectId,
    }),
    "delivery-audit.json"
  );
}

export async function writeLinearProjectDeliveryAudit(input: {
  readonly projectDir: string;
  readonly audit: LinearProjectDeliveryAuditRecord;
}): Promise<void> {
  const path = resolveLinearProjectDeliveryAuditPath({
    projectDir: input.projectDir,
    linearProjectId: input.audit.projectId,
  });
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(input.audit, null, 2)}\n`);
}

async function loadLinearProjectStatusUpdateAudit(input: {
  readonly projectDir: string;
  readonly linearProjectId: string;
}): Promise<LinearProjectStatusUpdateAudit> {
  const artifacts = await loadLocalLinearProjectArtifacts({
    projectDir: input.projectDir,
    linearProjectId: input.linearProjectId,
    family: "status-updates",
    ignoreParseErrors: true,
  });
  const entries = artifacts
    .filter(
      (
        artifact
      ): artifact is Extract<
        LocalLinearProjectArtifact,
        { readonly kind: "linear-project-status-update" }
      > => artifact.kind === "linear-project-status-update"
    )
    .map((artifact) =>
      toStatusUpdateAuditEntry({
        projectDir: input.projectDir,
        artifact,
      })
    );
  const drafts = entries
    .filter((entry) => entry.state === "draft")
    .sort(compareStatusUpdateAuditEntries);
  const published = entries
    .filter((entry) => entry.state === "published")
    .sort(compareStatusUpdateAuditEntries);

  return {
    draftCount: drafts.length,
    publishedCount: published.length,
    drafts,
    latestPublished: published[0] ?? null,
  };
}

async function readLinearProjectDeliveryAudit(input: {
  readonly projectDir: string;
  readonly linearProjectId: string;
}): Promise<{
  readonly audit: LinearProjectDeliveryAudit | null;
  readonly corruption: LinearProjectDeliveryAuditCorruption | null;
}> {
  const path = resolveLinearProjectDeliveryAuditPath(input);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {
      audit: null,
      corruption: null,
    };
  }

  const value = await file.json().catch(() => INVALID_JSON_AUDIT_SENTINEL);
  const parsed = parseLinearProjectDeliveryAuditRecord({
    value,
  });
  if (!parsed) {
    const repoRelativePath = toRepoRelativePath({
      projectDir: input.projectDir,
      path,
    });
    return {
      audit: null,
      corruption: {
        path: repoRelativePath,
        message:
          value === INVALID_JSON_AUDIT_SENTINEL
            ? "Delivery audit JSON is malformed."
            : "Delivery audit is missing required fields.",
        recovery: `Remove or repair ${repoRelativePath}, then rerun \`hack linear run-autosync --json\` to regenerate the audit from repo-bound sync state.`,
      },
    };
  }
  return {
    audit: {
      ...parsed,
      path: toRepoRelativePath({
        projectDir: input.projectDir,
        path,
      }),
    },
    corruption: null,
  };
}

function toStatusUpdateAuditEntry(input: {
  readonly projectDir: string;
  readonly artifact: Extract<
    LocalLinearProjectArtifact,
    { readonly kind: "linear-project-status-update" }
  >;
}): LinearProjectStatusUpdateAuditEntry {
  return {
    title: input.artifact.title,
    path: toRepoRelativePath({
      projectDir: input.projectDir,
      path: input.artifact.path,
    }),
    state: isDraftStatusUpdatePath({ path: input.artifact.path })
      ? "draft"
      : "published",
    ...(input.artifact.linearId ? { linearId: input.artifact.linearId } : {}),
    ...(input.artifact.date ? { date: input.artifact.date } : {}),
    ...(input.artifact.publishedAt
      ? { publishedAt: input.artifact.publishedAt }
      : {}),
    ...(input.artifact.updatedAt
      ? { updatedAt: input.artifact.updatedAt }
      : {}),
    ...(input.artifact.health ? { health: input.artifact.health } : {}),
  };
}

function compareStatusUpdateAuditEntries(
  left: LinearProjectStatusUpdateAuditEntry,
  right: LinearProjectStatusUpdateAuditEntry
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

function parseLinearProjectDeliveryAuditRecord(input: {
  readonly value: unknown;
}): LinearProjectDeliveryAuditRecord | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const projectId = readOptionalString(input.value.projectId);
  const profileId = readOptionalString(input.value.profileId);
  const updatedAt = readOptionalString(input.value.updatedAt);
  if (!(projectId && profileId && updatedAt)) {
    return null;
  }
  return {
    projectId,
    projectIds: Array.isArray(input.value.projectIds)
      ? input.value.projectIds.filter(
          (value): value is string => typeof value === "string"
        )
      : [projectId],
    profileId,
    updatedAt,
    processedDeliveries: readNumber(input.value.processedDeliveries),
    appliedDeliveries: readNumber(input.value.appliedDeliveries),
    failedDeliveries: readNumber(input.value.failedDeliveries),
    skippedDeliveries: readNumber(input.value.skippedDeliveries),
    created: readNumber(input.value.created),
    updated: readNumber(input.value.updated),
    commentsPulled: readNumber(input.value.commentsPulled),
    conflictsRecorded: readNumber(input.value.conflictsRecorded),
    checkpointsRecorded: readNumber(input.value.checkpointsRecorded),
    deliveries: Array.isArray(input.value.deliveries)
      ? input.value.deliveries
          .map((value) => parseLinearProjectDeliveryAuditOutcome({ value }))
          .filter(
            (value): value is LinearProjectDeliveryAuditOutcome =>
              value !== null
          )
      : [],
  };
}

function parseLinearProjectDeliveryAuditOutcome(input: {
  readonly value: unknown;
}): LinearProjectDeliveryAuditOutcome | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const deliveryId = readOptionalString(input.value.deliveryId);
  const profileId = readOptionalString(input.value.profileId);
  const mode = readOptionalString(input.value.mode);
  const status = readOptionalString(input.value.status);
  if (!(deliveryId && profileId)) {
    return null;
  }
  if (!(mode === "issue" || mode === "project")) {
    return null;
  }
  if (!(status === "applied" || status === "failed" || status === "skipped")) {
    return null;
  }
  return {
    deliveryId,
    profileId,
    mode,
    status,
    ...(readOptionalString(input.value.projectId)
      ? { projectId: readOptionalString(input.value.projectId) ?? undefined }
      : {}),
    ...(readOptionalString(input.value.teamId)
      ? { teamId: readOptionalString(input.value.teamId) ?? undefined }
      : {}),
    ...(readOptionalString(input.value.issueId)
      ? { issueId: readOptionalString(input.value.issueId) ?? undefined }
      : {}),
    ...(readOptionalString(input.value.issueIdentifier)
      ? {
          issueIdentifier:
            readOptionalString(input.value.issueIdentifier) ?? undefined,
        }
      : {}),
    ...(readOptionalString(input.value.ticketId)
      ? { ticketId: readOptionalString(input.value.ticketId) ?? undefined }
      : {}),
    ...(readOptionalString(input.value.reason)
      ? { reason: readOptionalString(input.value.reason) ?? undefined }
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

function isDraftStatusUpdatePath(input: { readonly path: string }): boolean {
  return input.path.replaceAll("\\", "/").includes("/status-updates/drafts/");
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

const INVALID_JSON_AUDIT_SENTINEL = Symbol(
  "invalid-linear-delivery-audit-json"
);
