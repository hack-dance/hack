import { HACK_WEB_BROKER_SESSION_COOKIE_NAME } from "@hack/auth-contract";
import type { NextRequest } from "next/server";

export type AccountOrganizationRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AccountTeamRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly organizationId: string;
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

export type AccountProjectOwnershipRecord = {
  readonly mode: "local" | "shared";
  readonly ownerType: "user" | "organization" | "team";
  readonly ownerId: string | null;
  readonly ownerSlug: string | null;
  readonly ownerName: string | null;
  readonly managedBy: "local" | "broker";
};

export type AccountProjectRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly ownership: AccountProjectOwnershipRecord;
  readonly currentAccessRole: "viewer" | "admin" | "owner";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AccountProjectAccessGrantRecord = {
  readonly id: string;
  readonly scope: "organization" | "team";
  readonly role: "viewer" | "admin";
  readonly subjectId: string;
  readonly subjectSlug: string;
  readonly subjectName: string;
  readonly organizationId: string;
  readonly teamId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AccountControlPlaneData = {
  readonly requestedOrganizationKey: string | null;
  readonly selectedOrganizationVisible: boolean;
  readonly organizations: readonly AccountOrganizationRecord[];
  readonly selectedOrganization: AccountOrganizationRecord | null;
  readonly selectedOrganizationMemberships: readonly AccountMembershipRecord[];
  readonly requestedTeamKey: string | null;
  readonly selectedTeamVisible: boolean;
  readonly teams: readonly AccountTeamRecord[];
  readonly selectedTeam: AccountTeamRecord | null;
  readonly selectedTeamMemberships: readonly AccountMembershipRecord[];
  readonly incomingInvitations: readonly AccountInvitationRecord[];
  readonly requestedProjectKey: string | null;
  readonly selectedProjectVisible: boolean;
  readonly projects: readonly AccountProjectRecord[];
  readonly selectedProject: AccountProjectRecord | null;
  readonly selectedProjectAccess: readonly AccountProjectAccessGrantRecord[];
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

const controlPlaneNoticeFeedback = {
  org_created: {
    tone: "success",
    title: "Organization created",
    body: "Hack created the organization and made you the initial active member.",
  },
  org_member_invited: {
    tone: "success",
    title: "Pending invite sent",
    body: "The invite stays pending until the intended recipient accepts or declines it.",
  },
  org_member_removed: {
    tone: "success",
    title: "Access revoked",
    body: "Hack removed the selected membership or pending invite cleanly.",
  },
  team_created: {
    tone: "success",
    title: "Team created",
    body: "Hack created the team inside the selected parent organization and kept the scope explicit.",
  },
  team_member_invited: {
    tone: "success",
    title: "Team invite sent",
    body: "Hack kept the team membership change scoped to the selected parent organization and team.",
  },
  team_member_removed: {
    tone: "success",
    title: "Team access revoked",
    body: "Hack removed the selected team membership without changing parent organization membership.",
  },
  invite_accepted: {
    tone: "success",
    title: "Invitation accepted",
    body: "Hack activated the shared organization access for this account.",
  },
  invite_declined: {
    tone: "success",
    title: "Invitation declined",
    body: "Hack removed the pending invitation without granting access.",
  },
  project_registered: {
    tone: "success",
    title: "Project registered",
    body: "Hack stored the durable shared project registration and kept its ownership scope explicit.",
  },
  project_access_granted: {
    tone: "success",
    title: "Project access granted",
    body: "Hack stored the explicit project access grant without inferring stale org or team ownership.",
  },
  project_access_revoked: {
    tone: "success",
    title: "Project access revoked",
    body: "Hack removed the selected project access grant while preserving the remaining shared ownership metadata.",
  },
} as const satisfies Record<string, AccountControlPlaneFeedback>;

const controlPlaneErrorFeedback = {
  auth_required: {
    tone: "danger",
    title: "Sign in required",
    body: "Sign in again before managing organizations or invitations.",
  },
  org_create_failed: {
    tone: "danger",
    title: "Could not create the organization",
    body: "Hack could not create the organization. Check the broker response and try again.",
  },
  org_member_invite_failed: {
    tone: "danger",
    title: "Could not send the invite",
    body: "Hack could not create the pending invite. Verify the target email and try again.",
  },
  org_member_remove_failed: {
    tone: "danger",
    title: "Could not revoke access",
    body: "Hack could not revoke the selected access. Refresh the page and try again.",
  },
  team_create_failed: {
    tone: "danger",
    title: "Could not create the team",
    body: "Hack could not create the selected team inside the current organization. Verify the org scope and try again.",
  },
  team_member_invite_failed: {
    tone: "danger",
    title: "Could not send the team invite",
    body: "Hack could not create the team-scoped invite. Verify the org, team, and recipient, then try again.",
  },
  team_member_remove_failed: {
    tone: "danger",
    title: "Could not revoke team access",
    body: "Hack could not remove the selected team membership. Refresh the page and try again.",
  },
  team_member_requires_active_org_membership: {
    tone: "danger",
    title: "Parent org membership required",
    body: "Only active parent-org members can receive team-scoped access. Grant or restore org membership before inviting this user to the team.",
  },
  invite_accept_failed: {
    tone: "danger",
    title: "Could not accept the invitation",
    body: "Hack could not confirm this invitation for the current account.",
  },
  invite_decline_failed: {
    tone: "danger",
    title: "Could not decline the invitation",
    body: "Hack could not decline this invitation for the current account.",
  },
  project_registration_conflict: {
    tone: "danger",
    title: "Project ownership conflict",
    body: "Hack found an existing durable registration for this slug with different ownership. Resolve the conflict explicitly before reusing the project key.",
  },
  project_scope_forbidden: {
    tone: "danger",
    title: "Active scope required",
    body: "The current Hack org or team context does not allow this shared project change. Switch the active scope before retrying the shared project action.",
  },
  project_register_failed: {
    tone: "danger",
    title: "Could not register the project",
    body: "Hack could not store the project registration. Verify the selected owner scope and try again.",
  },
  project_access_grant_failed: {
    tone: "danger",
    title: "Could not grant project access",
    body: "Hack could not store the selected project access grant. Verify the shared scope and try again.",
  },
  project_access_revoke_failed: {
    tone: "danger",
    title: "Could not revoke project access",
    body: "Hack could not remove the selected project access grant. Refresh the page and try again.",
  },
} as const satisfies Record<string, AccountControlPlaneFeedback>;

export async function loadAccountControlPlaneData(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly token: string;
  readonly selectedOrganizationKey?: string | null;
  readonly selectedTeamKey?: string | null;
  readonly selectedProjectKey?: string | null;
  readonly fetchImplementation?: BrokerFetch;
}): Promise<AccountControlPlaneData> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const requestedOrganizationKey = normalizeText(input.selectedOrganizationKey);
  const requestedTeamKey = normalizeText(input.selectedTeamKey);
  const requestedProjectKey = normalizeText(input.selectedProjectKey);
  const [organizations, incomingInvitations, projects] = await Promise.all([
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
    fetchProjects({
      authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
      token: input.token,
      fetchImplementation,
    }),
  ]);
  const selectedProjectCandidate = resolveSelectedProject({
    projects,
    requestedProjectKey,
  });
  const selectedProjectAccess = selectedProjectCandidate
    ? await fetchProjectAccess({
        authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
        projectKey: selectedProjectCandidate.slug,
        token: input.token,
        fetchImplementation,
      })
    : [];

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
      requestedTeamKey,
      selectedTeamVisible: !requestedTeamKey,
      teams: [],
      selectedTeam: null,
      selectedTeamMemberships: [],
      incomingInvitations,
      requestedProjectKey,
      selectedProjectVisible: selectedProjectCandidate
        ? true
        : !requestedProjectKey,
      projects,
      selectedProject: selectedProjectCandidate,
      selectedProjectAccess,
    };
  }

  const [selectedOrganization, selectedOrganizationMemberships, teams] =
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
      fetchTeams({
        authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
        organizationKey: selectedOrganizationCandidate.slug,
        token: input.token,
        fetchImplementation,
      }),
    ]);

  const selectedTeamCandidate = resolveSelectedTeam({
    teams,
    requestedTeamKey,
  });
  if (!selectedTeamCandidate) {
    return {
      requestedOrganizationKey,
      selectedOrganizationVisible: true,
      organizations,
      selectedOrganization,
      selectedOrganizationMemberships,
      requestedTeamKey,
      selectedTeamVisible: !requestedTeamKey,
      teams,
      selectedTeam: null,
      selectedTeamMemberships: [],
      incomingInvitations,
      requestedProjectKey,
      selectedProjectVisible: selectedProjectCandidate
        ? true
        : !requestedProjectKey,
      projects,
      selectedProject: selectedProjectCandidate,
      selectedProjectAccess,
    };
  }

  const [selectedTeam, selectedTeamMemberships] = await Promise.all([
    fetchSelectedTeam({
      authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
      organizationKey: selectedOrganizationCandidate.slug,
      teamKey: selectedTeamCandidate.slug,
      token: input.token,
      fallbackTeam: selectedTeamCandidate,
      fetchImplementation,
    }),
    fetchTeamMemberships({
      authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
      organizationKey: selectedOrganizationCandidate.slug,
      teamKey: selectedTeamCandidate.slug,
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
    requestedTeamKey,
    selectedTeamVisible: true,
    teams,
    selectedTeam,
    selectedTeamMemberships,
    incomingInvitations,
    requestedProjectKey,
    selectedProjectVisible: selectedProjectCandidate
      ? true
      : !requestedProjectKey,
    projects,
    selectedProject: selectedProjectCandidate,
    selectedProjectAccess,
  };
}

export function resolveAccountControlPlaneFeedback(input: {
  readonly notice?: string | null;
  readonly error?: string | null;
  readonly requestedOrganizationKey?: string | null;
  readonly selectedOrganizationVisible?: boolean;
  readonly requestedTeamKey?: string | null;
  readonly selectedTeamVisible?: boolean;
  readonly requestedProjectKey?: string | null;
  readonly selectedProjectVisible?: boolean;
}): AccountControlPlaneFeedback | null {
  const notice = normalizeText(input.notice);
  if (notice) {
    const feedback = readMappedFeedback({
      feedbackByKey: controlPlaneNoticeFeedback,
      key: notice,
    });
    if (feedback) {
      return feedback;
    }
  }

  const error = normalizeText(input.error);
  if (error) {
    const feedback = readMappedFeedback({
      feedbackByKey: controlPlaneErrorFeedback,
      key: error,
    });
    if (feedback) {
      return feedback;
    }
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

  const requestedTeamKey = normalizeText(input.requestedTeamKey);
  if (
    requestedTeamKey &&
    input.selectedOrganizationVisible !== false &&
    input.selectedTeamVisible === false
  ) {
    return {
      tone: "info",
      title: "Team not visible",
      body: "The requested team is not visible to the current account inside the selected organization. Team-scoped resources stay hidden until this account belongs to the team directly.",
    };
  }

  const requestedProjectKey = normalizeText(input.requestedProjectKey);
  if (requestedProjectKey && input.selectedProjectVisible === false) {
    return {
      tone: "info",
      title: "Project not visible",
      body: "The requested project is not visible to the current account. Shared project access stays scoped to explicit durable grants.",
    };
  }

  return null;
}

export function buildAccountControlPlanePath(input: {
  readonly redirectTo?: string | null;
  readonly notice?: string | null;
  readonly error?: string | null;
  readonly org?: string | null;
  readonly team?: string | null;
  readonly project?: string | null;
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
  } else {
    url.searchParams.delete("org");
  }

  const team = org ? normalizeText(input.team) : null;
  if (team) {
    url.searchParams.set("team", team);
  } else {
    url.searchParams.delete("team");
  }

  const project = normalizeText(input.project);
  if (project) {
    url.searchParams.set("project", project);
  } else {
    url.searchParams.delete("project");
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

async function fetchProjects(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly token: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<readonly AccountProjectRecord[]> {
  const payload = await fetchBrokerPayload<{
    readonly projects?: readonly unknown[];
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: "/v1/auth/projects",
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeProjects(payload?.projects);
}

async function fetchProjectAccess(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly projectKey: string;
  readonly token: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<readonly AccountProjectAccessGrantRecord[]> {
  const payload = await fetchBrokerPayload<{
    readonly access?: readonly unknown[];
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: `/v1/auth/projects/${encodeURIComponent(input.projectKey)}/access`,
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeProjectAccess(payload?.access);
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

async function fetchTeams(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly organizationKey: string;
  readonly token: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<readonly AccountTeamRecord[]> {
  const payload = await fetchBrokerPayload<{
    readonly teams?: readonly unknown[];
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: `/v1/auth/teams?org=${encodeURIComponent(input.organizationKey)}`,
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeTeams(payload?.teams);
}

async function fetchSelectedTeam(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly organizationKey: string;
  readonly teamKey: string;
  readonly token: string;
  readonly fallbackTeam: AccountTeamRecord;
  readonly fetchImplementation: BrokerFetch;
}): Promise<AccountTeamRecord> {
  const payload = await fetchBrokerPayload<{
    readonly team?: unknown;
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: `/v1/auth/teams/${encodeURIComponent(input.teamKey)}?org=${encodeURIComponent(input.organizationKey)}`,
    fetchImplementation: input.fetchImplementation,
  });
  return normalizeTeam(payload?.team) ?? input.fallbackTeam;
}

async function fetchTeamMemberships(input: {
  readonly authBrokerProxyBaseUrl: string;
  readonly organizationKey: string;
  readonly teamKey: string;
  readonly token: string;
  readonly fetchImplementation: BrokerFetch;
}): Promise<readonly AccountMembershipRecord[]> {
  const payload = await fetchBrokerPayload<{
    readonly memberships?: readonly unknown[];
  }>({
    authBrokerProxyBaseUrl: input.authBrokerProxyBaseUrl,
    token: input.token,
    path: `/v1/auth/teams/${encodeURIComponent(input.teamKey)}/members?org=${encodeURIComponent(input.organizationKey)}`,
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

function resolveSelectedTeam(input: {
  readonly teams: readonly AccountTeamRecord[];
  readonly requestedTeamKey: string | null;
}): AccountTeamRecord | null {
  if (!input.requestedTeamKey) {
    return input.teams[0] ?? null;
  }
  return (
    input.teams.find((team) => {
      return (
        team.slug === input.requestedTeamKey ||
        team.id === input.requestedTeamKey
      );
    }) ?? null
  );
}

function resolveSelectedProject(input: {
  readonly projects: readonly AccountProjectRecord[];
  readonly requestedProjectKey: string | null;
}): AccountProjectRecord | null {
  if (!input.requestedProjectKey) {
    return input.projects[0] ?? null;
  }
  return (
    input.projects.find((project) => {
      return (
        project.slug === input.requestedProjectKey ||
        project.id === input.requestedProjectKey
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

function normalizeTeams(
  value: readonly unknown[] | undefined
): readonly AccountTeamRecord[] {
  return (value ?? [])
    .map((team) => normalizeTeam(team))
    .filter((team): team is AccountTeamRecord => Boolean(team));
}

function normalizeProjects(
  value: readonly unknown[] | undefined
): readonly AccountProjectRecord[] {
  return (value ?? [])
    .map((project) => normalizeProject(project))
    .filter((project): project is AccountProjectRecord => Boolean(project));
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

function normalizeTeam(value: unknown): AccountTeamRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const slug = normalizeText(value.slug);
  const name = normalizeText(value.name);
  const organizationId = normalizeText(value.organizationId);
  const createdAt = normalizeText(value.createdAt);
  const updatedAt = normalizeText(value.updatedAt);

  if (!(id && slug && name && organizationId && createdAt && updatedAt)) {
    return null;
  }

  return {
    id,
    slug,
    name,
    organizationId,
    createdAt,
    updatedAt,
  };
}

function normalizeProject(value: unknown): AccountProjectRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const slug = normalizeText(value.slug);
  const name = normalizeText(value.name);
  const createdAt = normalizeText(value.createdAt);
  const updatedAt = normalizeText(value.updatedAt);
  const currentAccessRole = normalizeProjectAccessRole(value.currentAccessRole);
  const ownership = normalizeProjectOwnership(value.ownership);

  if (
    !(
      id &&
      slug &&
      name &&
      createdAt &&
      updatedAt &&
      currentAccessRole &&
      ownership
    )
  ) {
    return null;
  }

  return {
    id,
    slug,
    name,
    currentAccessRole,
    ownership,
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

function normalizeProjectAccess(
  value: readonly unknown[] | undefined
): readonly AccountProjectAccessGrantRecord[] {
  return (value ?? [])
    .map((grant) => normalizeProjectAccessGrant(grant))
    .filter((grant): grant is AccountProjectAccessGrantRecord =>
      Boolean(grant)
    );
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

function normalizeProjectOwnership(
  value: unknown
): AccountProjectOwnershipRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const mode = normalizeProjectOwnershipMode(value.mode);
  const ownerType = normalizeProjectOwnerType(value.ownerType);
  const managedBy = normalizeProjectOwnershipManager(value.managedBy);
  if (!(mode && ownerType && managedBy)) {
    return null;
  }
  return {
    mode,
    ownerType,
    ownerId: normalizeText(value.ownerId),
    ownerSlug: normalizeText(value.ownerSlug),
    ownerName: normalizeText(value.ownerName),
    managedBy,
  };
}

function normalizeProjectAccessGrant(
  value: unknown
): AccountProjectAccessGrantRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const scope = normalizeMembershipScope(value.scope);
  const role = normalizeProjectGrantRole(value.role);
  const subjectId = normalizeText(value.subjectId);
  const subjectSlug = normalizeText(value.subjectSlug);
  const subjectName = normalizeText(value.subjectName);
  const organizationId = normalizeText(value.organizationId);
  const createdAt = normalizeText(value.createdAt);
  const updatedAt = normalizeText(value.updatedAt);

  if (
    !(
      id &&
      scope &&
      role &&
      subjectId &&
      subjectSlug &&
      subjectName &&
      organizationId &&
      createdAt &&
      updatedAt
    )
  ) {
    return null;
  }

  return {
    id,
    scope,
    role,
    subjectId,
    subjectSlug,
    subjectName,
    organizationId,
    teamId: normalizeText(value.teamId),
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

function normalizeProjectOwnershipMode(
  value: unknown
): "local" | "shared" | null {
  return value === "local" || value === "shared" ? value : null;
}

function normalizeProjectOwnerType(
  value: unknown
): "user" | "organization" | "team" | null {
  return value === "user" || value === "organization" || value === "team"
    ? value
    : null;
}

function normalizeProjectOwnershipManager(
  value: unknown
): "local" | "broker" | null {
  return value === "local" || value === "broker" ? value : null;
}

function normalizeProjectAccessRole(
  value: unknown
): "viewer" | "admin" | "owner" | null {
  return value === "viewer" || value === "admin" || value === "owner"
    ? value
    : null;
}

function normalizeProjectGrantRole(value: unknown): "viewer" | "admin" | null {
  return value === "viewer" || value === "admin" ? value : null;
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

function readMappedFeedback<
  TFeedbackByKey extends Record<string, AccountControlPlaneFeedback>,
>(input: {
  readonly feedbackByKey: TFeedbackByKey;
  readonly key: string;
}): AccountControlPlaneFeedback | null {
  return (
    (input.key in input.feedbackByKey
      ? input.feedbackByKey[input.key as keyof TFeedbackByKey]
      : null) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
