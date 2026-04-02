import type { LucideIcon } from "lucide-react";
import {
  BriefcaseIcon,
  Building2Icon,
  KeyRoundIcon,
  PlugIcon,
  TicketIcon,
  UsersIcon,
} from "lucide-react";

export type AccountNavigationItem = {
  readonly title: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly description: string;
};

export const accountNavigationItems = [
  {
    title: "Projects",
    href: "/account/projects",
    icon: BriefcaseIcon,
    description: "Shared repos and current project access.",
  },
  {
    title: "Organizations",
    href: "/account",
    icon: Building2Icon,
    description: "Active org context and available organizations.",
  },
  {
    title: "Teams",
    href: "/account/teams",
    icon: UsersIcon,
    description: "Membership and scoped team access.",
  },
  {
    title: "Integrations",
    href: "/account/integrations",
    icon: PlugIcon,
    description: "GitHub and Linear connection state.",
  },
  {
    title: "Secrets",
    href: "/account/secrets",
    icon: KeyRoundIcon,
    description: "Repo env and secret storage status.",
  },
  {
    title: "Tickets",
    href: "/account/tickets",
    icon: TicketIcon,
    description: "Soon-to-be workflow and issue surfaces.",
  },
] as const satisfies readonly AccountNavigationItem[];

export function resolveAccountPageTitle(input: {
  readonly pathname: string;
}): string {
  const item = accountNavigationItems.find(
    ({ href }) => href === input.pathname
  );
  if (item) {
    return item.title;
  }

  return input.pathname === "/account" ? "Organizations" : "Account";
}

export function resolveAccountPageDescription(input: {
  readonly pathname: string;
}): string | null {
  const item = accountNavigationItems.find(
    ({ href }) => href === input.pathname
  );
  if (item) {
    return item.description;
  }

  return input.pathname === "/account"
    ? "Choose an active organization, review your memberships, and orient yourself in the workspace."
    : null;
}
