import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { requestHackAuthBroker } from "../lib/auth-broker-client.ts";
import {
  deleteHackAuthSession,
  fetchHackAuthMe,
  type HackAuthMeResponse,
  type HackAuthSession,
  loadHackAuthSession,
  pollHackAuthSessionFlow,
  resolveHackAuthBrokerBaseUrl,
  saveHackAuthSession,
  startHackAuthSessionFlow,
} from "../lib/auth-session.ts";
import { openUrl } from "../lib/os.ts";
import { logger } from "../ui/logger.ts";

const optNoOpen = defineOption({
  name: "noOpen",
  type: "boolean",
  long: "--no-open",
  description: "Print the browser URL instead of opening it automatically",
} as const);

const optBrokerUrl = defineOption({
  name: "brokerUrl",
  type: "string",
  long: "--broker-url",
  valueHint: "<url>",
  description: "Override the Hack auth broker base URL",
} as const);

const optRedirect = defineOption({
  name: "redirect",
  type: "string",
  long: "--redirect",
  valueHint: "<url>",
  description: "Return to this URL after browser sign-in finishes",
} as const);

const loginSpec = defineCommand({
  name: "login",
  summary: "Open a browser and sign in to Hack auth",
  group: "Integrations",
  options: [optJson, optNoOpen, optBrokerUrl, optRedirect] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const logoutSpec = defineCommand({
  name: "logout",
  summary: "Clear the locally stored Hack auth session",
  group: "Integrations",
  options: [optJson] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const statusSpec = defineCommand({
  name: "status",
  summary: "Show whether Hack auth is configured locally",
  group: "Integrations",
  options: [optJson, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const whoamiSpec = defineCommand({
  name: "whoami",
  summary: "Resolve the current Hack auth identity via the broker",
  group: "Integrations",
  options: [optJson, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const inviteIdPositionals = [{ name: "inviteId", required: true }] as const;

const invitesSpec = defineCommand({
  name: "invites",
  summary: "List pending invitations for the authenticated user",
  description:
    "Recipient-side membership lifecycle entry point. Lists pending org and team invites so the authenticated user can accept or decline them explicitly.",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const inviteAcceptSpec = defineCommand({
  name: "accept",
  summary: "Accept a pending invitation and activate membership",
  description:
    "Moves a pending org or team invite to active membership for the authenticated user.",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: inviteIdPositionals,
  subcommands: [] as const,
} as const);

const inviteDeclineSpec = defineCommand({
  name: "decline",
  summary: "Decline a pending invitation and mark it removed",
  description:
    "Moves a pending org or team invite to the removed audit state for the authenticated user.",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: inviteIdPositionals,
  subcommands: [] as const,
} as const);

const inviteSpec = defineCommand({
  name: "invite",
  summary: "Act on a specific invitation",
  description:
    "Recipient-side invitation actions. Acceptance and decline stay under auth so admins cannot implicitly activate access for someone else.",
  group: "Global",
  options: [] as const,
  positionals: [] as const,
  subcommands: [
    withHandler(inviteAcceptSpec, handleAuthInviteAccept),
    withHandler(inviteDeclineSpec, handleAuthInviteDecline),
  ] as const,
} as const);

export const authCommand = defineCommand({
  name: "auth",
  summary: "Manage Hack account sign-in",
  group: "Integrations",
  expandInRootHelp: false,
  options: [] as const,
  positionals: [] as const,
  subcommands: [
    withHandler(loginSpec, handleAuthLogin),
    withHandler(logoutSpec, handleAuthLogout),
    withHandler(statusSpec, handleAuthStatus),
    withHandler(whoamiSpec, handleAuthWhoami),
    withHandler(invitesSpec, handleAuthInvites),
    inviteSpec,
  ] as const,
} as const);

type LoginSpec = typeof loginSpec;
type LogoutSpec = typeof logoutSpec;
type StatusSpec = typeof statusSpec;
type WhoamiSpec = typeof whoamiSpec;
type InvitesSpec = typeof invitesSpec;
type InviteAcceptSpec = typeof inviteAcceptSpec;
type InviteDeclineSpec = typeof inviteDeclineSpec;

async function handleAuthLogin({
  args,
}: Parameters<CommandHandlerFor<LoginSpec>>[0]): Promise<number> {
  const brokerBaseUrl = resolveHackAuthBrokerBaseUrl({
    override: args.options.brokerUrl,
  });
  const start = await startHackAuthSessionFlow({
    baseUrl: brokerBaseUrl,
    redirectUrl: args.options.redirect,
  });
  if (!start.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: start.error,
    });
  }

  if (args.options.noOpen) {
    logger.info({
      message: `Open this URL to continue Hack auth login: ${start.value.authorizeUrl}`,
    });
  } else {
    const openExitCode = await openUrl(start.value.authorizeUrl);
    if (openExitCode !== 0) {
      return writeFailure({
        json: args.options.json === true,
        error:
          "Failed to open a browser for Hack auth login. Re-run with --no-open and open the URL manually.",
      });
    }
  }

  const claimed = await pollHackAuthSessionFlow({
    baseUrl: brokerBaseUrl,
    flowId: start.value.flowId,
    ...(start.value.deviceCode ? { deviceCode: start.value.deviceCode } : {}),
    ...(start.value.pollUrl ? { pollUrl: start.value.pollUrl } : {}),
    ...(start.value.expiresAt ? { expiresAt: start.value.expiresAt } : {}),
  });
  if (!claimed.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: claimed.error,
    });
  }

  await saveHackAuthSession({
    session: claimed.value,
  });

  const me = await fetchHackAuthMe({
    baseUrl: brokerBaseUrl,
    token: claimed.value.token,
  });
  const identityPayload = me.ok
    ? buildAuthIdentityPayload({
        response: me.value,
      })
    : {};
  const loginHuman =
    me.ok && me.value.authenticated === true
      ? renderWhoamiSummary({
          response: me.value,
        })
      : "Hack auth session stored.";

  return writeSuccess({
    json: args.options.json === true,
    human: loginHuman,
    payload: {
      ok: true,
      authenticated: true,
      validated: me.ok && me.value.authenticated === true,
      brokerBaseUrl,
      flowId: start.value.flowId,
      authorizeUrl: start.value.authorizeUrl,
      tokenStored: true,
      loginRequired: false,
      ...identityPayload,
      ...(me.ok
        ? {}
        : {
            warning: `Hack auth session was stored, but broker identity could not be resolved yet: ${me.error}`,
          }),
      ...(claimed.value.expiresAt
        ? { expiresAt: claimed.value.expiresAt }
        : {}),
    },
  });
}

async function handleAuthLogout({
  args,
}: Parameters<CommandHandlerFor<LogoutSpec>>[0]): Promise<number> {
  const hadToken = await deleteHackAuthSession();
  return writeSuccess({
    json: args.options.json === true,
    human: hadToken
      ? "Hack auth session cleared."
      : "No Hack auth session was stored.",
    payload: {
      ok: true,
      loggedOut: true,
      hadToken,
    },
  });
}

async function handleAuthStatus({
  args,
}: Parameters<CommandHandlerFor<StatusSpec>>[0]): Promise<number> {
  const brokerBaseUrl = resolveHackAuthBrokerBaseUrl({
    override: args.options.brokerUrl,
  });
  let stored: HackAuthSession | null;
  try {
    stored = await loadHackAuthSession();
  } catch (error) {
    return writeFailure({
      json: args.options.json === true,
      error: toErrorMessage(error),
    });
  }

  if (!stored) {
    return writeSuccess({
      json: args.options.json === true,
      human: "Not authenticated with Hack auth. Run `hack auth login`.",
      payload: {
        ok: true,
        authenticated: false,
        tokenStored: false,
        validated: false,
        loginRequired: true,
        nextStep: "Run `hack auth login`.",
        brokerBaseUrl,
      },
    });
  }

  const me = await fetchHackAuthMe({
    baseUrl: brokerBaseUrl,
    token: stored.token,
  });
  if (!me.ok) {
    return writeSuccess({
      json: args.options.json === true,
      human: `Hack auth token is stored locally, but broker validation failed: ${me.error} Run \`hack auth login\` if the session expired.`,
      payload: {
        ok: true,
        authenticated: false,
        tokenStored: true,
        validated: false,
        loginRequired: true,
        nextStep: "Run `hack auth login` if the stored session is stale.",
        brokerBaseUrl,
        error: me.error,
        ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
      },
    });
  }

  return writeSuccess({
    json: args.options.json === true,
    human: me.value.authenticated
      ? renderAuthStatusSummary({
          response: me.value,
        })
      : "Hack auth token is stored, but no authenticated broker session was resolved. Run `hack auth login` again.",
    payload: {
      ok: true,
      authenticated: me.value.authenticated === true,
      tokenStored: true,
      validated: true,
      loginRequired: me.value.authenticated !== true,
      ...(me.value.authenticated === true
        ? {}
        : {
            nextStep: "Run `hack auth login` again.",
          }),
      brokerBaseUrl,
      ...buildAuthIdentityPayload({
        response: me.value,
      }),
      ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
    },
  });
}

async function handleAuthWhoami({
  args,
}: Parameters<CommandHandlerFor<WhoamiSpec>>[0]): Promise<number> {
  const brokerBaseUrl = resolveHackAuthBrokerBaseUrl({
    override: args.options.brokerUrl,
  });
  let stored: HackAuthSession | null;
  try {
    stored = await loadHackAuthSession();
  } catch (error) {
    return writeFailure({
      json: args.options.json === true,
      error: toErrorMessage(error),
    });
  }
  if (!stored) {
    return writeFailure({
      json: args.options.json === true,
      error: "No stored Hack auth session. Run `hack auth login` first.",
      payload: {
        loginRequired: true,
        nextStep: "Run `hack auth login` first.",
      },
    });
  }

  const me = await fetchHackAuthMe({
    baseUrl: brokerBaseUrl,
    token: stored.token,
  });
  if (!me.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: me.error,
      payload: {
        loginRequired: true,
        nextStep: "Run `hack auth login` if the stored session is stale.",
      },
    });
  }
  if (me.value.authenticated !== true) {
    return writeFailure({
      json: args.options.json === true,
      error:
        "Stored Hack auth token is not authenticated anymore. Run `hack auth login` again.",
      payload: {
        loginRequired: true,
        nextStep: "Run `hack auth login` again.",
      },
    });
  }

  return writeSuccess({
    json: args.options.json === true,
    human: renderWhoamiSummary({
      response: me.value,
    }),
    payload: {
      ...me.value,
      brokerBaseUrl,
      ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
    },
  });
}

async function handleAuthInvites({
  args,
}: Parameters<CommandHandlerFor<InvitesSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: "/v1/auth/invitations",
    brokerUrl: args.options.brokerUrl,
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      payload: {
        brokerBaseUrl: response.brokerBaseUrl,
        loginRequired: response.loginRequired,
      },
    });
  }

  const invitations = Array.isArray(response.value.invitations)
    ? response.value.invitations
    : [];
  return writeSuccess({
    json: args.options.json === true,
    human:
      invitations.length > 0
        ? `Found ${invitations.length} pending Hack auth invitation${invitations.length === 1 ? "" : "s"}.`
        : "No pending Hack auth invitations.",
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleAuthInviteAccept({
  args,
}: Parameters<CommandHandlerFor<InviteAcceptSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/invitations/${encodeURIComponent(args.positionals.inviteId)}/accept`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      payload: {
        brokerBaseUrl: response.brokerBaseUrl,
        loginRequired: response.loginRequired,
      },
    });
  }

  return writeSuccess({
    json: args.options.json === true,
    human: "Invitation accepted.",
    payload: {
      ...response.value,
      brokerBaseUrl: response.brokerBaseUrl,
    },
  });
}

async function handleAuthInviteDecline({
  args,
}: Parameters<CommandHandlerFor<InviteDeclineSpec>>[0]): Promise<number> {
  const response = await requestHackAuthBroker({
    path: `/v1/auth/invitations/${encodeURIComponent(args.positionals.inviteId)}/decline`,
    method: "POST",
    brokerUrl: args.options.brokerUrl,
  });
  if (!response.ok) {
    return writeFailure({
      json: args.options.json === true,
      error: response.error,
      payload: {
        brokerBaseUrl: response.brokerBaseUrl,
        loginRequired: response.loginRequired,
      },
    });
  }

  return writeSuccess({
    json: args.options.json === true,
    human: "Invitation declined.",
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
    logger.success({
      message: input.human,
    });
  }
  return 0;
}

function writeFailure(input: {
  readonly json: boolean;
  readonly error: string;
  readonly payload?: Record<string, unknown>;
}): number {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: input.error,
          ...(input.payload ?? {}),
        },
        null,
        2
      )}\n`
    );
  } else {
    logger.error({
      message: input.error,
    });
  }
  return 1;
}

function renderWhoamiSummary(input: {
  readonly response: HackAuthMeResponse;
}): string {
  const session = input.response.session;
  const userLabel = formatHackAuthUserLabel({
    response: input.response,
  });
  const orgLabel = formatHackAuthOrgLabel({
    response: input.response,
  });
  const teamLabel = formatHackAuthTeamLabel({
    response: input.response,
  });
  const details: string[] = [];
  if (orgLabel) {
    details.push(`org: ${orgLabel}`);
  }
  if (teamLabel) {
    details.push(`team: ${teamLabel}`);
  }
  if (input.response.accessControlMode) {
    details.push(`mode: ${input.response.accessControlMode}`);
  }
  if (session || userLabel || orgLabel || teamLabel) {
    const headline = userLabel
      ? `Signed in to Hack auth as ${userLabel}`
      : "Signed in to Hack auth";
    return details.length > 0
      ? `${headline} (${details.join(", ")})`
      : headline;
  }
  return "Hack auth session is authenticated, but no session metadata was returned.";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function buildAuthIdentityPayload(input: {
  readonly response: HackAuthMeResponse;
}): Record<string, unknown> {
  return {
    accessControlMode: input.response.accessControlMode ?? null,
    session: input.response.session ?? null,
    ...(input.response.user ? { user: input.response.user } : {}),
    ...(input.response.activeOrganization
      ? { activeOrganization: input.response.activeOrganization }
      : {}),
    ...(input.response.activeTeam
      ? { activeTeam: input.response.activeTeam }
      : {}),
    shellPath:
      typeof input.response.shellPath === "string"
        ? input.response.shellPath
        : "/auth",
    accountPath:
      typeof input.response.accountPath === "string"
        ? input.response.accountPath
        : "/auth/account",
  };
}

function renderAuthStatusSummary(input: {
  readonly response: HackAuthMeResponse;
}): string {
  return renderWhoamiSummary({
    response: input.response,
  });
}

function formatHackAuthUserLabel(input: {
  readonly response: HackAuthMeResponse;
}): string | null {
  const name =
    typeof input.response.user?.name === "string"
      ? input.response.user.name.trim()
      : "";
  const email =
    typeof input.response.user?.email === "string"
      ? input.response.user.email.trim()
      : "";
  if (name && email) {
    return `${name} <${email}>`;
  }
  if (email) {
    return email;
  }
  if (name) {
    return name;
  }
  const userId =
    typeof input.response.session?.userId === "string"
      ? input.response.session.userId.trim()
      : "";
  return userId || null;
}

function formatHackAuthOrgLabel(input: {
  readonly response: HackAuthMeResponse;
}): string | null {
  const name =
    typeof input.response.activeOrganization?.name === "string"
      ? input.response.activeOrganization.name.trim()
      : "";
  const slug =
    typeof input.response.activeOrganization?.slug === "string"
      ? input.response.activeOrganization.slug.trim()
      : "";
  if (name) {
    return slug && slug !== name ? `${name} (${slug})` : name;
  }
  if (slug) {
    return slug;
  }
  const orgId =
    typeof input.response.session?.organizationId === "string"
      ? input.response.session.organizationId.trim()
      : "";
  return orgId || null;
}

function formatHackAuthTeamLabel(input: {
  readonly response: HackAuthMeResponse;
}): string | null {
  const name =
    typeof input.response.activeTeam?.name === "string"
      ? input.response.activeTeam.name.trim()
      : "";
  const slug =
    typeof input.response.activeTeam?.slug === "string"
      ? input.response.activeTeam.slug.trim()
      : "";
  if (name) {
    return slug && slug !== name ? `${name} (${slug})` : name;
  }
  if (slug) {
    return slug;
  }
  const teamId =
    typeof input.response.session?.teamId === "string"
      ? input.response.session.teamId.trim()
      : "";
  return teamId || null;
}
