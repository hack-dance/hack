import { expect, test } from "bun:test";
import { DOCTOR_CHECK_IDS } from "../src/lib/doctor-metadata.ts";

const CLASSIFIER = "apps/desktop/core/src/doctor.rs";
const EXACT_ID = /"([^"]+)"/g;
const PREFIX = /id\.starts_with\("([^"]+)"\)/g;

test("Desktop classifies every CLI Doctor check ID", async () => {
  const source = await Bun.file(
    new URL(`../${CLASSIFIER}`, import.meta.url)
  ).text();
  const classifier = source.split("pub fn classify(")[1] ?? "";
  const [exact = "", prefix = ""] = classifier.split("fn prefixed(");
  const ids = new Set(
    [...exact.replace(/^\s*\/\/.*$/gm, "").matchAll(EXACT_ID)].map(
      (match) => match[1]
    )
  );
  const prefixes = new Set(
    [...(prefix.split("\n}")[0] ?? "").matchAll(PREFIX)].map(
      (match) => `${match[1]}*`
    )
  );

  // Broad compatibility fallbacks such as "native " cannot cover new IDs.
  const missing = DOCTOR_CHECK_IDS.filter(
    (id) => !(id.endsWith("*") ? prefixes : ids).has(id)
  );
  expect(
    missing,
    `Unclassified CLI Doctor check IDs: ${missing.join(", ")}. Classify them in ${CLASSIFIER}.`
  ).toEqual([]);
});
