import { createHmac, timingSafeEqual } from "node:crypto";

const MANAGEMENT_TOKEN_VERSION = 1 as const;
const DEFAULT_MANAGEMENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MANAGEMENT_TOKEN_TYPE = "hack_linear_management" as const;

export type BrokerManagementTokenClaims = {
  readonly typ: typeof MANAGEMENT_TOKEN_TYPE;
  readonly v: typeof MANAGEMENT_TOKEN_VERSION;
  readonly sub: string;
  readonly profileId?: string;
  readonly organizationId?: string;
  readonly teamId?: string;
  readonly iat: number;
  readonly exp: number;
};

/**
 * Issue a signed broker management token for non-browser clients that still
 * need Better Auth-owned access to protected Linear broker routes.
 */
export function issueBrokerManagementToken(input: {
  readonly userId: string;
  readonly profileId?: string | null;
  readonly organizationId?: string | null;
  readonly teamId?: string | null;
  readonly nowMs?: number;
  readonly expiresInMs?: number;
}): { readonly token: string; readonly expiresAt: string } | null {
  const secret = resolveManagementTokenSecret();
  const userId = normalizeOptionalString(input.userId);
  if (!(secret && userId)) {
    return null;
  }
  const nowMs = input.nowMs ?? Date.now();
  const expiresInMs = Math.max(
    input.expiresInMs ?? DEFAULT_MANAGEMENT_TOKEN_TTL_MS,
    60_000
  );
  const claims: BrokerManagementTokenClaims = {
    typ: MANAGEMENT_TOKEN_TYPE,
    v: MANAGEMENT_TOKEN_VERSION,
    sub: userId,
    ...(normalizeOptionalString(input.profileId)
      ? { profileId: normalizeOptionalString(input.profileId) ?? undefined }
      : {}),
    ...(normalizeOptionalString(input.organizationId)
      ? {
          organizationId:
            normalizeOptionalString(input.organizationId) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalString(input.teamId)
      ? { teamId: normalizeOptionalString(input.teamId) ?? undefined }
      : {}),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor((nowMs + expiresInMs) / 1000),
  };
  const header = {
    alg: "HS256",
    typ: MANAGEMENT_TOKEN_TYPE,
    v: MANAGEMENT_TOKEN_VERSION,
  } as const;
  const encodedHeader = encodeBase64UrlJson(header);
  const encodedPayload = encodeBase64UrlJson(claims);
  const signedContent = `${encodedHeader}.${encodedPayload}`;
  const signature = signToken({
    secret,
    content: signedContent,
  });
  return {
    token: `${signedContent}.${signature}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

/**
 * Verify a broker management token and return the claims if the token is
 * correctly signed and not expired.
 */
export function verifyBrokerManagementToken(input: {
  readonly token: string;
  readonly nowMs?: number;
}):
  | { readonly ok: true; readonly claims: BrokerManagementTokenClaims }
  | { readonly ok: false; readonly error: string } {
  const secret = resolveManagementTokenSecret();
  const token = normalizeOptionalString(input.token);
  if (!secret) {
    return {
      ok: false,
      error: "management_token_secret_missing",
    };
  }
  if (!token) {
    return {
      ok: false,
      error: "management_token_missing",
    };
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      error: "management_token_invalid",
    };
  }
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] =
    parts;
  const signedContent = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = signToken({
    secret,
    content: signedContent,
  });
  if (!safeSignatureEquals(encodedSignature, expectedSignature)) {
    return {
      ok: false,
      error: "management_token_invalid",
    };
  }
  const parsedClaims = parseClaims({
    value: decodeBase64UrlJson(encodedPayload),
  });
  if (!parsedClaims) {
    return {
      ok: false,
      error: "management_token_invalid",
    };
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (parsedClaims.exp <= nowSeconds) {
    return {
      ok: false,
      error: "management_token_expired",
    };
  }
  return {
    ok: true,
    claims: parsedClaims,
  };
}

function resolveManagementTokenSecret(): string | null {
  return (
    normalizeOptionalString(process.env.BETTER_AUTH_SECRET) ??
    normalizeOptionalString(process.env.AUTH_SECRET) ??
    null
  );
}

function signToken(input: {
  readonly secret: string;
  readonly content: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(input.content, "utf8")
    .digest("base64url");
}

function safeSignatureEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeBase64UrlJson(value: string): unknown {
  try {
    return JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown;
  } catch {
    return null;
  }
}

function parseClaims(input: {
  readonly value: unknown;
}): BrokerManagementTokenClaims | null {
  if (!(typeof input.value === "object" && input.value !== null)) {
    return null;
  }
  const record = input.value as Record<string, unknown>;
  const typ = normalizeOptionalString(record.typ);
  const sub = normalizeOptionalString(record.sub);
  const profileId = normalizeOptionalString(record.profileId);
  const organizationId = normalizeOptionalString(record.organizationId);
  const teamId = normalizeOptionalString(record.teamId);
  const iat = readPositiveInteger(record.iat);
  const exp = readPositiveInteger(record.exp);
  if (
    !(
      typ === MANAGEMENT_TOKEN_TYPE &&
      record.v === MANAGEMENT_TOKEN_VERSION &&
      sub &&
      iat !== null &&
      exp !== null
    )
  ) {
    return null;
  }
  return {
    typ: MANAGEMENT_TOKEN_TYPE,
    v: MANAGEMENT_TOKEN_VERSION,
    sub,
    ...(profileId ? { profileId } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(teamId ? { teamId } : {}),
    iat,
    exp,
  };
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
