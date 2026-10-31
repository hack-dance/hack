"use client";
import type { Root } from "fumadocs-core/page-tree";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { usePathname, useRouter } from "next/navigation";
export function VersionedLayout({
  children,
  trees,
  paths,
}: {
  children: React.ReactNode;
  trees: { v4: Root; v5: Root };
  paths: { v4: string[]; v5: string[] };
}) {
  const path = usePathname();
  const router = useRouter();
  const version = path.startsWith("/docs/v4") ? "v4" : "v5";
  return (
    <DocsLayout
      githubUrl="https://github.com/hack-dance/hack"
      key={version}
      nav={{ title: "hack.foo", url: "/" }}
      sidebar={{
        banner: (
          <label className="docs-version">
            Docs version{" "}
            <select
              aria-label="Docs version"
              onChange={(e) =>
                router.push(
                  paths[e.target.value as "v4" | "v5"].includes(
                    path.replace(`/docs/${version}`, `/docs/${e.target.value}`)
                  )
                    ? path.replace(
                        `/docs/${version}`,
                        `/docs/${e.target.value}`
                      )
                    : `/docs/${e.target.value}`
                )
              }
              value={version}
            >
              <option value="v5">v5</option>
              <option value="v4">v4</option>
            </select>
          </label>
        ),
      }}
      tree={trees[version]}
    >
      {children}
    </DocsLayout>
  );
}
