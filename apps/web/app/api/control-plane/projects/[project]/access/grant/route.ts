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

type ProjectAccessResponse = {
  readonly error?: string | null;
};

export async function POST(
  request: NextRequest,
  context: { readonly params: Promise<{ readonly project: string }> }
) {
  const { project } = await context.params;
  const formData = await request.formData();
  const redirectTo = normalizeAccountRedirectPath({
    value: readAccountControlPlaneFormValue({ formData, key: "redirectTo" }),
  });
  const redirectSelection = readRedirectSelection(redirectTo);
  const token = readBrokerSessionTokenFromRequest({ request });
  if (!token) {
    return redirectToPath(
      buildAccountShellSignInHref({
        returnToPath: redirectTo,
      })
    );
  }

  const scope = readAccountControlPlaneFormValue({ formData, key: "scope" });
  const role = readAccountControlPlaneFormValue({ formData, key: "role" });
  const org = readAccountControlPlaneFormValue({ formData, key: "org" });
  const team = readAccountControlPlaneFormValue({ formData, key: "team" });
  if (!(isAccessScope(scope) && isGrantRole(role))) {
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org: org ?? redirectSelection.org,
        team: team ?? redirectSelection.team,
        project,
        error: "project_access_grant_failed",
      })
    );
  }

  const config = getWebAuthConfig();
  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/v1/auth/projects/${encodeURIComponent(project)}/access/grant`,
    {
      method: "POST",
      headers: createBrokerJsonRequestHeaders({ token }),
      body: JSON.stringify({
        scope,
        role,
        ...(org ? { org } : {}),
        ...(team ? { team } : {}),
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

  const payload = (await safeReadJson(
    response
  )) as ProjectAccessResponse | null;
  if (!response.ok) {
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org: org ?? redirectSelection.org,
        team: team ?? redirectSelection.team,
        project,
        error: normalizeBrokerProjectError(
          payload?.error,
          "project_access_grant_failed"
        ),
      })
    );
  }

  return redirectToPath(
    buildAccountControlPlanePath({
      redirectTo,
      org: org ?? redirectSelection.org,
      team: team ?? redirectSelection.team,
      project,
      notice: "project_access_granted",
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

function isAccessScope(value: string | null): value is "organization" | "team" {
  return value === "organization" || value === "team";
}

function isGrantRole(value: string | null): value is "viewer" | "admin" {
  return value === "viewer" || value === "admin";
}

function normalizeBrokerProjectError(
  error: string | null | undefined,
  fallback: string
) {
  return error === "project_access_grant_failed" ? error : fallback;
}

function redirectToPath(path: string) {
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: path,
    },
  });
}

function readRedirectSelection(path: string) {
  const url = new URL(path, "https://hack-control-plane.local");
  return {
    org: url.searchParams.get("org"),
    team: url.searchParams.get("team"),
  };
}
