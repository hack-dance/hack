import {
  AccountEmptyState,
  AccountPageFrame,
  AccountSectionCard,
  AccountStatsGrid,
} from "@/components/account-page-frame";
import { getAccountShellContext } from "@/lib/account-shell";
import { resolveBrowserSharedProjectScope } from "@/lib/browser-shared-project-scope";
import { loadGitHubManagementState } from "@/lib/github-management";
import { loadLinearManagementState } from "@/lib/linear-management";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default async function AccountIntegrationsPage(input: {
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

  const browserSharedProjectScope = resolveBrowserSharedProjectScope({
    account,
  });
  const [githubManagement, linearManagement] = await Promise.all([
    loadGitHubManagementState({
      browserSharedProjectScope,
    }),
    loadLinearManagementState({
      browserSharedProjectScope,
    }),
  ]);

  return (
    <AccountPageFrame
      description="Keep integrations operational and honest. The shell should show whether GitHub and Linear are actually usable right now, not just configured in theory."
      title="Integrations"
    >
      <AccountStatsGrid
        items={[
          {
            label: "GitHub",
            value: githubManagement.readiness.ready
              ? "Ready"
              : "Needs attention",
          },
          {
            label: "Linear",
            value: linearManagement.summary.connected ? "Connected" : "Repair",
          },
          {
            label: "Current project",
            value: account.selectedProject?.slug ?? "None",
          },
          {
            label: "Selected org",
            value: account.selectedOrganization?.slug ?? "None",
          },
        ]}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <AccountSectionCard
          description={githubManagement.readiness.detail}
          title="GitHub"
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <IntegrationValue
              label="Active profile"
              value={githubManagement.selectedProfile}
            />
            <IntegrationValue
              label="Source"
              value={githubManagement.selectedSource}
            />
            <IntegrationValue
              label="Account"
              value={githubManagement.accountLogin ?? "Not resolved"}
            />
            <IntegrationValue
              label="Installation"
              value={githubManagement.installationId ?? "Missing"}
            />
          </dl>
        </AccountSectionCard>

        <AccountSectionCard
          description={linearManagement.summary.routingSummary}
          title="Linear"
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <IntegrationValue
              label="Active profile"
              value={linearManagement.selectedProfile}
            />
            <IntegrationValue
              label="Source"
              value={linearManagement.selectedSource}
            />
            <IntegrationValue
              label="Account"
              value={linearManagement.accountEmail ?? "Not resolved"}
            />
            <IntegrationValue
              label="Bound project"
              value={
                linearManagement.projectBinding.defaultProject?.label ??
                linearManagement.summary.linkedProjectsLabel ??
                "None"
              }
            />
          </dl>
        </AccountSectionCard>
      </div>

      {githubManagement.readiness.ready ||
      linearManagement.summary.connected ? null : (
        <AccountEmptyState
          body="Neither integration is fully ready yet. This page is intentionally compact for the first shell pass, so it focuses on current state before deeper repair actions."
          title="Integration follow-up still needed"
        />
      )}
    </AccountPageFrame>
  );
}

function IntegrationValue(input: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
        {input.label}
      </dt>
      <dd className="mt-1 text-foreground">{input.value}</dd>
    </div>
  );
}

function readSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
