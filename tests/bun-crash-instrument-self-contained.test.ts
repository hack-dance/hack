import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dir, "../scripts");

/**
 * The gated bun-crash-experiment workflow checks out only these two files and
 * moves them outside the tested tree, so they may import only `node:`
 * modules and each other.
 */
const INSTRUMENT = {
  "bun-crash-loop.ts": ["./lib/bun-crash-classify.ts"],
  "lib/bun-crash-classify.ts": [],
} as const;

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

test("the bun crash loop instrument imports only node: modules and itself", async () => {
  for (const [file, allowed] of Object.entries(INSTRUMENT)) {
    const source = await readFile(resolve(SCRIPTS, file), "utf8");
    const specifiers = [...source.matchAll(SPECIFIER)].map(
      (match) => match[1] ?? ""
    );
    if (file === "bun-crash-loop.ts") {
      // Not vacuous: the loop imports node: modules and the classifier.
      expect(specifiers).toContain("./lib/bun-crash-classify.ts");
    }
    const foreign = specifiers.filter(
      (specifier) =>
        !(
          specifier.startsWith("node:") ||
          (allowed as readonly string[]).includes(specifier)
        )
    );
    expect([file, foreign]).toEqual([file, []]);
  }
});
