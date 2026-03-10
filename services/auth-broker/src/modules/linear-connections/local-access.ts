import { refreshAccessToken } from "../../linear.ts";
import type {
  LinearConnectionStore,
  LinearStoredLocalAccess,
} from "./service.ts";

const TOKEN_REFRESH_WINDOW_MS = 60_000;

export type SeedLinearLocalAccessResult =
  | {
      readonly ok: true;
      readonly profileId: string;
      readonly accountName: string | null;
      readonly accountEmail: string | null;
      readonly token: string;
      readonly tokenExpiresAt?: string;
      readonly refreshToken?: string;
      readonly refreshTokenExpiresAt?: string;
      readonly refreshed: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly statusCode: number;
    };

export async function persistLinearLocalAccessCustody(input: {
  readonly config: {
    readonly providerTokenEncryptionKey?: string;
  };
  readonly connectionStore: LinearConnectionStore;
  readonly profileId: string;
  readonly token?: string | null;
  readonly tokenExpiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly refreshTokenExpiresAt?: string | null;
}) {
  const encryptionKey = input.config.providerTokenEncryptionKey?.trim() ?? "";
  if (!encryptionKey) {
    return {
      ok: false as const,
      error: "provider_token_custody_not_configured",
      statusCode: 503,
    };
  }
  try {
    const connection = await input.connectionStore.saveLocalAccess({
      profileId: input.profileId,
      token: input.token,
      tokenExpiresAt: input.tokenExpiresAt,
      refreshToken: input.refreshToken,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt,
      encryptionKey,
    });
    return {
      ok: true as const,
      connection,
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      statusCode: 500,
    };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Local-access seeding preserves the full refresh-and-rehydrate flow, including custody persistence and operator-facing error mapping.
export async function seedLinearLocalAccess(input: {
  readonly config: {
    readonly providerTokenEncryptionKey?: string;
    readonly linearTokenUrl: string;
    readonly linearClientId?: string;
    readonly linearClientSecret?: string;
  };
  readonly connectionStore: LinearConnectionStore;
  readonly profileId: string;
}): Promise<SeedLinearLocalAccessResult> {
  const encryptionKey = input.config.providerTokenEncryptionKey?.trim() ?? "";
  if (!encryptionKey) {
    return {
      ok: false,
      error: "provider_token_custody_not_configured",
      statusCode: 503,
    };
  }
  let stored: LinearStoredLocalAccess | null = null;
  try {
    stored = await input.connectionStore.readLocalAccess({
      profileId: input.profileId,
      encryptionKey,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      statusCode: 500,
    };
  }
  if (!stored) {
    return {
      ok: false,
      error: "linear_local_access_unavailable",
      statusCode: 404,
    };
  }

  let envelope = stored.envelope;
  let refreshed = false;
  if (shouldRefreshEnvelope({ envelope })) {
    const refreshToken = envelope.refreshToken?.trim() ?? "";
    if (!refreshToken) {
      return {
        ok: false,
        error: "linear_local_access_refresh_required",
        statusCode: 409,
      };
    }
    const refreshedToken = await refreshAccessToken({
      tokenUrl: input.config.linearTokenUrl,
      clientId: input.config.linearClientId ?? "",
      ...(input.config.linearClientSecret
        ? { clientSecret: input.config.linearClientSecret }
        : {}),
      refreshToken,
    });
    if (!refreshedToken.ok) {
      return {
        ok: false,
        error: refreshedToken.error,
        statusCode: refreshedToken.statusCode,
      };
    }
    const persisted = await persistLinearLocalAccessCustody({
      config: input.config,
      connectionStore: input.connectionStore,
      profileId: input.profileId,
      token: refreshedToken.token,
      tokenExpiresAt: refreshedToken.tokenExpiresAt,
      refreshToken: refreshedToken.refreshToken ?? envelope.refreshToken,
      refreshTokenExpiresAt:
        refreshedToken.refreshTokenExpiresAt ?? envelope.refreshTokenExpiresAt,
    });
    if (!persisted.ok) {
      return persisted;
    }
    envelope =
      (
        await input.connectionStore.readLocalAccess({
          profileId: input.profileId,
          encryptionKey,
        })
      )?.envelope ?? envelope;
    refreshed = true;
  }

  const token = envelope.token?.trim() ?? "";
  if (!token) {
    return {
      ok: false,
      error: "linear_local_access_unavailable",
      statusCode: 409,
    };
  }

  return {
    ok: true,
    profileId: stored.connection.profileId ?? input.profileId,
    accountName: stored.connection.accountName,
    accountEmail: stored.connection.accountEmail,
    token,
    ...(envelope.tokenExpiresAt
      ? { tokenExpiresAt: envelope.tokenExpiresAt }
      : {}),
    ...(envelope.refreshToken ? { refreshToken: envelope.refreshToken } : {}),
    ...(envelope.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: envelope.refreshTokenExpiresAt }
      : {}),
    refreshed,
  };
}

function shouldRefreshEnvelope(input: {
  readonly envelope: {
    readonly token?: string;
    readonly tokenExpiresAt?: string;
    readonly refreshToken?: string;
  };
}): boolean {
  if (!input.envelope.refreshToken) {
    return false;
  }
  if (!input.envelope.token) {
    return true;
  }
  const expiresAtMs = parseTimestampMs(input.envelope.tokenExpiresAt);
  if (expiresAtMs === null) {
    return false;
  }
  return expiresAtMs <= Date.now() + TOKEN_REFRESH_WINDOW_MS;
}

function parseTimestampMs(value?: string): number | null {
  if (!(typeof value === "string" && value.trim().length > 0)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
