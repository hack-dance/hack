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
    if (!html.includes(`href="https://hack.foo${route}"`)) {
      throw new Error(`Canonical missing: ${route}`);
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
      /dogfooding/i.test(text)
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
  ["guides/global-settings", "reference/overview"],
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

// Every rendered diagram a staged page references must reach the browser: the
// page HTML carries both theme variants as images, and each SVG is served.
const stagedRoot = new URL("../../site/content/docs/", import.meta.url)
  .pathname;
const diagramReference = /\/diagrams\/[a-f0-9]+\.(?:light|dark)\.svg/g;
let diagramCount = 0;
for (const file of new Bun.Glob("**/*.md").scanSync({ cwd: stagedRoot })) {
  const references = new Set(
    (await Bun.file(`${stagedRoot}${file}`).text()).match(diagramReference)
  );
  if (references.size === 0) {
    continue;
  }
  const route = `/docs/${file.replace(/\.md$/, "").replace(/\/index$/, "")}`;
  const html = await (await fetch(new URL(route, base))).text();
  for (const reference of references) {
    const variant = reference.includes(".dark.") ? "dark" : "light";
    if (
      !new RegExp(
        `<img[^>]*class="diagram diagram-${variant}"[^>]*src="${reference}"|<img[^>]*src="${reference}"[^>]*class="diagram diagram-${variant}"`
      ).test(html)
    ) {
      throw new Error(`Diagram image missing from ${route}: ${reference}`);
    }
    const image = await fetch(new URL(reference, base));
    if (
      !(
        image.ok &&
        image.headers.get("content-type")?.startsWith("image/svg+xml") &&
        (await image.text()).includes("<svg")
      )
    ) {
      throw new Error(`Diagram not served as SVG: ${reference}`);
    }
    diagramCount += 1;
  }
}
if (diagramCount === 0) {
  throw new Error("No rendered diagrams found in the staged corpus");
}
console.log(`Diagram smoke passed: ${diagramCount} images served.`);

// v5 pages that moved into the native section keep their old routes, with and
// without the version prefix.
for (const [old, target] of [
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
