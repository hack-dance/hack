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

type RegisterProjectResponse = {
  readonly project?: {
    readonly slug?: string | null;
  } | null;
  readonly error?: string | null;
};

export async function POST(request: NextRequest) {
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

  const slug = readAccountControlPlaneFormValue({ formData, key: "slug" });
  const name = readAccountControlPlaneFormValue({ formData, key: "name" });
  const mode = readAccountControlPlaneFormValue({ formData, key: "mode" });
  const org = readAccountControlPlaneFormValue({ formData, key: "org" });
  const team = readAccountControlPlaneFormValue({ formData, key: "team" });
  if (!(slug && isProjectMode(mode))) {
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org: org ?? redirectSelection.org,
        team: team ?? redirectSelection.team,
        error: "project_register_failed",
      })
    );
  }

  const config = getWebAuthConfig();
  const response = await fetch(
    `${config.authBrokerProxyBaseUrl}/v1/auth/projects`,
    {
      method: "POST",
      headers: createBrokerJsonRequestHeaders({ token }),
      body: JSON.stringify({
        slug,
        ...(name ? { name } : {}),
        mode,
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
  )) as RegisterProjectResponse | null;
  if (!response.ok) {
    let error:
      | "project_registration_conflict"
      | "project_scope_forbidden"
      | "project_register_failed" = "project_register_failed";
    if (payload?.error === "project_registration_conflict") {
      error = "project_registration_conflict";
    } else if (payload?.error === "project_scope_forbidden") {
      error = "project_scope_forbidden";
    }
    return redirectToPath(
      buildAccountControlPlanePath({
        redirectTo,
        org: org ?? redirectSelection.org,
        team: team ?? redirectSelection.team,
        project: slug,
        error,
      })
    );
  }

  return redirectToPath(
    buildAccountControlPlanePath({
      redirectTo,
      org: org ?? redirectSelection.org,
      team: team ?? redirectSelection.team,
      project: payload?.project?.slug ?? slug,
      notice: "project_registered",
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

function isProjectMode(
  value: string | null
): value is "local" | "organization" | "team" {
  return value === "local" || value === "organization" || value === "team";
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
