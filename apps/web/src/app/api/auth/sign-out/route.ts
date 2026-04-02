import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import { type NextRequest, NextResponse } from "next/server";

const IP_ADDRESS_PATTERN =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?:[a-f0-9]*:){2,}[a-f0-9]*)$/i;

export function GET(request: NextRequest) {
  const redirectTarget = normalizeRedirectTarget({
    value: request.nextUrl.searchParams.get("redirect"),
  });
  const response = NextResponse.redirect(new URL(redirectTarget, request.url));
  const cookieTarget = resolveBrokerSessionCookieTarget({
    requestUrl: request.url,
  });
  response.cookies.set({
    name: HACK_WEB_BROKER_SESSION_COOKIE_NAME,
    value: "",
    expires: new Date(0),
    httpOnly: true,
    domain: cookieTarget.domain ?? undefined,
    path: "/",
    sameSite: "lax",
    secure: cookieTarget.secure,
  });
  return response;
}

function normalizeRedirectTarget(input: {
  readonly value: string | null;
}): string {
  if (input.value?.startsWith("/") && !input.value.startsWith("//")) {
    return input.value;
  }

  return "/auth";
}

function resolveBrokerSessionCookieTarget(input: {
  readonly requestUrl: string;
}): {
  readonly domain: string | null;
  readonly secure: boolean;
} {
  const requestUrl = new URL(input.requestUrl);
  return {
    domain: resolveCookieDomain({ host: requestUrl.hostname }),
    secure: requestUrl.protocol === "https:",
  };
}

function resolveCookieDomain(input: { readonly host: string }): string | null {
  const host = input.host.trim();
  if (!host || host === "localhost" || isIpAddress({ value: host })) {
    return null;
  }
  return host;
}

function isIpAddress(input: { readonly value: string }): boolean {
  return IP_ADDRESS_PATTERN.test(input.value);
}
