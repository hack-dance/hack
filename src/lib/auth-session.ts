import { isRecord } from "./guards.ts";
import { resolveSecretStore, type SecretStore } from "./secret-store.ts";

const DEFAULT_AUTH_BROKER_URL = "https://auth.hack.broker";
const DEFAULT_AUTH_BROKER_URL_ENV = "HACK_AUTH_BROKER_URL";
const AUTH_SESSION_PROJECT_NAME = "hack-auth";
const AUTH_SESSION_SECRET_KEY = "hack.auth.session";
const TRAILING_SLASH_REGEX = /\/+$/;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

export type HackAuthSession = {
  readonly token: string;
  readonly expiresAt?: string;
};

export type HackAuthStartFlow = {
  readonly flowId: string;
  readonly authorizeUrl: string;
  readonly deviceCode?: string;
  readonly pollUrl?: string;
  readonly expiresAt?: string;
};

export type HackAuthMeResponse = {
  readonly ok: boolean;
  readonly authenticated?: boolean;
  readonly accessControlMode?: string;
  readonly session?: {
    readonly userId?: string;
    readonly organizationId?: string | null;
    readonly teamId?: string | null;
    readonly managementTokenProfileId?: string | null;
  } | null;
  readonly shellPath?: string;
  readonly accountPath?: string;
} & Record<string, unknown>;

type BrokerResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type AuthSecretStore = Pick<SecretStore, "get" | "set" | "delete">;
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/**
 * Resolve the Hack auth broker base URL from CLI flags or environment.
 */
export function resolveHackAuthBrokerBaseUrl(input?: {
  readonly override?: string;
}): string {
  const raw =
    input?.override?.trim() ||
    process.env[DEFAULT_AUTH_BROKER_URL_ENV]?.trim() ||
    DEFAULT_AUTH_BROKER_URL;
  return raw.replace(TRAILING_SLASH_REGEX, "");
}

/**
 * Read the locally stored Hack auth broker management token.
 */
export async function loadHackAuthSession(input?: {
  readonly store?: AuthSecretStore;
}): Promise<HackAuthSession | null> {
  const store = input?.store ?? (await resolveHackAuthSecretStore());
  const raw = await store.get({
    key: AUTH_SESSION_SECRET_KEY,
  });
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Stored Hack auth session is invalid JSON. Run `hack auth logout` to clear it."
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.token !== "string" ||
    !parsed.token.trim()
  ) {
    throw new Error(
      "Stored Hack auth session is invalid. Run `hack auth logout` to clear it."
    );
  }
  return {
    token: parsed.token,
    ...(typeof parsed.expiresAt === "string" && parsed.expiresAt.trim()
      ? { expiresAt: parsed.expiresAt }
      : {}),
  };
}

/**
 * Persist the claimed Hack auth broker management token.
 */
export async function saveHackAuthSession(input: {
  readonly session: HackAuthSession;
  readonly store?: AuthSecretStore;
}): Promise<void> {
  const store = input.store ?? (await resolveHackAuthSecretStore());
  await store.set({
    key: AUTH_SESSION_SECRET_KEY,
    value: JSON.stringify(input.session),
  });
}

/**
 * Remove any stored Hack auth broker management token.
 */
export async function deleteHackAuthSession(input?: {
  readonly store?: AuthSecretStore;
}): Promise<boolean> {
  const store = input?.store ?? (await resolveHackAuthSecretStore());
  return await store.delete({
    key: AUTH_SESSION_SECRET_KEY,
  });
}

/**
 * Start a browser-driven Hack auth shell flow.
 */
export async function startHackAuthSessionFlow(input?: {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}): Promise<BrokerResult<HackAuthStartFlow>> {
  const baseUrl = resolveHackAuthBrokerBaseUrl({
    override: input?.baseUrl,
  });
  const response = await requestBrokerJson({
    url: `${baseUrl}/v1/auth/session/start`,
    routePath: "/v1/auth/session/start",
    fetchImpl: input?.fetchImpl,
  });
  if (!response.ok) {
    return response;
  }
  const parsed = parseStartFlowPayload({
    body: response.value,
    baseUrl,
  });
  if (!parsed.ok) {
    return parsed;
  }
  return parsed;
}

/**
 * Poll and claim a Hack auth shell flow until it yields a management token.
 */
export async function pollHackAuthSessionFlow(input: {
  readonly flowId: string;
  readonly baseUrl?: string;
  readonly deviceCode?: string;
  readonly pollUrl?: string;
  readonly expiresAt?: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}): Promise<BrokerResult<HackAuthSession>> {
  const baseUrl = resolveHackAuthBrokerBaseUrl({
    override: input.baseUrl,
  });
  const timeoutAtMs = resolvePollTimeoutAtMs({
    expiresAt: input.expiresAt,
    timeoutMs: input.timeoutMs,
  });

  while (Date.now() < timeoutAtMs) {
    const response = await requestBrokerJson({
      url: buildFlowStatusUrl({
        baseUrl,
        flowId: input.flowId,
        pollUrl: input.pollUrl,
        deviceCode: input.deviceCode,
      }),
      routePath: "/v1/auth/session/flows/:flowId",
      fetchImpl: input.fetchImpl,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `Hack auth broker status failed: ${response.error}`,
      };
    }

    const claimed = parseFlowClaimResult({
      body: response.value,
    });
    if (claimed.state === "claimed") {
      return {
        ok: true,
        value: claimed.session,
      };
    }
    if (claimed.state === "error") {
      return {
        ok: false,
        error: claimed.error,
      };
    }

    await Bun.sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    error: "Timed out waiting for Hack auth login to complete.",
  };
}

/**
 * Resolve the broker-side identity for the stored Hack auth management token.
 */
export async function fetchHackAuthMe(input: {
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}): Promise<BrokerResult<HackAuthMeResponse>> {
  const baseUrl = resolveHackAuthBrokerBaseUrl({
    override: input.baseUrl,
  });
  const response = await requestBrokerJson({
    url: `${baseUrl}/v1/auth/me`,
    routePath: "/v1/auth/me",
    fetchImpl: input.fetchImpl,
    init: {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.token}`,
      },
    },
  });
  if (!response.ok) {
    return response;
  }
  if (!isRecord(response.value)) {
    return {
      ok: false,
      error: "Hack auth broker returned an invalid /v1/auth/me response.",
    };
  }
  return {
    ok: true,
    value: response.value as HackAuthMeResponse,
  };
}

async function resolveHackAuthSecretStore(): Promise<AuthSecretStore> {
  return await resolveSecretStore({
    projectName: AUTH_SESSION_PROJECT_NAME,
  });
}

function parseStartFlowPayload(input: {
  readonly body: unknown;
  readonly baseUrl: string;
}): BrokerResult<HackAuthStartFlow> {
  if (!isRecord(input.body)) {
    return {
      ok: false,
      error:
        "Hack auth broker returned an invalid session-start response. Update auth-broker and retry.",
    };
  }
  const flowRecord = isRecord(input.body.flow) ? input.body.flow : input.body;
  const flowId = readOptionalString(flowRecord.flowId);
  const authorizeUrl = readOptionalString(flowRecord.authorizeUrl);
  if (!(flowId && authorizeUrl)) {
    return {
      ok: false,
      error:
        "Hack auth broker response was missing `flowId` or `authorizeUrl`. Update auth-broker and retry.",
    };
  }
  const pollUrl =
    readOptionalString(flowRecord.pollUrl) ??
    `${input.baseUrl}/v1/auth/session/flows/${encodeURIComponent(flowId)}`;
  return {
    ok: true,
    value: {
      flowId,
      authorizeUrl,
      ...(readOptionalString(flowRecord.deviceCode)
        ? { deviceCode: readOptionalString(flowRecord.deviceCode) }
        : {}),
      ...(pollUrl ? { pollUrl } : {}),
      ...(readOptionalString(flowRecord.expiresAt)
        ? { expiresAt: readOptionalString(flowRecord.expiresAt) }
        : {}),
    },
  };
}

function extractStatusRecord(input: {
  readonly body: unknown;
}): Record<string, unknown> {
  if (!isRecord(input.body)) {
    return {};
  }
  return isRecord(input.body.status) ? input.body.status : input.body;
}

function buildFlowStatusUrl(input: {
  readonly baseUrl: string;
  readonly flowId: string;
  readonly pollUrl?: string;
  readonly deviceCode?: string;
}): string {
  const statusUrl = new URL(
    input.pollUrl ??
      `/v1/auth/session/flows/${encodeURIComponent(input.flowId)}`,
    `${input.baseUrl}/`
  );
  statusUrl.searchParams.set("claim", "1");
  if (input.deviceCode) {
    statusUrl.searchParams.set("deviceCode", input.deviceCode);
  }
  return statusUrl.toString();
}

function parseFlowClaimResult(input: { readonly body: unknown }):
  | {
      readonly state: "claimed";
      readonly session: HackAuthSession;
    }
  | {
      readonly state: "pending";
    }
  | {
      readonly state: "error";
      readonly error: string;
    } {
  const statusRecord = extractStatusRecord({
    body: input.body,
  });
  const status = readOptionalString(statusRecord.status);
  if (!status) {
    return {
      state: "error",
      error:
        "Hack auth broker status response was missing `status`. Update auth-broker and retry.",
    };
  }
  if (status === "claimed") {
    const token =
      readOptionalString(statusRecord.managementToken) ??
      readOptionalString(statusRecord.token);
    if (!token) {
      return {
        state: "error",
        error:
          "Hack auth completed remotely, but the broker did not return a claimable token.",
      };
    }
    const expiresAt =
      readOptionalString(statusRecord.managementTokenExpiresAt) ??
      readOptionalString(statusRecord.tokenExpiresAt);
    return {
      state: "claimed",
      session: {
        token,
        ...(expiresAt ? { expiresAt } : {}),
      },
    };
  }
  if (status === "error") {
    return {
      state: "error",
      error:
        readOptionalString(statusRecord.error) ??
        "Hack auth broker reported an unrecoverable login error.",
    };
  }
  if (status === "expired") {
    return {
      state: "error",
      error: "Hack auth login timed out. Start the flow again.",
    };
  }
  return {
    state: "pending",
  };
}

async function requestBrokerJson(input: {
  readonly url: string;
  readonly routePath: string;
  readonly fetchImpl?: FetchLike;
  readonly init?: RequestInit;
}): Promise<BrokerResult<unknown>> {
  const fetchImpl: FetchLike =
    input.fetchImpl ?? ((resource, init) => fetch(resource, init));
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "GET",
      ...input.init,
      headers: {
        accept: "application/json",
        ...(input.init?.headers ?? {}),
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: `Unable to reach Hack auth broker route ${input.routePath}: ${toErrorMessage(error)}`,
    };
  }

  const body = await readJsonBody({
    response,
  });
  if (!response.ok) {
    const remoteMessage =
      isRecord(body) && readOptionalString(body.error)
        ? ` (${readOptionalString(body.error)})`
        : "";
    return {
      ok: false,
      error: `Hack auth broker route ${input.routePath} is unavailable or rejected the request (HTTP ${response.status})${remoteMessage}.`,
    };
  }

  return {
    ok: true,
    value: body,
  };
}

async function readJsonBody(input: {
  readonly response: Response;
}): Promise<unknown> {
  const text = await input.response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text,
    };
  }
}

function resolvePollTimeoutAtMs(input: {
  readonly expiresAt?: string;
  readonly timeoutMs?: number;
}): number {
  const defaultTimeoutAtMs =
    Date.now() + (input.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  if (!input.expiresAt) {
    return defaultTimeoutAtMs;
  }
  const expiresAtMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return defaultTimeoutAtMs;
  }
  return Math.min(defaultTimeoutAtMs, expiresAtMs);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
