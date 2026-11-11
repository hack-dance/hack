/**
 * Check or refresh the example-file blocks in doc pages (see
 * scripts/lib/doc-includes.ts).
 *
 *   bun scripts/refresh-doc-includes.ts docs/recipes/*.md          # check
 *   bun scripts/refresh-doc-includes.ts --write docs/recipes/*.md  # refresh
 *
 * Paths in include markers are relative to the repository root.
 */
import { join } from "node:path";

import { docIncludeIssues, refreshDocIncludes } from "./lib/doc-includes.ts";

const REPO_ROOT = join(import.meta.dir, "..");

async function readRepoFile(path: string): Promise<string | null> {
  const file = Bun.file(join(REPO_ROOT, path));
  return (await file.exists()) ? await file.text() : null;
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const pages = args.filter((arg) => arg !== "--write");
let failed = false;
for (const page of pages) {
  const markdown = await Bun.file(page).text();
  if (write) {
    const refreshed = await refreshDocIncludes({
      markdown,
      readFile: readRepoFile,
    });
    if (refreshed !== markdown) {
      await Bun.write(page, refreshed);
      console.log(`refreshed ${page}`);
    }
  }
  const issues = await docIncludeIssues({
    markdown: write ? await Bun.file(page).text() : markdown,
    readFile: readRepoFile,
  });
  for (const issue of issues) {
    failed = true;
    console.error(`${page}: ${issue}`);
  }
}
process.exit(failed ? 1 : 0);
