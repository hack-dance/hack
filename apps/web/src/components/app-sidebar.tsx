"use client";

import {
  BarChart3Icon,
  BookOpenIcon,
  BriefcaseIcon,
  CreditCardIcon,
  HelpCircleIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  PlugIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";

import { LatestChange } from "@/components/leatest-change";
import { Logo } from "@/components/logo";
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

const navSections: SidebarSection[] = [
  {
    label: "Product",
    items: [
      {
        title: "Dashboard",
        url: "/account",
        icon: <LayoutGridIcon />,
        isActive: true,
      },
      {
        title: "Analytics",
        url: "/account",
        icon: <BarChart3Icon />,
      },
      {
        title: "Projects",
        url: "/account",
        icon: <BriefcaseIcon />,
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        title: "Team",
        url: "/account",
        icon: <UsersIcon />,
      },
      {
        title: "Integrations",
        url: "/account",
        icon: <PlugIcon />,
      },
      {
        title: "API Keys",
        url: "/account",
        icon: <KeyRoundIcon />,
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        title: "Settings",
        url: "/account",
        icon: <SettingsIcon />,
      },
      {
        title: "Billing",
        url: "/account",
        icon: <CreditCardIcon />,
      },
    ],
  },
];

const footerNavLinks: SidebarNavItem[] = [
  {
    title: "Help Center",
    url: "https://github.com/hack-dance/hack",
    icon: <HelpCircleIcon />,
  },
  {
    title: "Documentation",
    url: "https://github.com/hack-dance/hack",
    icon: <BookOpenIcon />,
  },
];

export function AppSidebar() {
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
        <LatestChange />
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
