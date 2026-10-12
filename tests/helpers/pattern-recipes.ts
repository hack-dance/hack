import {
  NEGATIVE_EXAMPLE_END,
  NEGATIVE_EXAMPLE_START,
} from "../../src/agents/pattern-catalogue.ts";

/**
 * Banned-recipe scan shared by the pattern catalogue and its example fixtures.
 * Findings are closed codes; the scanned text is never echoed.
 */

/** Recipes that must never appear outside a negative-example block. */
export const BANNED_RECIPES: readonly (readonly [string, RegExp])[] = [
  ["broad-process-kill", /\b(?:pkill|killall)\b/],
  ["kill-by-port", /\blsof\b[^\n|]*-t[^\n|]*\|\s*xargs\s+(?:-\S+\s+)*kill\b/],
  ["placeholder-liveness-tail", /\btail\s+-f\s+\/dev\/null\b/],
  ["placeholder-liveness-sleep", /\bsleep\s+infinity\b/],
  [
    "argv-secret-flag",
    /--(?:password|passwd|token|secret|api-key|apikey|access-key)(?:=|\s+)\S/i,
  ],
  [
    "argv-secret-assignment",
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)=\S/,
  ],
  ["argv-env-value", /\bhack\s+env\s+(?:set|add)\s+\S+\s+\S+/],
];

function stripNegativeExamples(text: string): string {
  let result = "";
  let rest = text;
  for (;;) {
    const start = rest.indexOf(NEGATIVE_EXAMPLE_START);
    if (start === -1) {
      return result + rest;
    }
    const end = rest.indexOf(NEGATIVE_EXAMPLE_END, start);
    if (end === -1) {
      // An unterminated block exempts nothing.
      return result + rest;
    }
    result += rest.slice(0, start);
    rest = rest.slice(end + NEGATIVE_EXAMPLE_END.length);
  }
}

/** Codes of banned recipes found outside negative-example blocks. */
export function bannedRecipeFindings(text: string): string[] {
  const scanned = stripNegativeExamples(text);
  return BANNED_RECIPES.filter(([, pattern]) => pattern.test(scanned)).map(
    ([code]) => code
  );
}
