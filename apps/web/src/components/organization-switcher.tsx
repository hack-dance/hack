"use client";

import { Building2Icon, CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AccountShellContext } from "@/lib/account-shell";

type AuthenticatedAccount = Extract<
  AccountShellContext,
  { readonly authenticated: true }
>;

export function OrganizationSwitcher(input: {
  readonly account: AuthenticatedAccount;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedOrganization = searchParams.get("org");
  const selectedOrganization =
    input.account.organizations.find(
      (organization) => organization.slug === requestedOrganization
    ) ?? input.account.activeOrganization;
  const selectedOrganizationName =
    selectedOrganization?.name ??
    selectedOrganization?.id ??
    "Personal workspace";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Switch organization. Current selection: ${selectedOrganizationName}`}
          className="flex w-full items-center justify-between gap-3 border border-sidebar-border bg-sidebar-accent px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/80 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0"
          type="button"
        >
          <span className="flex min-w-0 items-center gap-2 group-data-[collapsible=icon]:contents">
            <span className="flex size-8 shrink-0 items-center justify-center border border-sidebar-border bg-background group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent">
              <Building2Icon aria-hidden className="size-4" />
            </span>
            <span className="min-w-0 group-data-[collapsible=icon]:hidden">
              <span className="block text-[11px] text-sidebar-foreground/55 uppercase tracking-[0.18em]">
                Organization
              </span>
              <span className="block truncate text-sidebar-foreground text-sm">
                {selectedOrganizationName}
              </span>
            </span>
          </span>
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
        {input.account.organizations.length > 0 ? (
          <>
            {input.account.organizations.map((organization) => {
              const href = buildScopedHref({
                organizationSlug: organization.slug,
                pathname,
                searchParams,
              });
              const isActive = organization.slug === requestedOrganization;
              return (
                <DropdownMenuItem asChild key={organization.id}>
                  <Link
                    className="flex items-center justify-between gap-3"
                    href={href}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">
                        {organization.name}
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {organization.slug}
                      </span>
                    </span>
                    {isActive ? (
                      <CheckIcon aria-hidden className="size-4" />
                    ) : null}
                  </Link>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem asChild>
          <Link href={buildScopedHref({ pathname, searchParams })}>
            Clear organization scope
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function buildScopedHref(input: {
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly organizationSlug?: string;
}): string {
  const nextSearchParams = new URLSearchParams(input.searchParams.toString());
  nextSearchParams.delete("team");
  nextSearchParams.delete("project");
  if (input.organizationSlug) {
    nextSearchParams.set("org", input.organizationSlug);
  } else {
    nextSearchParams.delete("org");
  }

  const query = nextSearchParams.toString();
  return query.length > 0 ? `${input.pathname}?${query}` : input.pathname;
}
