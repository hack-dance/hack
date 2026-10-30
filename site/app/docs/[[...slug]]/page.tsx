import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import defaultComponents from "fumadocs-ui/mdx";
import { redirect } from "next/navigation";
import { notFound } from "next/navigation";
import { sources } from "@/lib/source";

interface Props {
  params: Promise<{ slug?: string[] }>;
}
export default async function Page({ params }: Props) {
  const slug = (await params).slug ?? [];
  if (!slug.length) redirect("/docs/v5");
  const version = slug[0];
  if (version !== "v4" && version !== "v5") {
    if (/^v\d/.test(version!)) notFound();
    const legacy = ["guides/v5-dogfooding", "guides/getting-started"].includes(
      slug.join("/")
    )
      ? "getting-started"
      : slug.join("/");
    redirect(`/docs/v5/${legacy}`);
  }
  const page = sources[version].getPage(slug.slice(1));
  if (!page) {
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
  if (!slug.length) redirect("/docs/v5");
  const version = slug[0];
  if (version !== "v4" && version !== "v5") {
    if (/^v\d/.test(version!)) notFound();
    const legacy = ["guides/v5-dogfooding", "guides/getting-started"].includes(
      slug.join("/")
    )
      ? "getting-started"
      : slug.join("/");
    redirect(`/docs/v5/${legacy}`);
  }
  const page = sources[version].getPage(slug.slice(1));
  if (!page) {
    notFound();
  }
  return { title: page.data.title, alternates: { canonical: page.url } };
}
