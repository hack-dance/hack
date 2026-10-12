import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  NEGATIVE_EXAMPLE_END,
  NEGATIVE_EXAMPLE_START,
  PATTERN_CATALOGUE,
  type PatternCard,
  type PatternDisposition,
  renderPatternCatalogue,
} from "../src/agents/pattern-catalogue.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  extractHackInvocations,
  findGuidanceCommandIssues,
} from "./helpers/cli-guidance-commands.ts";
import { bannedRecipeFindings } from "./helpers/pattern-recipes.ts";

const EXPECTED_IDS = Array.from(
  { length: 12 },
  (_, index) => `HACK-P${String(index + 1).padStart(2, "0")}`
);
const OWNER = /^WU\d+(?:\/WU\d+)*$/;

/** Closed id problems: missing or duplicated cards fail the register. */
function catalogueIdIssues(cards: readonly PatternCard[]): string[] {
  const ids = cards.map((card) => card.id);
  return [
    ...EXPECTED_IDS.filter((id) => !ids.includes(id)).map(
      (id) => `missing ${id}`
    ),
    ...ids
      .filter((id, index) => ids.indexOf(id) !== index)
      .map((id) => `duplicate ${id}`),
    ...ids
      .filter((id) => !EXPECTED_IDS.includes(id))
      .map((id) => `unexpected ${id}`),
  ];
}

test("the catalogue holds exactly the twelve HACK-P cards in order", () => {
  expect(catalogueIdIssues(PATTERN_CATALOGUE)).toEqual([]);
  expect(PATTERN_CATALOGUE.map((card) => card.id)).toEqual(EXPECTED_IDS);
  expect(PATTERN_CATALOGUE.map((card) => card.linearId)).toEqual(
    Array.from({ length: 12 }, (_, index) => `HACK-${1145 + index}`)
  );
});

test("negative control: deleting or duplicating a card fails the id check", () => {
  expect(catalogueIdIssues(PATTERN_CATALOGUE.slice(1))).toEqual([
    "missing HACK-P01",
  ]);
  const first = PATTERN_CATALOGUE[0];
  if (!first) {
    throw new Error("empty catalogue");
  }
  expect(catalogueIdIssues([...PATTERN_CATALOGUE, first])).toEqual([
    "duplicate HACK-P01",
  ]);
});

test("starting dispositions match the recorded decisions", () => {
  const expected: Readonly<Record<string, PatternDisposition>> = {
    "HACK-P01": "partial",
    "HACK-P02": "partial",
    "HACK-P03": "partial",
    "HACK-P04": "retain-as-example",
    "HACK-P05": "deferred",
    "HACK-P06": "deferred",
    "HACK-P07": "partial",
    "HACK-P08": "deferred",
    "HACK-P09": "partial",
    "HACK-P10": "partial",
    "HACK-P11": "partial",
    "HACK-P12": "deferred",
  };
  expect(
    Object.fromEntries(
      PATTERN_CATALOGUE.map((card) => [card.id, card.disposition])
    )
  ).toEqual(expected);
  expect(
    PATTERN_CATALOGUE.find((card) => card.id === "HACK-P04")?.domainOwner
  ).toBe("WU29");
});

test("every card is complete and every unsupported card names its owner and missing contract", () => {
  for (const card of PATTERN_CATALOGUE) {
    for (const field of [
      card.title,
      card.useWhen,
      card.prerequisites,
      card.envOwnership,
      card.readiness,
      card.cleanup,
      card.negativeControl,
      card.provenance.source,
    ]) {
      expect(field.trim().length, card.id).toBeGreaterThan(0);
    }
    expect(card.domainOwner, card.id).toMatch(OWNER);
    expect(card.provenance.consumers, card.id).toBeGreaterThan(0);
    if (card.disposition === "supported") {
      expect(card.missingContract, card.id).toBeNull();
    } else {
      expect(card.missingContract?.trim().length ?? 0, card.id).toBeGreaterThan(
        0
      );
    }
  }
});

test("every named hack command resolves in CLI_SPEC", () => {
  for (const card of PATTERN_CATALOGUE) {
    for (const command of card.supportedCommands) {
      expect(command.startsWith("hack "), `${card.id}: ${command}`).toBe(true);
      expect(
        findGuidanceCommandIssues({
          cli: CLI_SPEC,
          rendered: `\`${command}\``,
        }),
        `${card.id}: ${command}`
      ).toEqual([]);
    }
  }
  const rendered = renderPatternCatalogue();
  expect(extractHackInvocations(rendered).length).toBeGreaterThan(0);
  expect(findGuidanceCommandIssues({ cli: CLI_SPEC, rendered })).toEqual([]);
});

test("banned recipes appear only inside negative-example blocks", () => {
  expect(bannedRecipeFindings(renderPatternCatalogue())).toEqual([]);
  const rendered = renderPatternCatalogue();
  for (const card of PATTERN_CATALOGUE) {
    expect(rendered).toContain(
      `${NEGATIVE_EXAMPLE_START}\n> Negative control: ${card.negativeControl}\n${NEGATIVE_EXAMPLE_END}`
    );
  }
});

test("negative control: the banned-recipe scan flags each recipe outside a negative block", () => {
  const fixtures: Readonly<Record<string, string>> = {
    "broad-process-kill": "pkill -f node",
    "kill-by-port": "lsof -t -i :3000 | xargs kill",
    "placeholder-liveness-tail": "command: tail -f /dev/null",
    "placeholder-liveness-sleep": "command: sleep infinity",
    "argv-secret-flag": "tool login --token abc123",
    "argv-secret-assignment": "API_TOKEN=abc123 hack up",
    "argv-env-value": "hack env set DATABASE_URL postgres://x",
  };
  for (const [code, text] of Object.entries(fixtures)) {
    expect(bannedRecipeFindings(text)).toEqual([code]);
    expect(
      bannedRecipeFindings(
        `${NEGATIVE_EXAMPLE_START}\n${text}\n${NEGATIVE_EXAMPLE_END}`
      )
    ).toEqual([]);
    expect(bannedRecipeFindings(`${NEGATIVE_EXAMPLE_START}\n${text}`)).toEqual([
      code,
    ]);
  }
});

test("the packaged hack-cli reference is the rendered catalogue", async () => {
  const packaged = await Bun.file(
    join(
      import.meta.dir,
      "..",
      "plugins/hack/skills/hack-cli/references/patterns.md"
    )
  ).text();
  expect(packaged.startsWith(renderPatternCatalogue().trimEnd())).toBe(true);
  for (const card of PATTERN_CATALOGUE) {
    expect(packaged).toContain(`## ${card.id}: ${card.title}`);
  }
});
