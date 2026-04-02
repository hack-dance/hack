"use client";

import Link from "next/link";

import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";

export function MarketingChrome() {
  return (
    <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-end gap-2 p-4 md:p-6">
      <Button asChild size="sm" variant="ghost">
        <Link href="/auth">Sign in</Link>
      </Button>
      <ModeToggle />
    </header>
  );
}
