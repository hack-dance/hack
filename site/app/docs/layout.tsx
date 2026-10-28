import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      githubUrl="https://github.com/hack-dance/hack"
      nav={{ title: "hack", url: "/" }}
      tree={source.pageTree}
    >
      {children}
    </DocsLayout>
  );
}
