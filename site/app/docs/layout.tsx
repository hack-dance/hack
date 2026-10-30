import { VersionedLayout } from "@/components/docs-layout";
import { sources } from "@/lib/source";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <VersionedLayout
      paths={{
        v4: sources.v4.getPages().map((p) => p.url),
        v5: sources.v5.getPages().map((p) => p.url),
      }}
      trees={{ v4: sources.v4.pageTree, v5: sources.v5.pageTree }}
    >
      {children}
    </VersionedLayout>
  );
}
