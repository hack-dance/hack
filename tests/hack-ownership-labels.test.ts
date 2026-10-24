import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HACK_OWNERSHIP_LABEL_NAMESPACES } from "../src/lib/hack-ownership-labels.ts";

/**
 * Pins `HACK_OWNERSHIP_LABEL_NAMESPACES` to the label keys Hack actually
 * writes and verifies. The scan reads the TypeScript CLI and the Rust
 * runtime-core sources (read-only); the two files that only restate the list
 * are left out, so the list cannot satisfy itself.
 */

const REPO = resolve(import.meta.dir, "..");
const PATTERNS = [
  "src/**/*.ts",
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.rs",
  "packages/*/tests/**/*.rs",
];
const RESTATEMENTS = new Set([
  "src/lib/hack-ownership-labels.ts",
  "src/lib/native-compose-backend-features.ts",
]);
const KEY = /\bio\.hack[A-Za-z0-9._-]*/g;

async function scannedLabelKeys(): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const pattern of PATTERNS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: REPO })) {
      if (RESTATEMENTS.has(path) || path.includes("node_modules")) {
        continue;
      }
      const text = await readFile(join(REPO, path), "utf8");
      for (const match of text.matchAll(KEY)) {
        keys.set(match[0], path);
      }
    }
  }
  return keys;
}

function namespaceOf(key: string): string | undefined {
  return HACK_OWNERSHIP_LABEL_NAMESPACES.find(
    (namespace) => key.startsWith(namespace) || `${key}.` === namespace
  );
}

test("every io.hack label key in TypeScript and runtime-core is in a declared ownership namespace", async () => {
  const keys = await scannedLabelKeys();
  // Guard against a scan that silently found nothing.
  expect(keys.size).toBeGreaterThan(10);
  const undeclared = [...keys]
    .filter(([key]) => namespaceOf(key) === undefined)
    .map(([key, path]) => `${key} (${path})`);
  expect(undeclared).toEqual([]);
});

test("every declared ownership namespace is written or verified somewhere", async () => {
  const keys = [...(await scannedLabelKeys()).keys()];
  const unused = HACK_OWNERSHIP_LABEL_NAMESPACES.filter(
    (namespace) => !keys.some((key) => namespaceOf(key) === namespace)
  );
  expect(unused).toEqual([]);
});
