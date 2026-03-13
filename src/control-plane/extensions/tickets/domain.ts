import { buildLegacyDescriptionDocument } from "./documents.ts";
import {
  buildTicketProvenance,
  projectRemoteLinkToCompatibilityFields,
} from "./provenance.ts";

export type TicketStatus = "open" | "in_progress" | "blocked" | "done";

export type TicketSummaryCompatibility = {
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

export type TicketSyncCheckpointCompatibility = {
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

export type TicketSyncConflictCompatibility = {
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
  readonly resolution?: "accept_local" | "accept_remote" | "merged" | "ignore";
  readonly resolutionSummary?: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
};

export type NormalizedTicketIdentity = {
  readonly ticketId: string;
  readonly projectId?: string;
  readonly projectName?: string;
};

export type TicketOrigin = {
  readonly owner: string;
  readonly source: string;
  readonly system: string;
};

export type TicketRemoteLink = {
  readonly provider: string;
  readonly remoteId?: string;
  readonly remoteKey?: string;
  readonly remoteUrl?: string;
  readonly profileId?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly teamId?: string;
  readonly remoteCursor?: string;
  readonly remoteUpdatedAt?: string;
};

export type TicketFieldAuthority =
  | "local"
  | "remote"
  | "append_only"
  | "derived"
  | "review_required";

export type TicketFieldAuthorityEntry = {
  readonly field: string;
  readonly authority: TicketFieldAuthority;
};

export type TicketFieldVersion = {
  readonly field: string;
  readonly source: "local" | "remote";
  readonly provider?: string;
  readonly recordedAt: string;
  readonly value?: TicketMetadataValue;
};

export type {
  TicketDocument,
  TicketDocumentKind,
  TicketDocumentRole,
} from "./documents.ts";

export type TicketFieldState = {
  readonly field: string;
  readonly authority: string;
  readonly conflictIds: readonly string[];
};

export type NormalizedTicket = {
  readonly identity: NormalizedTicketIdentity;
  readonly title: string;
  readonly status: TicketStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependsOn: readonly string[];
  readonly blocks: readonly string[];
  readonly assignee?: string;
  readonly tags: readonly string[];
  readonly provenance: {
    readonly origin: TicketOrigin;
    readonly remotes: readonly TicketRemoteLink[];
    readonly fieldAuthorities: readonly TicketFieldAuthorityEntry[];
    readonly fieldVersions: readonly TicketFieldVersion[];
  };
  readonly documents: readonly TicketDocument[];
  readonly fieldStates: readonly TicketFieldState[];
  readonly sync: {
    readonly checkpoints: readonly TicketSyncCheckpointCompatibility[];
    readonly conflicts: readonly TicketSyncConflictCompatibility[];
  };
};

export function createNormalizedTicket(input: {
  readonly ticket: TicketSummaryCompatibility;
  readonly syncCheckpoints?: readonly TicketSyncCheckpointCompatibility[];
  readonly conflicts?: readonly TicketSyncConflictCompatibility[];
  readonly documents?: readonly TicketDocument[];
}): NormalizedTicket {
  const documents = buildDocuments({
    ticket: input.ticket,
    documents: input.documents,
  });
  const checkpoints = input.syncCheckpoints ?? [];
  const conflicts = input.conflicts ?? [];
  const provenance = buildTicketProvenance({
    ticket: input.ticket,
    syncCheckpoints: checkpoints,
    conflicts,
  });

  return {
    identity: {
      ticketId: input.ticket.ticketId,
      ...(input.ticket.projectId ? { projectId: input.ticket.projectId } : {}),
      ...(input.ticket.projectName
        ? { projectName: input.ticket.projectName }
        : {}),
    },
    title: input.ticket.title,
    status: input.ticket.status,
    createdAt: input.ticket.createdAt,
    updatedAt: input.ticket.updatedAt,
    dependsOn: [...input.ticket.dependsOn],
    blocks: [...input.ticket.blocks],
    ...(input.ticket.assignee ? { assignee: input.ticket.assignee } : {}),
    tags: [...input.ticket.tags],
    provenance,
    documents,
    fieldStates: buildFieldStates({
      fieldAuthorities: provenance.fieldAuthorities,
      conflicts,
    }),
    sync: {
      checkpoints: [...checkpoints],
      conflicts: [...conflicts],
    },
  };
}

export function projectNormalizedTicketSummary(input: {
  readonly ticket: NormalizedTicket;
}): TicketSummaryCompatibility {
  const description = input.ticket.documents.find(
    (document) => document.role === "description"
  );
  const primaryRemote = input.ticket.provenance.remotes[0];

  return {
    ticketId: input.ticket.identity.ticketId,
    title: input.ticket.title,
    ...(description ? { body: description.content } : {}),
    status: input.ticket.status,
    createdAt: input.ticket.createdAt,
    updatedAt: input.ticket.updatedAt,
    dependsOn: [...input.ticket.dependsOn],
    blocks: [...input.ticket.blocks],
    owner: input.ticket.provenance.origin.owner,
    source: input.ticket.provenance.origin.source,
    ...(input.ticket.assignee ? { assignee: input.ticket.assignee } : {}),
    tags: [...input.ticket.tags],
    ...(primaryRemote
      ? projectRemoteLinkToCompatibilityFields({
          remote: primaryRemote,
        })
      : {}),
    ...(input.ticket.identity.projectId
      ? { projectId: input.ticket.identity.projectId }
      : {}),
    ...(input.ticket.identity.projectName
      ? { projectName: input.ticket.identity.projectName }
      : {}),
  };
}

function buildDocuments(input: {
  readonly ticket: TicketSummaryCompatibility;
  readonly documents?: readonly TicketDocument[];
}): TicketDocument[] {
  if (input.documents && input.documents.length > 0) {
    return [...input.documents];
  }
  if (!input.ticket.body) {
    return [];
  }
  return [
    buildLegacyDescriptionDocument({
      eventId: "compatibility-summary",
      ticketId: input.ticket.ticketId,
      content: input.ticket.body,
      createdAt: input.ticket.createdAt,
      updatedAt: input.ticket.updatedAt,
    }),
  ];
}

function buildFieldStates(input: {
  readonly fieldAuthorities: readonly TicketFieldAuthorityEntry[];
  readonly conflicts: readonly TicketSyncConflictCompatibility[];
}): TicketFieldState[] {
  return input.fieldAuthorities
    .filter((fieldAuthority) =>
      ["title", "status", "assignee", "description"].includes(
        fieldAuthority.field
      )
    )
    .map((fieldAuthority) => ({
      field: fieldAuthority.field,
      authority: fieldAuthority.authority,
      conflictIds: input.conflicts
        .filter((conflict) => conflict.field === fieldAuthority.field)
        .map((conflict) => conflict.conflictId),
    }));
}
