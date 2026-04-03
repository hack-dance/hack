import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import { cookies } from "next/headers";

import { buildAuthBrokerProxyUrl, getWebAuthConfig } from "./auth-config";

type BrokerMePayload = {
  readonly ok?: boolean;
  readonly authenticated?: boolean;
  readonly user?: {
    readonly id?: string | null;
  } | null;
};

export async function hasAuthenticatedBrowserSession(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const token = normalizeText(
      cookieStore.get(HACK_WEB_BROKER_SESSION_COOKIE_NAME)?.value
    );
    if (!token) {
      return false;
    }

    return await resolveAuthenticatedBrowserSession({
      authBrokerProxyBaseUrl: getWebAuthConfig().authBrokerProxyBaseUrl,
      token,
    });
  } catch {
    return false;
  }
}

export async function resolveAuthenticatedBrowserSession(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly token: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<boolean> {
  try {
    const response = await (input.fetchImplementation ?? fetch)(
      buildAuthBrokerProxyUrl({
        authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
        path: "/v1/auth/me",
      }),
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.token}`,
        },
        cache: "no-store",
      }
    );
    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as BrokerMePayload;
    return (
      payload.ok === true &&
      payload.authenticated === true &&
      Boolean(normalizeText(payload.user?.id))
    );
  } catch {
    return false;
  }
}

function normalizeText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
