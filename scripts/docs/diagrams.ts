/**
 * Render fenced ```mermaid blocks with the pinned Pele renderer (site devDependency,
 * exactly 1.9.0) and the Hack Dance house theme. Each diagram becomes a light and a
 * dark SVG under site/public/diagrams, and the staged page shows the image with the
 * Mermaid source kept underneath in a collapsed block. Links and images are always
 * disabled: diagram text comes from Markdown and is treated as untrusted.
 *
 * The LLM exports keep the raw Mermaid blocks; only the staged pages are rewritten.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const diagramsRoute = "/diagrams";
const repositoryRoot = resolve(import.meta.dir, "../..");
const sitePackage = resolve(repositoryRoot, "site/package.json");
const themePath = resolve(repositoryRoot, "site/lib/diagrams/hackdance.css");
const expectedPele = "1.9.0";
const fence = /^(```|~~~)mermaid[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm;

type Render = (
  source: string,
  options: Record<string, unknown>
) => { svg: string; width: number; height: number };

let renderer: Promise<Render> | undefined;
let theme: string | undefined;

async function loadRenderer(): Promise<Render> {
  const req = createRequire(sitePackage);
  const version = (req("pele/package.json") as { version: string }).version;
  if (version !== expectedPele) {
    throw new Error(`Expected pele ${expectedPele} in site/, found ${version}`);
  }
  const module = (await import(req.resolve("pele"))) as { render: Render };
  return module.render;
}

function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

/** Front-matter `title:` or the diagram keyword, used as the image alt text. */
export function diagramTitle(source: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(source);
  const title = front
    ? /^title:\s*(.+)$/m.exec(front[1] ?? "")?.[1]?.trim()
    : undefined;
  if (title) {
    return title.replace(/^["']|["']$/g, "");
  }
  const body = source.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return `${body.split(/\s+/)[0] ?? "Diagram"} diagram`;
}

export async function renderDiagram(
  source: string
): Promise<{ light: string; dark: string }> {
  renderer ??= loadRenderer();
  theme ??= await Bun.file(themePath).text();
  const render = await renderer;
  const { svg } = render(source, {
    links: false,
    images: false,
    fontFamily: "Geist",
    fontFamilyMono: "Geist Mono",
    fontSize: 15,
    padding: 24,
    config: {
      state: { wrappingWidth: 180 },
      flowchart: { wrappingWidth: 180 },
    },
  });
  const style = `<style><![CDATA[${theme.replaceAll("]]>", "]]]]><![CDATA[>")}]]></style>`;
  const themed = (mode: "light" | "dark") => {
    const opened = svg.replace(/^<svg([^>]*)>/, `<svg$1 data-theme="${mode}">`);
    const end = opened.indexOf(">") + 1;
    return `${opened.slice(0, end)}${style}${opened.slice(end)}`;
  };
  return { light: themed("light"), dark: themed("dark") };
}

export interface DiagramAsset {
  readonly name: string;
  readonly svg: string;
}

/**
 * Replace every Mermaid fence in a staged page with its rendered images. A diagram
 * Pele rejects fails the build with the page and the renderer's message, so an
 * unrendered block never reaches the published site.
 */
export async function embedDiagrams(
  markdown: string,
  assets: Map<string, string>,
  page: string
): Promise<string> {
  const blocks = [...markdown.matchAll(fence)];
  if (blocks.length === 0) {
    return markdown;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const match of blocks) {
    const source = match[2] ?? "";
    const id = hash(source);
    let rendered: { light: string; dark: string };
    try {
      rendered = await renderDiagram(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Diagram render error in ${page}: ${message.split("\n")[0]}`
      );
    }
    assets.set(`${id}.light.svg`, rendered.light);
    assets.set(`${id}.dark.svg`, rendered.dark);
    const alt = diagramTitle(source).replaceAll('"', "&quot;");
    const replacement = [
      `<figure className="diagram">`,
      `  <img alt="${alt}" className="diagram-light" src="${diagramsRoute}/${id}.light.svg" />`,
      `  <img alt="${alt}" className="diagram-dark" src="${diagramsRoute}/${id}.dark.svg" />`,
      "</figure>",
      "",
      "<details>",
      "<summary>Diagram source</summary>",
      "",
      match[0],
      "",
      "</details>",
    ].join("\n");
    parts.push(markdown.slice(cursor, match.index), replacement);
    cursor = (match.index ?? 0) + match[0].length;
  }
  parts.push(markdown.slice(cursor));
  return parts.join("");
}
