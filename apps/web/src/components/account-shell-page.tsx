import ControlPlaneShell from "@/src/components/control-plane-shell";
import {
  buildAccountControlPlanePath,
  resolveAccountControlPlaneFeedback,
} from "@/src/lib/account-control-plane";
import {
  buildAccountShellSignInHref,
  getAccountShellContext,
} from "@/src/lib/account-shell";

export default async function AccountShellPage(input: {
  readonly returnToPath: string;
  readonly searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const searchParams = (await input.searchParams) ?? {};
  const requestedOrganizationKey = readSearchParam(searchParams.org);
  const account = await getAccountShellContext({
    selectedOrganizationKey: requestedOrganizationKey,
  });
  const feedback = resolveAccountControlPlaneFeedback({
    notice: readSearchParam(searchParams.notice),
    error: readSearchParam(searchParams.error),
    requestedOrganizationKey,
    selectedOrganizationVisible: account.authenticated
      ? account.selectedOrganizationVisible
      : true,
  });
  const returnToPath = buildAccountControlPlanePath({
    redirectTo: input.returnToPath,
    org:
      requestedOrganizationKey ??
      (account.authenticated ? account.selectedOrganization?.slug : null),
  });

  return (
    <ControlPlaneShell
      account={account}
      feedback={feedback}
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
