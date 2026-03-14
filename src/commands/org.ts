import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { requestHackAuthBroker } from "../lib/auth-broker-client.ts";
import { logger } from "../ui/logger.ts";

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

const optTeam = defineOption({
  name: "team",
  type: "string",
  long: "--team",
  valueHint: "<team>",
  description: "Seed one or more team-scoped invites alongside the org invite",
} as const);

const optBrokerUrl = defineOption({
  name: "brokerUrl",
  type: "string",
  long: "--broker-url",
  valueHint: "<url>",
  description: "Override the Hack auth broker base URL",
} as const);

const orgPositionals = [{ name: "org", required: true }] as const;
const orgSlugPositionals = [{ name: "slug", required: true }] as const;
const orgMemberTargetPositionals = [
  { name: "org", required: true },
  { name: "target", required: true },
] as const;

const createSpec = defineCommand({
  name: "create",
  summary: "Create an organization without creating any teams implicitly",
  description:
    "Creates the organization record and makes the caller the initial active org admin.",
  group: "Global",
  options: [optName, optJson, optBrokerUrl] as const,
  positionals: orgSlugPositionals,
  subcommands: [] as const,
} as const);

const listSpec = defineCommand({
  name: "list",
  summary: "List organizations visible to the authenticated user",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const showSpec = defineCommand({
  name: "show",
  summary: "Show one organization and its current membership context",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: orgPositionals,
  subcommands: [] as const,
} as const);

const memberListSpec = defineCommand({
  name: "list",
  summary: "List org members and pending invites",
  description:
    "Defaults to actionable memberships; use --state removed or --state all for audit history.",
  group: "Global",
  options: [optState, optJson, optBrokerUrl] as const,
  positionals: orgPositionals,
  subcommands: [] as const,
} as const);

const memberInviteSpec = defineCommand({
  name: "invite",
  summary: "Create pending org membership for an email address",
  description:
    "Creates pending access only. Existing accounts still stay pending until the recipient accepts.",
  group: "Global",
  options: [optTeam, optJson, optBrokerUrl] as const,
  positionals: orgMemberTargetPositionals,
  subcommands: [] as const,
} as const);

const memberAddSpec = defineCommand({
  name: "add",
  summary: "Grant active org membership immediately to an existing user",
  description:
    "Requires a resolvable Hack user identity. Use invite when the target does not already exist.",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: orgMemberTargetPositionals,
  subcommands: [] as const,
} as const);

const memberRemoveSpec = defineCommand({
  name: "remove",
  summary: "Remove org membership or cancel a pending org invite",
  description:
    "Admin-side revoke verb. Removing org access also removes matching team memberships and invites in that organization.",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: orgMemberTargetPositionals,
  subcommands: [] as const,
} as const);

const memberSpec = defineCommand({
  name: "member",
  summary: "Manage org memberships and invitation lifecycle",
  group: "Global",
  options: [] as const,
  positionals: [] as const,
  subcommands: [
    withHandler(memberListSpec, handleOrgMemberList),
    withHandler(memberInviteSpec, handleOrgMemberInvite),
    withHandler(memberAddSpec, handleOrgMemberAdd),
    withHandler(memberRemoveSpec, handleOrgMemberRemove),
  ] as const,
} as const);

export const orgCommand = defineCommand({
  name: "org",
  summary: "Manage organizations and org-scoped membership lifecycle",
  description:
    "Admin-side organization surface. Org membership is the parent grant for team access.",
  group: "Global",
  expandInRootHelp: true,
  options: [] as const,
  positionals: [] as const,
  subcommands: [
    withHandler(createSpec, handleOrgCreate),
    withHandler(listSpec, handleOrgList),
    withHandler(showSpec, handleOrgShow),
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

async function handleOrgCreate({
  args,
}: Parameters<CommandHandlerFor<CreateSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: "/v1/auth/orgs",
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      slug: args.positionals.slug,
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
    human: `Created organization ${args.positionals.slug}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleOrgList({
  args,
}: Parameters<CommandHandlerFor<ListSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: "/v1/auth/orgs",
    brokerUrl: args.options.brokerUrl,
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      brokerBaseUrl: response.brokerBaseUrl,
      loginRequired: response.loginRequired,
    });
  }
  const organizations = Array.isArray(response.value.organizations)
    ? response.value.organizations
    : [];
  return writeSuccess({
    json: args.options.json === true,
    human:
      organizations.length > 0
        ? `Found ${organizations.length} organization${organizations.length === 1 ? "" : "s"}.`
        : "No organizations found.",
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleOrgShow({
  args,
}: Parameters<CommandHandlerFor<ShowSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/orgs/${encodeURIComponent(args.positionals.org)}`,
    brokerUrl: args.options.brokerUrl,
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
    human: `Loaded organization ${args.positionals.org}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleOrgMemberList({
  args,
}: Parameters<CommandHandlerFor<MemberListSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/orgs/${encodeURIComponent(args.positionals.org)}/members`,
    brokerUrl: args.options.brokerUrl,
    query: {
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
    human: `Loaded membership state for org ${args.positionals.org}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleOrgMemberInvite({
  args,
}: Parameters<CommandHandlerFor<MemberInviteSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/orgs/${encodeURIComponent(args.positionals.org)}/members/invite`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      target: args.positionals.target,
      ...(args.options.team ? { teams: [args.options.team] } : {}),
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
    human: `Created pending org invite for ${args.positionals.target}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleOrgMemberAdd({
  args,
}: Parameters<CommandHandlerFor<MemberAddSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/orgs/${encodeURIComponent(args.positionals.org)}/members/add`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      target: args.positionals.target,
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
    human: `Granted org access to ${args.positionals.target}.`,
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleOrgMemberRemove({
  args,
}: Parameters<CommandHandlerFor<MemberRemoveSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/orgs/${encodeURIComponent(args.positionals.org)}/members/remove`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
    body: {
      target: args.positionals.target,
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
    human: `Removed org access for ${args.positionals.target}.`,
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
