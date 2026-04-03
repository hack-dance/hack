"use client";

import { Building2Icon, LogOutIcon } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AccountShellContext } from "@/lib/account-shell";

const WHITESPACE_PATTERN = /\s+/;

type AuthenticatedAccount = Extract<
  AccountShellContext,
  { readonly authenticated: true }
>;

export function NavUser(input: { readonly account: AuthenticatedAccount }) {
  const userName =
    input.account.user.name ?? input.account.user.email ?? "Hack user";
  const userEmail = input.account.user.email ?? "Signed in";
  const organizationName =
    input.account.activeOrganization?.name ?? "No organization selected";
  const avatarFallback = resolveAvatarFallback({
    email: input.account.user.email,
    name: input.account.user.name,
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Open user menu for ${userName}`}
          className="flex size-8 items-center justify-center border border-transparent transition-colors hover:border-border hover:bg-muted/60"
          type="button"
        >
          <Avatar className="size-8">
            <AvatarImage src={input.account.user.image ?? undefined} />
            <AvatarFallback>{avatarFallback}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem className="flex items-center justify-start gap-2">
          <DropdownMenuLabel className="flex w-full items-center gap-3">
            <Avatar className="size-10">
              <AvatarImage src={input.account.user.image ?? undefined} />
              <AvatarFallback>{avatarFallback}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <span className="block truncate font-medium text-foreground">
                {userName}
              </span>
              <div className="max-w-full overflow-hidden overflow-ellipsis whitespace-nowrap text-muted-foreground text-xs">
                {userEmail}
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link className="flex items-center gap-2" href="/account">
              <Building2Icon />
              {organizationName}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            asChild
            className="w-full cursor-pointer"
            variant="destructive"
          >
            <Link
              className="flex items-center gap-2"
              href="/api/auth/sign-out?redirect=%2Fauth"
            >
              <LogOutIcon />
              Sign out
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function resolveAvatarFallback(input: {
  readonly name: string | null;
  readonly email: string | null;
}): string {
  const name = input.name?.trim();
  if (name) {
    const parts = name.split(WHITESPACE_PATTERN).slice(0, 2);
    return parts.map((part) => part.charAt(0).toUpperCase()).join("");
  }

  return input.email?.charAt(0).toUpperCase() ?? "H";
}
