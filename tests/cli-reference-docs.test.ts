import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { renderCliReferenceMarkdown } from "../src/cli/reference.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

const DOCS_PATH = resolve(import.meta.dir, "..", "docs", "reference", "cli.md");

describe("generated CLI reference", () => {
  test("docs/reference/cli.md matches CLI_SPEC (run: bun run docs:cli-reference)", async () => {
    const committed = await Bun.file(DOCS_PATH).text();
    const rendered = renderCliReferenceMarkdown({ cli: CLI_SPEC });
    expect(committed).toBe(rendered);
  });

  test("reference covers every top-level command", () => {
    const rendered = renderCliReferenceMarkdown({ cli: CLI_SPEC });
    for (const command of CLI_SPEC.commands) {
      expect(rendered).toContain(`hack ${command.name}`);
    }
  });

  test("experimental commands are listed but not expanded", () => {
    const rendered = renderCliReferenceMarkdown({ cli: CLI_SPEC });
    expect(rendered).toContain("## Experimental (unsupported)");
    expect(rendered).not.toContain("## `hack node pair`");
  });
});
