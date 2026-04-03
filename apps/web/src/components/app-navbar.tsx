"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { CustomSidebarTrigger } from "@/components/custom-sidebar-trigger";
import { NavUser } from "@/components/nav-user";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { resolveAccountPageTitle } from "@/lib/account-navigation";
import type { AccountShellContext } from "@/lib/account-shell";
import { cn } from "@/lib/utils";

type AuthenticatedAccount = Extract<
  AccountShellContext,
  { readonly authenticated: true }
>;

export function AppNavbar(input: { readonly account: AuthenticatedAccount }) {
  const pathname = usePathname();
  const pageTitle = resolveAccountPageTitle({
    pathname,
  });
  const isOverview = pathname === "/account";

  return (
    <header
      className={cn(
        "sticky top-0 z-50 flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4 md:px-6",
        "bg-background/95 backdrop-blur-sm supports-backdrop-filter:bg-background/60"
      )}
    >
      <div className="flex items-center gap-3">
        <CustomSidebarTrigger />
        <Separator
          className="mr-2 h-4 data-[orientation=vertical]:self-center"
          orientation="vertical"
        />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              {isOverview ? (
                <BreadcrumbPage>Account</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href="/account">Account</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {isOverview ? null : (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{pageTitle}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <div className="flex items-center gap-3">
        <NavUser account={input.account} />
      </div>
    </header>
  );
}
