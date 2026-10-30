import { resolve } from "node:path";
import {
  prepare,
  repositoryRoot,
  resolvePublicSource,
  rewriteTarget,
} from "./prepare";
import { isVersionedSearchUrl } from "./version-boundary";

await prepare(true);
// Boundary checks: traversal, private evidence, untracked input must never become a link.
const source = resolve(repositoryRoot, "docs/README.md");
for (const target of [
  "../../outside.md",
  "../_docs/private.md",
  "../_internal/native-evidence.md",
  "https://example.com/%5Fdocs/private.md",
  "javascript:alert(1)",
  "../.hack-local/evidence.md",
  "../test-execution/log.md",
  "missing-public-document.md",
]) {
  let rejected = false;
  try {
    await rewriteTarget(target, source);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Public boundary accepted ${target}`);
  }
}
if (
  (await rewriteTarget("core.md#commands", source)) !== "/docs/v4/core#commands"
) {
  throw new Error("Canonical doc links must use site routes");
}
console.log("Public link boundaries and canonical route rewriting passed.");

// Manifest inputs are independently validated before realpath/Bun.file can read them.
for (const file of [
  "docs/../../outside.md",
  "docs/../README.md",
  "/tmp/outside.md",
  "../docs/core.md",
  "docs/_internal/native-evidence.md",
  "docs/core.ts",
  "docs/../docs/core.md",
  "docs\\..\\outside.md",
]) {
  let rejected = false;
  try {
    resolvePublicSource(file);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Manifest boundary accepted ${file}`);
  }
}
if (
  resolvePublicSource("docs/core.md") !==
  resolve(repositoryRoot, "docs/core.md")
) {
  throw new Error("Canonical Markdown source rejected");
}
console.log(
  "Manifest source containment and Markdown schema boundaries passed."
);

for (const version of ["v4", "v5"]) {
  const corpus = await Bun.file(
    resolve(repositoryRoot, `site/public/${version}/llms-full.txt`)
  ).text();
  const other = version === "v4" ? "v5" : "v4";
  if (
    corpus.includes(`https://hack.foo/docs/${other}/`) ||
    /dogfooding/i.test(corpus)
  ) {
    throw new Error(`Mixed or obsolete public corpus: ${version}`);
  }
  const index = await Bun.file(
    resolve(repositoryRoot, `site/public/${version}/llms.txt`)
  ).text();
  for (const route of ["install", "getting-started", "agent-handoff"]) {
    if (!index.includes(`/docs/${version}/${route}`)) {
      throw new Error(`Missing entry point: ${version}/${route}`);
    }
  }
}
if (
  (await Bun.file(resolve(repositoryRoot, "site/public/llms.txt")).text()) !==
  (await Bun.file(resolve(repositoryRoot, "site/public/v5/llms.txt")).text())
) {
  throw new Error("Default agent index must select v5");
}
console.log(
  "Version-isolated exports, entry points and default version passed."
);

for (const version of ["v4", "v5"] as const) {
  const other = version === "v4" ? "v5" : "v4";
  for (const url of [
    `/docs/${version}`,
    `/docs/${version}#setup`,
    `/docs/${version}/install`,
    `/docs/${version}/env#keys`,
  ]) {
    if (!isVersionedSearchUrl(url, version)) {
      throw new Error(`Rejected valid search URL: ${url}`);
    }
  }
  for (const url of [
    `/docs/${other}`,
    `/docs/${other}/install`,
    `/docs/${version}0`,
    `/docs/${version}-other`,
    `/docs/${version}/../${other}/env`,
    `//example.com/docs/${version}`,
    `/\\example.com/docs/${version}`,
    `https://example.com/docs/${version}`,
    null,
  ]) {
    if (isVersionedSearchUrl(url, version)) {
      throw new Error(`Accepted escaping search URL: ${url}`);
    }
  }
}
console.log(
  "Search index/anchor acceptance and cross-version negative controls passed."
);
