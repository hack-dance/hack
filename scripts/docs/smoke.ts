import { documents } from "./manifest";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3000");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
  base.protocol !== "http:"
) {
  throw new Error("Docs smoke checks require an HTTP loopback preview URL");
}
async function read(path: string): Promise<string> {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (response.status !== 200) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.text();
}
const home = await read("/");
if (!home.includes("Your machine is the platform.")) {
  throw new Error("Home positioning missing");
}
const routes = documents.map(
  ([, slug]) => `/docs${slug === "index" ? "" : `/${slug}`}`
);
for (const route of routes) {
  const html = await read(route);
  if (!html.includes(`href="https://hack.foo${route}"`)) {
    throw new Error(`Missing canonical URL: ${route}`);
  }
}
for (const [name, marker] of [
  ["llms.txt", "https://hack.foo/docs"],
  ["llms-full.txt", "<!-- Source: docs/README.md;"],
] as const) {
  const corpus = await read(`/${name}`);
  if (!corpus.includes(marker)) {
    throw new Error(`${name}: canonical export missing`);
  }
}
const sitemap = await read("/sitemap.xml");
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  (match) => match[1]
);
if (
  urls.length !== routes.length + 1 ||
  !["/", ...routes].every((route) => urls.includes(`https://hack.foo${route}`))
) {
  throw new Error("Sitemap does not match the public corpus");
}
const results: unknown = JSON.parse(await read("/api/search?query=secrets"));
if (!Array.isArray(results) || results.length === 0) {
  throw new Error("Public search returned no results for secrets");
}
for (const result of results) {
  if (
    typeof result !== "object" ||
    result === null ||
    !("url" in result) ||
    typeof result.url !== "string" ||
    !routes.includes(result.url.split("#")[0] ?? "")
  ) {
    throw new Error("Search result escaped the public corpus");
  }
}
if (
  !(await read("/robots.txt")).includes("Sitemap: https://hack.foo/sitemap.xml")
) {
  throw new Error("Robots sitemap missing");
}
console.log(
  `HTTP smoke passed: home, ${routes.length} canonical docs, search (${results.length} results), sitemap, robots and both LLM exports.`
);
