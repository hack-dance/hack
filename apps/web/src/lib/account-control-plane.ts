import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import type { NextRequest } from "next/server";

export type AccountOrganizationRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AccountMembershipRecord = {
  readonly id: string;
  readonly scope: "organization" | "team";
  readonly state: "pending" | "active" | "removed";
  readonly organizationId: string;
  readonly teamId: string | null;
  readonly userId: string | null;
  readonly email: string | null;
  readonly target: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AccountInvitationRecord = {
  readonly id: string;
  readonly scope: "organization" | "team";
  readonly organizationId: string;
  readonly teamId: string | null;
  readonly email: string;
  readonly status: "pending" | "accepted" | "removed";
  readonly teamTargets: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AccountControlPlaneData = {
  readonly requestedOrganizationKey: string | null;
  readonly selectedOrganizationVisible: boolean;
  readonly organizations: readonly AccountOrganizationRecord[];
  readonly selectedOrganization: AccountOrganizationRecord | null;
  readonly selectedOrganizationMemberships: readonly AccountMembershipRecord[];
  readonly incomingInvitations: readonly AccountInvitationRecord[];
};

export type AccountControlPlaneFeedback = {
  readonly tone: "success" | "danger" | "info";
  readonly title: string;
  readonly body: string;
};

type BrokerFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response> | Response;

const INTERNAL_CONTROL_PLANE_ORIGIN = "https://hack-control-plane.local";

export async function loadAccountControlPlaneData(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly token: string;
  readonly selectedOrganizationKey?: string | null;
  readonly fetchImplementation?: BrokerFetch;
}): Promise<AccountControlPlaneData> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const requestedOrganizationKey = normalizeText(input.selectedOrganizationKey);
  const [organizations, incomingInvitations] = await Promise.all([
    fetchOrganizations({
      authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
      token: input.token,
      fetchImplementation,
    }),
    fetchIncomingInvitations({
      authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
      token: input.token,
      fetchImplementation,
    }),
  ]);

  const selectedOrganizationCandidate = resolveSelectedOrganization({
    organizations,
    requestedOrganizationKey,
  });

  if (!selectedOrganizationCandidate) {
    return {
      requestedOrganizationKey,
      selectedOrganizationVisible: !requestedOrganizationKey,
      organizations,
      selectedOrganization: null,
      selectedOrganizationMemberships: [],
      incomingInvitations,
    };
  }

  const [selectedOrganization, selectedOrganizationMemberships] =
    await Promise.all([
      fetchSelectedOrganization({
        authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
        organizationKey: selectedOrganizationCandidate.slug,
        token: input.token,
        fallbackOrganization: selectedOrganizationCandidate,
        fetchImplementation,
      }),
      fetchOrganizationMemberships({
        authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
        organizationKey: selectedOrganizationCandidate.slug,
        token: input.token,
        fetchImplementation,
      }),
    ]);

  return {
    requestedOrganizationKey,
    selectedOrganizationVisible: true,
    organizations,
    selectedOrganization,
    selectedOrganizationMemberships,
    incomingInvitations,
  };
}

export function resolveAccountControlPlaneFeedback(input: {
  readonly notice?: string | null;
  readonly error?: string | null;
  readonly requestedOrganizationKey?: string | null;
  readonly selectedOrganizationVisible?: boolean;
}): AccountControlPlaneFeedback | null {
  const notice = normalizeText(input.notice);
  if (notice === "org_created") {
    return {
      tone: "success",
      title: "Organization created",
      body: "Hack created the organization and made you the initial active member.",
    };
  }
  if (notice === "org_member_invited") {
    return {
      tone: "success",
      title: "Pending invite sent",
      body: "The invite stays pending until the intended recipient accepts or declines it.",
    };
  }
  if (notice === "org_member_removed") {
    return {
      tone: "success",
      title: "Access revoked",
      body: "Hack removed the selected membership or pending invite cleanly.",
    };
  }
  if (notice === "invite_accepted") {
    return {
      tone: "success",
      title: "Invitation accepted",
      body: "Hack activated the shared organization access for this account.",
    };
  }
  if (notice === "invite_declined") {
    return {
      tone: "success",
      title: "Invitation declined",
      body: "Hack removed the pending invitation without granting access.",
    };
  }

  const error = normalizeText(input.error);
  if (error === "auth_required") {
    return {
      tone: "danger",
      title: "Sign in required",
      body: "Sign in again before managing organizations or invitations.",
    };
  }
  if (error === "org_create_failed") {
    return {
      tone: "danger",
      title: "Could not create the organization",
      body: "Hack could not create the organization. Check the broker response and try again.",
    };
  }
  if (error === "org_member_invite_failed") {
    return {
      tone: "danger",
      title: "Could not send the invite",
      body: "Hack could not create the pending invite. Verify the target email and try again.",
    };
  }
  if (error === "org_member_remove_failed") {
    return {
      tone: "danger",
      title: "Could not revoke access",
      body: "Hack could not revoke the selected access. Refresh the page and try again.",
    };
  }
  if (error === "invite_accept_failed") {
    return {
      tone: "danger",
      title: "Could not accept the invitation",
      body: "Hack could not confirm this invitation for the current account.",
    };
  }
  if (error === "invite_decline_failed") {
    return {
      tone: "danger",
      title: "Could not decline the invitation",
      body: "Hack could not decline this invitation for the current account.",
    };
  }

  const requestedOrganizationKey = normalizeText(
    input.requestedOrganizationKey
  );
  if (requestedOrganizationKey && input.selectedOrganizationVisible === false) {
    return {
      tone: "info",
      title: "Organization not visible",
      body: "The requested organization is not visible to the current account. Shared org detail stays scoped to the caller.",
    };
  }

  return null;
}

export function buildAccountControlPlanePath(input: {
  readonly redirectTo?: string | null;
  readonly notice?: string | null;
  readonly error?: string | null;
  readonly org?: string | null;
}): string {
  const redirectTo = normalizeAccountRedirectPath({
    value: input.redirectTo,
  });
  const url = new URL(redirectTo, INTERNAL_CONTROL_PLANE_ORIGIN);

  url.searchParams.delete("notice");
  url.searchParams.delete("error");

  const org = normalizeText(input.org);
  if (org) {
    url.searchParams.set("org", org);
  }

  const notice = normalizeText(input.notice);
  if (notice) {
    url.searchParams.set("notice", notice);
  }

  const error = normalizeText(input.error);
  if (error) {
    url.searchParams.set("error", error);
  }

  return `${url.pathname}${url.search}`;
}

export function normalizeAccountRedirectPath(input: {
  readonly value?: string | null;
  readonly fallback?: string;
}): string {
  const fallback = input.fallback ?? "/account";
  const value = normalizeText(input.value);
  if (!(value?.startsWith("/") && !value.startsWith("//"))) {
    return fallback;
  }
  try {
    const url = new URL(value, INTERNAL_CONTROL_PLANE_ORIGIN);
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

export function readAccountControlPlaneFormValue(input: {
  readonly formData: FormData;
  readonly key: string;
}): string | null {
  const value = input.formData.get(input.key);
  return typeof value === "string" ? normalizeText(value) : null;
}

export function readBrokerSessionTokenFromRequest(input: {
  readonly request: NextRequest;
}): string | null {
  const requestCookies = input.request.cookies;
  if (requestCookies) {
    const cookieValue = requestCookies.get(
      HACK_WEB_BROKER_SESSION_COOKIE_NAME
    )?.value;
    const normalizedCookieValue = normalizeText(cookieValue);
    if (normalizedCookieValue) {
      return normalizedCookieValue;
    }
  }

  const cookieHeader = normalizeText(input.request.headers.get("cookie"));
  if (!cookieHeader) {
    return null;
  }

  const cookieEntries = cookieHeader.split(";");
  for (const entry of cookieEntries) {
    const [key, ...valueParts] = entry.split("=");
    if (normalizeText(key) !== HACK_WEB_BROKER_SESSION_COOKIE_NAME) {
      continue;
    }
    return normalizeText(valueParts.join("="));
  }

  return null;
}

export function createBrokerJsonRequestHeaders(input: {
  readonly token: string;
}): HeadersInit {
  return {
    accept: "application/json",
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  };
}

async function fetchOrganizations(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly token: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<readonly AccountOrganizationRecord[]> {
  const payload = await fetchBrokerPayload<{
    readonly organizations?: readonly unknown[];
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: "/v1/auth/orgs",
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeOrganizations(payload?.organizations);
}

async function fetchIncomingInvitations(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly token: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<readonly AccountInvitationRecord[]> {
  const payload = await fetchBrokerPayload<{
    readonly invitations?: readonly unknown[];
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: "/v1/auth/invitations",
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeInvitations(payload?.invitations);
}

async function fetchSelectedOrganization(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly organizationKey: string;
  readonly token: string;
  readonly fallbackOrganization: AccountOrganizationRecord;
  readonly fetchImplementation: BrokerFetch;
}): Promise<AccountOrganizationRecord> {
  const payload = await fetchBrokerPayload<{
    readonly organization?: unknown;
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: `/v1/auth/orgs/${encodeURIComponent(input.organizationKey)}`,
    fetchImplementation: input.fetchImplementation,
  });
  return (
    normalizeOrganization(payload?.organization) ?? input.fallbackOrganization
  );
}

async function fetchOrganizationMemberships(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly organizationKey: string;
  readonly token: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<readonly AccountMembershipRecord[]> {
  const payload = await fetchBrokerPayload<{
    readonly memberships?: readonly unknown[];
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: `/v1/auth/orgs/${encodeURIComponent(input.organizationKey)}/members`,
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeMemberships(payload?.memberships);
}

async function fetchBrokerPayload<T>(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly token: string;
  readonly path: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<T | null> {
  try {
    const response = await input.fetchImplementation(
      `${input.authBrokerProxyBaseUrl}${input.path}`,
      {
        headers: createBrokerJsonRequestHeaders({
          token: input.token,
        }),
        cache: "no-store",
      }
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function resolveSelectedOrganization(input: {
  readonly organizations: readonly AccountOrganizationRecord[];
  readonly requestedOrganizationKey: string | null;
}): AccountOrganizationRecord | null {
  if (!input.requestedOrganizationKey) {
    return input.organizations[0] ?? null;
  }
  return (
    input.organizations.find((organization) => {
      return (
        organization.slug === input.requestedOrganizationKey ||
        organization.id === input.requestedOrganizationKey
      );
    }) ?? null
  );
}

function normalizeOrganizations(
  value: readonly unknown[] | undefined
): readonly AccountOrganizationRecord[] {
  return (value ?? [])
    .map((organization) => normalizeOrganization(organization))
    .filter((organization): organization is AccountOrganizationRecord =>
      Boolean(organization)
    );
}

function normalizeOrganization(
  value: unknown
): AccountOrganizationRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const slug = normalizeText(value.slug);
  const name = normalizeText(value.name);
  const createdAt = normalizeText(value.createdAt);
  const updatedAt = normalizeText(value.updatedAt);

  if (!(id && slug && name && createdAt && updatedAt)) {
    return null;
  }

  return {
    id,
    slug,
    name,
    createdAt,
    updatedAt,
  };
}

function normalizeMemberships(
  value: readonly unknown[] | undefined
): readonly AccountMembershipRecord[] {
  return (value ?? [])
    .map((membership) => normalizeMembership(membership))
    .filter((membership): membership is AccountMembershipRecord =>
      Boolean(membership)
    );
}

function normalizeMembership(value: unknown): AccountMembershipRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const scope = normalizeMembershipScope(value.scope);
  const state = normalizeMembershipState(value.state);
  const organizationId = normalizeText(value.organizationId);
  const createdAt = normalizeText(value.createdAt);
  const updatedAt = normalizeText(value.updatedAt);
  const target = normalizeText(value.target);

  if (
    !(
      id &&
      scope &&
      state &&
      organizationId &&
      createdAt &&
      updatedAt &&
      target
    )
  ) {
    return null;
  }

  return {
    id,
    scope,
    state,
    organizationId,
    teamId: normalizeText(value.teamId),
    userId: normalizeText(value.userId),
    email: normalizeText(value.email),
    target,
    createdAt,
    updatedAt,
  };
}

function normalizeInvitations(
  value: readonly unknown[] | undefined
): readonly AccountInvitationRecord[] {
  return (value ?? [])
    .map((invitation) => normalizeInvitation(invitation))
    .filter((invitation): invitation is AccountInvitationRecord =>
      Boolean(invitation)
    );
}

function normalizeInvitation(value: unknown): AccountInvitationRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const scope = normalizeMembershipScope(value.scope);
  const organizationId = normalizeText(value.organizationId);
  const email = normalizeText(value.email);
  const status = normalizeInvitationStatus(value.status);
  const createdAt = normalizeText(value.createdAt);
  const updatedAt = normalizeText(value.updatedAt);

  if (
    !(
      id &&
      scope &&
      organizationId &&
      email &&
      status &&
      createdAt &&
      updatedAt
    )
  ) {
    return null;
  }

  return {
    id,
    scope,
    organizationId,
    teamId: normalizeText(value.teamId),
    email,
    status,
    teamTargets: normalizeStringArray(value.teamTargets),
    createdAt,
    updatedAt,
  };
}

function normalizeMembershipScope(
  value: unknown
): "organization" | "team" | null {
  return value === "team" || value === "organization" ? value : null;
}

function normalizeMembershipState(
  value: unknown
): "pending" | "active" | "removed" | null {
  return value === "pending" || value === "active" || value === "removed"
    ? value
    : null;
}

function normalizeInvitationStatus(
  value: unknown
): "pending" | "accepted" | "removed" | null {
  return value === "pending" || value === "accepted" || value === "removed"
    ? value
    : null;
}

function normalizeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
