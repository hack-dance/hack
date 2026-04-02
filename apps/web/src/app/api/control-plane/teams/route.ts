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

type CreateTeamResponse = {
  readonly team?: {
    readonly slug?: string | null;
  } | null;
};

export async function POST(request: NextRequest) {
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
  const slug = readAccountControlPlaneFormValue({ formData, key: "slug" });
  const name = readAccountControlPlaneFormValue({ formData, key: "name" });
  if (!(org && slug)) {
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org,
        error: "team_create_failed",
      })
    );
  }

  const config = getWebAuthConfig();
  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/v1/auth/teams`,
    {
      method: "POST",
      headers: createBrokerJsonRequestHeaders({ token }),
      body: JSON.stringify({
        org,
        slug,
        ...(name ? { name } : {}),
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
        error: "team_create_failed",
      })
    );
  }

  const payload = (await safeReadJson(response)) as CreateTeamResponse | null;
  return redirectToPath(
    buildAccountControlPlanePath({
      redirectTo,
      org,
      team: payload?.team?.slug ?? slug,
      notice: "team_created",
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
