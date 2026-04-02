import { type NextRequest, NextResponse } from "next/server";

import { getWebAuthConfig } from "@/lib/auth-config";

export async function GET(
  request: NextRequest,
  context: {
    readonly params: Promise<{
      readonly flowId: string;
    }>;
  }
) {
  const { flowId } = await context.params;
  const deviceCode = request.nextUrl.searchParams.get("deviceCode")?.trim();
  if (!deviceCode) {
    return NextResponse.json(
      {
        error: "device_code_required",
        message: "This browser handoff is missing its device code.",
      },
      { status: 400 }
    );
  }

  const config = getWebAuthConfig();
  const brokerUrl = new URL(
    `/v1/auth/session/flows/${encodeURIComponent(flowId)}`,
    `${config.authBrokerProxyBaseUrl}/`
  );
  brokerUrl.searchParams.set("deviceCode", deviceCode);

  const response = await fetch(brokerUrl, {
    headers: {
      accept: "application/json",
    },
    cache: "no-store",
  });
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
