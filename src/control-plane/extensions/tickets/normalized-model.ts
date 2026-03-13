import type { TicketSummary } from "./store.ts";

export const NORMALIZED_TICKET_SCHEMA_VERSION = 1 as const;

export const TICKET_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
] as const;

export const EXTERNAL_TICKET_SYSTEMS = ["linear", "github", "asana"] as const;

export const TICKET_LINK_CONTAINER_KINDS = [
  "project",
  "team",
  "repo",
  "workspace",
  "board",
  "list",
] as const;

export const TICKET_AUTHORITY_FIELDS = [
  "title",
  "body",
  "status",
  "assignee",
  "project",
  "tags",
  "dependsOn",
  "blocks",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type ExternalTicketSystem = (typeof EXTERNAL_TICKET_SYSTEMS)[number];
export type TicketLinkContainerKind =
  (typeof TICKET_LINK_CONTAINER_KINDS)[number];
export type TicketAuthorityField = (typeof TICKET_AUTHORITY_FIELDS)[number];

export type TicketSchemaValue =
  | string
  | number
  | boolean
  | null
  | readonly TicketSchemaValue[]
  | { readonly [key: string]: TicketSchemaValue };

export type LegacyTicketSummary = TicketSummary;

export type TicketLinkContainer = {
  readonly kind: TicketLinkContainerKind;
  readonly id: string;
  readonly name?: string;
};

export type TicketLinkConnection = {
  readonly profileId?: string;
  readonly accountId?: string;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
};

export type NormalizedTicketLink = {
  readonly linkId: string;
  readonly system: ExternalTicketSystem;
  readonly role: "origin" | "synced" | "reference";
  readonly syncDirection: "pull" | "push" | "bidirectional";
  readonly connection?: TicketLinkConnection;
  readonly remote: {
    readonly id: string;
    readonly key?: string;
    readonly url?: string;
    readonly containers: readonly TicketLinkContainer[];
  };
  readonly adapterMetadata?: { readonly [key: string]: TicketSchemaValue };
};

export type TicketAuthorityWinner =
  | { readonly kind: "local" }
  | { readonly kind: "origin" }
  | { readonly kind: "link"; readonly linkId: string };

export type TicketAuthorityRule = {
  readonly policy: "replace" | "append" | "set_union";
  readonly winner?: TicketAuthorityWinner;
};

export type NormalizedTicketAuthority = {
  readonly defaultRule: TicketAuthorityRule;
  readonly fieldRules: Partial<
    Record<TicketAuthorityField, TicketAuthorityRule>
  >;
};

export type NormalizedTicketOrigin =
  | {
      readonly kind: "local";
      readonly system: "hack";
    }
  | {
      readonly kind: "external";
      readonly system: ExternalTicketSystem;
      readonly linkId: string;
    };

export type NormalizedTicketEntity = {
  readonly schemaVersion: typeof NORMALIZED_TICKET_SCHEMA_VERSION;
  readonly kind: "ticket";
  readonly id: string;
  readonly canonical: {
    readonly title: string;
    readonly body?: string;
    readonly status: TicketStatus;
    readonly assignee?: string;
    readonly project?: {
      readonly id?: string;
      readonly name?: string;
    };
    readonly tags: readonly string[];
    readonly relationships: {
      readonly dependsOn: readonly string[];
      readonly blocks: readonly string[];
    };
    readonly timestamps: {
      readonly createdAt: string;
      readonly updatedAt: string;
    };
  };
  readonly provenance: {
    readonly origin: NormalizedTicketOrigin;
    readonly links: readonly NormalizedTicketLink[];
    readonly authority: NormalizedTicketAuthority;
  };
};

export type NormalizedTicketLinkInput = {
  readonly system: ExternalTicketSystem;
  readonly remoteId: string;
  readonly remoteKey?: string;
  readonly remoteUrl?: string;
  readonly containers?: readonly TicketLinkContainer[];
  readonly role?: NormalizedTicketLink["role"];
  readonly syncDirection?: NormalizedTicketLink["syncDirection"];
  readonly connection?: TicketLinkConnection;
  readonly adapterMetadata?: { readonly [key: string]: TicketSchemaValue };
};

export type NormalizeLegacyTicketSummaryInput = {
  readonly ticket: LegacyTicketSummary;
  readonly linkContext?: TicketLinkConnection & {
    readonly adapterMetadata?: {
      readonly [key: string]: TicketSchemaValue;
    };
  };
};

type Schema<T> = {
  readonly parse: (input: unknown) => T;
};

export const normalizedTicketAuthoritySchema: Schema<NormalizedTicketAuthority> =
  {
    parse: (input) => parseNormalizedTicketAuthority(input),
  };

export const normalizedTicketEntitySchema: Schema<NormalizedTicketEntity> = {
  parse: (input) => parseNormalizedTicketEntity(input),
};

/**
 * Builds a provider-agnostic external link record that keeps provider-specific
 * data inside `adapterMetadata` rather than the canonical ticket fields.
 */
export const buildNormalizedTicketLink = (
  input: NormalizedTicketLinkInput
): NormalizedTicketLink => {
  const remoteId = input.remoteId.trim();
  const remoteKey = normalizeOptionalString(input.remoteKey);
  const remoteUrl = normalizeOptionalString(input.remoteUrl);
  const containers = normalizeContainers(input.containers ?? []);
  const connection = normalizeConnection(input.connection);
  const adapterMetadata = normalizeAdapterMetadata(input.adapterMetadata);

  const normalizedLink: NormalizedTicketLink = {
    linkId: `${input.system}:${remoteId}`,
    system: input.system,
    role: input.role ?? "synced",
    syncDirection: input.syncDirection ?? "bidirectional",
    ...(connection ? { connection } : {}),
    remote: {
      id: remoteId,
      ...(remoteKey ? { key: remoteKey } : {}),
      ...(remoteUrl ? { url: remoteUrl } : {}),
      containers,
    },
    ...(adapterMetadata ? { adapterMetadata } : {}),
  };

  return parseNormalizedTicketLink(normalizedLink);
};

/**
 * Projects the current flat ticket summary into the normalized entity shape so
 * storage and sync adapters can converge on one schema before the event store
 * is migrated.
 */
export const normalizeLegacyTicketSummary = (
  input: NormalizeLegacyTicketSummaryInput
): NormalizedTicketEntity => {
  assertLegacySummaryRemoteIdentity(input.ticket);
  const link = buildLinkFromLegacySummary({
    ticket: input.ticket,
    linkContext: input.linkContext,
  });
  const origin = deriveOrigin({
    ticket: input.ticket,
    link,
  });
  const authority = deriveAuthority({
    origin,
  });
  const project = normalizeProject({
    id: input.ticket.projectId,
    name: input.ticket.projectName,
  });

  const normalized: NormalizedTicketEntity = {
    schemaVersion: NORMALIZED_TICKET_SCHEMA_VERSION,
    kind: "ticket",
    id: input.ticket.ticketId,
    canonical: {
      title: input.ticket.title.trim(),
      ...(input.ticket.body !== undefined ? { body: input.ticket.body } : {}),
      status: input.ticket.status,
      ...(normalizeOptionalString(input.ticket.assignee)
        ? { assignee: input.ticket.assignee.trim() }
        : {}),
      ...(project ? { project } : {}),
      tags: normalizeStringList(input.ticket.tags),
      relationships: {
        dependsOn: normalizeStringList(input.ticket.dependsOn),
        blocks: normalizeStringList(input.ticket.blocks),
      },
      timestamps: {
        createdAt: input.ticket.createdAt,
        updatedAt: input.ticket.updatedAt,
      },
    },
    provenance: {
      origin,
      links: link ? [link] : [],
      authority,
    },
  };

  return normalizedTicketEntitySchema.parse(normalized);
};

const buildLinkFromLegacySummary = (input: {
  readonly ticket: LegacyTicketSummary;
  readonly linkContext?: NormalizeLegacyTicketSummaryInput["linkContext"];
}): NormalizedTicketLink | undefined => {
  const system = normalizeExternalSystem(input.ticket.externalSystem);
  const remoteId = normalizeOptionalString(input.ticket.externalId);
  if (!(system && remoteId)) {
    return undefined;
  }

  const containers: TicketLinkContainer[] = [];
  const projectId = normalizeOptionalString(input.ticket.externalProjectId);
  const projectName = normalizeOptionalString(input.ticket.externalProjectName);
  if (projectId) {
    containers.push({
      kind: "project",
      id: projectId,
      ...(projectName ? { name: projectName } : {}),
    });
  }

  const teamId = normalizeOptionalString(input.ticket.externalTeamId);
  if (teamId) {
    containers.push({
      kind: "team",
      id: teamId,
    });
  }

  return buildNormalizedTicketLink({
    system,
    remoteId,
    remoteKey: input.ticket.externalKey,
    remoteUrl: input.ticket.externalUrl,
    containers,
    role: isExternalOrigin({ ticket: input.ticket, system })
      ? "origin"
      : "synced",
    syncDirection: "bidirectional",
    connection: input.linkContext,
    adapterMetadata: input.linkContext?.adapterMetadata,
  });
};

const deriveOrigin = (input: {
  readonly ticket: LegacyTicketSummary;
  readonly link?: NormalizedTicketLink;
}): NormalizedTicketOrigin => {
  if (
    input.link &&
    input.link.role === "origin" &&
    normalizeOwnerLikeValue(input.ticket.source) === input.link.system
  ) {
    return {
      kind: "external",
      system: input.link.system,
      linkId: input.link.linkId,
    };
  }

  return {
    kind: "local",
    system: "hack",
  };
};

const deriveAuthority = (input: {
  readonly origin: NormalizedTicketOrigin;
}): NormalizedTicketAuthority => {
  const defaultRule: TicketAuthorityRule =
    input.origin.kind === "external"
      ? {
          policy: "replace",
          winner: { kind: "origin" },
        }
      : {
          policy: "replace",
          winner: { kind: "local" },
        };

  return {
    defaultRule,
    fieldRules: {
      tags: {
        policy: "set_union",
      },
      dependsOn: {
        policy: "set_union",
      },
      blocks: {
        policy: "set_union",
      },
    },
  };
};

const assertLegacySummaryRemoteIdentity = (
  ticket: LegacyTicketSummary
): void => {
  const sourceSystem = normalizeExternalSystem(ticket.source);
  if (!sourceSystem) {
    return;
  }

  const externalSystem = normalizeExternalSystem(ticket.externalSystem);
  const remoteId = normalizeOptionalString(ticket.externalId);
  assertValue(
    externalSystem === sourceSystem && remoteId !== undefined,
    "externally sourced legacy ticket requires externalSystem and externalId"
  );
};

const isExternalOrigin = (input: {
  readonly ticket: LegacyTicketSummary;
  readonly system: ExternalTicketSystem;
}): boolean => normalizeOwnerLikeValue(input.ticket.source) === input.system;

const normalizeProject = (input: {
  readonly id?: string;
  readonly name?: string;
}):
  | {
      readonly id?: string;
      readonly name?: string;
    }
  | undefined => {
  const id = normalizeOptionalString(input.id);
  const name = normalizeOptionalString(input.name);
  if (!(id || name)) {
    return undefined;
  }
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
};

const normalizeConnection = (
  input: TicketLinkConnection | undefined
): TicketLinkConnection | undefined => {
  if (!input) {
    return undefined;
  }

  const profileId = normalizeOptionalString(input.profileId);
  const accountId = normalizeOptionalString(input.accountId);
  const workspaceId = normalizeOptionalString(input.workspaceId);
  const workspaceName = normalizeOptionalString(input.workspaceName);

  if (!(profileId || accountId || workspaceId || workspaceName)) {
    return undefined;
  }

  return {
    ...(profileId ? { profileId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceName ? { workspaceName } : {}),
  };
};

const normalizeContainers = (
  input: readonly TicketLinkContainer[]
): TicketLinkContainer[] => {
  const normalized: TicketLinkContainer[] = [];
  const seen = new Set<string>();

  for (const container of input) {
    const id = normalizeOptionalString(container.id);
    if (!id) {
      continue;
    }
    const name = normalizeOptionalString(container.name);
    const key = `${container.kind}:${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      kind: container.kind,
      id,
      ...(name ? { name } : {}),
    });
  }

  return normalized;
};

const normalizeStringList = (input: readonly string[]): string[] => {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const value = normalizeOptionalString(item);
    if (!(value && !seen.has(value))) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
};

const normalizeAdapterMetadata = (
  input: { readonly [key: string]: TicketSchemaValue } | undefined
): { readonly [key: string]: TicketSchemaValue } | undefined => {
  if (!input) {
    return undefined;
  }

  const entries = Object.entries(input)
    .map(([key, value]) => [key.trim(), value] as const)
    .filter(([key]) => key.length > 0);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
};

const normalizeOptionalString = (
  input: string | undefined
): string | undefined => {
  const value = input?.trim();
  return value ? value : undefined;
};

const normalizeOwnerLikeValue = (
  input: string | undefined
): string | undefined => normalizeOptionalString(input)?.toLowerCase();

const normalizeExternalSystem = (
  input: string | undefined
): ExternalTicketSystem | undefined => {
  const value = normalizeOwnerLikeValue(input);
  if (value === "linear" || value === "github" || value === "asana") {
    return value;
  }
  return undefined;
};

const parseNormalizedTicketEntity = (
  input: unknown
): NormalizedTicketEntity => {
  const record = asRecord(input, "normalized ticket entity");
  assertValue(
    record.schemaVersion === NORMALIZED_TICKET_SCHEMA_VERSION,
    "normalized ticket entity schemaVersion must be 1"
  );
  assertValue(
    record.kind === "ticket",
    "normalized ticket entity kind must be ticket"
  );

  const canonicalRecord = asRecord(
    record.canonical,
    "normalized ticket entity canonical"
  );
  const provenanceRecord = asRecord(
    record.provenance,
    "normalized ticket entity provenance"
  );

  assertNonEmptyString(record.id, "normalized ticket entity id");
  assertNonEmptyString(
    canonicalRecord.title,
    "normalized ticket canonical title"
  );
  if (canonicalRecord.body !== undefined) {
    assertString(canonicalRecord.body, "normalized ticket canonical body");
  }
  assertTicketStatus(canonicalRecord.status);
  if (canonicalRecord.assignee !== undefined) {
    assertNonEmptyString(
      canonicalRecord.assignee,
      "normalized ticket canonical assignee"
    );
  }

  if (canonicalRecord.project !== undefined) {
    const projectRecord = asRecord(
      canonicalRecord.project,
      "normalized ticket canonical project"
    );
    assertValue(
      typeof projectRecord.id === "string" ||
        typeof projectRecord.name === "string",
      "normalized ticket canonical project must include an id or name"
    );
    if (projectRecord.id !== undefined) {
      assertNonEmptyString(
        projectRecord.id,
        "normalized ticket canonical project id"
      );
    }
    if (projectRecord.name !== undefined) {
      assertNonEmptyString(
        projectRecord.name,
        "normalized ticket canonical project name"
      );
    }
  }

  assertStringList(canonicalRecord.tags, "normalized ticket canonical tags");

  const relationshipsRecord = asRecord(
    canonicalRecord.relationships,
    "normalized ticket canonical relationships"
  );
  assertStringList(
    relationshipsRecord.dependsOn,
    "normalized ticket canonical dependsOn"
  );
  assertStringList(
    relationshipsRecord.blocks,
    "normalized ticket canonical blocks"
  );

  const timestampsRecord = asRecord(
    canonicalRecord.timestamps,
    "normalized ticket canonical timestamps"
  );
  assertIsoTimestamp(timestampsRecord.createdAt, "normalized ticket createdAt");
  assertIsoTimestamp(timestampsRecord.updatedAt, "normalized ticket updatedAt");

  const origin = parseNormalizedTicketOrigin(provenanceRecord.origin);
  assertValue(
    Array.isArray(provenanceRecord.links),
    "normalized ticket links must be an array"
  );
  const links = provenanceRecord.links.map((link) =>
    parseNormalizedTicketLink(link)
  );
  const linkIds = new Set<string>();
  const originLinks: NormalizedTicketLink[] = [];
  for (const link of links) {
    assertValue(
      !linkIds.has(link.linkId),
      `normalized ticket link ${link.linkId} must be unique`
    );
    linkIds.add(link.linkId);
    if (link.role === "origin") {
      originLinks.push(link);
    }
  }

  if (origin.kind === "local") {
    assertValue(
      originLinks.length === 0,
      "normalized ticket local origin cannot include origin links"
    );
  }

  if (origin.kind === "external") {
    const matchingOriginLink = originLinks.find(
      (link) => link.linkId === origin.linkId && link.system === origin.system
    );
    assertValue(
      matchingOriginLink !== undefined,
      "normalized ticket external origin must reference a matching origin link"
    );
  }

  parseNormalizedTicketAuthority(provenanceRecord.authority, linkIds);

  return record as NormalizedTicketEntity;
};

const parseNormalizedTicketAuthority = (
  input: unknown,
  linkIds?: ReadonlySet<string>
): NormalizedTicketAuthority => {
  const record = asRecord(input, "normalized ticket authority");
  parseTicketAuthorityRule(
    record.defaultRule,
    "normalized ticket authority defaultRule",
    linkIds
  );
  const fieldRules = asRecord(
    record.fieldRules,
    "normalized ticket authority fieldRules"
  );
  for (const [key, value] of Object.entries(fieldRules)) {
    assertValue(
      (TICKET_AUTHORITY_FIELDS as readonly string[]).includes(key),
      `normalized ticket authority field ${key} is not supported`
    );
    parseTicketAuthorityRule(
      value,
      `normalized ticket authority fieldRules.${key}`,
      linkIds
    );
  }
  return record as NormalizedTicketAuthority;
};

const parseNormalizedTicketOrigin = (
  input: unknown
): NormalizedTicketOrigin => {
  const record = asRecord(input, "normalized ticket origin");
  assertValue(
    record.kind === "local" || record.kind === "external",
    "normalized ticket origin kind must be local or external"
  );

  if (record.kind === "local") {
    assertValue(
      record.system === "hack",
      "local ticket origin system must be hack"
    );
    return record as NormalizedTicketOrigin;
  }

  assertExternalTicketSystem(record.system);
  assertNonEmptyString(record.linkId, "external ticket origin linkId");
  return record as NormalizedTicketOrigin;
};

const parseNormalizedTicketLink = (input: unknown): NormalizedTicketLink => {
  const record = asRecord(input, "normalized ticket link");
  assertNonEmptyString(record.linkId, "normalized ticket linkId");
  assertExternalTicketSystem(record.system);
  assertValue(
    record.role === "origin" ||
      record.role === "synced" ||
      record.role === "reference",
    "normalized ticket link role must be origin, synced, or reference"
  );
  assertValue(
    record.syncDirection === "pull" ||
      record.syncDirection === "push" ||
      record.syncDirection === "bidirectional",
    "normalized ticket link syncDirection must be pull, push, or bidirectional"
  );

  if (record.connection !== undefined) {
    const connectionRecord = asRecord(
      record.connection,
      "normalized ticket connection"
    );
    const values = [
      connectionRecord.profileId,
      connectionRecord.accountId,
      connectionRecord.workspaceId,
      connectionRecord.workspaceName,
    ].filter((value) => typeof value === "string");
    assertValue(
      values.length > 0,
      "normalized ticket connection must include at least one identifier"
    );
    for (const [key, value] of Object.entries(connectionRecord)) {
      assertNonEmptyString(value, `normalized ticket connection ${key}`);
    }
  }

  const remoteRecord = asRecord(record.remote, "normalized ticket remote");
  assertNonEmptyString(remoteRecord.id, "normalized ticket remote id");
  if (remoteRecord.key !== undefined) {
    assertNonEmptyString(remoteRecord.key, "normalized ticket remote key");
  }
  if (remoteRecord.url !== undefined) {
    assertUrl(remoteRecord.url, "normalized ticket remote url");
  }
  assertValue(
    Array.isArray(remoteRecord.containers),
    "normalized ticket remote containers must be an array"
  );
  for (const container of remoteRecord.containers) {
    const containerRecord = asRecord(container, "normalized ticket container");
    assertValue(
      (TICKET_LINK_CONTAINER_KINDS as readonly string[]).includes(
        String(containerRecord.kind)
      ),
      "normalized ticket container kind is invalid"
    );
    assertNonEmptyString(containerRecord.id, "normalized ticket container id");
    if (containerRecord.name !== undefined) {
      assertNonEmptyString(
        containerRecord.name,
        "normalized ticket container name"
      );
    }
  }

  if (record.adapterMetadata !== undefined) {
    const metadataRecord = asRecord(
      record.adapterMetadata,
      "normalized ticket adapter metadata"
    );
    for (const [key, value] of Object.entries(metadataRecord)) {
      assertNonEmptyString(key, "normalized ticket adapter metadata key");
      assertTicketSchemaValue(
        value,
        `normalized ticket adapter metadata ${key}`
      );
    }
  }

  return record as NormalizedTicketLink;
};

const parseTicketAuthorityRule = (
  input: unknown,
  label: string,
  linkIds?: ReadonlySet<string>
): TicketAuthorityRule => {
  const record = asRecord(input, label);
  assertValue(
    record.policy === "replace" ||
      record.policy === "append" ||
      record.policy === "set_union",
    `${label} policy must be replace, append, or set_union`
  );

  if (record.winner !== undefined) {
    const winnerRecord = asRecord(record.winner, `${label} winner`);
    assertValue(
      winnerRecord.kind === "local" ||
        winnerRecord.kind === "origin" ||
        winnerRecord.kind === "link",
      `${label} winner kind must be local, origin, or link`
    );
    if (winnerRecord.kind === "link") {
      assertNonEmptyString(winnerRecord.linkId, `${label} winner linkId`);
      if (linkIds) {
        assertValue(
          linkIds.has(winnerRecord.linkId),
          `${label} winner linkId must reference an existing link`
        );
      }
    }
  }

  return record as TicketAuthorityRule;
};

const assertTicketSchemaValue = (input: unknown, label: string): void => {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return;
  }

  if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) {
      assertTicketSchemaValue(value, `${label}[${index}]`);
    }
    return;
  }

  if (typeof input === "object") {
    for (const [key, value] of Object.entries(asRecord(input, label))) {
      assertNonEmptyString(key, `${label} key`);
      assertTicketSchemaValue(value, `${label}.${key}`);
    }
    return;
  }

  throw new Error(`${label} must be a JSON-like metadata value`);
};

const assertStringList = (input: unknown, label: string): void => {
  assertValue(Array.isArray(input), `${label} must be an array`);
  for (const [index, value] of input.entries()) {
    assertNonEmptyString(value, `${label}[${index}]`);
  }
};

const assertTicketStatus = (input: unknown): asserts input is TicketStatus => {
  assertValue(
    (TICKET_STATUSES as readonly string[]).includes(String(input)),
    "ticket status must be open, in_progress, blocked, or done"
  );
};

const assertExternalTicketSystem = (
  input: unknown
): asserts input is ExternalTicketSystem => {
  assertValue(
    (EXTERNAL_TICKET_SYSTEMS as readonly string[]).includes(String(input)),
    "external ticket system must be linear, github, or asana"
  );
};

const assertIsoTimestamp = (input: unknown, label: string): void => {
  assertNonEmptyString(input, label);
  assertValue(
    !Number.isNaN(Date.parse(input)),
    `${label} must be an ISO timestamp`
  );
};

const assertUrl = (input: unknown, label: string): void => {
  assertNonEmptyString(input, label);
  try {
    new URL(input);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
};

const assertString = (input: unknown, label: string): void => {
  assertValue(typeof input === "string", `${label} must be a string`);
};

const assertNonEmptyString = (input: unknown, label: string): void => {
  assertString(input, label);
  assertValue(input.trim().length > 0, `${label} must be a non-empty string`);
};

const asRecord = (input: unknown, label: string): Record<string, unknown> => {
  assertValue(
    Boolean(input) && typeof input === "object" && !Array.isArray(input),
    `${label} must be an object`
  );
  return input as Record<string, unknown>;
};

const assertValue = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};
