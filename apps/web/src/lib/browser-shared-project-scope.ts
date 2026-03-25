import type { AccountProjectOwnershipRecord } from "./account-control-plane";
import type { AccountShellContext } from "./account-shell";

type SharedProjectAccessRole = "viewer" | "admin" | "owner";

export type BrowserSharedProjectScopeSummary = {
  readonly state: "local_only" | "shared_visible" | "shared_hidden";
  readonly mutable: boolean;
  readonly summary: string;
  readonly detail: string;
  readonly projectSlug: string;
  readonly currentAccessRole: SharedProjectAccessRole | null;
  readonly ownerType: AccountProjectOwnershipRecord["ownerType"] | null;
  readonly ownerId: string | null;
  readonly ownerSlug: string | null;
  readonly ownerName: string | null;
};

export function resolveBrowserSharedProjectScope(input: {
  readonly account: AccountShellContext;
}): BrowserSharedProjectScopeSummary | null {
  if (!input.account.authenticated) {
    return null;
  }

  const scopeLabel = describeActiveBrowserScope({
    account: input.account,
  });
  if (
    input.account.requestedProjectKey &&
    input.account.selectedProjectVisible === false &&
    !input.account.selectedProject
  ) {
    return {
      state: "shared_hidden",
      mutable: false,
      summary: `Shared project scope denied for ${input.account.requestedProjectKey}.`,
      detail: `${scopeLabel} does not expose the shared project registration for this repo.`,
      projectSlug: input.account.requestedProjectKey,
      currentAccessRole: null,
      ownerType: null,
      ownerId: null,
      ownerSlug: null,
      ownerName: null,
    };
  }

  const selectedProject = input.account.selectedProject;
  if (!selectedProject) {
    return null;
  }

  if (selectedProject.ownership.mode === "local") {
    return {
      state: "local_only",
      mutable: true,
      summary: `This repo currently uses local project ownership for ${selectedProject.slug}.`,
      detail:
        "GitHub and Linear readiness remain repo-local until this project is registered with a shared organization or team owner.",
      projectSlug: selectedProject.slug,
      currentAccessRole: selectedProject.currentAccessRole,
      ownerType: selectedProject.ownership.ownerType,
      ownerId: selectedProject.ownership.ownerId,
      ownerSlug: selectedProject.ownership.ownerSlug,
      ownerName: selectedProject.ownership.ownerName,
    };
  }

  const mutable = selectedProject.currentAccessRole !== "viewer";
  return {
    state: "shared_visible",
    mutable,
    summary: mutable
      ? `Shared project scope is active for ${selectedProject.slug}.`
      : `Shared project scope is read-only for ${selectedProject.slug}.`,
    detail: mutable
      ? `${scopeLabel} can manage shared integration resources for this repo.`
      : `${scopeLabel} can inspect shared integration resources for this repo, but mutations stay blocked while the current role is viewer.`,
    projectSlug: selectedProject.slug,
    currentAccessRole: selectedProject.currentAccessRole,
    ownerType: selectedProject.ownership.ownerType,
    ownerId: selectedProject.ownership.ownerId,
    ownerSlug: selectedProject.ownership.ownerSlug,
    ownerName: selectedProject.ownership.ownerName,
  };
}

function describeActiveBrowserScope(input: {
  readonly account: Extract<
    AccountShellContext,
    { readonly authenticated: true }
  >;
}): string {
  const teamName =
    input.account.selectedTeam?.name ??
    input.account.activeTeam?.name ??
    input.account.selectedTeam?.id ??
    input.account.activeTeam?.id;
  if (teamName) {
    return `The active team ${teamName}`;
  }

  const organizationName =
    input.account.selectedOrganization?.name ??
    input.account.activeOrganization?.name ??
    input.account.selectedOrganization?.id ??
    input.account.activeOrganization?.id;
  if (organizationName) {
    return `The active organization ${organizationName}`;
  }

  return "The current Hack account context";
}
