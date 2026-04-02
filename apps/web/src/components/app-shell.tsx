import { AppNavbar } from "@/components/app-navbar";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { AccountShellContext } from "@/lib/account-shell";

type AuthenticatedAccount = Extract<
  AccountShellContext,
  { readonly authenticated: true }
>;

export function AppShell(input: {
  readonly account: AuthenticatedAccount;
  readonly children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar account={input.account} />
      <SidebarInset>
        <AppNavbar account={input.account} />
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
          {input.children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
