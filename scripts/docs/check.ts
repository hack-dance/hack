import { resolve } from "node:path";
import {
  prepare,
  repositoryRoot,
  resolvePublicSource,
  rewriteTarget,
} from "./prepare";

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
  (await rewriteTarget("core.md#commands", source)) !== "/docs/core#commands"
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
