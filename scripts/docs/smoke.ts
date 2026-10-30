import versions from "./versions.json";
const base = new URL(process.argv[2] ?? "http://127.0.0.1:3000");
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
  base.protocol !== "http:"
)
  throw new Error("Use HTTP loopback preview");
async function read(path: string) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (response.status !== 200)
    throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}
if (!(await read("/")).includes("hack.foo"))
  throw new Error("Homepage missing");
const landing = await fetch(new URL("/docs", base), { redirect: "manual" });
if (
  ![307, 308].includes(landing.status) ||
  !landing.headers.get("location")?.endsWith("/docs/v5")
)
  throw new Error("Default docs must redirect to v5");
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
    const route = `/docs/${version}${slug === "index" ? "" : "/" + slug}`;
    const html = await read(route);
    if (!html.includes(`href="https://hack.foo${route}"`))
      throw new Error(`Canonical missing: ${route}`);
    total++;
  }
  const results = JSON.parse(
    await read(`/api/search?version=${version}&query=secrets`)
  );
  if (
    !Array.isArray(results) ||
    !results.length ||
    results.some(
      (r) => typeof r.url !== "string" || !r.url.startsWith(`/docs/${version}/`)
    )
  )
    throw new Error(`Search isolation failed: ${version}`);
  for (const name of ["llms.txt", "llms-full.txt"]) {
    const text = await read(`/${version}/${name}`);
    if (
      !text.includes(`/docs/${version}`) ||
      text.includes(`/docs/${version === "v4" ? "v5" : "v4"}/`) ||
      /dogfooding/i.test(text)
    )
      throw new Error(`Export isolation failed: ${version}/${name}`);
  }
}
for (const path of ["/docs/v99", "/docs/v4/not-a-page"])
  if ((await fetch(new URL(path, base))).status !== 404)
    throw new Error(`Unknown route not rejected: ${path}`);
if (
  (await fetch(new URL("/api/search?version=v99&query=test", base))).status !==
  400
)
  throw new Error("Unknown search version not rejected");
await read("/sitemap.xml");
await read("/robots.txt");
await read("/llms.txt");
await read("/llms-full.txt");
console.log(
  `Versioned HTTP smoke passed: ${total} docs, isolated searches/exports, default redirect and unknown-version refusals.`
);
