import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import { type NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest) {
  const redirectTarget = normalizeRedirectTarget({
    value: request.nextUrl.searchParams.get("redirect"),
  });
  const response = NextResponse.redirect(new URL(redirectTarget, request.url));
  response.cookies.set({
    name: HACK_WEB_BROKER_SESSION_COOKIE_NAME,
    value: "",
    expires: new Date(0),
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
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
