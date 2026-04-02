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

export default async function AccountProjectsPage(input: {
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
      description="Keep project access visible and simple: which projects exist, who owns them, and what the current scope can actually use."
      title="Projects"
    >
      <AccountStatsGrid
        items={[
          {
            label: "Visible projects",
            value: String(account.projects.length),
          },
          {
            label: "Current access",
            value: account.selectedProject?.currentAccessRole ?? "None",
          },
          {
            label: "Access grants",
            value: String(account.selectedProjectAccess.length),
          },
          {
            label: "Selected org",
            value: account.selectedOrganization?.slug ?? "None",
          },
        ]}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <AccountSectionCard
          description="Pick a project to inspect its ownership and access grants."
          title="Project directory"
        >
          {account.projects.length > 0 ? (
            <div className="divide-y divide-border border border-border">
              {account.projects.map((project) => (
                <Link
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
                  href={buildAccountControlPlanePath({
                    redirectTo: "/account/projects",
                    org: account.selectedOrganization?.slug ?? null,
                    team: account.selectedTeam?.slug ?? null,
                    project: project.slug,
                  })}
                  key={project.id}
                >
                  <span>
                    <span className="block font-medium text-foreground">
                      {project.name}
                    </span>
                    <span className="block text-muted-foreground text-xs">
                      {project.slug}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                    {project.currentAccessRole}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <AccountEmptyState
              body="No projects are visible in the current scope yet."
              title="No projects available"
            />
          )}
        </AccountSectionCard>

        <AccountSectionCard
          description="The selected project stays intentionally light in this first pass."
          title={account.selectedProject?.name ?? "Selected project"}
        >
          {account.selectedProject ? (
            <div className="space-y-5 text-sm">
              <dl className="space-y-4">
                <div>
                  <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                    Ownership
                  </dt>
                  <dd className="mt-1 text-foreground">
                    {account.selectedProject.ownership.ownerName ??
                      account.selectedProject.ownership.ownerType}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                    Managed by
                  </dt>
                  <dd className="mt-1 text-foreground">
                    {account.selectedProject.ownership.managedBy}
                  </dd>
                </div>
              </dl>
              {account.selectedProjectAccess.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                    Access grants
                  </p>
                  <div className="divide-y divide-border border border-border">
                    {account.selectedProjectAccess.map((grant) => (
                      <div
                        className="flex items-center justify-between gap-4 px-4 py-3"
                        key={grant.id}
                      >
                        <span>
                          <span className="block text-foreground">
                            {grant.subjectName}
                          </span>
                          <span className="block text-muted-foreground text-xs">
                            {grant.scope}
                          </span>
                        </span>
                        <span className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                          {grant.role}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <AccountEmptyState
                  body="Select a project with shared access grants to see them here."
                  title="No access grants to show"
                />
              )}
            </div>
          ) : (
            <AccountEmptyState
              body="Choose a project from the directory to inspect its current access."
              title="No project selected"
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
