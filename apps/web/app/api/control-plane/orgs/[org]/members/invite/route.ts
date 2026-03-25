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

export async function POST(
  request: NextRequest,
  context: {
    readonly params: Promise<{
      readonly org: string;
    }>;
  }
) {
  const { org } = await context.params;
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

  const target = readAccountControlPlaneFormValue({ formData, key: "target" });
  if (!target) {
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org,
        error: "org_member_invite_failed",
      })
    );
  }

  const config = getWebAuthConfig();
  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/v1/auth/orgs/${encodeURIComponent(org)}/members/invite`,
    {
      method: "POST",
      headers: createBrokerJsonRequestHeaders({ token }),
      body: JSON.stringify({
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
        error: "org_member_invite_failed",
      })
    );
  }

  return redirectToPath(
    buildAccountControlPlanePath({
      redirectTo,
      org,
      notice: "org_member_invited",
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
