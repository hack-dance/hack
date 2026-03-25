import ControlPlaneShell from "@/src/components/control-plane-shell";
import {
  buildAccountShellSignInHref,
  getAccountShellContext,
} from "@/src/lib/account-shell";

export default async function AccountShellPage(input: {
  readonly returnToPath: string;
}) {
  const account = await getAccountShellContext();

  return (
    <ControlPlaneShell
      account={account}
      signInHref={buildAccountShellSignInHref({
        returnToPath: input.returnToPath,
      })}
    />
  );
}
