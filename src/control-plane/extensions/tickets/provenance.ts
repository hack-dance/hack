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

export type TicketProvenanceCompatibility = {
  readonly owner: string;
  readonly source: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly status: string;
  readonly body?: string;
  readonly assignee?: string;
  readonly externalSystem?: string;
  readonly externalId?: string;
  readonly externalKey?: string;
  readonly externalUrl?: string;
  readonly externalProjectId?: string;
  readonly externalProjectName?: string;
  readonly externalTeamId?: string;
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

export function normalizeTicketFieldName(field: string): string {
  return field === "body" ? "description" : field;
}

export function inferTicketSourceSystem(input: {
  readonly ticket: Pick<
    TicketProvenanceCompatibility,
    "owner" | "source" | "externalSystem"
  >;
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

export function buildTicketRemoteLinks(input: {
  readonly ticket: Pick<
    TicketProvenanceCompatibility,
    | "owner"
    | "source"
    | "externalSystem"
    | "externalId"
    | "externalKey"
    | "externalUrl"
    | "externalProjectId"
    | "externalProjectName"
    | "externalTeamId"
  >;
  readonly syncCheckpoints?: readonly TicketSyncCheckpointCompatibility[];
}): TicketRemoteLink[] {
  const sourceSystem = inferTicketSourceSystem({
    ticket: input.ticket,
  });
  const remotes: TicketRemoteLink[] = [];

  if (ticketHasRemoteIdentity({ ticket: input.ticket })) {
    remotes.push(
      createPrimaryRemoteLink({
        ticket: input.ticket,
        sourceSystem,
      })
    );
  }

  for (const checkpoint of input.syncCheckpoints ?? []) {
    const trackedIndex = remotes.findIndex((remote) =>
      remoteMatchesCheckpoint({ remote, checkpoint })
    );

    if (trackedIndex >= 0) {
      const trackedRemote = remotes[trackedIndex];
      if (!trackedRemote) {
        continue;
      }
      remotes[trackedIndex] = mergeCheckpointRemote({
        remote: trackedRemote,
        checkpoint,
      });
      continue;
    }

    remotes.push(createCheckpointRemoteLink({ checkpoint }));
  }

  return remotes;
}

function ticketHasRemoteIdentity(input: {
  readonly ticket: Pick<
    TicketProvenanceCompatibility,
    | "externalSystem"
    | "externalId"
    | "externalKey"
    | "externalUrl"
    | "externalProjectId"
    | "externalProjectName"
    | "externalTeamId"
  >;
}): boolean {
  return Boolean(
    input.ticket.externalSystem ||
      input.ticket.externalId ||
      input.ticket.externalKey ||
      input.ticket.externalUrl ||
      input.ticket.externalProjectId ||
      input.ticket.externalProjectName ||
      input.ticket.externalTeamId
  );
}

function createPrimaryRemoteLink(input: {
  readonly ticket: Pick<
    TicketProvenanceCompatibility,
    | "externalSystem"
    | "externalId"
    | "externalKey"
    | "externalUrl"
    | "externalProjectId"
    | "externalProjectName"
    | "externalTeamId"
  >;
  readonly sourceSystem: string;
}): TicketRemoteLink {
  return {
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
  };
}

function remoteMatchesCheckpoint(input: {
  readonly remote: TicketRemoteLink;
  readonly checkpoint: TicketSyncCheckpointCompatibility;
}): boolean {
  return (
    input.remote.provider === input.checkpoint.provider &&
    (input.remote.profileId === input.checkpoint.profileId ||
      input.remote.profileId === undefined ||
      input.checkpoint.profileId === undefined)
  );
}

function mergeCheckpointRemote(input: {
  readonly remote: TicketRemoteLink;
  readonly checkpoint: TicketSyncCheckpointCompatibility;
}): TicketRemoteLink {
  return {
    ...input.remote,
    ...(input.remote.profileId === undefined && input.checkpoint.profileId
      ? { profileId: input.checkpoint.profileId }
      : {}),
    ...(input.checkpoint.remoteCursor
      ? { remoteCursor: input.checkpoint.remoteCursor }
      : {}),
    ...(input.checkpoint.remoteUpdatedAt
      ? { remoteUpdatedAt: input.checkpoint.remoteUpdatedAt }
      : {}),
  };
}

function createCheckpointRemoteLink(input: {
  readonly checkpoint: TicketSyncCheckpointCompatibility;
}): TicketRemoteLink {
  return {
    provider: input.checkpoint.provider,
    ...(input.checkpoint.profileId
      ? { profileId: input.checkpoint.profileId }
      : {}),
    ...(input.checkpoint.remoteCursor
      ? { remoteCursor: input.checkpoint.remoteCursor }
      : {}),
    ...(input.checkpoint.remoteUpdatedAt
      ? { remoteUpdatedAt: input.checkpoint.remoteUpdatedAt }
      : {}),
  };
}

export function buildTicketFieldAuthorities(input: {
  readonly remotes: readonly TicketRemoteLink[];
  readonly conflicts?: readonly TicketSyncConflictCompatibility[];
}): TicketFieldAuthorityEntry[] {
  const defaultAuthority: TicketFieldAuthority =
    input.remotes.length > 0 ? "remote" : "local";
  const byField = new Map<string, TicketFieldAuthorityEntry>();

  for (const field of [
    "title",
    "status",
    "assignee",
    "description",
    "project",
  ]) {
    byField.set(field, {
      field,
      authority: defaultAuthority,
    });
  }
  byField.set("comment", {
    field: "comment",
    authority: "append_only",
  });
  byField.set("review_note", {
    field: "review_note",
    authority: "local",
  });
  byField.set("sync_checkpoint", {
    field: "sync_checkpoint",
    authority: "derived",
  });
  byField.set("sync_conflict", {
    field: "sync_conflict",
    authority: "derived",
  });

  for (const conflict of input.conflicts ?? []) {
    const field = normalizeTicketFieldName(conflict.field);
    const current = byField.get(field);
    const authority = normalizeConflictAuthority({
      authority: conflict.authority,
    });
    byField.set(field, {
      field,
      authority: authority ?? current?.authority ?? defaultAuthority,
    });
  }

  return [...byField.values()];
}

function normalizeConflictAuthority(input: {
  readonly authority?: string;
}): TicketFieldAuthority | undefined {
  if (
    input.authority === "local" ||
    input.authority === "remote" ||
    input.authority === "append_only" ||
    input.authority === "derived" ||
    input.authority === "review_required"
  ) {
    return input.authority;
  }
  return undefined;
}

export function buildTicketFieldVersions(input: {
  readonly ticket: TicketProvenanceCompatibility;
  readonly conflicts?: readonly TicketSyncConflictCompatibility[];
}): TicketFieldVersion[] {
  const versions: TicketFieldVersion[] = [
    {
      field: "title",
      source: "local",
      recordedAt: input.ticket.updatedAt,
      value: input.ticket.title,
    },
    {
      field: "status",
      source: "local",
      recordedAt: input.ticket.updatedAt,
      value: input.ticket.status,
    },
    {
      field: "description",
      source: "local",
      recordedAt: input.ticket.updatedAt,
      ...(input.ticket.body ? { value: input.ticket.body } : {}),
    },
  ];

  if (input.ticket.assignee) {
    versions.push({
      field: "assignee",
      source: "local",
      recordedAt: input.ticket.updatedAt,
      value: input.ticket.assignee,
    });
  }

  for (const conflict of input.conflicts ?? []) {
    const field = normalizeTicketFieldName(conflict.field);
    if (conflict.localValue !== undefined) {
      versions.push({
        field,
        source: "local",
        recordedAt: conflict.updatedAt,
        value: conflict.localValue,
      });
    }
    if (conflict.remoteValue !== undefined) {
      versions.push({
        field,
        source: "remote",
        provider: conflict.provider,
        recordedAt: conflict.updatedAt,
        value: conflict.remoteValue,
      });
    }
  }

  return versions;
}

export function buildTicketProvenance(input: {
  readonly ticket: TicketProvenanceCompatibility;
  readonly syncCheckpoints?: readonly TicketSyncCheckpointCompatibility[];
  readonly conflicts?: readonly TicketSyncConflictCompatibility[];
}): {
  readonly origin: TicketOrigin;
  readonly remotes: readonly TicketRemoteLink[];
  readonly fieldAuthorities: readonly TicketFieldAuthorityEntry[];
  readonly fieldVersions: readonly TicketFieldVersion[];
} {
  const system = inferTicketSourceSystem({
    ticket: input.ticket,
  });
  const remotes = buildTicketRemoteLinks({
    ticket: input.ticket,
    syncCheckpoints: input.syncCheckpoints,
  });

  return {
    origin: {
      owner: input.ticket.owner,
      source: input.ticket.source,
      system,
    },
    remotes,
    fieldAuthorities: buildTicketFieldAuthorities({
      remotes,
      conflicts: input.conflicts,
    }),
    fieldVersions: buildTicketFieldVersions({
      ticket: input.ticket,
      conflicts: input.conflicts,
    }),
  };
}

export function findTicketRemoteLink(input: {
  readonly ticket: Pick<
    TicketProvenanceCompatibility,
    | "owner"
    | "source"
    | "updatedAt"
    | "title"
    | "status"
    | "externalSystem"
    | "externalId"
    | "externalKey"
    | "externalUrl"
    | "externalProjectId"
    | "externalProjectName"
    | "externalTeamId"
  >;
  readonly provider: string;
  readonly syncCheckpoints?: readonly TicketSyncCheckpointCompatibility[];
}): TicketRemoteLink | null {
  return (
    buildTicketRemoteLinks({
      ticket: input.ticket,
      syncCheckpoints: input.syncCheckpoints,
    }).find((remote) => remote.provider === input.provider) ?? null
  );
}

export function projectRemoteLinkToCompatibilityFields(input: {
  readonly remote: TicketRemoteLink;
}): {
  readonly externalSystem: string;
  readonly externalId?: string;
  readonly externalKey?: string;
  readonly externalUrl?: string;
  readonly externalProjectId?: string;
  readonly externalProjectName?: string;
  readonly externalTeamId?: string;
} {
  return {
    externalSystem: input.remote.provider,
    ...(input.remote.remoteId ? { externalId: input.remote.remoteId } : {}),
    ...(input.remote.remoteKey ? { externalKey: input.remote.remoteKey } : {}),
    ...(input.remote.remoteUrl ? { externalUrl: input.remote.remoteUrl } : {}),
    ...(input.remote.projectId
      ? { externalProjectId: input.remote.projectId }
      : {}),
    ...(input.remote.projectName
      ? { externalProjectName: input.remote.projectName }
      : {}),
    ...(input.remote.teamId ? { externalTeamId: input.remote.teamId } : {}),
  };
}
