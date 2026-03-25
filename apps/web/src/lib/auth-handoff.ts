import { isTrustedAuthOrigin } from "@hack/auth-contract";

const SAFE_RETURN_PROTOCOLS = new Set(["hack:", "hack-dev:"]);

export function normalizeAppReturnUrl(input: {
  readonly value?: string | null;
  readonly appBaseUrl: string;
  readonly trustedOrigins: readonly string[];
}): string | null {
  const value = input.value?.trim();
  if (!value) {
    return null;
  }
  try {
    if (value.startsWith("/")) {
      return new URL(value, ensureTrailingSlash(input.appBaseUrl)).toString();
    }
    const candidate = new URL(value, ensureTrailingSlash(input.appBaseUrl));
    if (SAFE_RETURN_PROTOCOLS.has(candidate.protocol)) {
      return candidate.toString();
    }
    const appOrigin = new URL(input.appBaseUrl).origin;
    if (candidate.origin === appOrigin) {
      return candidate.toString();
    }
    return isTrustedAuthOrigin({
      origin: candidate.origin,
      trustedOrigins: input.trustedOrigins,
    })
      ? candidate.toString()
      : null;
  } catch {
    return null;
  }
}

export function shouldAutoNavigateToReturnUrl(input: {
  readonly value: string | null;
}): boolean {
  if (!input.value) {
    return false;
  }
  try {
    const protocol = new URL(input.value).protocol;
    return (
      SAFE_RETURN_PROTOCOLS.has(protocol) ||
      protocol === "http:" ||
      protocol === "https:"
    );
  } catch {
    return false;
  }
}

export function buildBrokerAccountBridgeUrl(input: {
  readonly authBrokerBaseUrl: string;
  readonly appBaseUrl: string;
  readonly flowId?: string | null;
  readonly deviceCode?: string | null;
  readonly finalReturnUrl?: string | null;
}): string {
  const appAccountUrl = new URL(
    "/auth/account",
    ensureTrailingSlash(input.appBaseUrl)
  );
  if (input.flowId) {
    appAccountUrl.searchParams.set("flowId", input.flowId);
  }
  if (input.deviceCode) {
    appAccountUrl.searchParams.set("deviceCode", input.deviceCode);
  }
  if (input.finalReturnUrl) {
    appAccountUrl.searchParams.set("redirect", input.finalReturnUrl);
  }

  const brokerAccountUrl = new URL(
    "/auth/account",
    ensureTrailingSlash(input.authBrokerBaseUrl)
  );
  brokerAccountUrl.searchParams.set("bridge", "1");
  if (input.flowId) {
    brokerAccountUrl.searchParams.set("flowId", input.flowId);
  }
  if (input.deviceCode) {
    brokerAccountUrl.searchParams.set("deviceCode", input.deviceCode);
  }
  brokerAccountUrl.searchParams.set("redirect", appAccountUrl.toString());
  return brokerAccountUrl.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
