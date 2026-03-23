import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { requestHackAuthBroker } from "../lib/auth-broker-client.ts";
import { logger } from "../ui/logger.ts";

const optOrg = defineOption({
  name: "org",
  type: "string",
  long: "--org",
  valueHint: "<org>",
  description: "Parent organization slug or id",
} as const);

const optName = defineOption({
  name: "name",
  type: "string",
  long: "--name",
  valueHint: "<display-name>",
  description: "Human-friendly name to store alongside the slug",
} as const);

const optState = defineOption({
  name: "state",
  type: "string",
  long: "--state",
  valueHint: "<pending|active|removed|all>",
  description: "Filter membership rows by lifecycle state",
} as const);

const optBrokerUrl = defineOption({
  name: "brokerUrl",
  type: "string",
  long: "--broker-url",
  valueHint: "<url>",
  description: "Override the Hack auth broker base URL",
} as const);

const teamPositionals = [{ name: "team", required: true }] as const;
const teamSlugPositionals = [{ name: "slug", required: true }] as const;
const teamMemberTargetPositionals = [
  { name: "team", required: true },
  { name: "target", required: true },
] as const;

const createSpec = defineCommand({
  name: "create",
  summary: "Create a team inside an existing organization",
  description:
    "Requires an explicit --org value and does not add any members implicitly.",
  group: "Global",
  options: [optOrg, optName, optJson, optBrokerUrl] as const,
  positionals: teamSlugPositionals,
  subcommands: [] as const,
} as const);

const listSpec = defineCommand({
  name: "list",
  summary: "List teams for one organization",
  group: "Global",
  options: [optOrg, optJson, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const showSpec = defineCommand({
  name: "show",
  summary: "Show one team and its parent org context",
  group: "Global",
  options: [optOrg, optJson, optBrokerUrl] as const,
  positionals: teamPositionals,
  subcommands: [] as const,
} as const);

const memberListSpec = defineCommand({
  name: "list",
  summary: "List team members and pending invites",
  description:
    "Team membership depends on active org membership in the same organization.",
  group: "Global",
  options: [optOrg, optState, optJson, optBrokerUrl] as const,
  positionals: teamPositionals,
  subcommands: [] as const,
} as const);

const memberInviteSpec = defineCommand({
  name: "invite",
  summary: "Create pending team membership for an email address",
  description:
    "If the recipient is not already an org member, the final implementation must pair this with an org invite instead of granting access implicitly.",
  group: "Global",
  options: [optOrg, optJson, optBrokerUrl] as const,
  positionals: teamMemberTargetPositionals,
  subcommands: [] as const,
} as const);

const memberAddSpec = defineCommand({
  name: "add",
  summary: "Grant active team membership immediately to an existing user",
  description:
    "Requires both a resolvable Hack user and active org membership in the parent org.",
  group: "Global",
  options: [optOrg, optJson, optBrokerUrl] as const,
  positionals: teamMemberTargetPositionals,
  subcommands: [] as const,
} as const);

const memberRemoveSpec = defineCommand({
  name: "remove",
  summary: "Remove team membership or cancel a pending team invite",
  description:
    "Revokes only the team-level grant. Parent org membership stays unchanged.",
  group: "Global",
  options: [optOrg, optJson, optBrokerUrl] as const,
  positionals: teamMemberTargetPositionals,
  subcommands: [] as const,
} as const);

const memberSpec = defineCommand({
  name: "member",
  summary: "Manage team memberships and invitation lifecycle",
  group: "Global",
  options: [] as const,
  positionals: [] as const,
  subcommands: [
    withHandler(memberListSpec, handleTeamMemberList),
    withHandler(memberInviteSpec, handleTeamMemberInvite),
    withHandler(memberAddSpec, handleTeamMemberAdd),
    withHandler(memberRemoveSpec, handleTeamMemberRemove),
  ] as const,
} as const);

export const teamCommand = defineCommand({
  name: "team",
  summary: "Manage teams and team-scoped membership lifecycle",
  description:
    "Admin-side team surface. Team membership is always nested under one organization.",
  group: "Global",
  expandInRootHelp: true,
  options: [] as const,
  positionals: [] as const,
  subcommands: [
    withHandler(createSpec, handleTeamCreate),
    withHandler(listSpec, handleTeamList),
    withHandler(showSpec, handleTeamShow),
    memberSpec,
  ] as const,
} as const);

type CreateSpec = typeof createSpec;
type ListSpec = typeof listSpec;
type ShowSpec = typeof showSpec;
type MemberListSpec = typeof memberListSpec;
type MemberInviteSpec = typeof memberInviteSpec;
type MemberAddSpec = typeof memberAddSpec;
type MemberRemoveSpec = typeof memberRemoveSpec;

async function handleTeamCreate({
  args,
}: Parameters<CommandHandlerFor<CreateSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: "/v1/auth/teams",
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      slug: args.positionals.slug,
      org: args.options.org,
      ...(args.options.name ? { name: args.options.name } : {}),
    },
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  return writeSuccess({
    json: args.options.json === true,
    human: `Created team ${args.positionals.slug}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleTeamList({
  args,
}: Parameters<CommandHandlerFor<ListSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: "/v1/auth/teams",
    brokerUrl: args.options.brokerUrl,
    query: {
      org: args.options.org,
    },
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  const teams = Array.isArray(response.value.teams) ? response.value.teams : [];
  return writeSuccess({
    json: args.options.json === true,
    human:
      teams.length > 0
        ? `Found ${teams.length} team${teams.length === 1 ? "" : "s"}.`
        : "No teams found.",
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleTeamShow({
  args,
}: Parameters<CommandHandlerFor<ShowSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/teams/${encodeURIComponent(args.positionals.team)}`,
    brokerUrl: args.options.brokerUrl,
    query: {
      org: args.options.org,
    },
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  return writeSuccess({
    json: args.options.json === true,
    human: `Loaded team ${args.positionals.team}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleTeamMemberList({
  args,
}: Parameters<CommandHandlerFor<MemberListSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/teams/${encodeURIComponent(args.positionals.team)}/members`,
    brokerUrl: args.options.brokerUrl,
    query: {
      org: args.options.org,
      state: args.options.state,
    },
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  return writeSuccess({
    json: args.options.json === true,
    human: `Loaded membership state for team ${args.positionals.team}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleTeamMemberInvite({
  args,
}: Parameters<CommandHandlerFor<MemberInviteSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/teams/${encodeURIComponent(args.positionals.team)}/members/invite`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      target: args.positionals.target,
      org: args.options.org,
    },
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  return writeSuccess({
    json: args.options.json === true,
    human: `Created pending team invite for ${args.positionals.target}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleTeamMemberAdd({
  args,
}: Parameters<CommandHandlerFor<MemberAddSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/teams/${encodeURIComponent(args.positionals.team)}/members/add`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      target: args.positionals.target,
      org: args.options.org,
    },
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  return writeSuccess({
    json: args.options.json === true,
    human: `Granted team access to ${args.positionals.target}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleTeamMemberRemove({
  args,
}: Parameters<CommandHandlerFor<MemberRemoveSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/teams/${encodeURIComponent(args.positionals.team)}/members/remove`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      target: args.positionals.target,
      org: args.options.org,
    },
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  return writeSuccess({
    json: args.options.json === true,
    human: `Removed team access for ${args.positionals.target}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

function writeSuccess(input: {
  readonly json: boolean;
  readonly human: string;
  readonly payload: Record<string, unknown>;
}): number {
  if (input.json) {
    process.stdout.write(`${JSON.stringify(input.payload, null, 2)}\n`);
  } else {
    logger.success({ message: input.human });
  }
  return 0;
}

function writeFailure(input: {
  readonly json: boolean;
  readonly error: string;
  readonly brokerBaseUrl: string;
  readonly loginRequired: boolean;
}): number {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: input.error,
          brokerBaseUrl: input.brokerBaseUrl,
          loginRequired: input.loginRequired,
        },
        null,
        2
      )}\n`
    );
  } else {
    logger.error({ message: input.error });
  }
  return 1;
}
