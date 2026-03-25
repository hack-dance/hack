import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import { cookies } from "next/headers";

import { loadAccountControlPlaneData } from "./account-control-plane";
import { getWebAuthConfig } from "./auth-config";

type NamedEntity = {
  readonly id: string;
  readonly name: string | null;
};

type AccountUser = {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
};

type BrokerMePayload = {
  readonly ok?: boolean;
  readonly authenticated?: boolean;
  readonly accessControlMode?: string | null;
  readonly user?: {
    readonly id?: string | null;
    readonly email?: string | null;
    readonly name?: string | null;
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
      readonly organizations: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["organizations"];
      readonly selectedOrganization: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedOrganization"];
      readonly selectedOrganizationMemberships: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["selectedOrganizationMemberships"];
      readonly incomingInvitations: Awaited<
        ReturnType<typeof loadAccountControlPlaneData>
      >["incomingInvitations"];
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
      `${config.authBrokerProxyBaseUrl}/v1/auth/me`,
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
    });

    return {
      authenticated: true,
      accessControlMode: normalizeText(payload.accessControlMode),
      user: {
        id: userId,
        email: normalizeText(payload.user?.email),
        name: normalizeText(payload.user?.name),
      },
      activeOrganization: toNamedEntity(payload.activeOrganization),
      activeTeam: toNamedEntity(payload.activeTeam),
      shellPath: normalizeText(payload.shellPath) ?? "/auth",
      accountPath: normalizeText(payload.accountPath) ?? "/auth/account",
      requestedOrganizationKey: controlPlaneData.requestedOrganizationKey,
      selectedOrganizationVisible: controlPlaneData.selectedOrganizationVisible,
      organizations: controlPlaneData.organizations,
      selectedOrganization: controlPlaneData.selectedOrganization,
      selectedOrganizationMemberships:
        controlPlaneData.selectedOrganizationMemberships,
      incomingInvitations: controlPlaneData.incomingInvitations,
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
