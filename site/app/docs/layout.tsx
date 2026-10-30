import { sources } from "@/lib/source";
import { VersionedLayout } from "@/components/docs-layout";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <VersionedLayout
      trees={{ v4: sources.v4.pageTree, v5: sources.v5.pageTree }}
      paths={{
        v4: sources.v4.getPages().map((p) => p.url),
        v5: sources.v5.getPages().map((p) => p.url),
      }}
    >
      {children}
    </VersionedLayout>
  );
}
