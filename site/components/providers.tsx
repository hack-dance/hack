"use client";
import { RootProvider } from "fumadocs-ui/provider/next";
import { usePathname } from "next/navigation";
export function Providers({ children }: { children: React.ReactNode }) {
  const version = usePathname().startsWith("/docs/v4") ? "v4" : "v5";
  return (
    <RootProvider
      key={version}
      search={{ options: { api: `/api/search?version=${version}` } }}
    >
      {children}
    </RootProvider>
  );
}
