import Link from "next/link";

import {
  AccountEmptyState,
  AccountPageFrame,
  AccountSectionCard,
} from "@/components/account-page-frame";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export default function AccountTicketsPage() {
  return (
    <AccountPageFrame
      description="Tickets are intentionally a placeholder in this first shell pass. The nav is real now, and this page marks where lightweight ticket workflows should land next."
      title="Tickets"
    >
      <AccountSectionCard
        action={
          <Button asChild size="sm" variant="outline">
            <a
              href="https://github.com/hack-dance/hack"
              rel="noopener noreferrer"
              target="_blank"
            >
              Open repo
            </a>
          </Button>
        }
        description="This page keeps the information architecture honest without pretending the tickets UX is already built."
        title="Coming next"
      >
        <AccountEmptyState
          body="The shell now has a dedicated tickets area, but the actual ticket workflow still needs a focused design and data pass."
          title="Ticket management is not wired yet"
        />
        <div className="mt-4 flex gap-3">
          <Button asChild size="sm" variant="outline">
            <Link href="/account/projects">Back to projects</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/account/integrations">View integrations</Link>
          </Button>
        </div>
      </AccountSectionCard>
    </AccountPageFrame>
  );
}
