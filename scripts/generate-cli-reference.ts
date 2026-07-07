import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderCliReferenceMarkdown } from "../src/cli/reference.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

/**
 * Regenerates docs/reference/cli.md from CLI_SPEC.
 *
 * Run via `bun run docs:cli-reference`. A drift test
 * (tests/cli-reference-docs.test.ts) fails when the committed file no longer
 * matches the spec, so command/flag documentation cannot rot.
 */
async function main(): Promise<void> {
  const outPath = resolve(import.meta.dir, "..", "docs", "reference", "cli.md");
  const markdown = renderCliReferenceMarkdown({ cli: CLI_SPEC });
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, markdown);
  process.stdout.write(`wrote ${outPath}\n`);
}

await main();
