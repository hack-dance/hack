import { AppShell } from "@/components/app-shell";
import {
  buildAccountShellSignInHref,
  getAccountShellContext,
} from "@/lib/account-shell";
import { redirect } from "@/lib/server-navigation";

export default async function AccountLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const account = await getAccountShellContext();
  if (!account.authenticated) {
    redirect(
      buildAccountShellSignInHref({
        returnToPath: "/account",
      })
    );
  }

  return <AppShell account={account}>{children}</AppShell>;
}
