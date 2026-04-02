import Link from "next/link";

import {
  AccountEmptyState,
  AccountPageFrame,
  AccountSectionCard,
  AccountStatsGrid,
} from "@/components/account-page-frame";
import { buildAccountControlPlanePath } from "@/lib/account-control-plane";
import { getAccountShellContext } from "@/lib/account-shell";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function AccountTeamsPage(input: {
  readonly searchParams?: SearchParams;
}) {
  const searchParams = (await input.searchParams) ?? {};
  const account = await getAccountShellContext({
    selectedOrganizationKey: readSearchParam(searchParams.org),
    selectedTeamKey: readSearchParam(searchParams.team),
    selectedProjectKey: readSearchParam(searchParams.project),
  });

  if (!account.authenticated) {
    return null;
  }

  return (
    <AccountPageFrame
      description="Teams stay scoped to the selected organization so the shell only shows memberships that matter to the current context."
      title="Teams"
    >
      <AccountStatsGrid
        items={[
          {
            label: "Visible teams",
            value: String(account.teams.length),
          },
          {
            label: "Selected team",
            value: account.selectedTeam?.slug ?? "None",
          },
          {
            label: "Team memberships",
            value: String(account.selectedTeamMemberships.length),
          },
          {
            label: "Org memberships",
            value: String(account.selectedOrganizationMemberships.length),
          },
        ]}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <AccountSectionCard
          description="Team visibility depends on the active organization selection."
          title="Team directory"
        >
          {account.teams.length > 0 ? (
            <div className="divide-y divide-border border border-border">
              {account.teams.map((team) => (
                <Link
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
                  href={buildAccountControlPlanePath({
                    redirectTo: "/account/teams",
                    org: account.selectedOrganization?.slug ?? null,
                    team: team.slug,
                  })}
                  key={team.id}
                >
                  <span>
                    <span className="block font-medium text-foreground">
                      {team.name}
                    </span>
                    <span className="block text-muted-foreground text-xs">
                      {team.slug}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                    {account.selectedTeam?.slug === team.slug
                      ? "Active"
                      : "Open"}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <AccountEmptyState
              body="Select an organization to inspect its teams."
              title="No teams in scope"
            />
          )}
        </AccountSectionCard>

        <AccountSectionCard
          description="Membership stays explicit so the shell does not imply permissions you do not actually have."
          title={account.selectedTeam?.name ?? "Team memberships"}
        >
          {account.selectedTeamMemberships.length > 0 ? (
            <div className="divide-y divide-border border border-border">
              {account.selectedTeamMemberships.map((membership) => (
                <div
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
                  key={membership.id}
                >
                  <span>
                    <span className="block text-foreground">
                      {membership.email ?? membership.target}
                    </span>
                    <span className="block text-muted-foreground text-xs">
                      {membership.scope}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                    {membership.state}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <AccountEmptyState
              body="Choose a team to see the memberships that are currently visible."
              title="No team selected"
            />
          )}
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
