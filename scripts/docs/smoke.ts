import { assertPinnedInstallers } from "./installer-pin";
import { publishedTerminology } from "./prepare";
import { isVersionedSearchUrl } from "./version-boundary";
import versions from "./versions.json";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3000");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
  base.protocol !== "http:"
) {
  throw new Error("Use HTTP loopback preview");
}
async function read(path: string) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (response.status !== 200) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.text();
}
if (!(await read("/")).includes("hack.foo")) {
  throw new Error("Homepage missing");
}
const landing = await fetch(new URL("/docs", base), { redirect: "manual" });
if (
  !(
    [307, 308].includes(landing.status) &&
    landing.headers.get("location")?.endsWith("/docs/v5")
  )
) {
  throw new Error("Default docs must redirect to v5");
}
let total = 0;
for (const version of ["v4", "v5"] as const) {
  const m = versions[version];
  const pages = [
    ...m.entries.filter(
      (e) => !m.editorial.some((page) => page.slug === e.slug)
    ),
    ...m.editorial,
  ];
  for (const { slug } of pages) {
    const route = `/docs/${version}${slug === "index" ? "" : `/${slug}`}`;
    const html = await read(route);
    if (/<img\b[^>]*\bsrc=["'](?:https?:)?\/\//i.test(html)) {
      throw new Error(`Remote image embed in rendered page: ${route}`);
    }
    if (!html.includes(`href="https://hack.foo${route}"`)) {
      throw new Error(`Canonical missing: ${route}`);
    }
    if (version === "v5") {
      const prerelease = /next\.(\d+)/.exec(m.label)?.[1];
      if (!prerelease) {
        throw new Error("Missing v5 prerelease pin");
      }
      assertPinnedInstallers({
        text: html,
        tag: `v5.0.0-next.${prerelease}`,
        source: route,
      });
    }
    total++;
  }
  const results = JSON.parse(
    await read(`/api/search?version=${version}&query=secrets`)
  );
  if (
    !(Array.isArray(results) && results.length) ||
    results.some((r) => !isVersionedSearchUrl(r.url, version))
  ) {
    throw new Error(`Search isolation failed: ${version}`);
  }
  for (const name of ["llms.txt", "llms-full.txt"]) {
    const text = await read(`/${version}/${name}`);
    if (
      !text.includes(`/docs/${version}`) ||
      text.includes(`/docs/${version === "v4" ? "v5" : "v4"}/`) ||
      publishedTerminology(text) !== text
    ) {
      throw new Error(`Export isolation failed: ${version}/${name}`);
    }
  }
}
for (const path of ["/docs/v99", "/docs/v4/not-a-page"]) {
  if ((await fetch(new URL(path, base))).status !== 404) {
    throw new Error(`Unknown route not rejected: ${path}`);
  }
}
if (
  (await fetch(new URL("/api/search?version=v99&query=test", base))).status !==
  400
) {
  throw new Error("Unknown search version not rejected");
}
await read("/sitemap.xml");
await read("/robots.txt");
await read("/llms.txt");
await read("/llms-full.txt");
console.log(
  `Versioned HTTP smoke passed: ${total} docs, isolated searches/exports, default redirect and unknown-version refusals.`
);

for (const [old, target] of [
  ["agent-guidance", "agent-handoff"],
  ["guides/global-settings", "guides/global-settings"],
  ["guides/getting-started", "getting-started"],
  ["guides/v5-dogfooding", "getting-started"],
]) {
  const response = await fetch(new URL(`/docs/${old}`, base), {
    redirect: "manual",
  });
  if (
    !(
      [307, 308].includes(response.status) &&
      response.headers.get("location")?.endsWith(`/docs/v5/${target}`)
    )
  ) {
    throw new Error(`Legacy redirect failed: ${old}`);
  }
}

// Every Mermaid block in a published source must reach the browser as its two
// Pele renders. The count comes from the sources, not from the staged output,
// so a page whose diagrams are dropped anywhere in the pipeline fails here.
const repositoryRoot = new URL("../../", import.meta.url).pathname;
const mermaidFence = /^(?:```|~~~)mermaid[ \t]*$/gm;
const diagramImage = /<img\b[^>]*>/g;
const expandControl =
  /<button\b[^>]*aria-label="Open diagram full size: [^"]*"[^>]*class="diagram-expand"|<button\b[^>]*class="diagram-expand"[^>]*aria-label="Open diagram full size: [^"]*"/g;
const diagramSource = /src="(\/diagrams\/[a-f0-9]+\.(light|dark)\.svg)"/;
let diagramBlocks = 0;
const diagramFiles = new Set<string>();
for (const version of ["v4", "v5"] as const) {
  const m = versions[version];
  const sources = [
    ...m.entries
      .filter((e) => !m.editorial.some((page) => page.slug === e.slug))
      .map((e) => ({ slug: e.slug, file: e.snapshot })),
    ...m.editorial.map((page) => ({
      slug: page.slug,
      file: `docs/versions/${version}/${page.slug}.md`,
    })),
  ];
  for (const { slug, file } of sources) {
    const blocks = (
      (await Bun.file(`${repositoryRoot}${file}`).text()).match(mermaidFence) ??
      []
    ).length;
    if (blocks === 0) {
      continue;
    }
    const route = `/docs/${version}${slug === "index" ? "" : `/${slug}`}`;
    const shown = { light: 0, dark: 0 };
    const html = await read(route);
    for (const tag of html.match(diagramImage) ?? []) {
      const source = diagramSource.exec(tag);
      const variant = source?.[2] as "light" | "dark" | undefined;
      if (
        source?.[1] &&
        variant &&
        tag.includes(`class="diagram diagram-${variant}"`)
      ) {
        shown[variant] += 1;
        diagramFiles.add(source[1]);
      }
    }
    if (shown.light !== blocks || shown.dark !== blocks) {
      throw new Error(
        `${route}: ${blocks} Mermaid blocks but ${shown.light} light and ${shown.dark} dark diagram images`
      );
    }
    // Each image carries the control that opens it full size.
    const controls = (html.match(expandControl) ?? []).length;
    if (controls !== blocks * 2) {
      throw new Error(
        `${route}: ${blocks * 2} diagram images but ${controls} full-size controls`
      );
    }
    diagramBlocks += blocks;
  }
}
if (diagramBlocks === 0) {
  throw new Error("No Mermaid blocks found in the published sources");
}
for (const file of diagramFiles) {
  const image = await fetch(new URL(file, base), {
    signal: AbortSignal.timeout(20_000),
  });
  if (
    !(
      image.status === 200 &&
      image.headers.get("content-type")?.startsWith("image/svg+xml") &&
      (await image.text()).includes("<svg")
    )
  ) {
    throw new Error(`Diagram not served as SVG: ${file}`);
  }
}
console.log(
  `Diagram smoke passed: ${diagramBlocks} Mermaid blocks shown as ${diagramFiles.size} served SVGs.`
);

// Recipe pages contain copy-paste examples, so check their rendered links too:
// a multiline Markdown link can escape the preparation step's line-based rewrite.
const recipeLinks = new Map<string, string>();
const recipeEntryPoints = new Set([
  "index",
  "env",
  "reference/configuration-fields",
  "guides/upgrade-from-v4",
  "native/start",
  "troubleshooting",
  "native/setup",
  "native/log-follow",
]);
const v5Slugs = new Set(
  [...versions.v5.entries, ...versions.v5.editorial].map((page) => page.slug)
);
for (const slug of v5Slugs) {
  if (!(slug.startsWith("recipes/") || recipeEntryPoints.has(slug))) {
    continue;
  }
  const route = `/docs/v5${slug === "index" ? "" : `/${slug}`}`;
  const html = await read(route);
  if (html.includes("language-mermaid")) {
    throw new Error(`Unrendered Mermaid source: ${route}`);
  }
  for (const match of html.matchAll(/href="([^"<>]+)"/g)) {
    const url = new URL(match[1] ?? "", new URL(route, base));
    if (
      (url.origin === base.origin || url.origin === "https://hack.foo") &&
      (url.pathname === "/docs/v5" || url.pathname.startsWith("/docs/v5/"))
    ) {
      recipeLinks.set(`${url.pathname}${url.hash}`, route);
    }
  }
}
for (const [target, source] of recipeLinks) {
  const url = new URL(target, base);
  const html = await read(url.pathname);
  const id = decodeURIComponent(url.hash.slice(1)).replaceAll("&", "&amp;");
  if (id && !html.includes(`id="${id}"`)) {
    throw new Error(`Missing recipe link anchor: ${source} -> ${target}`);
  }
}
console.log(
  `Recipe smoke passed: ${recipeLinks.size} local links and anchors.`
);

// Section roots must reach the overview, including through the legacy redirect.
for (const prefix of ["/docs/v5/", "/docs/"]) {
  const response = await fetch(new URL(`${prefix}recipes`, base), {
    signal: AbortSignal.timeout(20_000),
  });
  if (
    response.status !== 200 ||
    new URL(response.url).pathname !== "/docs/v5/recipes/overview" ||
    !(await response.text()).includes(
      'href="https://hack.foo/docs/v5/recipes/overview"'
    )
  ) {
    throw new Error(`Recipes section root failed: ${prefix}recipes`);
  }
}

// v5 aliases keep their old routes, with and without the version prefix.
for (const [old, target] of [
  ["recipes", "recipes/overview"],
  ["guides/native-candidate", "native/full-reference"],
  ["guides/candidate-install", "native/install"],
  ["reference/native-authored-commands", "native/authored-commands"],
  ["reference/native-config-import", "native/config-import"],
]) {
  for (const prefix of ["/docs/v5/", "/docs/"]) {
    const response = await fetch(new URL(`${prefix}${old}`, base), {
      redirect: "manual",
    });
    if (
      !(
        [307, 308].includes(response.status) &&
        response.headers.get("location")?.endsWith(`/docs/v5/${target}`)
      )
    ) {
      throw new Error(`Moved-page redirect failed: ${prefix}${old}`);
    }
  }
}
