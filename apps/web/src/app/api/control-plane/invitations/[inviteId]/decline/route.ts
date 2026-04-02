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
      readonly inviteId: string;
    }>;
  }
) {
  const { inviteId } = await context.params;
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

  const config = getWebAuthConfig();
  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/v1/auth/invitations/${encodeURIComponent(inviteId)}/decline`,
    {
      method: "POST",
      headers: createBrokerJsonRequestHeaders({ token }),
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
        error: "invite_decline_failed",
      })
    );
  }

  return redirectToPath(
    buildAccountControlPlanePath({
      redirectTo,
      notice: "invite_declined",
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
