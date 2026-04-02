import Link from "next/link";

import {
  AccountEmptyState,
  AccountPageFrame,
  AccountSectionCard,
  AccountStatsGrid,
} from "@/components/account-page-frame";
import { Button } from "@/components/ui/button";
import {
  buildAccountControlPlanePath,
  resolveAccountControlPlaneFeedback,
} from "@/lib/account-control-plane";
import { getAccountShellContext } from "@/lib/account-shell";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function AccountPage(input: {
  readonly searchParams?: SearchParams;
}) {
  const searchParams = (await input.searchParams) ?? {};
  const requestedOrganizationKey = readSearchParam(searchParams.org);
  const requestedTeamKey = readSearchParam(searchParams.team);
  const requestedProjectKey = readSearchParam(searchParams.project);
  const account = await getAccountShellContext({
    selectedOrganizationKey: requestedOrganizationKey,
    selectedTeamKey: requestedTeamKey,
    selectedProjectKey: requestedProjectKey,
  });

  if (!account.authenticated) {
    return null;
  }

  const feedback = resolveAccountControlPlaneFeedback({
    notice: readSearchParam(searchParams.notice),
    error: readSearchParam(searchParams.error),
    requestedOrganizationKey,
    requestedTeamKey,
    requestedProjectKey,
    selectedOrganizationVisible: account.selectedOrganizationVisible,
    selectedTeamVisible: account.selectedTeamVisible,
    selectedProjectVisible: account.selectedProjectVisible,
  });

  return (
    <AccountPageFrame
      description="Keep the signed-in workspace minimal: choose an organization, confirm your current scope, and jump into the parts of Hack you need."
      title="Organizations"
    >
      {feedback ? (
        <div className="border border-border bg-muted/40 px-4 py-3 text-sm">
          <p className="font-medium text-foreground">{feedback.title}</p>
          <p className="mt-1 text-muted-foreground">{feedback.body}</p>
        </div>
      ) : null}

      <AccountStatsGrid
        items={[
          {
            label: "Organizations",
            value: String(account.organizations.length),
            hint: "Visible to the signed-in account.",
          },
          {
            label: "Teams",
            value: String(account.teams.length),
            hint: "Within the currently selected organization.",
          },
          {
            label: "Projects",
            value: String(account.projects.length),
            hint: "Available to your current workspace access.",
          },
          {
            label: "Invitations",
            value: String(account.incomingInvitations.length),
            hint: "Pending invites waiting for a response.",
          },
        ]}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <AccountSectionCard
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/account/projects">Open projects</Link>
            </Button>
          }
          description="Use this as the main org switcher and current workspace anchor for the rest of the shell."
          title="Available organizations"
        >
          {account.organizations.length > 0 ? (
            <div className="divide-y divide-border border border-border">
              {account.organizations.map((organization) => {
                const isSelected =
                  account.selectedOrganization?.slug === organization.slug;
                const href = buildAccountControlPlanePath({
                  redirectTo: "/account",
                  org: organization.slug,
                });
                return (
                  <Link
                    className="flex items-center justify-between gap-4 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
                    href={href}
                    key={organization.id}
                  >
                    <span>
                      <span className="block font-medium text-foreground">
                        {organization.name}
                      </span>
                      <span className="block text-muted-foreground text-xs">
                        {organization.slug}
                      </span>
                    </span>
                    <span className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                      {isSelected ? "Active" : "Switch"}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <AccountEmptyState
              body="No shared organizations are visible yet. You can still work with local-only state until an org is added."
              title="No organizations yet"
            />
          )}
        </AccountSectionCard>

        <AccountSectionCard
          description="This is the current scoped context the rest of the account routes will use."
          title="Current scope"
        >
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                User
              </dt>
              <dd className="mt-1 text-foreground">
                {account.user.name ?? account.user.email ?? "Signed in"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                Organization
              </dt>
              <dd className="mt-1 text-foreground">
                {account.selectedOrganization?.name ??
                  account.activeOrganization?.name ??
                  "No active organization"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                Team
              </dt>
              <dd className="mt-1 text-foreground">
                {account.selectedTeam?.name ??
                  account.activeTeam?.name ??
                  "No active team"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                Project
              </dt>
              <dd className="mt-1 text-foreground">
                {account.selectedProject?.name ?? "No project selected"}
              </dd>
            </div>
          </dl>
        </AccountSectionCard>
      </div>
    </AccountPageFrame>
  );
}

function readSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
