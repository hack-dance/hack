import { expect, test } from "bun:test";
import {
  renderHelpForPath,
  renderHelpMarkdownForPath,
} from "../src/cli/help.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

test("root help leads with the local-first offer and new command grouping", () => {
  const help = renderHelpForPath(CLI_SPEC, []);

  expect(help).toContain("Local development without the port-collision tax");
  expect(help).toContain("Core promises:");
  expect(help).toContain("Core workflows:");
  expect(help).toContain("Local helpers:");
  expect(help).toContain("Unsupported experimental:");
  expect(help).toContain("Extension commands:");
  expect(help).toMatch(
    /hack tickets(?: \[args\.\.\.\])?\s+Track repo-local work without leaving git/
  );
  expect(help).toMatch(
    /hack auth(?: \[args\.\.\.\])?\s+Removed: Hack account sign-in no longer ships with the local-first CLI/
  );
  expect(help).toMatch(
    /hack linear(?: \[args\.\.\.\])?\s+Removed: Linear integration is no longer part of Hack v3/
  );
  expect(help).toMatch(
    /hack remote\s+Beta: guided remote access and gateway helpers/
  );
  expect(help.indexOf("Core workflows:")).toBeLessThan(
    help.indexOf("Unsupported experimental:")
  );
});

test("markdown help preserves the local-first grouping", () => {
  const help = renderHelpMarkdownForPath(CLI_SPEC, []);

  expect(help).toContain("### Core promises");
  expect(help).toContain("### Core workflows");
  expect(help).toContain("### Local helpers");
  expect(help).toContain("### Unsupported experimental");
  expect(help).toContain("`hack tickets [args...]`");
  expect(help).toContain("`hack auth [args...]`");
  expect(help).toContain("`hack linear [args...]`");
});

test("experimental subcommand help stays visibly labeled experimental", () => {
  const help = renderHelpForPath(CLI_SPEC, ["remote", "setup"]);
  const markdown = renderHelpMarkdownForPath(CLI_SPEC, ["remote", "setup"]);

  expect(help).toContain("hack remote setup");
  expect(help).toContain("Status: Unsupported experimental workflow");
  expect(markdown).toContain("> Status: Unsupported experimental workflow.");
});

test("dispatch help no longer advertises built-in GitHub PR automation", () => {
  const help = renderHelpForPath(CLI_SPEC, ["dispatch", "run"]);

  expect(help).toContain("hack dispatch run");
  expect(help).not.toContain("create/update GitHub PR");
  expect(help).toContain("Removed in v3: legacy GitHub PR automation flag");
});
