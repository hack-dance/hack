import { DocsBody, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import defaultComponents from "fumadocs-ui/mdx";
import { notFound } from "next/navigation";
import { source } from "@/lib/source";

interface Props {
  params: Promise<{ slug?: string[] }>;
}
export default async function Page({ params }: Props) {
  const page = source.getPage((await params).slug);
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
  return source.generateParams();
}
export async function generateMetadata({ params }: Props) {
  const page = source.getPage((await params).slug);
  if (!page) {
    notFound();
  }
  return { title: page.data.title, alternates: { canonical: page.url } };
}
