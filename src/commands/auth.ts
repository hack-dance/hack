import type { CommandHandlerFor } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
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

const loginSpec = defineCommand({
  name: "login",
  summary: "Open a browser and sign in to Hack auth",
  group: "Global",
  options: [optJson, optNoOpen, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const logoutSpec = defineCommand({
  name: "logout",
  summary: "Clear the locally stored Hack auth session",
  group: "Global",
  options: [optJson] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const statusSpec = defineCommand({
  name: "status",
  summary: "Show whether Hack auth is configured locally",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

const whoamiSpec = defineCommand({
  name: "whoami",
  summary: "Resolve the current Hack auth identity via the broker",
  group: "Global",
  options: [optJson, optBrokerUrl] as const,
  positionals: [] as const,
  subcommands: [] as const,
} as const);

export const authCommand = defineCommand({
  name: "auth",
  summary: "Manage Hack auth sessions",
  group: "Global",
  expandInRootHelp: true,
  options: [] as const,
  positionals: [] as const,
  subcommands: [
    withHandler(loginSpec, handleAuthLogin),
    withHandler(logoutSpec, handleAuthLogout),
    withHandler(statusSpec, handleAuthStatus),
    withHandler(whoamiSpec, handleAuthWhoami),
  ] as const,
} as const);

type LoginSpec = typeof loginSpec;
type LogoutSpec = typeof logoutSpec;
type StatusSpec = typeof statusSpec;
type WhoamiSpec = typeof whoamiSpec;

async function handleAuthLogin({
  args,
}: Parameters<CommandHandlerFor<LoginSpec>>[0]): Promise<number> {
  const brokerBaseUrl = resolveHackAuthBrokerBaseUrl({
    override: args.options.brokerUrl,
  });
  const start = await startHackAuthSessionFlow({
    baseUrl: brokerBaseUrl,
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

  return writeSuccess({
    json: args.options.json === true,
    human: "Hack auth session stored.",
    payload: {
      ok: true,
      authenticated: true,
      brokerBaseUrl,
      flowId: start.value.flowId,
      authorizeUrl: start.value.authorizeUrl,
      tokenStored: true,
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
      human: "Not authenticated with Hack auth.",
      payload: {
        ok: true,
        authenticated: false,
        tokenStored: false,
        validated: false,
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
      human: `Hack auth token is stored locally, but broker validation failed: ${me.error}`,
      payload: {
        ok: true,
        authenticated: false,
        tokenStored: true,
        validated: false,
        brokerBaseUrl,
        error: me.error,
        ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
      },
    });
  }

  return writeSuccess({
    json: args.options.json === true,
    human: me.value.authenticated
      ? "Hack auth session is valid."
      : "Hack auth token is stored, but no authenticated broker session was resolved.",
    payload: {
      ok: true,
      authenticated: me.value.authenticated === true,
      tokenStored: true,
      validated: true,
      brokerBaseUrl,
      accessControlMode: me.value.accessControlMode ?? null,
      session: me.value.session ?? null,
      ...(typeof me.value.user === "object" && me.value.user !== null
        ? { user: me.value.user }
        : {}),
      ...(typeof me.value.activeOrganization === "object" &&
      me.value.activeOrganization !== null
        ? { activeOrganization: me.value.activeOrganization }
        : {}),
      ...(typeof me.value.activeTeam === "object" &&
      me.value.activeTeam !== null
        ? { activeTeam: me.value.activeTeam }
        : {}),
      shellPath:
        typeof me.value.shellPath === "string" ? me.value.shellPath : "/auth",
      accountPath:
        typeof me.value.accountPath === "string"
          ? me.value.accountPath
          : "/auth/account",
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
    });
  }
  if (me.value.authenticated !== true) {
    return writeFailure({
      json: args.options.json === true,
      error:
        "Stored Hack auth token is not authenticated anymore. Run `hack auth login` again.",
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
}): number {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: input.error,
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
  if (!session) {
    return "Hack auth session is authenticated, but no session metadata was returned.";
  }

  const details = [
    `user=${session.userId ?? "unknown"}`,
    `org=${session.organizationId ?? "none"}`,
    `team=${session.teamId ?? "none"}`,
  ];
  if (input.response.accessControlMode) {
    details.push(`mode=${input.response.accessControlMode}`);
  }
  return `Hack auth: ${details.join(", ")}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
