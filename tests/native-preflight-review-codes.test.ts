import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REVIEW_FAILURE_CODES,
  REVIEW_STOP_CODES,
} from "../src/backends/native-preflight.ts";

/**
 * The native preflight reports a failed review request as a project blocker
 * only for codes it knows are a verdict on the project
 * (`REVIEW_STOP_CODES`). Every other code is an unavailable review that exits
 * 0. A project code missing from that set would therefore tell a user "no
 * blockers" for a project native `up` refuses.
 *
 * This reads the runtime's project sources and requires every closed error
 * code they can fail with to be classified, in exactly one of the two sets.
 * When it fails, decide which set the new code belongs to.
 */

const PROJECT_SOURCES = "packages/runtime-core/src/project";
/**
 * A closed error built with a literal code: `problem("code", …)` and its
 * siblings, bare or path-qualified (`super::problem(`). `Diagnostic::error(`
 * is a collected review diagnostic, not a failed request, and is excluded.
 */
const CLOSED_ERROR =
  /(?<![A-Za-z_])(?<!Diagnostic::)(?:(?:super|crate|self)::)*(?:problem|error|CandidateError::new)\(\s*"([a-z][a-z0-9_]*)"/g;
/** A helper that takes the code as a parameter hides its literals from the scan above. */
const CODE_PARAMETER_HELPER = /fn (\w+)\(\s*code: &'static str/g;
/**
 * The helpers that exist today. `problem` and `error` are the constructors the
 * scan follows. `failed_service_error` is only called while a graph executes,
 * which a review never reaches. A new helper must be looked at and added here.
 */
const KNOWN_CODE_HELPERS = new Set([
  "problem",
  "error",
  "failed_service_error",
]);
/**
 * Inline unit tests (`mod tests { … }`) are cut off before scanning. That is
 * only safe while such a module is the last item in its file, which the test
 * below checks. A `mod tests;` declaration names a separate file, which the
 * directory walk skips, and is not a cut point.
 */
const TEST_MODULE = "#[cfg(test)]\nmod tests {";

async function rustSources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") {
        found.push(...(await rustSources(path)));
      }
    } else if (entry.name.endsWith(".rs") && entry.name !== "tests.rs") {
      found.push(path);
    }
  }
  return found;
}

test("every closed error code of the runtime's project module is classified for the preflight", async () => {
  const codes = new Set<string>();
  const helpers = new Set<string>();
  for (const path of await rustSources(PROJECT_SOURCES)) {
    const text = await readFile(path, "utf8");
    const inline = text.indexOf(TEST_MODULE);
    for (const helper of text.matchAll(CODE_PARAMETER_HELPER)) {
      if (helper[1] !== undefined) {
        helpers.add(helper[1]);
      }
    }
    if (inline >= 0) {
      // Nothing but the module's own body may follow the cut.
      expect(
        text
          .slice(inline + TEST_MODULE.length)
          .trimEnd()
          .endsWith("}")
      ).toBe(true);
      expect(text.indexOf(TEST_MODULE, inline + 1)).toBe(-1);
    }
    for (const match of (inline < 0 ? text : text.slice(0, inline)).matchAll(
      CLOSED_ERROR
    )) {
      if (match[1] !== undefined) {
        codes.add(match[1]);
      }
    }
  }
  // The scan found the sources: a broken pattern must not pass as "nothing to classify".
  expect(codes.size).toBeGreaterThan(80);
  expect(codes.has("invalid_mount")).toBe(true);
  expect(codes.has("invalid_routing_labels")).toBe(true);
  // A path-qualified call is found too.
  expect(codes.has("invalid_capability_list")).toBe(true);
  expect([...helpers].filter((name) => !KNOWN_CODE_HELPERS.has(name))).toEqual(
    []
  );
  const unclassified = [...codes]
    .filter(
      (code) => !(REVIEW_STOP_CODES.has(code) || REVIEW_FAILURE_CODES.has(code))
    )
    .sort();
  expect(unclassified).toEqual([]);
});

test("no code is both a project verdict and a runtime failure", () => {
  expect(
    [...REVIEW_STOP_CODES].filter((code) => REVIEW_FAILURE_CODES.has(code))
  ).toEqual([]);
});
