import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import defaultComponents from "fumadocs-ui/mdx";
import { notFound, redirect } from "next/navigation";
import { sources } from "@/lib/source";

const versionPattern = /^v\d/;
/** Unversioned routes from before the site had versions. */
const legacyRoutes: Record<string, string> = {
  "guides/v5-dogfooding": "getting-started",
  "guides/getting-started": "getting-started",
  "agent-guidance": "agent-handoff",
  "guides/global-settings": "reference/overview",
};
/** v5 pages that moved into the "Native backend (beta)" section. */
const movedV5Routes: Record<string, string> = {
  "guides/native-candidate": "native/full-reference",
  "guides/candidate-install": "native/install",
  "reference/native-authored-commands": "native/authored-commands",
  "reference/native-config-import": "native/config-import",
};
interface Props {
  params: Promise<{ slug?: string[] }>;
}
export default async function Page({ params }: Props) {
  const slug = (await params).slug ?? [];
  if (!slug.length) {
    redirect("/docs/v5");
  }
  const version = slug[0];
  if (version !== "v4" && version !== "v5") {
    if (versionPattern.test(version ?? "")) {
      notFound();
    }
    const path = slug.join("/");
    redirect(`/docs/v5/${legacyRoutes[path] ?? movedV5Routes[path] ?? path}`);
  }
  const page = sources[version].getPage(slug.slice(1));
  if (!page) {
    const moved =
      version === "v5" ? movedV5Routes[slug.slice(1).join("/")] : undefined;
    if (moved) {
      redirect(`/docs/v5/${moved}`);
    }
    notFound();
  }
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsBody>
        <MDX components={defaultComponents} />
      </DocsBody>
    </DocsPage>
  );
}
export function generateStaticParams() {
  return (["v4", "v5"] as const).flatMap((version) =>
    sources[version]
      .getPages()
      .map((page) => ({ slug: [version, ...page.slugs] }))
  );
}
export async function generateMetadata({ params }: Props) {
  const slug = (await params).slug ?? [];
  if (!slug.length) {
    redirect("/docs/v5");
  }
  const version = slug[0];
  if (version !== "v4" && version !== "v5") {
    if (versionPattern.test(version ?? "")) {
      notFound();
    }
    const path = slug.join("/");
    redirect(`/docs/v5/${legacyRoutes[path] ?? movedV5Routes[path] ?? path}`);
  }
  const page = sources[version].getPage(slug.slice(1));
  if (!page) {
    const moved =
      version === "v5" ? movedV5Routes[slug.slice(1).join("/")] : undefined;
    if (moved) {
      redirect(`/docs/v5/${moved}`);
    }
    notFound();
  }
  return { title: page.data.title, alternates: { canonical: page.url } };
}
