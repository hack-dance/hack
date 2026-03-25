import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import { cookies } from "next/headers";

import { getWebAuthConfig } from "./auth-config";

const REPO_ROOT = resolve(process.cwd(), "../..");
const STATUS_COMMAND = "./dist/hack linear status --json";
const PROFILES_COMMAND = "./dist/hack linear profiles --json";
const CONNECTIONS_COMMAND = "./dist/hack linear connections --json";
const STATUS_ARGS = ["index.ts", "linear", "status", "--json"] as const;
const PROFILES_ARGS = ["index.ts", "linear", "profiles", "--json"] as const;
const execFileAsync = promisify(execFile);

type LinearCommandEnvironment = Record<string, string | undefined>;

export type LinearRepairAction = {
  readonly reason: string;
  readonly command: string;
};

export type LinearProfileSummary = {
  readonly id: string;
  readonly isDefault: boolean;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnv: string;
  readonly apiUrl: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly accountEmail?: string;
};

type LinearProjectBindingTarget = {
  readonly profileId?: string;
  readonly projectId: string;
  readonly projectName?: string;
  readonly teamId?: string;
};

type LinearProjectBindingPayload = {
  readonly ok: true;
  readonly profileId: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly teamId: string | null;
  readonly additionalProjects: readonly LinearProjectBindingTarget[];
};

type LinearStatusCommandPayload = {
  readonly extensionId: string;
  readonly selectedProfile: string;
  readonly selectedSource: string;
  readonly defaultProfile: string;
  readonly selectedMissing: boolean;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnvFallback: string;
  readonly apiUrl: string;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly accountEmail: string | null;
  readonly tokenResolved: boolean;
  readonly tokenSource: string | null;
  readonly tokenExpiresAt: string | null;
  readonly error: string | null;
  readonly profileError: string | null;
  readonly ok: boolean;
  readonly projectBinding: LinearProjectBindingPayload;
  readonly summary: {
    readonly activeProfile: string;
    readonly connected: boolean;
    readonly connectionLabel: string;
    readonly routingSummary: string;
    readonly linkedProjectsLabel: string | null;
    readonly capabilities: readonly string[];
    readonly repair: LinearRepairAction | null;
    readonly nextSteps: readonly string[];
  };
  readonly audit?: {
    readonly statusUpdates: {
      readonly draftCount: number;
      readonly publishedCount: number;
      readonly drafts?: readonly {
        readonly title: string;
        readonly path: string;
        readonly state: "draft" | "published";
        readonly linearId?: string;
        readonly date?: string;
        readonly publishedAt?: string;
        readonly updatedAt?: string;
        readonly health?: string;
      }[];
      readonly latestPublished: {
        readonly title: string;
        readonly path: string;
        readonly state?: "draft" | "published";
        readonly linearId?: string;
        readonly date?: string;
        readonly publishedAt?: string;
        readonly updatedAt?: string;
        readonly health?: string;
      } | null;
    };
    readonly delivery: {
      readonly path: string;
      readonly projectId?: string;
      readonly projectIds?: readonly string[];
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
      readonly deliveries: readonly {
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
      }[];
    } | null;
  } | null;
};

type LinearProfilesPayload = {
  readonly defaultProfileId: string;
  readonly selectedProfileId: string;
  readonly selectedProfileSource: string;
  readonly selectedProfileMissing: boolean;
  readonly projectProfileOverride?: string;
  readonly profiles: readonly LinearProfileSummary[];
};

type LinearConnectionSummary = {
  readonly id: string;
  readonly profileId: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly accountEmail: string | null;
  readonly authRef: string | null;
  readonly betterAuthUserId: string | null;
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly localAccessAvailable: boolean;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type BrokerListConnectionsPayload = {
  readonly accessControlMode?: string;
  readonly connections: readonly LinearConnectionSummary[];
};

type CommandRunner = <TPayload>(input: {
  readonly args: readonly string[];
}) => Promise<{
  readonly payload: TPayload | null;
  readonly output: string;
}>;

export type LinearBoundProject = {
  readonly projectId: string;
  readonly projectName?: string;
  readonly teamId?: string;
  readonly label: string;
};

export type LinearManagementState = {
  readonly extensionEnabled: boolean;
  readonly selectedProfile: string;
  readonly selectedSource: string;
  readonly defaultProfile: string;
  readonly projectOverride?: string;
  readonly selectedMissing: boolean;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnvFallback: string;
  readonly apiUrl: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly accountEmail?: string;
  readonly tokenResolved: boolean;
  readonly tokenSource?: string;
  readonly tokenExpiresAt?: string;
  readonly profileError?: string;
  readonly error?: string;
  readonly profiles: readonly LinearProfileSummary[];
  readonly projectBinding: {
    readonly profileId: string | null;
    readonly defaultProject: LinearBoundProject | null;
    readonly additionalProjects: readonly LinearBoundProject[];
  };
  readonly summary: LinearStatusCommandPayload["summary"];
  readonly hackConnection: {
    readonly inspectable: boolean;
    readonly loaded: boolean;
    readonly connected: boolean;
    readonly localAccessAvailable: boolean;
    readonly accessibleConnectionCount: number;
    readonly ownerLabel: string | null;
    readonly accountLabel: string;
    readonly summary: string;
    readonly detail: string;
  };
  readonly localAccess: {
    readonly ready: boolean;
    readonly summary: string;
    readonly detail: string;
  };
  readonly repair: {
    readonly title: string;
    readonly reason: string;
    readonly command: string;
  } | null;
  readonly accessControlMode?: string;
  readonly audit: LinearStatusCommandPayload["audit"];
  readonly statusCommand: string;
  readonly profilesCommand: string;
  readonly connectionsCommand: string;
};

export async function loadLinearManagementState(input?: {
  readonly token?: string | null;
  readonly authBrokerProxyBaseUrl?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly runCommandImplementation?: CommandRunner;
}): Promise<LinearManagementState> {
  const runCommandImplementation =
    input?.runCommandImplementation ?? runLinearJsonCommand;
  const [statusResult, profilesResult] = await Promise.all([
    runCommandImplementation<LinearStatusCommandPayload>({
      args: STATUS_ARGS,
    }),
    runCommandImplementation<LinearProfilesPayload>({
      args: PROFILES_ARGS,
    }),
  ]);

  if (!statusResult.payload) {
    return createFallbackLinearManagementState({
      output: statusResult.output,
    });
  }

  const token =
    input?.token === undefined
      ? await readBrokerSessionTokenFromCookies()
      : input.token;
  const authBrokerProxyBaseUrl =
    input?.authBrokerProxyBaseUrl ?? getWebAuthConfig().authBrokerProxyBaseUrl;
  const connectionsResult = token
    ? await fetchLinearConnections({
        authBrokerProxyBaseUrl,
        fetchImplementation: input?.fetchImplementation ?? fetch,
        profileId: statusResult.payload.selectedProfile,
        token,
      })
    : { loaded: false, payload: null };

  return buildLinearManagementState({
    status: statusResult.payload,
    profiles: profilesResult.payload,
    connections: connectionsResult.payload,
    canInspectHackConnection: Boolean(token),
    connectionsLoaded: connectionsResult.loaded,
  });
}

export function buildLinearManagementState(input: {
  readonly status: LinearStatusCommandPayload;
  readonly profiles?: LinearProfilesPayload | null;
  readonly connections?: BrokerListConnectionsPayload | null;
  readonly canInspectHackConnection: boolean;
  readonly connectionsLoaded?: boolean;
}): LinearManagementState {
  const binding = normalizeLinearBinding({
    binding: input.status.projectBinding,
  });
  const selectedConnection =
    input.connections?.connections.find((connection) => {
      return (
        normalizeIdentifier(connection.profileId) ===
        normalizeIdentifier(input.status.selectedProfile)
      );
    }) ?? null;
  const hackConnection = buildHackConnectionState({
    activeProfile: input.status.selectedProfile,
    canInspectHackConnection: input.canInspectHackConnection,
    connectionsLoaded: input.connectionsLoaded ?? Boolean(input.connections),
    selectedConnection,
    tokenResolved: input.status.tokenResolved,
  });
  const repair = buildLinearRepairState({
    activeProfile: input.status.selectedProfile,
    canInspectHackConnection: input.canInspectHackConnection,
    connectionsLoaded: input.connectionsLoaded ?? Boolean(input.connections),
    selectedConnection,
    summaryRepair: input.status.summary.repair,
    tokenEnvFallback: input.status.tokenEnvFallback,
    tokenResolved: input.status.tokenResolved,
  });

  return {
    extensionEnabled: input.status.extensionId === "dance.hack.linear",
    selectedProfile: input.status.selectedProfile,
    selectedSource: input.status.selectedSource,
    defaultProfile:
      input.profiles?.defaultProfileId ?? input.status.defaultProfile,
    ...(input.profiles?.projectProfileOverride
      ? { projectOverride: input.profiles.projectProfileOverride }
      : {}),
    selectedMissing: input.status.selectedMissing,
    authRef: input.status.authRef,
    service: input.status.service,
    tokenEnvFallback: input.status.tokenEnvFallback,
    apiUrl: input.status.apiUrl,
    ...(input.status.accountId ? { accountId: input.status.accountId } : {}),
    ...(input.status.accountName
      ? { accountName: input.status.accountName }
      : {}),
    ...(input.status.accountEmail
      ? { accountEmail: input.status.accountEmail }
      : {}),
    tokenResolved: input.status.tokenResolved,
    ...(input.status.tokenSource
      ? { tokenSource: input.status.tokenSource }
      : {}),
    ...(input.status.tokenExpiresAt
      ? { tokenExpiresAt: input.status.tokenExpiresAt }
      : {}),
    ...(input.status.profileError
      ? { profileError: input.status.profileError }
      : {}),
    ...(input.status.error ? { error: input.status.error } : {}),
    profiles: input.profiles?.profiles ?? [],
    projectBinding: binding,
    summary: input.status.summary,
    hackConnection,
    localAccess: {
      ready: input.status.tokenResolved,
      summary: input.status.tokenResolved
        ? `Local Linear access is ready on this machine${input.status.tokenSource ? ` via ${input.status.tokenSource}` : ""}.`
        : "Local Linear access needs repair on this machine.",
      detail:
        repair?.reason ??
        input.status.error ??
        "The active profile resolved a usable local token.",
    },
    repair,
    ...(input.connections?.accessControlMode
      ? { accessControlMode: input.connections.accessControlMode }
      : {}),
    audit: input.status.audit ?? null,
    statusCommand: STATUS_COMMAND,
    profilesCommand: PROFILES_COMMAND,
    connectionsCommand: CONNECTIONS_COMMAND,
  };
}

export function buildLinearCommandEnvironment(input?: {
  readonly env?: LinearCommandEnvironment;
}): LinearCommandEnvironment {
  const env = input?.env ?? process.env;
  return {
    ...env,
    HACK_LINEAR_PREFER_ENV_TOKEN_ONLY:
      env.HACK_LINEAR_PREFER_ENV_TOKEN_ONLY ?? "true",
  };
}

async function runLinearJsonCommand<TPayload>(input: {
  readonly args: readonly string[];
}): Promise<{
  readonly payload: TPayload | null;
  readonly output: string;
}> {
  try {
    const result = await execFileAsync("bun", input.args, {
      cwd: REPO_ROOT,
      env: buildLinearCommandEnvironment() as typeof process.env,
    });
    const output = result.stdout.trim();
    return {
      payload: parseJsonPayload<TPayload>({ output }),
      output,
    };
  } catch (error) {
    const output = readCommandOutput({ error });
    return {
      payload: parseJsonPayload<TPayload>({ output }),
      output,
    };
  }
}

async function fetchLinearConnections(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly fetchImplementation: typeof fetch;
  readonly profileId: string;
  readonly token: string;
}): Promise<{
  readonly loaded: boolean;
  readonly payload: BrokerListConnectionsPayload | null;
}> {
  try {
    const url = new URL(
      "/v1/auth/linear/connections",
      input.authBrokerProxyBaseUrl
    );
    url.searchParams.set("profileId", input.profileId);
    const response = await input.fetchImplementation(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
      },
    });
    if (!response.ok) {
      return { loaded: false, payload: null };
    }
    return {
      loaded: true,
      payload: parseConnectionsPayload({
        payload: (await response.json()) as unknown,
      }),
    };
  } catch {
    return { loaded: false, payload: null };
  }
}

function normalizeLinearBinding(input: {
  readonly binding: LinearProjectBindingPayload;
}): LinearManagementState["projectBinding"] {
  const defaultProject = input.binding.projectId
    ? createBoundProject({
        projectId: input.binding.projectId,
        projectName: input.binding.projectName ?? undefined,
        teamId: input.binding.teamId ?? undefined,
      })
    : null;
  const seenProjectIds = new Set<string>();
  if (defaultProject) {
    seenProjectIds.add(defaultProject.projectId.toLowerCase());
  }

  const additionalProjects: LinearBoundProject[] = [];
  for (const project of input.binding.additionalProjects) {
    const key = project.projectId.toLowerCase();
    if (seenProjectIds.has(key)) {
      continue;
    }
    seenProjectIds.add(key);
    additionalProjects.push(
      createBoundProject({
        projectId: project.projectId,
        ...(project.projectName ? { projectName: project.projectName } : {}),
        ...(project.teamId ? { teamId: project.teamId } : {}),
      })
    );
  }

  return {
    profileId: input.binding.profileId,
    defaultProject,
    additionalProjects,
  };
}

function createBoundProject(input: {
  readonly projectId: string;
  readonly projectName?: string;
  readonly teamId?: string;
}): LinearBoundProject {
  return {
    projectId: input.projectId,
    ...(input.projectName ? { projectName: input.projectName } : {}),
    ...(input.teamId ? { teamId: input.teamId } : {}),
    label: formatLinearProjectLabel(input),
  };
}

function formatLinearProjectLabel(input: {
  readonly projectId: string;
  readonly projectName?: string;
  readonly teamId?: string;
}): string {
  const projectLabel = input.projectName
    ? `${input.projectName} (${input.projectId})`
    : input.projectId;
  return input.teamId
    ? `${projectLabel} in team ${input.teamId}`
    : projectLabel;
}

function buildHackConnectionState(input: {
  readonly activeProfile: string;
  readonly canInspectHackConnection: boolean;
  readonly connectionsLoaded: boolean;
  readonly selectedConnection: LinearConnectionSummary | null;
  readonly tokenResolved: boolean;
}): LinearManagementState["hackConnection"] {
  if (!input.canInspectHackConnection) {
    return {
      inspectable: false,
      loaded: false,
      connected: false,
      localAccessAvailable: false,
      accessibleConnectionCount: 0,
      ownerLabel: null,
      accountLabel: "Sign in to inspect",
      summary: "Sign in to compare Hack-owned access with local Linear access.",
      detail:
        "Hack only exposes broker-owned Linear connections for the current browser account session.",
    };
  }

  if (!input.connectionsLoaded) {
    return {
      inspectable: true,
      loaded: false,
      connected: false,
      localAccessAvailable: false,
      accessibleConnectionCount: 0,
      ownerLabel: null,
      accountLabel: "Unavailable",
      summary: "Hack-owned Linear connection state is unavailable right now.",
      detail:
        "Refresh this page after reauthenticating if the Hack-owned connection state still does not load.",
    };
  }

  if (!input.selectedConnection) {
    return {
      inspectable: true,
      loaded: true,
      connected: false,
      localAccessAvailable: false,
      accessibleConnectionCount: 0,
      ownerLabel: null,
      accountLabel: "No Hack-owned connection",
      summary: `Hack does not have a broker-owned Linear connection for profile "${input.activeProfile}".`,
      detail: input.tokenResolved
        ? "This machine can still use Linear locally, but broker-owned repair and delivery flows stay unavailable until Hack claims the active profile."
        : "Hack and this machine both need Linear access repair for the active profile.",
    };
  }

  return {
    inspectable: true,
    loaded: true,
    connected: true,
    localAccessAvailable: input.selectedConnection.localAccessAvailable,
    accessibleConnectionCount: 1,
    ownerLabel: describeConnectionOwner(input.selectedConnection),
    accountLabel:
      input.selectedConnection.accountName ??
      input.selectedConnection.accountEmail ??
      input.selectedConnection.accountId ??
      "Connected account",
    summary: `Hack has a broker-owned Linear connection for profile "${input.activeProfile}".`,
    detail: input.selectedConnection.localAccessAvailable
      ? "Protected local access is stored on Hack and can be reseeded onto this machine if needed."
      : "Hack knows this profile, but it cannot reseed protected local access onto this machine yet.",
  };
}

function buildLinearRepairState(input: {
  readonly activeProfile: string;
  readonly canInspectHackConnection: boolean;
  readonly connectionsLoaded: boolean;
  readonly selectedConnection: LinearConnectionSummary | null;
  readonly summaryRepair: LinearRepairAction | null;
  readonly tokenEnvFallback: string;
  readonly tokenResolved: boolean;
}): LinearManagementState["repair"] {
  const reconnectCommand = `hack linear connect --profile ${input.activeProfile}`;
  const envOnlyRepairCommand = `export ${input.tokenEnvFallback}=<linear-token>`;

  if (
    input.canInspectHackConnection &&
    input.connectionsLoaded &&
    !input.selectedConnection &&
    input.tokenResolved
  ) {
    return {
      title: "Connect this profile on Hack",
      reason:
        "This machine can use Linear, but Hack does not have a broker-owned connection for the active profile yet.",
      command: reconnectCommand,
    };
  }

  if (!input.summaryRepair) {
    return null;
  }

  if (
    (input.summaryRepair.command === reconnectCommand ||
      input.summaryRepair.command === envOnlyRepairCommand) &&
    input.selectedConnection?.localAccessAvailable
  ) {
    return {
      title: "Seed local access from Hack",
      reason:
        "Hack already has protected local access for this profile; reseed it on this machine instead of reconnecting.",
      command: `hack linear seed-local-access --profile ${input.activeProfile}`,
    };
  }

  if (
    (input.summaryRepair.command === reconnectCommand ||
      input.summaryRepair.command === envOnlyRepairCommand) &&
    input.selectedConnection &&
    !input.selectedConnection.localAccessAvailable
  ) {
    return {
      title: "Reconnect local Linear access",
      reason:
        "Hack already knows this profile, but this machine still needs fresh protected local access stored locally.",
      command: reconnectCommand,
    };
  }

  return {
    title: describeRepairTitle({
      command: input.summaryRepair.command,
    }),
    reason: input.summaryRepair.reason,
    command: input.summaryRepair.command,
  };
}

function describeRepairTitle(input: { readonly command: string }): string {
  if (input.command === "hack auth login") {
    return "Refresh Hack account access";
  }
  if (input.command.startsWith("export ")) {
    return "Set the env token";
  }
  if (input.command.startsWith("hack linear setup")) {
    return "Fix the active Linear profile binding";
  }
  if (input.command.startsWith("hack linear connect")) {
    return "Connect Linear for this profile";
  }
  return "Repair the active Linear state";
}

function describeConnectionOwner(input: LinearConnectionSummary): string {
  if (input.betterAuthTeamId) {
    return `team:${input.betterAuthTeamId}`;
  }
  if (input.betterAuthOrganizationId) {
    return `org:${input.betterAuthOrganizationId}`;
  }
  if (input.betterAuthUserId) {
    return `user:${input.betterAuthUserId}`;
  }
  return "legacy";
}

function parseConnectionsPayload(input: {
  readonly payload: unknown;
}): BrokerListConnectionsPayload | null {
  if (!(typeof input.payload === "object" && input.payload !== null)) {
    return null;
  }
  const payload = input.payload as {
    readonly accessControlMode?: unknown;
    readonly connections?: unknown;
  };
  if (!Array.isArray(payload.connections)) {
    return null;
  }
  return {
    ...(typeof payload.accessControlMode === "string"
      ? { accessControlMode: payload.accessControlMode }
      : {}),
    connections: payload.connections
      .map((value) => parseConnectionSummary({ value }))
      .filter((value): value is LinearConnectionSummary => value !== null),
  };
}

function parseConnectionSummary(input: {
  readonly value: unknown;
}): LinearConnectionSummary | null {
  if (!(typeof input.value === "object" && input.value !== null)) {
    return null;
  }
  const value = input.value as Record<string, unknown>;
  const id = readOptionalString(value.id);
  const createdAt = readOptionalString(value.createdAt);
  const updatedAt = readOptionalString(value.updatedAt);
  if (!(id && createdAt && updatedAt)) {
    return null;
  }
  return {
    id,
    profileId: readOptionalString(value.profileId) ?? null,
    accountId: readOptionalString(value.accountId) ?? null,
    accountName: readOptionalString(value.accountName) ?? null,
    accountEmail: readOptionalString(value.accountEmail) ?? null,
    authRef: readOptionalString(value.authRef) ?? null,
    betterAuthUserId: readOptionalString(value.betterAuthUserId) ?? null,
    betterAuthOrganizationId:
      readOptionalString(value.betterAuthOrganizationId) ?? null,
    betterAuthTeamId: readOptionalString(value.betterAuthTeamId) ?? null,
    organizationId: readOptionalString(value.organizationId) ?? null,
    teamId: readOptionalString(value.teamId) ?? null,
    localAccessAvailable: value.localAccessAvailable === true,
    metadata:
      typeof value.metadata === "object" && value.metadata !== null
        ? (value.metadata as Record<string, unknown>)
        : {},
    createdAt,
    updatedAt,
  };
}

function createFallbackLinearManagementState(input: {
  readonly output: string;
}): LinearManagementState {
  const repairReason =
    input.output || "The repo-bound Linear status command did not return JSON.";
  return {
    extensionEnabled: false,
    selectedProfile: "default",
    selectedSource: "implicit_default",
    defaultProfile: "default",
    selectedMissing: false,
    authRef: "linear.api.default",
    service: "hack-linear-auth",
    tokenEnvFallback: "HACK_LINEAR_API_TOKEN",
    apiUrl: "https://api.linear.app/graphql",
    tokenResolved: false,
    profiles: [],
    projectBinding: {
      profileId: null,
      defaultProject: null,
      additionalProjects: [],
    },
    summary: {
      activeProfile: "default",
      connected: false,
      connectionLabel: "Not connected",
      routingSummary:
        "This repo does not have a default Linear project route yet.",
      linkedProjectsLabel: null,
      capabilities: [],
      repair: {
        reason: repairReason,
        command: STATUS_COMMAND,
      },
      nextSteps: [`Run \`${STATUS_COMMAND}\`.`],
    },
    hackConnection: {
      inspectable: false,
      loaded: false,
      connected: false,
      localAccessAvailable: false,
      accessibleConnectionCount: 0,
      ownerLabel: null,
      accountLabel: "Unavailable",
      summary: "Hack-owned Linear state is unavailable right now.",
      detail: repairReason,
    },
    localAccess: {
      ready: false,
      summary: "Local Linear access needs repair on this machine.",
      detail: repairReason,
    },
    repair: {
      title: "Inspect repo-bound Linear status",
      reason: repairReason,
      command: STATUS_COMMAND,
    },
    audit: null,
    statusCommand: STATUS_COMMAND,
    profilesCommand: PROFILES_COMMAND,
    connectionsCommand: CONNECTIONS_COMMAND,
  };
}

function parseJsonPayload<TPayload>(input: {
  readonly output: string;
}): TPayload | null {
  const output = input.output.trim();
  if (!output.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(output) as TPayload;
  } catch {
    return null;
  }
}

function readCommandOutput(input: { readonly error: unknown }): string {
  if (
    input.error &&
    typeof input.error === "object" &&
    "stdout" in input.error &&
    typeof input.error.stdout === "string"
  ) {
    return input.error.stdout.trim();
  }
  if (input.error instanceof Error) {
    return input.error.message;
  }
  return "";
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  return readOptionalString(value)?.toLowerCase() ?? null;
}

async function readBrokerSessionTokenFromCookies(): Promise<string | null> {
  const cookieStore = await cookies();
  return (
    cookieStore.get(HACK_WEB_BROKER_SESSION_COOKIE_NAME)?.value.trim() || null
  );
}
