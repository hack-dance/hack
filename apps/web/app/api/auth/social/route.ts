import { type NextRequest, NextResponse } from "next/server";

import { getAuthoritativeWebAuthConfig } from "@/src/lib/auth-config";
import {
  buildBrokerAccountBridgeUrl,
  normalizeAppReturnUrl,
} from "@/src/lib/auth-handoff";

export async function POST(request: NextRequest) {
  const body = (await readJsonBody(request)) as {
    readonly provider?: string;
    readonly flowId?: string;
    readonly deviceCode?: string;
    readonly redirect?: string;
  } | null;

  const provider = normalizeString(body?.provider);
  if (!provider) {
    return NextResponse.json(
      {
        error: "provider_required",
        message: "Choose a provider before starting Hack auth.",
      },
      { status: 400 }
    );
  }

  const config = await getAuthoritativeWebAuthConfig();
  if (config.betterAuthSource === "fail_closed") {
    return NextResponse.json(
      {
        error: "auth_metadata_unavailable",
        message:
          "Hack could not confirm the broker auth metadata for this sign-in flow.",
      },
      { status: 503 }
    );
  }
  if (
    !config.betterAuth.socialProviders.some(
      (socialProvider) => socialProvider.id === provider
    )
  ) {
    return NextResponse.json(
      {
        error: "provider_unavailable",
        message:
          "This sign-in provider is currently unavailable in the broker metadata.",
      },
      { status: 400 }
    );
  }
  const finalReturnUrl = normalizeAppReturnUrl({
    value: body?.redirect,
    appBaseUrl: config.appBaseUrl,
    trustedOrigins: config.betterAuth.trustedOrigins,
  });
  const callbackUrl = buildBrokerAccountBridgeUrl({
    authBrokerBaseUrl: config.authBrokerBaseUrl,
    appBaseUrl: config.appBaseUrl,
    flowId: normalizeString(body?.flowId),
    deviceCode: normalizeString(body?.deviceCode),
    finalReturnUrl,
  });

  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/api/auth/sign-in/social`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider,
        callbackURL: callbackUrl,
      }),
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

async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
