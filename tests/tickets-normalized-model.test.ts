import { expect, test } from "bun:test";

import {
  buildNormalizedTicketLink,
  normalizedTicketAuthoritySchema,
  normalizedTicketEntitySchema,
  normalizeLegacyTicketSummary,
  TICKET_AUTHORITY_FIELDS,
} from "../src/control-plane/extensions/tickets/normalized-model.ts";

const createMinimalNormalizedTicket = () =>
  ({
    schemaVersion: 1,
    kind: "ticket",
    id: "T-00099",
    canonical: {
      title: "Normalized ticket",
      status: "open",
      tags: [],
      relationships: {
        dependsOn: [],
        blocks: [],
      },
      timestamps: {
        createdAt: "2026-03-13T18:00:00.000Z",
        updatedAt: "2026-03-13T18:05:00.000Z",
      },
    },
    provenance: {
      origin: {
        kind: "local",
        system: "hack",
      },
      links: [],
      authority: {
        defaultRule: {
          policy: "replace",
          winner: { kind: "local" },
        },
        fieldRules: {},
      },
    },
  }) as const;

test("normalizes a local-only ticket with local authority defaults", () => {
  const normalized = normalizeLegacyTicketSummary({
    ticket: {
      ticketId: "T-00042",
      title: "Keep local-only work local",
      body: "No remote linkage yet.",
      status: "open",
      createdAt: "2026-03-13T18:00:00.000Z",
      updatedAt: "2026-03-13T18:05:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "hack",
      source: "hack",
      tags: ["core"],
      projectId: "proj_local",
      projectName: "Hack App",
    },
  });

  expect(normalizedTicketEntitySchema.parse(normalized)).toEqual(normalized);
  expect(normalized.provenance.origin).toEqual({
    kind: "local",
    system: "hack",
  });
  expect(normalized.provenance.links).toEqual([]);
  expect(normalized.provenance.authority.defaultRule).toEqual({
    policy: "replace",
    winner: { kind: "local" },
  });
  expect(normalized.canonical.project).toEqual({
    id: "proj_local",
    name: "Hack App",
  });
});

test("normalizes a Linear-origin ticket into generic provenance, links, and authority", () => {
  const normalized = normalizeLegacyTicketSummary({
    ticket: {
      ticketId: "T-00043",
      title: "Imported from Linear",
      body: "Remote source stays authoritative.",
      status: "in_progress",
      createdAt: "2026-03-13T18:10:00.000Z",
      updatedAt: "2026-03-13T18:15:00.000Z",
      dependsOn: ["T-00042"],
      blocks: [],
      owner: "linear",
      source: "linear",
      assignee: "alice@hack",
      tags: ["sync", "linear"],
      externalSystem: "linear",
      externalId: "lin_123",
      externalKey: "HACK-449",
      externalUrl: "https://linear.app/hackdance/issue/HACK-449",
      externalProjectId: "linear_project_1",
      externalProjectName: "Tickets Normalization Core",
      externalTeamId: "linear_team_1",
      projectId: "proj_linear",
      projectName: "Hack App",
    },
    linkContext: {
      profileId: "default",
      workspaceId: "linear_workspace_1",
      workspaceName: "Hack Dance",
      adapterMetadata: {
        stateId: "started",
        priority: 2,
      },
    },
  });

  expect(normalizedTicketEntitySchema.parse(normalized)).toEqual(normalized);
  expect(normalized.provenance.origin).toEqual({
    kind: "external",
    system: "linear",
    linkId: "linear:lin_123",
  });
  expect(normalized.provenance.authority.defaultRule).toEqual({
    policy: "replace",
    winner: { kind: "origin" },
  });
  expect(normalized.provenance.links).toEqual([
    {
      linkId: "linear:lin_123",
      system: "linear",
      role: "origin",
      syncDirection: "bidirectional",
      connection: {
        profileId: "default",
        workspaceId: "linear_workspace_1",
        workspaceName: "Hack Dance",
      },
      remote: {
        id: "lin_123",
        key: "HACK-449",
        url: "https://linear.app/hackdance/issue/HACK-449",
        containers: [
          {
            kind: "project",
            id: "linear_project_1",
            name: "Tickets Normalization Core",
          },
          {
            kind: "team",
            id: "linear_team_1",
          },
        ],
      },
      adapterMetadata: {
        stateId: "started",
        priority: 2,
      },
    },
  ]);
});

test("builds generic external links that keep adapter metadata outside canonical fields", () => {
  const link = buildNormalizedTicketLink({
    system: "github",
    remoteId: "issue_987",
    remoteKey: "hack-dance/hack-cli#987",
    remoteUrl: "https://github.com/hack-dance/hack-cli/issues/987",
    containers: [
      {
        kind: "repo",
        id: "hack-dance/hack-cli",
        name: "hack-dance/hack-cli",
      },
    ],
    connection: {
      profileId: "work",
      accountId: "installation_1",
      workspaceName: "hack-dance",
    },
    adapterMetadata: {
      labels: ["tickets", "sync"],
      milestone: "Tickets Normalization Core",
    },
  });

  expect(link).toEqual({
    linkId: "github:issue_987",
    system: "github",
    role: "synced",
    syncDirection: "bidirectional",
    connection: {
      profileId: "work",
      accountId: "installation_1",
      workspaceName: "hack-dance",
    },
    remote: {
      id: "issue_987",
      key: "hack-dance/hack-cli#987",
      url: "https://github.com/hack-dance/hack-cli/issues/987",
      containers: [
        {
          kind: "repo",
          id: "hack-dance/hack-cli",
          name: "hack-dance/hack-cli",
        },
      ],
    },
    adapterMetadata: {
      labels: ["tickets", "sync"],
      milestone: "Tickets Normalization Core",
    },
  });
});

test("keeps Hack-origin tickets local while adding synced external links", () => {
  const normalized = normalizeLegacyTicketSummary({
    ticket: {
      ticketId: "T-00044",
      title: "Push to GitHub after local creation",
      status: "open",
      createdAt: "2026-03-13T18:20:00.000Z",
      updatedAt: "2026-03-13T18:25:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "hack",
      source: "hack",
      tags: ["github"],
      externalSystem: "github",
      externalId: "issue_44",
      externalKey: "hack-dance/hack-cli#44",
      externalUrl: "https://github.com/hack-dance/hack-cli/issues/44",
    },
  });

  expect(normalized.provenance.origin).toEqual({
    kind: "local",
    system: "hack",
  });
  expect(normalized.provenance.links[0]).toMatchObject({
    system: "github",
    role: "synced",
    linkId: "github:issue_44",
  });
  expect(normalized.provenance.authority.defaultRule).toEqual({
    policy: "replace",
    winner: { kind: "local" },
  });
});

test("treats owner as separate from origin when a local ticket is synced externally", () => {
  const normalized = normalizeLegacyTicketSummary({
    ticket: {
      ticketId: "T-00045",
      title: "Locally created but externally owned",
      status: "in_progress",
      createdAt: "2026-03-13T18:30:00.000Z",
      updatedAt: "2026-03-13T18:35:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "linear",
      source: "hack",
      tags: ["linear"],
      externalSystem: "linear",
      externalId: "lin_45",
      externalKey: "HACK-45",
      externalUrl: "https://linear.app/hackdance/issue/HACK-45",
    },
  });

  expect(normalized.provenance.origin).toEqual({
    kind: "local",
    system: "hack",
  });
  expect(normalized.provenance.links).toEqual([
    expect.objectContaining({
      linkId: "linear:lin_45",
      system: "linear",
      role: "synced",
    }),
  ]);
});

test("covers the canonical authority fields required by sync adapters", () => {
  expect(TICKET_AUTHORITY_FIELDS).toEqual([
    "title",
    "body",
    "status",
    "assignee",
    "project",
    "tags",
    "dependsOn",
    "blocks",
  ]);
});

test("rejects externally sourced legacy tickets that do not include remote identity", () => {
  expect(() =>
    normalizeLegacyTicketSummary({
      ticket: {
        ticketId: "T-00046",
        title: "Imported but missing remote identity",
        status: "open",
        createdAt: "2026-03-13T18:40:00.000Z",
        updatedAt: "2026-03-13T18:45:00.000Z",
        dependsOn: [],
        blocks: [],
        owner: "linear",
        source: "linear",
        tags: ["linear"],
        externalSystem: "linear",
      },
    })
  ).toThrow(
    "externally sourced legacy ticket requires externalSystem and externalId"
  );
});

test("does not fabricate container ids from legacy project names", () => {
  const normalized = normalizeLegacyTicketSummary({
    ticket: {
      ticketId: "T-00047",
      title: "Imported with a project name only",
      status: "open",
      createdAt: "2026-03-13T18:50:00.000Z",
      updatedAt: "2026-03-13T18:55:00.000Z",
      dependsOn: [],
      blocks: [],
      owner: "linear",
      source: "linear",
      tags: ["linear"],
      externalSystem: "linear",
      externalId: "lin_47",
      externalProjectName: "Name Without Stable Id",
      externalTeamId: "team_47",
    },
  });

  expect(normalized.provenance.links).toEqual([
    {
      linkId: "linear:lin_47",
      system: "linear",
      role: "origin",
      syncDirection: "bidirectional",
      remote: {
        id: "lin_47",
        containers: [
          {
            kind: "team",
            id: "team_47",
          },
        ],
      },
    },
  ]);
});

test("rejects external origin records that do not point at a matching origin link", () => {
  const normalized = createMinimalNormalizedTicket();

  expect(() =>
    normalizedTicketEntitySchema.parse({
      ...normalized,
      provenance: {
        ...normalized.provenance,
        origin: {
          kind: "external",
          system: "linear",
          linkId: "linear:lin_missing",
        },
        links: [
          buildNormalizedTicketLink({
            system: "linear",
            remoteId: "lin_123",
            role: "origin",
          }),
        ],
      },
    })
  ).toThrow(
    "normalized ticket external origin must reference a matching origin link"
  );
});

test("rejects authority winners that reference unknown links", () => {
  const normalized = createMinimalNormalizedTicket();

  expect(() =>
    normalizedTicketEntitySchema.parse({
      ...normalized,
      provenance: {
        ...normalized.provenance,
        links: [
          buildNormalizedTicketLink({
            system: "github",
            remoteId: "issue_42",
          }),
        ],
        authority: {
          defaultRule: {
            policy: "replace",
            winner: { kind: "link", linkId: "github:issue_missing" },
          },
          fieldRules: {},
        },
      },
    })
  ).toThrow(
    "normalized ticket authority defaultRule winner linkId must reference an existing link"
  );
});

test("parses standalone authority rules with link winners without entity context", () => {
  expect(
    normalizedTicketAuthoritySchema.parse({
      defaultRule: {
        policy: "replace",
        winner: { kind: "link", linkId: "github:issue_42" },
      },
      fieldRules: {
        tags: {
          policy: "set_union",
        },
      },
    })
  ).toEqual({
    defaultRule: {
      policy: "replace",
      winner: { kind: "link", linkId: "github:issue_42" },
    },
    fieldRules: {
      tags: {
        policy: "set_union",
      },
    },
  });
});

test("rejects blank remote identifiers when building normalized links", () => {
  expect(() =>
    buildNormalizedTicketLink({
      system: "asana",
      remoteId: "   ",
    })
  ).toThrow("normalized ticket remote id must be a non-empty string");
});

test("rejects local-origin tickets that still carry an origin link", () => {
  const normalized = createMinimalNormalizedTicket();

  expect(() =>
    normalizedTicketEntitySchema.parse({
      ...normalized,
      provenance: {
        ...normalized.provenance,
        links: [
          buildNormalizedTicketLink({
            system: "github",
            remoteId: "issue_51",
            role: "origin",
          }),
        ],
      },
    })
  ).toThrow("normalized ticket local origin cannot include origin links");
});

test("rejects parsed links whose linkId does not match the remote system identity", () => {
  expect(() =>
    normalizedTicketEntitySchema.parse({
      ...createMinimalNormalizedTicket(),
      provenance: {
        origin: {
          kind: "external",
          system: "linear",
          linkId: "linear:lin_52",
        },
        links: [
          {
            ...buildNormalizedTicketLink({
              system: "linear",
              remoteId: "lin_52",
              role: "origin",
            }),
            linkId: "linear:lin_other",
          },
        ],
        authority: {
          defaultRule: {
            policy: "replace",
            winner: { kind: "origin" },
          },
          fieldRules: {},
        },
      },
    })
  ).toThrow("normalized ticket linkId must match system and remote id");
});

test("rejects duplicate canonical list values in parsed entities", () => {
  expect(() =>
    normalizedTicketEntitySchema.parse({
      ...createMinimalNormalizedTicket(),
      canonical: {
        ...createMinimalNormalizedTicket().canonical,
        tags: ["sync", "sync"],
      },
    })
  ).toThrow("normalized ticket canonical tags must not contain duplicates");
});

test("rejects duplicate remote containers in parsed links", () => {
  expect(() =>
    normalizedTicketEntitySchema.parse({
      ...createMinimalNormalizedTicket(),
      provenance: {
        origin: {
          kind: "external",
          system: "asana",
          linkId: "asana:task_53",
        },
        links: [
          {
            ...buildNormalizedTicketLink({
              system: "asana",
              remoteId: "task_53",
              role: "origin",
              containers: [
                {
                  kind: "project",
                  id: "proj_1",
                  name: "Tickets",
                },
              ],
            }),
            remote: {
              id: "task_53",
              containers: [
                {
                  kind: "project",
                  id: "proj_1",
                  name: "Tickets",
                },
                {
                  kind: "project",
                  id: "proj_1",
                  name: "Tickets",
                },
              ],
            },
          },
        ],
        authority: {
          defaultRule: {
            policy: "replace",
            winner: { kind: "origin" },
          },
          fieldRules: {},
        },
      },
    })
  ).toThrow("normalized ticket remote containers must not contain duplicates");
});
