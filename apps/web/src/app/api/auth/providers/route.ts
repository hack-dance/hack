import { type NextRequest, NextResponse } from "next/server";

import { buildAuthBrokerProxyUrl, getWebAuthConfig } from "@/lib/auth-config";

export async function GET(_request: NextRequest) {
  const config = getWebAuthConfig();
  const response = await fetch(
    buildAuthBrokerProxyUrl({
      authBrokerProxyBaseUrl: config.authBrokerProxyBaseUrl,
      path: "/v1/auth/providers",
    }),
    {
      headers: {
        accept: "application/json",
      },
      cache: "no-store",
    }
  );
  const rawText = await response.text();

  return new NextResponse(rawText, {
    status: response.status,
    headers: {
      "cache-control": "no-store",
      "content-type":
        response.headers.get("content-type") ??
        "application/json; charset=utf-8",
    },
  });
}
