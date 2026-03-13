import { sha256Hex } from "./util.ts";

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
  readonly projectId?: string;
  readonly projectName?: string;
  readonly teamId?: string;
};

export type TicketDocumentKind = "description" | "spec" | "notes";
export type TicketDocumentRole = TicketDocumentKind | "handoff";

export type TicketDocument = {
  readonly documentId: string;
  readonly ticketId: string;
  readonly kind: TicketDocumentKind;
  readonly role: TicketDocumentRole;
  readonly content: string;
  readonly contentSha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

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
}): NormalizedTicket {
  const sourceSystem = inferSourceSystem({ ticket: input.ticket });
  const documents = buildDocuments({ ticket: input.ticket });
  const remotes = buildRemoteLinks({
    ticket: input.ticket,
    sourceSystem,
  });
  const checkpoints = input.syncCheckpoints ?? [];
  const conflicts = input.conflicts ?? [];

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
    provenance: {
      origin: {
        owner: input.ticket.owner,
        source: input.ticket.source,
        system: sourceSystem,
      },
      remotes,
    },
    documents,
    fieldStates: buildFieldStates({ remotes, conflicts }),
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
      ? {
          externalSystem: primaryRemote.provider,
          ...(primaryRemote.remoteId
            ? { externalId: primaryRemote.remoteId }
            : {}),
          ...(primaryRemote.remoteKey
            ? { externalKey: primaryRemote.remoteKey }
            : {}),
          ...(primaryRemote.remoteUrl
            ? { externalUrl: primaryRemote.remoteUrl }
            : {}),
          ...(primaryRemote.projectId
            ? { externalProjectId: primaryRemote.projectId }
            : {}),
          ...(primaryRemote.projectName
            ? { externalProjectName: primaryRemote.projectName }
            : {}),
          ...(primaryRemote.teamId
            ? { externalTeamId: primaryRemote.teamId }
            : {}),
        }
      : {}),
    ...(input.ticket.identity.projectId
      ? { projectId: input.ticket.identity.projectId }
      : {}),
    ...(input.ticket.identity.projectName
      ? { projectName: input.ticket.identity.projectName }
      : {}),
  };
}

function inferSourceSystem(input: {
  readonly ticket: TicketSummaryCompatibility;
}): string {
  if (input.ticket.externalSystem) {
    return input.ticket.externalSystem;
  }
  if (input.ticket.source !== "hack") {
    return input.ticket.source;
  }
  if (input.ticket.owner !== "hack") {
    return input.ticket.owner;
  }
  return "hack";
}

function buildDocuments(input: {
  readonly ticket: TicketSummaryCompatibility;
}): TicketDocument[] {
  if (!input.ticket.body) {
    return [];
  }

  const contentSha256 = sha256Hex({ value: input.ticket.body });
  return [
    {
      documentId: `${input.ticket.ticketId}:description:${contentSha256.slice(0, 12)}`,
      ticketId: input.ticket.ticketId,
      kind: "description",
      role: "description",
      content: input.ticket.body,
      contentSha256,
      createdAt: input.ticket.createdAt,
      updatedAt: input.ticket.updatedAt,
    },
  ];
}

function buildRemoteLinks(input: {
  readonly ticket: TicketSummaryCompatibility;
  readonly sourceSystem: string;
}): TicketRemoteLink[] {
  if (
    !(
      input.ticket.externalSystem ||
      input.ticket.externalId ||
      input.ticket.externalKey ||
      input.ticket.externalUrl ||
      input.ticket.externalProjectId ||
      input.ticket.externalProjectName ||
      input.ticket.externalTeamId
    )
  ) {
    return [];
  }

  return [
    {
      provider: input.ticket.externalSystem ?? input.sourceSystem,
      ...(input.ticket.externalId ? { remoteId: input.ticket.externalId } : {}),
      ...(input.ticket.externalKey
        ? { remoteKey: input.ticket.externalKey }
        : {}),
      ...(input.ticket.externalUrl
        ? { remoteUrl: input.ticket.externalUrl }
        : {}),
      ...(input.ticket.externalProjectId
        ? { projectId: input.ticket.externalProjectId }
        : {}),
      ...(input.ticket.externalProjectName
        ? { projectName: input.ticket.externalProjectName }
        : {}),
      ...(input.ticket.externalTeamId
        ? { teamId: input.ticket.externalTeamId }
        : {}),
    },
  ];
}

function buildFieldStates(input: {
  readonly remotes: readonly TicketRemoteLink[];
  readonly conflicts: readonly TicketSyncConflictCompatibility[];
}): TicketFieldState[] {
  const defaultAuthority = input.remotes.length > 0 ? "remote" : "local";
  const byField = new Map<string, TicketFieldState>();

  for (const field of ["title", "status", "assignee", "description"]) {
    byField.set(field, {
      field,
      authority: defaultAuthority,
      conflictIds: [],
    });
  }

  for (const conflict of input.conflicts) {
    const current = byField.get(conflict.field);
    const conflictIds = [...(current?.conflictIds ?? []), conflict.conflictId];
    byField.set(conflict.field, {
      field: conflict.field,
      authority: conflict.authority ?? current?.authority ?? defaultAuthority,
      conflictIds,
    });
  }

  return [...byField.values()];
}
