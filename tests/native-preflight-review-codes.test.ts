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
/** A closed error built with a literal code: `problem("code", …)` and its siblings. */
const CLOSED_ERROR =
  /(?<![A-Za-z_:])(?:problem|error|CandidateError::new)\(\s*"([a-z][a-z0-9_]*)"/g;
const TEST_MODULE = "#[cfg(test)]\nmod tests";

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
  for (const path of await rustSources(PROJECT_SOURCES)) {
    const text = await readFile(path, "utf8");
    const inline = text.indexOf(TEST_MODULE);
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
