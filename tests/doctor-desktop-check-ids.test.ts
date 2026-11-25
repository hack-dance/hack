import { expect, test } from "bun:test";
import {
  DOCTOR_CHECK_IDS,
  doctorMetadata,
} from "../src/lib/doctor-metadata.ts";

const ROUTING = "apps/desktop/ui/src/window.rs";
const CLASSIFIER = "apps/desktop/core/src/doctor.rs";
const EXACT_ID = /"([^"]+)"\s*(?=\||=>)/g;
const RUST_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const PREFIX = /id\.starts_with\("([^"]+)"\)/g;

function unclassifiedIds(source: string): readonly string[] {
  const classifier =
    source.split("pub fn classify(")[1]?.replace(RUST_COMMENT, "") ?? "";
  const [exact = "", prefix = ""] = classifier.split("fn prefixed(");
  const ids = new Set([...exact.matchAll(EXACT_ID)].map((match) => match[1]));
  const prefixes = new Set(
    [...(prefix.split("\n}")[0] ?? "").matchAll(PREFIX)].map(
      (match) => `${match[1]}*`
    )
  );

  // Broad compatibility fallbacks such as "native " cannot cover new IDs.
  return DOCTOR_CHECK_IDS.filter(
    (id) => !(id.endsWith("*") ? prefixes : ids).has(id)
  );
}

test("Desktop classifies every CLI Doctor check ID", async () => {
  const source = await Bun.file(
    new URL(`../${CLASSIFIER}`, import.meta.url)
  ).text();
  const missing = unclassifiedIds(source);
  expect(
    missing,
    `Unclassified CLI Doctor check IDs: ${missing.join(", ")}. Classify them in ${CLASSIFIER}.`
  ).toEqual([]);
});

test("a commented-out classification does not satisfy the Desktop contract", async () => {
  const source = await Bun.file(
    new URL(`../${CLASSIFIER}`, import.meta.url)
  ).text();
  const commented = source.replace(
    '| "native temporary aliases"\n        | "native pool idle"',
    '| "native temporary aliases" /* "native pool idle" | */ // "native pool idle" =>\n        '
  );
  expect(commented).not.toBe(source);
  expect(unclassifiedIds(commented)).toEqual(["native pool idle"]);
});

test("Desktop routing status covers the CLI's machine routing and certificate checks", async () => {
  const source = (
    await Bun.file(new URL(`../${ROUTING}`, import.meta.url)).text()
  ).replace(RUST_COMMENT, "");
  const routingIds = DOCTOR_CHECK_IDS.filter((id) => {
    const { area, scope } = doctorMetadata({ id });
    return (
      scope === "machine" &&
      (area === "routing_dns" || area === "certificates") &&
      !id.endsWith("(optional)")
    );
  });

  for (const [name, expected] of [
    ["ROUTING_CHECKS", routingIds.filter((id) => !id.endsWith("*"))],
    [
      "ROUTING_PREFIXES",
      routingIds.filter((id) => id.endsWith("*")).map((id) => id.slice(0, -1)),
    ],
  ] as const) {
    const block = source
      .split(`const ${name}:`)[1]
      ?.split("= [")[1]
      ?.split("];")[0];
    const actual = [...(block ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(actual.sort(), `Update ${name} in ${ROUTING}.`).toEqual(
      expected.sort()
    );
  }
});
