import { type NextRequest, NextResponse } from "next/server";

import {
  buildAccountControlPlanePath,
  createBrokerJsonRequestHeaders,
  normalizeAccountRedirectPath,
  readAccountControlPlaneFormValue,
  readBrokerSessionTokenFromRequest,
} from "@/lib/account-control-plane";
import { buildAccountShellSignInHref } from "@/lib/account-shell";
import { getWebAuthConfig } from "@/lib/auth-config";

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
        error: "team_member_remove_failed",
      })
    );
  }

  const config = getWebAuthConfig();
  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/v1/auth/teams/${encodeURIComponent(team)}/members/remove`,
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
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org,
        team,
        error: "team_member_remove_failed",
      })
    );
  }

  return redirectToPath(
    buildAccountControlPlanePath({
      redirectTo,
      org,
      team,
      notice: "team_member_removed",
    })
  );
}

function redirectToPath(path: string) {
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: path,
    },
  });
}
