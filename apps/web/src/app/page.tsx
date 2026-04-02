import { BigLogo } from "@/components/big-logo";
import { MarketingChrome } from "@/components/marketing-chrome";

export default function HomePage() {
  return (
    <div className="relative flex min-h-svh flex-col bg-background">
      <MarketingChrome />
      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-16">
        <BigLogo className="size-36 text-foreground md:size-42" />
      </main>
    </div>
  );
}
