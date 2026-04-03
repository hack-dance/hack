import ControlPlaneShell from "@/components/control-plane-shell";
import {
  buildAccountControlPlanePath,
  resolveAccountControlPlaneFeedback,
} from "@/lib/account-control-plane";
import {
  buildAccountShellSignInHref,
  getAccountShellContext,
} from "@/lib/account-shell";
import { resolveBrowserSharedProjectScope } from "@/lib/browser-shared-project-scope";
import { loadEnvManagementState } from "@/lib/env-management";
import { loadGitHubManagementState } from "@/lib/github-management";
import { loadLinearManagementState } from "@/lib/linear-management";

export default async function AccountShellPage(input: {
  readonly returnToPath: string;
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
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
  const browserSharedProjectScope = resolveBrowserSharedProjectScope({
    account,
  });
  const [envManagement, githubManagement, linearManagement] = await Promise.all(
    [
      loadEnvManagementState(),
      loadGitHubManagementState({
        browserSharedProjectScope,
      }),
      loadLinearManagementState({
        browserSharedProjectScope,
      }),
    ]
  );
  const feedback = resolveAccountControlPlaneFeedback({
    notice: readSearchParam(searchParams.notice),
    error: readSearchParam(searchParams.error),
    requestedOrganizationKey,
    requestedTeamKey,
    requestedProjectKey,
    selectedOrganizationVisible: account.authenticated
      ? account.selectedOrganizationVisible
      : true,
    selectedTeamVisible: account.authenticated
      ? account.selectedTeamVisible
      : true,
    selectedProjectVisible: account.authenticated
      ? account.selectedProjectVisible
      : true,
  });
  const returnToPath = buildAccountControlPlanePath({
    redirectTo: input.returnToPath,
    org:
      requestedOrganizationKey ??
      (account.authenticated ? account.selectedOrganization?.slug : null),
    team:
      requestedTeamKey ??
      (account.authenticated ? account.selectedTeam?.slug : null),
    project:
      requestedProjectKey ??
      (account.authenticated ? account.selectedProject?.slug : null),
  });

  return (
    <ControlPlaneShell
      account={account}
      envManagement={envManagement}
      feedback={feedback}
      githubManagement={githubManagement}
      linearManagement={linearManagement}
      returnToPath={input.returnToPath}
      signInHref={buildAccountShellSignInHref({
        returnToPath,
      })}
    />
  );
}

function readSearchParam(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
