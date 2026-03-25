import { type NextRequest, NextResponse } from "next/server";

import {
  buildAccountControlPlanePath,
  createBrokerJsonRequestHeaders,
  normalizeAccountRedirectPath,
  readAccountControlPlaneFormValue,
  readBrokerSessionTokenFromRequest,
} from "@/src/lib/account-control-plane";
import { buildAccountShellSignInHref } from "@/src/lib/account-shell";
import { getWebAuthConfig } from "@/src/lib/auth-config";

type ErrorResponse = {
  readonly error?: string | null;
};

export async function POST(
  request: NextRequest,
  context: {
    readonly params: Promise<{
      readonly team: string;
    }>;
  }
) {
  const { team } = await context.params;
  const formData = await request.formData();
  const redirectTo = normalizeAccountRedirectPath({
    value: readAccountControlPlaneFormValue({ formData, key: "redirectTo" }),
  });
  const token = readBrokerSessionTokenFromRequest({ request });
  if (!token) {
    return redirectToPath(
      buildAccountShellSignInHref({
        returnToPath: redirectTo,
      })
    );
  }

  const org = readAccountControlPlaneFormValue({ formData, key: "org" });
  const target = readAccountControlPlaneFormValue({ formData, key: "target" });
  if (!(org && target)) {
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org,
        team,
        error: "team_member_invite_failed",
      })
    );
  }

  const config = getWebAuthConfig();
  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/v1/auth/teams/${encodeURIComponent(team)}/members/invite`,
    {
      method: "POST",
      headers: createBrokerJsonRequestHeaders({ token }),
      body: JSON.stringify({
        org,
        target,
      }),
      cache: "no-store",
    }
  );
  if (response.status === 401) {
    return redirectToPath(
      buildAccountShellSignInHref({
        returnToPath: redirectTo,
      })
    );
  }
  if (!response.ok) {
    const payload = (await safeReadJson(response)) as ErrorResponse | null;
    const error =
      payload?.error === "team_member_requires_active_org_membership"
        ? "team_member_requires_active_org_membership"
        : "team_member_invite_failed";
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org,
        team,
        error,
      })
    );
  }

  return redirectToPath(
    buildAccountControlPlanePath({
      redirectTo,
      org,
      team,
      notice: "team_member_invited",
    })
  );
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function redirectToPath(path: string) {
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: path,
    },
  });
}
