import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import { cookies } from "next/headers";

import { loadAccountControlPlaneData } from "./account-control-plane";
import { buildAuthBrokerProxyUrl, getWebAuthConfig } from "./auth-config";

type NamedEntity = {
  readonly id: string;
  readonly name: string | null;
};

type AccountUser = {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly image?: string | null;
};

type BrokerMePayload = {
  readonly ok?: boolean;
  readonly authenticated?: boolean;
  readonly accessControlMode?: string | null;
  readonly user?: {
    readonly id?: string | null;
    readonly email?: string | null;
    readonly name?: string | null;
    readonly image?: string | null;
  } | null;
  readonly activeOrganization?: {
    readonly id?: string | null;
    readonly name?: string | null;
  } | null;
  readonly activeTeam?: {
    readonly id?: string | null;
    readonly name?: string | null;
  } | null;
  readonly shellPath?: string | null;
  readonly accountPath?: string | null;
};

export type AccountShellContext =
  | {
      readonly authenticated: true;
      readonly accessControlMode: string | null;
      readonly user: AccountUser;
      readonly activeOrganization: NamedEntity | null;
      readonly activeTeam: NamedEntity | null;
      readonly shellPath: string;
      readonly accountPath: string;
      readonly requestedOrganizationKey: string | null;
      readonly selectedOrganizationVisible: boolean;
      readonly requestedTeamKey: string | null;
      readonly selectedTeamVisible: boolean;
      readonly requestedProjectKey: string | null;
      readonly selectedProjectVisible: boolean;
      readonly organizations: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["organizations"];
      readonly selectedOrganization: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedOrganization"];
      readonly selectedOrganizationMemberships: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedOrganizationMemberships"];
      readonly teams: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["teams"];
      readonly selectedTeam: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedTeam"];
      readonly selectedTeamMemberships: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedTeamMemberships"];
      readonly incomingInvitations: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["incomingInvitations"];
      readonly projects: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["projects"];
      readonly selectedProject: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedProject"];
      readonly selectedProjectAccess: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedProjectAccess"];
    }
  | {
      readonly authenticated: false;
    };

export function buildAccountShellSignInHref(input: {
  readonly returnToPath: string;
}): string {
  const searchParams = new URLSearchParams({
    redirect: input.returnToPath,
  });

  return `/auth?${searchParams.toString()}`;
}

export async function getAccountShellContext(input?: {
  readonly selectedOrganizationKey?: string | null;
  readonly selectedTeamKey?: string | null;
  readonly selectedProjectKey?: string | null;
}): Promise<AccountShellContext> {
  const cookieStore = await cookies();
  const token = cookieStore
    .get(HACK_WEB_BROKER_SESSION_COOKIE_NAME)
    ?.value.trim();
  if (!token) {
    return { authenticated: false };
  }

  const config = getWebAuthConfig();

  try {
    const response = await fetch(
      buildAuthBrokerProxyUrl({
        authBrokerProxyBaseUrl: config.authBrokerProxyBaseUrl,
        path: "/v1/auth/me",
      }),
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      }
    );
    if (!response.ok) {
      return { authenticated: false };
    }

    const payload = (await response.json()) as BrokerMePayload;
    const userId = normalizeText(payload.user?.id);
    if (!(payload.ok === true && payload.authenticated === true && userId)) {
      return { authenticated: false };
    }

    const controlPlaneData = await loadAccountControlPlaneData({
      authBrokerProxyBaseUrl: config.authBrokerProxyBaseUrl,
      token,
      selectedOrganizationKey: input?.selectedOrganizationKey,
      selectedTeamKey: input?.selectedTeamKey,
      selectedProjectKey: input?.selectedProjectKey,
    });

    return {
      authenticated: true,
      accessControlMode: normalizeText(payload.accessControlMode),
      user: {
        id: userId,
        email: normalizeText(payload.user?.email),
        name: normalizeText(payload.user?.name),
        image: normalizeText(payload.user?.image),
      },
      activeOrganization: toNamedEntity(payload.activeOrganization),
      activeTeam: toNamedEntity(payload.activeTeam),
      shellPath: normalizeText(payload.shellPath) ?? "/auth",
      accountPath: normalizeText(payload.accountPath) ?? "/auth/account",
      requestedOrganizationKey: controlPlaneData.requestedOrganizationKey,
      selectedOrganizationVisible: controlPlaneData.selectedOrganizationVisible,
      requestedTeamKey: controlPlaneData.requestedTeamKey,
      selectedTeamVisible: controlPlaneData.selectedTeamVisible,
      requestedProjectKey: controlPlaneData.requestedProjectKey,
      selectedProjectVisible: controlPlaneData.selectedProjectVisible,
      organizations: controlPlaneData.organizations,
      selectedOrganization: controlPlaneData.selectedOrganization,
      selectedOrganizationMemberships:
        controlPlaneData.selectedOrganizationMemberships,
      teams: controlPlaneData.teams,
      selectedTeam: controlPlaneData.selectedTeam,
      selectedTeamMemberships: controlPlaneData.selectedTeamMemberships,
      incomingInvitations: controlPlaneData.incomingInvitations,
      projects: controlPlaneData.projects,
      selectedProject: controlPlaneData.selectedProject,
      selectedProjectAccess: controlPlaneData.selectedProjectAccess,
    };
  } catch {
    return { authenticated: false };
  }
}

function toNamedEntity(
  value:
    | {
        readonly id?: string | null;
        readonly name?: string | null;
      }
    | null
    | undefined
): NamedEntity | null {
  const id = normalizeText(value?.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: normalizeText(value?.name),
  };
}

function normalizeText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
