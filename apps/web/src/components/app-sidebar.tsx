"use client";

import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Logo } from "@/components/logo";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { accountNavigationItems } from "@/lib/account-navigation";
import type { AccountShellContext } from "@/lib/account-shell";
import { cn } from "@/lib/utils";

export type SidebarNavItem = {
  title: string;
  url: string;
  icon: React.ReactNode;
  isActive?: boolean;
};

type SidebarSection = {
  label: string;
  items: SidebarNavItem[];
};

type AuthenticatedAccount = Extract<
  AccountShellContext,
  { readonly authenticated: true }
>;

const footerNavLinks: SidebarNavItem[] = [
  {
    title: "Documentation",
    url: "https://github.com/hack-dance/hack",
    icon: <ArrowUpRightIcon />,
  },
  {
    title: "GitHub",
    url: "https://github.com/hack-dance/hack",
    icon: <ArrowUpRightIcon />,
  },
];

export function AppSidebar(input: { readonly account: AuthenticatedAccount }) {
  const pathname = usePathname();
  const navSections = buildNavSections({
    pathname,
  });

  return (
    <Sidebar
      className={cn(
        "*:data-[slot=sidebar-inner]:bg-background",
        "**:data-[slot=sidebar-menu-button]:[&>span]:text-foreground/75"
      )}
      collapsible="icon"
      variant="sidebar"
    >
      <SidebarHeader className="h-14 justify-center border-b px-2">
        <SidebarMenuButton asChild>
          <Link href="/">
            <Logo className="size-6" decorative />
            <span className="font-medium">Hack</span>
          </Link>
        </SidebarMenuButton>
      </SidebarHeader>
      <SidebarContent>
        {navSections.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel className="group-data-[collapsible=icon]:pointer-events-none">
              {section.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {section.items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={item.isActive}
                    tooltip={item.title}
                  >
                    <Link href={item.url}>
                      {item.icon}
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-0 p-0">
        <div className="border-t p-2">
          <OrganizationSwitcher account={input.account} />
        </div>
        <SidebarMenu className="border-t p-2">
          {footerNavLinks.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                className="text-muted-foreground"
                isActive={item.isActive ?? false}
                size="sm"
              >
                <a href={item.url} rel="noopener noreferrer" target="_blank">
                  {item.icon}
                  <span>{item.title}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
        <div className="px-4 pt-4 pb-2 transition-opacity group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0">
          <p className="text-nowrap text-[9px] text-muted-foreground">
            © {new Date().getFullYear()} Hack
          </p>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function buildNavSections(input: {
  readonly pathname: string;
}): readonly SidebarSection[] {
  return [
    {
      label: "Workspace",
      items: accountNavigationItems.map((item) => ({
        title: item.title,
        url: item.href,
        icon: <item.icon />,
        isActive:
          item.href === "/account"
            ? input.pathname === "/account"
            : input.pathname.startsWith(item.href),
      })),
    },
  ];
}
